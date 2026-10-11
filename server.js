require("dotenv").config();

const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const QRCode = require("qrcode");
const { createPool, withTx, bootstrap, saveUser, mapUser, mapCoinExchange, mapCoinWithdrawal, mapSubscription, mapDeposit, mapWithdrawal, nowIso, money, iso, bool, parseJson, SCHEMA_FILE } = require("./db");
const { migrateBlob, exportBlob } = require("./migration-core");

const app = express();
app.set("trust proxy", 1); // Render sits behind a proxy; needed for correct req.ip (rate limiting)
const PORT = Number(process.env.PORT || 3000);
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const BOT_USERNAME = process.env.BOT_USERNAME || "Cjp_Earnig_Bot";
const MINI_APP_URL = process.env.MINI_APP_URL || `https://t.me/${BOT_USERNAME.replace("@", "")}`;
const CHANNEL_USERNAME = process.env.CHANNEL_USERNAME || "@CJPEarningOfficial";
const CHAT_USERNAME = process.env.CHAT_USERNAME || "";
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const AUTH_MAX_AGE_SEC = Number(process.env.AUTH_MAX_AGE_SEC || 24 * 60 * 60); // Telegram initData freshness

// ───────────────────────────── Core rules ─────────────────────────────
// CJP POINTS live inside the app (users.cjp_balance). The CJP COIN is a TON Jetton: members exchange points for coins (see COIN_*).
const DAILY_CHECKIN_REWARD = 10;
const DAILY_STREAK_CAP_DAYS = 30; // reward grows +10/day up to day 30, then plateaus until the streak breaks
const SIGNUP_BONUS_CJP = 200;
const REFERRAL_SIGNUP_BONUS_CJP = 100;
const JOIN_CHANNEL_REWARD = 100;
const JOIN_CHAT_REWARD = 100;

// Referral tasks. kind "vip" counts invited members who are VIP, kind "nonvip" counts invited members who are not VIP.
// VIP tasks pay USDT + points, non-VIP tasks pay points only. (Non-VIP point amounts are placeholders - edit freely.)
const REFERRAL_MILESTONES = {
  referral_milestone_5:  { kind: "vip", count: 5,  usdt: 2,  points: 1000 },
  referral_milestone_10: { kind: "vip", count: 10, usdt: 5,  points: 2500 },
  referral_milestone_50: { kind: "vip", count: 50, usdt: 30, points: 10000 },
  referral_nonvip_5:     { kind: "nonvip", count: 5,  usdt: 0, points: 500 },
  referral_nonvip_10:    { kind: "nonvip", count: 10, usdt: 0, points: 1250 },
  referral_nonvip_50:    { kind: "nonvip", count: 50, usdt: 0, points: 5000 }
};
const DEPOSIT_MIN = 10;
const WITHDRAW_MIN = 0.1;
const WITHDRAW_FEE_PERCENT = 5;
const WITHDRAW_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const MAX_PENDING_DEPOSITS_PER_USER = 5;
const NETWORKS = ["TON", "TRC20", "BEP20"];

// Mining: one claim every MINING_COOLDOWN_MS (8 hours) = 3 claims per day. Points per claim by VIP level.
const MINING_COOLDOWN_MS = 8 * 60 * 60 * 1000;
const NON_VIP_MINING_POINTS = 100;
const VIP_PLANS = {
  1: { price: 10,  miningPoints: 200,  spinsPerDay: 2 },
  2: { price: 25,  miningPoints: 300,  spinsPerDay: 3 },
  3: { price: 50,  miningPoints: 500,  spinsPerDay: 5 },
  4: { price: 100, miningPoints: 750,  spinsPerDay: 7 },
  5: { price: 250, miningPoints: 1500, spinsPerDay: 10 }
};
const NON_VIP_FREE_SPINS = 1;
const NON_VIP_REFERRAL_PERCENT = 2;   // commission (in points) the referrer earns on referred members' earnings
const VIP_REFERRAL_PERCENT = 5;
const VIP_UPGRADE_REFUND_PERCENT = 100;
// VIP members can claim USDT once per UTC day in Tasks: plan price x VIP_DAILY_USDT_MONTHLY_PERCENT % per 30 days, paid as 1/30 per day.
const VIP_DAILY_USDT_MONTHLY_PERCENT = 10;
const VIP_DAILY_USDT_DAYS = 30;

// CJP coin (Jetton). Points -> coin at POINTS_PER_COIN. An exchange needs at least COIN_MIN_EXCHANGE_POINTS and releases its coins
// linearly over COIN_EXCHANGE_DAYS. Mined coins can be claimed once per UTC day. Withdrawals (to a TON wallet such as Tonkeeper) open on COIN_WITHDRAW_OPEN_AT.
const POINTS_PER_COIN = 1000;
const COIN_MIN_EXCHANGE_POINTS = 100000;
const COIN_EXCHANGE_DAYS = 90;
const COIN_WITHDRAW_OPEN_AT = "2027-01-01T00:00:00.000Z";
const COIN_WITHDRAW_MIN = 1;

// Monthly Top Referrers: the top REF_LB_REWARDS_POINTS.length members with the most VIP referrals in a UTC calendar month win CJP POINTS,
// paid automatically after the month ends. Only VIP referrals count: a referral counts for the month in which the invited member FIRST became VIP.
// Winners need at least REF_LB_MIN_REFERRALS VIP referrals. Ties: whoever reached that count first, then the older account.
const REF_LB_REWARDS_POINTS = [10000, 7000, 5000, 4000, 3000, 2000, 1500, 1000, 750, 500];   // rank 1..10 (ranks 2-10 are placeholders)
const REF_LB_MIN_REFERRALS = 5;

// Spin game: free spins per day by VIP level (VIP_PLANS[l].spinsPerDay, non-VIP NON_VIP_FREE_SPINS). Extra spins are bought with USDT
// (taken from the withdrawable balance first) and stored in users.bonus_spins, they never expire.
// 12-slot wheel. weight is per-mille (sum = 1000). A prize is { cjp } points or { usdt } (tiny USDT prize).
// Expected value 53.0 points per spin plus ~0.00003 USDT.
const SPIN_PRICE_USDT = 0.1;
const SPIN_PACK_SIZE = 10;
const SPIN_PACK_PRICE_USDT = 0.9;
const SPIN_PRIZES = [
  { cjp: 250, weight: 30 },    // slot 1  - 3%
  { cjp: 10, weight: 200 },    // slot 2  - 20%
  { cjp: 1000, weight: 4 },    // slot 3  - 0.4%
  { cjp: 50, weight: 140 },    // slot 4  - 14%
  { cjp: 0, weight: 202 },     // slot 5  - 20.2%
  { usdt: 0.002, weight: 8 },  // slot 6  - 0.8%
  { cjp: 150, weight: 40 },    // slot 7  - 4%
  { cjp: 25, weight: 180 },    // slot 8  - 18%
  { cjp: 500, weight: 15 },    // slot 9  - 1.5%
  { cjp: 75, weight: 100 },    // slot 10 - 10%
  { cjp: 100, weight: 70 },    // slot 11 - 7%
  { usdt: 0.001, weight: 11 }  // slot 12 - 1.1%
];
const SPIN_WEIGHT_TOTAL = SPIN_PRIZES.reduce((n, p) => n + p.weight, 0);
if (SPIN_PRIZES.length !== 12 || SPIN_WEIGHT_TOTAL !== 1000) throw new Error("SPIN_PRIZES must have 12 slots and weights summing to 1000");

const DEFAULT_SETTINGS = { channelJoinEnabled: true, dailyCheckinEnabled: true, miningEnabled: true, gamesEnabled: true, referralLeaderboardEnabled: true, vipDailyUsdtEnabled: true, coinExchangeEnabled: true };

// ───────────────────────────── Small helpers ─────────────────────────────
const DAY_MS = 24 * 60 * 60 * 1000;
function dayKey() { return new Date().toISOString().slice(0, 10); }
function yesterdayKey() { return new Date(Date.now() - DAY_MS).toISOString().slice(0, 10); }
function msUntilNextUtcDay() { const n = new Date(); return Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + 1) - n.getTime(); }
function floor6(n) { return Math.floor(Number(n || 0) * 1e6 + 1e-9) / 1e6; }
function referralCode(userId) { return "CJP" + Number(userId).toString(36).toUpperCase(); }
function safeEqual(a, b) {
  const x = crypto.createHash("sha256").update(String(a)).digest();
  const y = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}
function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
function parseId(v) { if (!/^\d{1,15}$/.test(String(v))) throw httpError(400, "Invalid id"); return Number(v); }

const TX_RE = /^[A-Za-z0-9_\-=+/:.]{16,128}$/;
const ADDRESS_RES = {
  TON: /^([A-Za-z0-9_-]{48}|-?\d+:[a-fA-F0-9]{64})$/,
  TRC20: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
  BEP20: /^0x[a-fA-F0-9]{40}$/
};

// Simple in-memory fixed-window rate limiter (per IP).
function makeLimiter({ windowMs, max }) {
  const hits = new Map();
  setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.reset < now) hits.delete(k); }, windowMs).unref();
  return (req, res, next) => {
    const now = Date.now(); const key = req.ip || "unknown";
    let rec = hits.get(key);
    if (!rec || rec.reset < now) { rec = { n: 0, reset: now + windowMs }; hits.set(key, rec); }
    if (++rec.n > max) return res.status(429).json({ error: "Too many requests. Please slow down." });
    next();
  };
}

// ───────────────────────────── Database access ─────────────────────────────
let pool = null;
const rowsOf = async (c, sql, params = []) => (await c.query(sql, params)).rows;
const rowOf = async (c, sql, params = []) => (await c.query(sql, params)).rows[0] || null;

// Every state change runs inside one transaction. The member's own row is locked with SELECT ... FOR UPDATE first,
// so two requests of the same member can never interleave (no double-claims, no lost balance updates).
function api(fn) {
  return async (req, res) => {
    try { res.json(await withTx(pool, c => fn(req, c))); }
    catch (e) { fail(res, e); }
  };
}
function raw(fn) { // handlers that manage their own transactions (e.g. they wait for the network)
  return async (req, res) => { try { res.json(await fn(req)); } catch (e) { fail(res, e); } };
}
function fail(res, e) {
  if (!e.status) console.error(e);
  res.status(e.status || 500).json({ error: e.status ? e.message : "Server error" });
}

async function getSettings(c) {
  const s = { ...DEFAULT_SETTINGS };
  for (const r of await rowsOf(c, "SELECT key, value FROM settings")) if (r.key in DEFAULT_SETTINGS) { const v = parseJson(r.value); if (typeof v === "boolean") s[r.key] = v; }
  return s;
}

async function addLedger(c, userId, type, amount, currency, meta = {}) {
  await c.query("INSERT INTO ledger (user_id, type, amount, currency, meta, created_at) VALUES ($1,$2,$3,$4,$5,$6)", [Number(userId), type, Number(amount), currency, JSON.stringify(meta), nowIso()]);
}

// In-memory credit on a locked/loaded member (the caller saves it). The referrer is updated with atomic SQL increments.
async function creditCjp(c, u, amount, applyReferral = true, source = "earning") {
  const value = money(amount);
  u.cjpBalance = money(u.cjpBalance + value);
  await addLedger(c, u.id, "credit", value, "CJP", { reason: source });
  if (applyReferral && u.referredBy) {
    const ref = await rowOf(c, "SELECT id, vip_level FROM users WHERE id = $1", [u.referredBy]);
    if (ref) {
      const pct = (Number(ref.vip_level) > 0 ? VIP_REFERRAL_PERCENT : NON_VIP_REFERRAL_PERCENT) / 100;
      const commission = money(value * pct);
      await c.query("UPDATE users SET cjp_balance = cjp_balance + $2, ref_commission_cjp = ref_commission_cjp + $2 WHERE id = $1", [ref.id, commission]);
      await addLedger(c, ref.id, "referral_commission", commission, "CJP", { fromUserId: u.id, rate: pct });
    }
  }
}
async function creditUsdt(c, u, amount, type, meta = {}) {
  const value = money(amount);
  u.usdtBalance = money(u.usdtBalance + value);
  if (type === "deposit_verified") u.depositUsdtBalance = money(u.depositUsdtBalance + value);
  else u.swapUsdtBalance = money(u.swapUsdtBalance + value);
  await addLedger(c, u.id, type, value, "USDT", meta);
}
// Same, for a member that is not loaded in memory (admin approvals, refunds, leaderboard prizes): atomic SQL increments.
async function creditUsdtById(c, userId, amount, type, meta = {}) {
  const value = money(amount);
  const col = type === "deposit_verified" ? "deposit_usdt_balance" : "swap_usdt_balance";
  await c.query(`UPDATE users SET usdt_balance = usdt_balance + $2, ${col} = ${col} + $2 WHERE id = $1`, [userId, value]);
  await addLedger(c, userId, type, value, "USDT", meta);
}

// ───────────────────────────── Member helpers ─────────────────────────────
async function isChatMember(chatUsername, userId) {
  // true = member, false = verified NOT a member, null = cannot verify (not configured / Telegram error / bot not in chat)
  if (!BOT_TOKEN) return null;
  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=${encodeURIComponent(chatUsername)}&user_id=${encodeURIComponent(userId)}`;
    const data = await (await fetch(url)).json();
    if (!data.ok) {
      if (/user not found/i.test(String(data.description || ""))) return false;
      console.error("getChatMember failed:", data.description);
      return null;
    }
    const r = data.result || {};
    if (r.status === "restricted") return r.is_member === true;
    return ["creator", "administrator", "member"].includes(r.status);
  } catch (e) { console.error("isChatMember check failed:", e.message); return null; }
}

function isVip(u) { return Number(u?.vipLevel) > 0; }
function currentVipLevel(u) { return isVip(u) ? Number(u.vipLevel) : 0; }
function miningRewardFor(u) { const l = currentVipLevel(u); return l > 0 ? VIP_PLANS[l].miningPoints : NON_VIP_MINING_POINTS; }
function nextMineAtMs(u) { return u.lastMineAt ? new Date(u.lastMineAt).getTime() + MINING_COOLDOWN_MS : 0; }
function extraSpinsOf(u) { return Math.max(0, Math.floor(Number(u.bonusSpins || 0))); }
function spinsUsedToday(u) { return u.spinDay === dayKey() ? Number(u.spinCount || 0) : 0; }
function freeSpinsPerDay(u) { const l = currentVipLevel(u); return l > 0 ? VIP_PLANS[l].spinsPerDay : NON_VIP_FREE_SPINS; }
function freeSpinsLeft(u) { return Math.max(0, freeSpinsPerDay(u) - spinsUsedToday(u)); }
function vipDailyUsdtFor(u) { const l = currentVipLevel(u); return l > 0 ? floor6(VIP_PLANS[l].price * VIP_DAILY_USDT_MONTHLY_PERCENT / 100 / VIP_DAILY_USDT_DAYS) : 0; }
async function vipReferralCount(c, userId) {
  return Number((await rowOf(c, "SELECT COUNT(*) AS n FROM users WHERE referred_by = $1 AND vip_level > 0 AND is_blocked = FALSE", [userId])).n);
}
async function nonVipReferralCount(c, userId) {
  return Number((await rowOf(c, "SELECT COUNT(*) AS n FROM users WHERE referred_by = $1 AND vip_level = 0 AND is_blocked = FALSE", [userId])).n);
}
// Points credit for a member that is not loaded in memory (leaderboard prizes): atomic SQL increment, no referral commission.
async function creditCjpById(c, userId, amount, source) {
  const value = money(amount);
  await c.query("UPDATE users SET cjp_balance = cjp_balance + $2 WHERE id = $1", [userId, value]);
  await addLedger(c, userId, "credit", value, "CJP", { reason: source });
}
// Takes USDT for purchases: withdrawable (swap-backed) balance first, then verified-deposit balance. Returns false if the member cannot pay.
function spendUsdt(u, amount) {
  const amt = money(amount);
  if (money(u.usdtBalance) < amt) return false;
  const fromSwap = Math.min(money(u.swapUsdtBalance), amt), fromDeposit = money(amt - fromSwap);
  if (fromDeposit > money(u.depositUsdtBalance)) return false;
  u.swapUsdtBalance = money(u.swapUsdtBalance - fromSwap); u.depositUsdtBalance = money(u.depositUsdtBalance - fromDeposit); u.usdtBalance = money(u.usdtBalance - amt);
  return true;
}
// Coins an exchange has released so far (linear over its 90 days) minus what was already claimed. Rounded DOWN to 6 decimals,
// except that after the end date the rest is paid out completely, so no dust is ever left behind.
function exchangeClaimable(e, nowMs) {
  const start = new Date(e.startAt).getTime(), end = new Date(e.endAt).getTime();
  if (nowMs >= end) return money(e.coinsTotal - e.claimedCoins);
  const released = floor6(e.coinsTotal * Math.max(0, nowMs - start) / (end - start));
  return Math.max(0, money(released - e.claimedCoins));
}
async function activeExchanges(c, userId) {
  return (await rowsOf(c, "SELECT * FROM coin_exchanges WHERE user_id = $1 AND status = 'active' ORDER BY id", [userId])).map(mapCoinExchange);
}
function nextDailyReward(u) {
  const today = dayKey();
  let streak;
  if (u.lastDailyDay === today || u.lastDailyDay === yesterdayKey()) streak = Math.min(Number(u.dailyStreak || 0) + 1, DAILY_STREAK_CAP_DAYS);
  else streak = 1;
  return DAILY_CHECKIN_REWARD * streak;
}

async function getOrCreateUser(c, tg, ref, lock = true) {
  const uid = Number(tg.id);
  const lockSql = lock ? " FOR UPDATE" : "";
  let row = await rowOf(c, "SELECT * FROM users WHERE id = $1" + lockSql, [uid]);
  if (!row) {
    let referredBy = null;
    const refText = String(ref || "");
    if (refText.startsWith("ref_")) {
      const rid = refText.slice(4).trim();
      if (/^\d+$/.test(rid) && Number(rid) !== uid && await rowOf(c, "SELECT id FROM users WHERE id = $1", [Number(rid)])) referredBy = Number(rid);
    }
    const ins = await c.query(
      "INSERT INTO users (id, username, first_name, referral_code, referred_by, cjp_balance, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING RETURNING id",
      [uid, tg.username || "", tg.first_name || "", referralCode(uid), referredBy, SIGNUP_BONUS_CJP, nowIso()]);
    if (ins.rows.length) { // we created it (a parallel request that lost the race skips the bonuses)
      if (referredBy) {
        await c.query("UPDATE users SET referral_count = referral_count + 1, cjp_balance = cjp_balance + $2, ref_bonus_cjp = ref_bonus_cjp + $2 WHERE id = $1", [referredBy, REFERRAL_SIGNUP_BONUS_CJP]);
        await addLedger(c, referredBy, "referral_signup_bonus", REFERRAL_SIGNUP_BONUS_CJP, "CJP", { reason: "referred_new_member", newUserId: uid });
      }
      await addLedger(c, uid, "signup_bonus", SIGNUP_BONUS_CJP, "CJP", { reason: "new_member_signup" });
    }
    row = await rowOf(c, "SELECT * FROM users WHERE id = $1" + lockSql, [uid]);
  }
  const u = mapUser(row);
  const username = tg.username || u.username || "", firstName = tg.first_name || u.firstName || "";
  if (username !== u.username || firstName !== u.firstName) {
    await c.query("UPDATE users SET username = $2, first_name = $3 WHERE id = $1", [uid, username, firstName]);
    u.username = username; u.firstName = firstName;
  }
  return u;
}

async function publicUser(c, u) {
  const level = currentVipLevel(u);
  const today = dayKey();
  const claims = new Set((await rowsOf(c, "SELECT task_id FROM task_claims WHERE user_id = $1", [u.id])).map(r => r.task_id));
  const freeLeft = freeSpinsLeft(u), extra = extraSpinsOf(u);
  const nowMs = Date.now(), nextMine = nextMineAtMs(u);
  const exchanges = await activeExchanges(c, u.id);
  const claimable = money(exchanges.reduce((n, e) => n + exchangeClaimable(e, nowMs), 0));
  const daily = vipDailyUsdtFor(u);
  return {
    id: u.id, username: u.username, firstName: u.firstName,
    cjpBalance: money(u.cjpBalance), usdtBalance: money(u.usdtBalance),
    depositUsdtBalance: money(u.depositUsdtBalance), swapUsdtBalance: money(u.swapUsdtBalance),
    referralCode: u.referralCode, referralCount: Number(u.referralCount || 0),
    vipLevel: level, vipStartedAt: level ? u.vipStartedAt : null, vipDepositUsdt: level ? money(u.vipPaidUsdt) : 0,
    isBlocked: Boolean(u.isBlocked),
    dailyClaimed: u.lastDailyDay === today, dailyStreak: Number(u.dailyStreak || 0), nextDailyReward: nextDailyReward(u), lastDaily: u.lastDaily,
    miningReward: miningRewardFor(u), miningReady: nowMs >= nextMine, miningWaitMs: Math.max(0, nextMine - nowMs),
    spinsPerDay: freeSpinsPerDay(u), freeSpinsLeft: freeLeft, extraSpins: extra, spinsLeft: freeLeft + extra,
    resetInMs: msUntilNextUtcDay(),
    coinBalance: money(u.coinBalance), coinClaimable: claimable, coinClaimedToday: u.lastCoinClaimDay === today,
    coinLockedPoints: money(exchanges.reduce((n, e) => n + e.points, 0)), coinActiveExchanges: exchanges.length,
    vipDailyUsdt: daily, vipDailyUsdtClaimed: u.lastVipUsdtDay === today,
    joinChannelClaimed: claims.has("join_channel"), joinChatClaimed: claims.has("join_chat"),
    vipReferralCount: await vipReferralCount(c, u.id), nonVipReferralCount: await nonVipReferralCount(c, u.id),
    milestoneClaims: Object.keys(REFERRAL_MILESTONES).reduce((acc, t) => { acc[t] = claims.has(t); return acc; }, {})
  };
}

function publicConfig(s) {
  return {
    miningCooldownHours: MINING_COOLDOWN_MS / 3600000, nonVipMiningPoints: NON_VIP_MINING_POINTS, vipUpgradeRefundPercent: VIP_UPGRADE_REFUND_PERCENT,
    referralCommission: { nonVipPercent: NON_VIP_REFERRAL_PERCENT, vipPercent: VIP_REFERRAL_PERCENT },
    dailyCheckinReward: DAILY_CHECKIN_REWARD, joinChannelReward: JOIN_CHANNEL_REWARD, joinChatReward: JOIN_CHAT_REWARD, referralMilestones: REFERRAL_MILESTONES,
    plans: Object.fromEntries(Object.entries(VIP_PLANS).map(([l, p]) => [l, { ...p, dailyUsdt: floor6(p.price * VIP_DAILY_USDT_MONTHLY_PERCENT / 100 / VIP_DAILY_USDT_DAYS) }])),
    vipDailyUsdt: { monthlyPercent: VIP_DAILY_USDT_MONTHLY_PERCENT, days: VIP_DAILY_USDT_DAYS },
    nonVipFreeSpins: NON_VIP_FREE_SPINS, spinPrizes: SPIN_PRIZES.map(p => ({ cjp: p.cjp || 0, usdt: p.usdt || 0 })),
    spinShop: { price: SPIN_PRICE_USDT, packSize: SPIN_PACK_SIZE, packPrice: SPIN_PACK_PRICE_USDT },
    coin: { pointsPerCoin: POINTS_PER_COIN, minExchangePoints: COIN_MIN_EXCHANGE_POINTS, days: COIN_EXCHANGE_DAYS, withdrawOpenAt: COIN_WITHDRAW_OPEN_AT, withdrawMin: COIN_WITHDRAW_MIN },
    channel: CHANNEL_USERNAME, chat: CHAT_USERNAME || null, botUsername: BOT_USERNAME, miniAppUrl: MINI_APP_URL,
    withdrawalMin: WITHDRAW_MIN, withdrawalCooldownHours: 24, withdrawalFeePercent: WITHDRAW_FEE_PERCENT, depositMin: DEPOSIT_MIN,
    features: { mining: s.miningEnabled !== false, games: s.gamesEnabled !== false, dailyCheckin: s.dailyCheckinEnabled !== false, channelJoin: s.channelJoinEnabled !== false,
      vipDailyUsdt: s.vipDailyUsdtEnabled !== false, coinExchange: s.coinExchangeEnabled !== false }
  };
}

// ───────────────────────────── Monthly Top Referrers ─────────────────────────────
function monthKeyOf(ms) { return new Date(ms).toISOString().slice(0, 7); }
function monthStartMs(key) { const [y, m] = key.split("-").map(Number); return Date.UTC(y, m - 1, 1); }
function nextMonthKey(key) { const [y, m] = key.split("-").map(Number); return monthKeyOf(Date.UTC(y, m, 1)); }
function prevMonthKey(key) { const [y, m] = key.split("-").map(Number); return monthKeyOf(Date.UTC(y, m - 2, 1)); }
function maskMember(u) { const n = String(u?.firstName || u?.username || "Member").trim() || "Member"; return Array.from(n).slice(0, 2).join("") + "***"; }
async function memberName(c, userId) {
  const r = await rowOf(c, "SELECT first_name, username FROM users WHERE id = $1", [userId]);
  return r ? { firstName: r.first_name, username: r.username } : null;
}

// Ranked list [{ id, count, lastAt, since }] of members with >= 1 VIP referral that FIRST became VIP in the given month.
// "First VIP" = the earliest subscription (or users.vip_started_at for admin-granted VIP). Blocked members are excluded on both sides.
async function computeMonthBoard(c, key) {
  const start = new Date(monthStartMs(key)).toISOString(), end = new Date(monthStartMs(nextMonthKey(key))).toISOString();
  const rows = await rowsOf(c, `
    SELECT u.referred_by AS id, COUNT(*) AS cnt, MAX(fv.t) AS last_at, r.created_at AS since
    FROM users u
    JOIN (SELECT x.id AS uid, COALESCE((SELECT MIN(s.started_at) FROM subscriptions s WHERE s.user_id = x.id), x.vip_started_at) AS t
          FROM users x WHERE x.vip_level > 0) fv ON fv.uid = u.id
    JOIN users r ON r.id = u.referred_by
    WHERE u.vip_level > 0 AND u.is_blocked = FALSE AND r.is_blocked = FALSE AND fv.t >= $1 AND fv.t < $2
    GROUP BY u.referred_by, r.created_at
    ORDER BY COUNT(*) DESC, MAX(fv.t) ASC, r.created_at ASC, u.referred_by ASC`, [start, end]);
  return rows.map(r => ({ id: Number(r.id), count: Number(r.cnt), lastAt: iso(r.last_at), since: iso(r.since) }));
}
let boardCache = { key: null, at: 0, rows: [] };
async function currentBoard(c) {
  const key = monthKeyOf(Date.now());
  if (boardCache.key !== key || Date.now() - boardCache.at > 20000) boardCache = { key, at: Date.now(), rows: await computeMonthBoard(c, key) };
  return boardCache.rows;
}
async function getLastSettled(c) {
  const r = await rowOf(c, "SELECT value FROM app_state WHERE key = 'ref_lb_last_settled'");
  return r ? String(parseJson(r.value)) : prevMonthKey(monthKeyOf(Date.now())); // first deploy: never pay past months
}

// Pays every finished month that has not been settled yet (startup, hourly and when the board is opened).
// One transaction + an advisory lock, so even two server instances can never pay the same month twice.
async function settleReferralMonths() {
  const current = monthKeyOf(Date.now());
  if (!(nextMonthKey(await getLastSettled(pool)) < current)) return;
  await withTx(pool, async c => {
    await c.query("SELECT pg_advisory_xact_lock(727002)");
    let last = await getLastSettled(c);
    const enabled = (await getSettings(c)).referralLeaderboardEnabled !== false;
    while (nextMonthKey(last) < current) {
      const month = nextMonthKey(last);
      const winners = [];
      if (enabled) {
        const board = (await computeMonthBoard(c, month)).filter(r => r.count >= REF_LB_MIN_REFERRALS).slice(0, REF_LB_REWARDS_POINTS.length);
        for (let i = 0; i < board.length; i++) {
          const r = board[i], points = REF_LB_REWARDS_POINTS[i];
          await creditCjpById(c, r.id, points, "leaderboard_reward");
          const nm = await memberName(c, r.id);
          winners.push({ rank: i + 1, userId: r.id, name: maskMember(nm), username: nm?.username || "", count: r.count, points });
        }
      }
      await c.query("INSERT INTO ref_leaderboard_history (month, winners, skipped, settled_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", [month, JSON.stringify(winners), !enabled, nowIso()]);
      await c.query("INSERT INTO app_state (key, value) VALUES ('ref_lb_last_settled', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [JSON.stringify(month)]);
      last = month;
    }
    await c.query("DELETE FROM ref_leaderboard_history WHERE month NOT IN (SELECT month FROM ref_leaderboard_history ORDER BY month DESC LIMIT 36)");
  });
  boardCache.at = 0;
}

// ───────────────────────────── Auth ─────────────────────────────
function verifyInitData(initData) {
  if (!initData || !BOT_TOKEN) return null;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    const startParam = params.get("start_param") || null;
    const authDate = Number(params.get("auth_date") || 0);
    params.delete("hash");
    const dataCheckString = [...params.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => `${k}=${v}`).join("\n");
    const secret = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
    const expected = crypto.createHmac("sha256", secret).update(dataCheckString).digest("hex");
    if (!hash || hash.length !== expected.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(hash))) return null;
    if (!authDate || Date.now() / 1000 - authDate > AUTH_MAX_AGE_SEC) return null; // stale/replayed initData
    const user = JSON.parse(params.get("user") || "null");
    return user && Number.isInteger(Number(user.id)) ? { ...user, __startParam: startParam } : null;
  } catch { return null; }
}

function getTelegramUser(req) {
  const initData = req.headers["x-telegram-init-data"] || req.body?.initData || "";
  const tg = verifyInitData(initData);
  if (tg) return tg;
  if (process.env.ALLOW_DEMO === "true") return { id: 999001, username: "demo_user", first_name: "Demo" };
  throw httpError(401, initData ? "Session expired or invalid. Please reopen the Mini App from Telegram." : "Telegram authentication required");
}

const adminFails = new Map();
setInterval(() => { const now = Date.now(); for (const [k, v] of adminFails) if (v.until < now && v.n === 0) adminFails.delete(k); }, 15 * 60 * 1000).unref();
function requireAdmin(req) {
  const ip = req.ip || "unknown";
  const rec = adminFails.get(ip);
  if (rec && rec.until > Date.now()) throw httpError(429, "Too many failed attempts. Try again in 15 minutes.");
  if (!ADMIN_KEY || !safeEqual(req.headers["x-admin-key"] || "", ADMIN_KEY)) {
    const r = rec || { n: 0, until: 0 };
    if (++r.n >= 10) { r.until = Date.now() + 15 * 60 * 1000; r.n = 0; }
    adminFails.set(ip, r);
    throw httpError(403, "Admin authorization required");
  }
  adminFails.delete(ip);
}
function admin(fn) { return api((req, c) => { requireAdmin(req); return fn(req, c); }); }

function assertNotBlocked(u) {
  if (u.isBlocked) throw httpError(403, "Your account has been suspended. Contact support.");
}

// ───────────────────────────── HTTP: static + security ─────────────────────────────
app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => {
  res.set("X-Content-Type-Options", "nosniff");
  res.set("Referrer-Policy", "no-referrer");
  next();
});
app.use("/api/", makeLimiter({ windowMs: 60 * 1000, max: 300 }));

// SECURITY: static files are served from an explicit allow-list only (no express.static on the project folder),
// so server.js, package.json, schema.sql, .env etc. can never be fetched - not even via %-encoded paths.
const PUBLIC_FILES = new Set(["app.js", "style.css", "admin.js", "admin.css"]);
const sendFile = (res, name) => res.sendFile(path.join(__dirname, name), err => { if (err && !res.headersSent) res.status(err.status || 500).send("File could not be served."); });

app.get(["/admin", "/admin/", "/admin.html"], (req, res) => {
  // Strict CSP for the admin panel: no inline scripts, no third-party origins (defense in depth against XSS).
  res.set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  res.set("Cache-Control", "no-store");
  sendFile(res, "admin.html");
});
app.get("/", (req, res) => sendFile(res, "index.html"));
app.get("/payouts", (req, res) => sendFile(res, "payouts.html"));
app.get("/health", async (req, res) => {
  try { await pool.query("SELECT 1"); res.json({ ok: true, service: "Cjpearnigbot", db: "postgres", time: nowIso() }); }
  catch (e) { res.status(503).json({ ok: false, error: "database unavailable" }); }
});
app.get("/api/qr", makeLimiter({ windowMs: 60 * 1000, max: 30 }), async (req, res) => {
  try {
    const data = String(req.query.data || "").trim();
    const allowed = [process.env.DEPOSIT_TON, process.env.DEPOSIT_TRC20, process.env.DEPOSIT_BEP20].filter(Boolean);
    if (!data || data.length > 500 || !allowed.includes(data)) return res.status(400).send("Invalid QR data"); // only our deposit addresses
    const png = await QRCode.toBuffer(data, { width: 320, margin: 2, errorCorrectionLevel: "M", type: "png" });
    res.set("Content-Type", "image/png"); res.set("Cache-Control", "no-store"); res.send(png);
  } catch (e) { res.status(500).send("QR generation failed"); }
});

// Public proof-of-payout (no auth): completed withdrawals WITH an on-chain tx hash, masked identity.
function maskName(name) {
  const s = String(name || "").trim() || "Member";
  if (s.length <= 2) return s[0] + "*";
  return s[0] + "*".repeat(Math.min(s.length - 2, 5)) + s[s.length - 1];
}
app.get("/api/public/payouts", async (req, res) => {
  try {
    const rows = await rowsOf(pool, `SELECT w.network, w.amount, w.net_amount, w.tx_hash, w.completed_at, u.first_name, u.username
      FROM withdrawals w LEFT JOIN users u ON u.id = w.user_id
      WHERE w.status = 'completed' AND w.tx_hash IS NOT NULL AND w.tx_hash <> '' AND w.hidden_from_proof = FALSE
      ORDER BY w.completed_at DESC, w.id DESC LIMIT 50`);
    res.json(rows.map(w => ({ name: maskName(w.first_name || w.username || "Member"), amount: money(w.net_amount != null ? w.net_amount : w.amount), network: w.network, txHash: w.tx_hash, completedAt: iso(w.completed_at) })));
  } catch (e) { console.error(e); res.status(500).json({ error: "Unable to load payouts" }); }
});

app.get("/api/config", raw(async () => publicConfig(await getSettings(pool))));

// ───────────────────────────── HTTP: member API ─────────────────────────────
app.post("/api/bootstrap", api(async (req, c) => {
  const tg = getTelegramUser(req); const u = await getOrCreateUser(c, tg, tg.__startParam || req.body?.ref, false);
  return { user: await publicUser(c, u) };
}));
app.get("/api/me", api(async (req, c) => ({ user: await publicUser(c, await getOrCreateUser(c, getTelegramUser(req), null, false)) })));
app.post("/api/vip/status", api(async (req, c) => ({ user: await publicUser(c, await getOrCreateUser(c, getTelegramUser(req), null, false)) })));

app.post("/api/daily", api(async (req, c) => {
  if ((await getSettings(c)).dailyCheckinEnabled === false) throw httpError(403, "Daily Check-in is temporarily disabled.");
  const u = await getOrCreateUser(c, getTelegramUser(req), null, true); assertNotBlocked(u);
  const today = dayKey();
  if (u.lastDailyDay === today) return { ok: false, message: "Daily reward already claimed today. Come back tomorrow.", user: await publicUser(c, u) };
  const streakBroken = u.lastDailyDay !== yesterdayKey(); // a full calendar day was skipped
  u.dailyStreak = streakBroken ? 1 : Math.min(Number(u.dailyStreak || 0) + 1, DAILY_STREAK_CAP_DAYS);
  const reward = DAILY_CHECKIN_REWARD * u.dailyStreak;
  await creditCjp(c, u, reward, true, "daily_checkin"); u.lastDaily = nowIso(); u.lastDailyDay = today; await saveUser(c, u);
  return { ok: true, message: `+${reward} CJP added (Day ${u.dailyStreak} streak)`, user: await publicUser(c, u) };
}));

const waitText = ms => { const m = Math.max(1, Math.ceil(ms / 60000)); return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`; };

// Mining: one claim every 8 hours (MINING_COOLDOWN_MS). The amount in points depends on the VIP level.
app.post("/api/mine", api(async (req, c) => {
  if ((await getSettings(c)).miningEnabled === false) throw httpError(403, "Mining is temporarily disabled.");
  const u = await getOrCreateUser(c, getTelegramUser(req), null, true); assertNotBlocked(u);
  const now = Date.now(), next = nextMineAtMs(u);
  if (now < next) return { ok: false, message: `Mining is cooling down. Next claim in ${waitText(next - now)}.`, user: await publicUser(c, u) };
  const reward = miningRewardFor(u);
  u.lastMineAt = new Date(now).toISOString();
  await creditCjp(c, u, reward, true, "mining"); await saveUser(c, u);
  return { ok: true, message: `⛏ Mining complete! +${reward} points added`, reward, user: await publicUser(c, u) };
}));

// Spin game: server decides the result (crypto RNG); client only animates it.
function pickPrizeIndex() {
  let r = crypto.randomInt(0, SPIN_WEIGHT_TOTAL);
  for (let i = 0; i < SPIN_PRIZES.length; i++) { if (r < SPIN_PRIZES[i].weight) return i; r -= SPIN_PRIZES[i].weight; }
  return 0;
}
app.post("/api/spin", api(async (req, c) => {
  if ((await getSettings(c)).gamesEnabled === false) throw httpError(403, "Games are temporarily disabled.");
  const u = await getOrCreateUser(c, getTelegramUser(req), null, true); assertNotBlocked(u);
  const today = dayKey();
  if (u.spinDay !== today) { u.spinDay = today; u.spinCount = 0; }
  // The daily free spins are used first, then purchased extra spins.
  let usedType;
  if (u.spinCount < freeSpinsPerDay(u)) { u.spinCount += 1; usedType = "free"; }
  else if (extraSpinsOf(u) > 0) { u.bonusSpins = extraSpinsOf(u) - 1; usedType = "extra"; }
  else { await saveUser(c, u); return { ok: false, message: "No spins left. Free spins reset at 00:00 UTC, or buy more spins.", user: await publicUser(c, u) }; }
  const index = pickPrizeIndex(); const p = SPIN_PRIZES[index];
  const prize = p.cjp || 0, usdtWon = p.usdt || 0;
  if (prize > 0) await creditCjp(c, u, prize, true, "spin_reward");
  if (usdtWon > 0) await creditUsdt(c, u, usdtWon, "spin_usdt_reward", { index, usedType });
  await saveUser(c, u);
  const message = prize > 0 ? `🎉 You won +${prize} points!` : usdtWon > 0 ? `💵 You won ${usdtWon} USDT!` : "No luck this time. Try again!";
  return { ok: true, index, prize, usdtWon, usedType, message, user: await publicUser(c, u) };
}));

// Buy extra spins with USDT: 1 spin = SPIN_PRICE_USDT, pack of 10 = SPIN_PACK_PRICE_USDT.
app.post("/api/spin/buy", api(async (req, c) => {
  if ((await getSettings(c)).gamesEnabled === false) throw httpError(403, "Games are temporarily disabled.");
  const u = await getOrCreateUser(c, getTelegramUser(req), null, true); assertNotBlocked(u);
  const pack = Number(req.body?.pack);
  let count, price;
  if (pack === 1) { count = 1; price = SPIN_PRICE_USDT; }
  else if (pack === SPIN_PACK_SIZE) { count = SPIN_PACK_SIZE; price = SPIN_PACK_PRICE_USDT; }
  else throw httpError(400, "Invalid spin pack.");
  if (!spendUsdt(u, price)) throw httpError(400, `You need ${price} USDT to buy ${count} spin${count > 1 ? "s" : ""}.`);
  u.bonusSpins = extraSpinsOf(u) + count;
  await addLedger(c, u.id, "spin_purchase", price, "USDT", { spins: count });
  await saveUser(c, u);
  return { ok: true, message: `✅ ${count} spin${count > 1 ? "s" : ""} added for ${price} USDT.`, user: await publicUser(c, u) };
}));

// VIP daily USDT (Tasks): once per UTC day, plan price x VIP_DAILY_USDT_MONTHLY_PERCENT % spread over 30 days. Paid to the withdrawable balance.
app.post("/api/vip/daily-usdt", api(async (req, c) => {
  if ((await getSettings(c)).vipDailyUsdtEnabled === false) throw httpError(403, "VIP daily USDT is temporarily disabled.");
  const u = await getOrCreateUser(c, getTelegramUser(req), null, true); assertNotBlocked(u);
  if (!isVip(u)) throw httpError(403, "Only VIP members can claim the daily USDT.");
  const today = dayKey();
  if (u.lastVipUsdtDay === today) return { ok: false, message: "Today's USDT is already claimed. Come back after the daily reset.", user: await publicUser(c, u) };
  const amount = vipDailyUsdtFor(u);
  await creditUsdt(c, u, amount, "vip_daily_usdt", { level: u.vipLevel, monthlyPercent: VIP_DAILY_USDT_MONTHLY_PERCENT });
  u.lastVipUsdtDay = today; await saveUser(c, u);
  return { ok: true, message: `+${amount} USDT added`, amount, user: await publicUser(c, u) };
}));

// ───────── CJP coin (Jetton): points -> coin exchange, daily claim, withdrawal to a TON wallet (opens COIN_WITHDRAW_OPEN_AT) ─────────
app.post("/api/coin/exchange", api(async (req, c) => {
  if ((await getSettings(c)).coinExchangeEnabled === false) throw httpError(403, "Coin exchange is temporarily disabled.");
  const u = await getOrCreateUser(c, getTelegramUser(req), null, true); assertNotBlocked(u);
  const points = Math.floor(Number(req.body?.points));
  if (!Number.isFinite(points) || points < COIN_MIN_EXCHANGE_POINTS) throw httpError(400, `Minimum exchange is ${COIN_MIN_EXCHANGE_POINTS.toLocaleString("en-US")} points.`);
  if (points > money(u.cjpBalance)) throw httpError(400, "Insufficient CJP points.");
  const coins = floor6(points / POINTS_PER_COIN);
  const start = new Date(), end = new Date(start.getTime() + COIN_EXCHANGE_DAYS * DAY_MS);
  u.cjpBalance = money(u.cjpBalance - points);
  const row = await rowOf(c, "INSERT INTO coin_exchanges (user_id, points, coins_total, claimed_coins, start_at, end_at, status) VALUES ($1,$2,$3,0,$4,$5,'active') RETURNING id",
    [u.id, points, coins, start.toISOString(), end.toISOString()]);
  await addLedger(c, u.id, "coin_exchange", points, "CJP", { coins, exchangeId: Number(row.id), days: COIN_EXCHANGE_DAYS });
  await saveUser(c, u);
  return { ok: true, message: `Exchange started: ${points.toLocaleString("en-US")} points → ${coins} CJP coin, released over ${COIN_EXCHANGE_DAYS} days. Claim your mined coins once a day.`, user: await publicUser(c, u) };
}));

app.post("/api/coin/claim", api(async (req, c) => {
  const u = await getOrCreateUser(c, getTelegramUser(req), null, true); assertNotBlocked(u);
  const today = dayKey(), nowMs = Date.now();
  if (u.lastCoinClaimDay === today) return { ok: false, message: "You already claimed your coins today. Come back after the daily reset (00:00 UTC).", user: await publicUser(c, u) };
  const exchanges = await activeExchanges(c, u.id);
  if (!exchanges.length) return { ok: false, message: `No active exchange. Exchange at least ${COIN_MIN_EXCHANGE_POINTS.toLocaleString("en-US")} points to start mining coins.`, user: await publicUser(c, u) };
  let total = 0;
  for (const e of exchanges) {
    const amt = exchangeClaimable(e, nowMs);
    const finished = nowMs >= new Date(e.endAt).getTime();
    if (amt > 0 || finished) await c.query("UPDATE coin_exchanges SET claimed_coins = claimed_coins + $2, status = $3 WHERE id = $1", [e.id, amt, finished ? "completed" : "active"]);
    total = money(total + amt);
  }
  if (total <= 0) return { ok: false, message: "Nothing mined yet. Check again in a little while.", user: await publicUser(c, u) };
  u.coinBalance = money(u.coinBalance + total); u.lastCoinClaimDay = today;
  await addLedger(c, u.id, "coin_claim", total, "COIN", {});
  await saveUser(c, u);
  return { ok: true, message: `⛏ ${total} CJP coin claimed`, claimed: total, user: await publicUser(c, u) };
}));

app.get("/api/coin/status", api(async (req, c) => {
  const u = await getOrCreateUser(c, getTelegramUser(req), null, false);
  const nowMs = Date.now();
  const exchanges = (await rowsOf(c, "SELECT * FROM coin_exchanges WHERE user_id = $1 ORDER BY id DESC LIMIT 20", [u.id])).map(mapCoinExchange)
    .map(e => ({ ...e, claimable: e.status === "active" ? exchangeClaimable(e, nowMs) : 0 }));
  const withdrawals = (await rowsOf(c, "SELECT * FROM coin_withdrawals WHERE user_id = $1 ORDER BY id DESC LIMIT 20", [u.id])).map(mapCoinWithdrawal);
  return { exchanges, withdrawals, withdrawOpen: nowMs >= new Date(COIN_WITHDRAW_OPEN_AT).getTime(), withdrawOpenAt: COIN_WITHDRAW_OPEN_AT };
}));

app.post("/api/coin/withdraw", api(async (req, c) => {
  const u = await getOrCreateUser(c, getTelegramUser(req), null, true); assertNotBlocked(u);
  if (Date.now() < new Date(COIN_WITHDRAW_OPEN_AT).getTime()) throw httpError(403, `CJP coin withdrawals open on ${COIN_WITHDRAW_OPEN_AT.slice(0, 10)}.`);
  const address = String(req.body?.address || "").trim(), amount = money(Number(req.body?.amount));
  if (!address) throw httpError(400, "Please enter your Tonkeeper (TON) wallet address.");
  if (!ADDRESS_RES.TON.test(address)) throw httpError(400, "That doesn't look like a valid TON wallet address.");
  if (!Number.isFinite(amount) || amount < COIN_WITHDRAW_MIN) throw httpError(400, `Minimum withdrawal is ${COIN_WITHDRAW_MIN} CJP coin.`);
  if (amount > money(u.coinBalance)) throw httpError(400, "Insufficient CJP coin balance.");
  if (await rowOf(c, "SELECT id FROM coin_withdrawals WHERE user_id = $1 AND status = 'processing'", [u.id])) throw httpError(400, "You already have a coin withdrawal in processing.");
  u.coinBalance = money(u.coinBalance - amount);
  const row = await rowOf(c, "INSERT INTO coin_withdrawals (user_id, address, amount, status, created_at) VALUES ($1,$2,$3,'processing',$4) RETURNING *", [u.id, address, amount, nowIso()]);
  await addLedger(c, u.id, "coin_withdrawal_hold", amount, "COIN", { withdrawalId: Number(row.id) });
  await saveUser(c, u);
  return { ok: true, message: `Withdrawal requested: ${amount} CJP coin. It will be sent to your wallet after review.`, user: await publicUser(c, u), withdrawal: mapCoinWithdrawal(row) };
}));

const taskLocks = new Set();
app.post("/api/task", raw(async req => {
  const tg = getTelegramUser(req);
  const taskId = String(req.body?.taskId || "");
  if (REFERRAL_MILESTONES[taskId]) {
    const m = REFERRAL_MILESTONES[taskId];
    return withTx(pool, async c => {
      const u = await getOrCreateUser(c, tg, null, true); assertNotBlocked(u);
      const have = m.kind === "vip" ? await vipReferralCount(c, u.id) : await nonVipReferralCount(c, u.id);
      const label = m.kind === "vip" ? "VIP" : "non-VIP";
      if (await rowOf(c, "SELECT id FROM task_claims WHERE user_id = $1 AND task_id = $2", [u.id, taskId])) return { ok: false, message: "Task already claimed", user: await publicUser(c, u) };
      if (have < m.count) throw httpError(400, `You need ${m.count} ${label} referrals to claim this. You currently have ${have}.`);
      const ins = await c.query("INSERT INTO task_claims (user_id, task_id, created_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id", [u.id, taskId, nowIso()]);
      if (!ins.rows.length) return { ok: false, message: "Task already claimed", user: await publicUser(c, u) };
      if (m.usdt > 0) await creditUsdt(c, u, m.usdt, "referral_milestone", { taskId, requiredReferrals: m.count, kind: m.kind });
      if (m.points > 0) await creditCjp(c, u, m.points, false, "referral_task"); // task rewards earn no referral commission
      await saveUser(c, u);
      return { ok: true, message: `+${m.points.toLocaleString("en-US")} points${m.usdt > 0 ? ` and +${m.usdt} USDT` : ""} added for ${m.count} ${label} referrals!`, user: await publicUser(c, u) };
    });
  }
  const rewards = { join_channel: JOIN_CHANNEL_REWARD, join_chat: JOIN_CHAT_REWARD };
  if (!rewards[taskId]) throw httpError(400, "Invalid task");

  // 1) quick checks (short transaction)  2) Telegram membership check WITHOUT holding a database transaction  3) claim + credit.
  // Step 3 is guarded by the UNIQUE (user_id, task_id) constraint, so parallel taps can never double-claim.
  const pre = await withTx(pool, async c => {
    const u = await getOrCreateUser(c, tg, null, false); assertNotBlocked(u);
    const s = await getSettings(c);
    if (taskId === "join_channel" && s.channelJoinEnabled === false) throw httpError(403, "Channel Join task is temporarily disabled.");
    if (taskId === "join_chat" && !CHAT_USERNAME) throw httpError(400, "Chat Join task is not configured yet.");
    if (await rowOf(c, "SELECT id FROM task_claims WHERE user_id = $1 AND task_id = $2", [u.id, taskId])) return { done: { ok: false, message: "Task already claimed", user: await publicUser(c, u) } };
    return { uid: u.id };
  });
  if (pre.done) return pre.done;

  const lockKey = `${pre.uid}:${taskId}`;
  if (taskLocks.has(lockKey)) throw httpError(429, "Verification already in progress. Please wait a moment.");
  taskLocks.add(lockKey);
  try {
    const targetChat = taskId === "join_channel" ? CHANNEL_USERNAME : CHAT_USERNAME;
    const member = await isChatMember(targetChat, pre.uid);
    if (member === null) throw httpError(503, "Membership could not be verified right now. Please try again later or contact support.");
    if (!member) throw httpError(400, `Please join ${targetChat} first, then tap the button again to claim your reward.`);
    return await withTx(pool, async c => {
      const u = await getOrCreateUser(c, tg, null, true); assertNotBlocked(u);
      const ins = await c.query("INSERT INTO task_claims (user_id, task_id, created_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id", [u.id, taskId, nowIso()]);
      if (!ins.rows.length) return { ok: false, message: "Task already claimed", user: await publicUser(c, u) };
      await creditCjp(c, u, rewards[taskId], true, `task_${taskId}`); await saveUser(c, u);
      return { ok: true, message: `+${rewards[taskId]} CJP added`, user: await publicUser(c, u) };
    });
  } finally { taskLocks.delete(lockKey); }
}));

app.get("/api/referral", api(async (req, c) => {
  const u = await getOrCreateUser(c, getTelegramUser(req), null, false);
  return {
    referralCode: u.referralCode, referralCount: Number(u.referralCount || 0), commission: `${VIP_REFERRAL_PERCENT}% VIP / ${NON_VIP_REFERRAL_PERCENT}% non-VIP`,
    referralBonusCjp: money(u.refBonusCjp), referralCommissionCjp: money(u.refCommissionCjp), totalReferralCjp: money(money(u.refBonusCjp) + money(u.refCommissionCjp))
  };
}));

app.get("/api/referral/leaderboard", raw(async req => {
  const tg = getTelegramUser(req);
  await settleReferralMonths(); // outside the request transaction: it uses its own
  return withTx(pool, async c => {
    const u = await getOrCreateUser(c, tg, null, false);
    const enabled = (await getSettings(c)).referralLeaderboardEnabled !== false;
    const month = monthKeyOf(Date.now()), board = await currentBoard(c);
    const top = [];
    for (let i = 0; i < Math.min(board.length, REF_LB_REWARDS_POINTS.length); i++) {
      const r = board[i];
      top.push({ rank: i + 1, name: r.id === u.id ? "You" : maskMember(await memberName(c, r.id)), count: r.count, reward: REF_LB_REWARDS_POINTS[i], unit: "points", qualified: r.count >= REF_LB_MIN_REFERRALS, isYou: r.id === u.id });
    }
    const idx = board.findIndex(r => r.id === u.id);
    const last = await rowOf(c, "SELECT * FROM ref_leaderboard_history ORDER BY month DESC LIMIT 1");
    let lastMonth = null;
    if (last && !(last.skipped === true || last.skipped === 1)) {
      const winners = [];
      for (const w of parseJson(last.winners, [])) {
        const nm = await memberName(c, w.userId);
        winners.push({ rank: w.rank, name: w.userId === u.id ? "You" : (nm ? maskMember(nm) : w.name), count: w.count, reward: w.points != null ? w.points : w.usdt, unit: w.points != null ? "points" : "usdt", isYou: w.userId === u.id });
      }
      lastMonth = { month: last.month, winners };
    }
    return {
      enabled, month, endsInMs: monthStartMs(nextMonthKey(month)) - Date.now(),
      rewards: REF_LB_REWARDS_POINTS, rewardUnit: "points", minReferrals: REF_LB_MIN_REFERRALS, top,
      me: { count: idx >= 0 ? board[idx].count : 0, rank: idx >= 0 ? idx + 1 : null }, lastMonth
    };
  });
}));

app.post("/api/vip/subscribe", api(async (req, c) => {
  const u = await getOrCreateUser(c, getTelegramUser(req), null, true); assertNotBlocked(u);
  const level = Number(req.body?.level); const plan = VIP_PLANS[level];
  if (!plan) throw httpError(400, "Invalid VIP level");
  const highestOwned = currentVipLevel(u);
  if (level <= highestOwned) throw httpError(400, `You already own VIP ${highestOwned}. You can only upgrade to a higher level.`);
  // Only verified real deposits may be used to buy VIP. CJP-swap USDT is not eligible.
  if (money(u.depositUsdtBalance) < plan.price) throw httpError(400, `You need ${plan.price} USDT from a verified deposit to activate VIP ${level}. USDT earned from tasks, spins or daily claims cannot be used for VIP.`);

  // Upgrading replaces the previous level; it refunds VIP_UPGRADE_REFUND_PERCENT of what was originally paid for it.
  const currentSubs = (await rowsOf(c, "SELECT * FROM subscriptions WHERE user_id = $1 AND status = 'active'", [u.id])).map(mapSubscription);
  const now = nowIso();
  let refundAmount = 0;
  for (const s of currentSubs) {
    const r = money(money(s.priceUsdt) * (VIP_UPGRADE_REFUND_PERCENT / 100));
    await c.query("UPDATE subscriptions SET status = 'upgraded', upgraded_at = $2, refunded = TRUE, refunded_at = $2, refund_amount = $3 WHERE id = $1", [s.id, now, r]);
    refundAmount = money(refundAmount + r);
  }
  u.depositUsdtBalance = money(u.depositUsdtBalance - plan.price);
  u.usdtBalance = money(u.usdtBalance - plan.price);
  if (refundAmount > 0) await creditUsdt(c, u, refundAmount, "vip_upgrade_refund", { fromLevels: currentSubs.map(s => s.level), toLevel: level });

  const sub = await rowOf(c, "INSERT INTO subscriptions (user_id, level, price_usdt, started_at, status) VALUES ($1,$2,$3,$4,'active') RETURNING id", [u.id, level, plan.price, now]);
  u.vipLevel = level; u.vipStartedAt = now; u.activeSubscriptionId = Number(sub.id); u.vipPaidUsdt = plan.price;
  await addLedger(c, u.id, "vip_subscription_payment", plan.price, "USDT", { subscriptionId: Number(sub.id), level, source: "verified_deposit" });
  await saveUser(c, u);
  const refundNote = refundAmount > 0 ? ` ${refundAmount.toFixed(6)} USDT (${VIP_UPGRADE_REFUND_PERCENT}% of your previous VIP) was refunded to your USDT balance.` : "";
  return { ok: true, message: `VIP ${level} activated permanently${highestOwned ? ", replacing your previous VIP" : ""}.${refundNote} ${plan.price} USDT was deducted from your verified deposit balance.`, user: await publicUser(c, u) };
}));

app.get("/api/deposit-addresses", (req, res) => res.json({
  TON: process.env.DEPOSIT_TON || "NOT_CONFIGURED", TRC20: process.env.DEPOSIT_TRC20 || "NOT_CONFIGURED", BEP20: process.env.DEPOSIT_BEP20 || "NOT_CONFIGURED"
}));

// Deposit requests stay pending until an admin verifies the transaction on-chain.
app.post("/api/deposit", api(async (req, c) => {
  const u = await getOrCreateUser(c, getTelegramUser(req), null, true); assertNotBlocked(u);
  const network = String(req.body?.network || "");
  const txHash = String(req.body?.txHash || "").trim();
  const amount = money(Number(req.body?.amount));
  if (!NETWORKS.includes(network)) throw httpError(400, "Unsupported network");
  if (!txHash) throw httpError(400, "Please enter your transaction hash.");
  if (!TX_RE.test(txHash)) throw httpError(400, "That transaction hash doesn't look valid.");
  if (!Number.isFinite(amount) || amount <= 0) throw httpError(400, "Please enter a valid deposit amount.");
  if (amount < DEPOSIT_MIN) throw httpError(400, `Minimum deposit is ${DEPOSIT_MIN} USDT.`);
  if (await rowOf(c, "SELECT id FROM deposits WHERE lower(tx_hash) = $1", [txHash.toLowerCase()])) throw httpError(400, "This transaction hash has already been submitted");
  const pending = Number((await rowOf(c, "SELECT COUNT(*) AS n FROM deposits WHERE user_id = $1 AND status = 'pending'", [u.id])).n);
  if (pending >= MAX_PENDING_DEPOSITS_PER_USER) throw httpError(400, "You have too many pending deposits. Please wait for verification.");
  let row;
  try {
    row = await rowOf(c, "INSERT INTO deposits (user_id, network, tx_hash, amount, status, created_at) VALUES ($1,$2,$3,$4,'pending',$5) RETURNING *", [u.id, network, txHash, amount, nowIso()]);
  } catch (e) { if (e.code === "23505") throw httpError(400, "This transaction hash has already been submitted"); throw e; } // lost a race with the same hash
  return { ok: true, message: "Deposit submitted. USDT will be added only after verification.", deposit: mapDeposit(row) };
}));

app.get("/api/my-deposits", api(async (req, c) => {
  const u = await getOrCreateUser(c, getTelegramUser(req), null, false);
  return (await rowsOf(c, "SELECT * FROM deposits WHERE user_id = $1 ORDER BY id DESC LIMIT 50", [u.id])).map(mapDeposit);
}));

async function ledgerHistory(c, userId, currency, types, limit = 100) {
  const ph = types.map((_, i) => `$${i + 3}`).join(",");
  const rows = await rowsOf(c, `SELECT id, type, amount, created_at, meta FROM ledger WHERE user_id = $1 AND currency = $2 AND type IN (${ph}) AND amount > 0 ORDER BY id DESC LIMIT ${Number(limit)}`, [userId, currency, ...types]);
  return rows.map(x => ({ id: Number(x.id), type: x.type, amount: money(x.amount), createdAt: iso(x.created_at), meta: parseJson(x.meta, {}) }));
}
app.get("/api/my-cjp-history", api(async (req, c) => {
  const u = await getOrCreateUser(c, getTelegramUser(req), null, false);
  return ledgerHistory(c, u.id, "CJP", ["credit", "signup_bonus", "referral_commission", "referral_signup_bonus"]);
}));
app.get("/api/my-usdt-bonus-history", api(async (req, c) => {
  const u = await getOrCreateUser(c, getTelegramUser(req), null, false);
  return ledgerHistory(c, u.id, "USDT", ["vip_upgrade_refund", "referral_milestone", "referral_leaderboard_reward", "vip_daily_usdt", "spin_usdt_reward"]);
}));
app.get("/api/my-withdrawals", api(async (req, c) => {
  const u = await getOrCreateUser(c, getTelegramUser(req), null, false);
  return (await rowsOf(c, "SELECT * FROM withdrawals WHERE user_id = $1 ORDER BY id DESC LIMIT 20", [u.id])).map(mapWithdrawal);
}));

// Withdrawal is processed by the admin/payout system and should be completed within 24 hours.
app.post("/api/withdraw", api(async (req, c) => {
  const u = await getOrCreateUser(c, getTelegramUser(req), null, true); assertNotBlocked(u);
  if (!isVip(u)) throw httpError(403, "Only VIP members can withdraw USDT.");
  const network = String(req.body?.network || ""); const address = String(req.body?.address || "").trim(); const amount = money(Number(req.body?.amount));
  if (!NETWORKS.includes(network)) throw httpError(400, "Unsupported network");
  if (!address) throw httpError(400, "Please enter your receiving wallet address.");
  if (!ADDRESS_RES[network].test(address)) throw httpError(400, `That doesn't look like a valid ${network} wallet address.`);
  if (!Number.isFinite(amount) || amount < WITHDRAW_MIN) throw httpError(400, `Minimum withdrawal is ${WITHDRAW_MIN} USDT`);
  if (amount > money(u.usdtBalance)) throw httpError(400, "Insufficient USDT balance");
  const mine = (await rowsOf(c, "SELECT * FROM withdrawals WHERE user_id = $1", [u.id])).map(mapWithdrawal);
  if (mine.some(x => x.status === "processing")) throw httpError(400, "You already have a withdrawal in processing.");
  const last = mine.filter(x => x.status !== "rejected").sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
  if (last && Date.now() - new Date(last.createdAt).getTime() < WITHDRAW_COOLDOWN_MS) throw httpError(400, "Only 1 withdrawal request is allowed every 24 hours.");

  const fromSwap = Math.min(money(u.swapUsdtBalance), amount);
  const fromDeposit = money(amount - fromSwap);
  if (fromDeposit > money(u.depositUsdtBalance)) throw httpError(400, "Insufficient USDT balance.");
  u.swapUsdtBalance = money(u.swapUsdtBalance - fromSwap);
  u.depositUsdtBalance = money(u.depositUsdtBalance - fromDeposit);
  u.usdtBalance = money(u.usdtBalance - amount);
  const feeAmount = money(amount * (WITHDRAW_FEE_PERCENT / 100));
  const netAmount = money(amount - feeAmount);
  const created = Date.now();
  const row = await rowOf(c, `INSERT INTO withdrawals (user_id, network, address, amount, fee_percent, fee_amount, net_amount, status, source_swap_usdt, source_deposit_usdt, created_at, available_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,'processing',$8,$9,$10,$11) RETURNING *`,
    [u.id, network, address, amount, WITHDRAW_FEE_PERCENT, feeAmount, netAmount, fromSwap, fromDeposit, new Date(created).toISOString(), new Date(created + WITHDRAW_COOLDOWN_MS).toISOString()]);
  const w = mapWithdrawal(row);
  await addLedger(c, u.id, "withdrawal_hold", amount, "USDT", { withdrawalId: w.id });
  await addLedger(c, u.id, "withdrawal_fee", feeAmount, "USDT", { withdrawalId: w.id, feePercent: WITHDRAW_FEE_PERCENT });
  await saveUser(c, u);
  return { ok: true, message: `Withdrawal request submitted. A ${WITHDRAW_FEE_PERCENT}% fee (${feeAmount.toFixed(6)} USDT) applies. You will receive ${netAmount.toFixed(6)} USDT within 24 hours.`, user: await publicUser(c, u), withdrawal: w };
}));

// ───────────────────────────── HTTP: admin API (X-Admin-Key) ─────────────────────────────
async function tableCounts(c) {
  const n = async t => Number((await rowOf(c, `SELECT COUNT(*) AS n FROM ${t}`)).n);
  return { users: await n("users"), subscriptions: await n("subscriptions"), deposits: await n("deposits"), withdrawals: await n("withdrawals"), taskClaims: await n("task_claims"), ledger: await n("ledger") };
}

// Since v2.0 the legacy data is imported automatically on first start, so this only reports the status.
app.post("/api/admin/run-migration-once", admin(async (req, c) => {
  const flag = await rowOf(c, "SELECT value FROM app_state WHERE key = 'legacy_import'");
  const info = flag ? parseJson(flag.value, {}) : {};
  return { ok: true, message: `The database already runs on relational tables${info.source === "legacy_blob" ? ` (old data was imported automatically at ${info.at})` : ""}. Nothing to migrate.`, counts: await tableCounts(c) };
}));

// Copies the whole database (as a backup-format blob) into ANOTHER empty Postgres database, e.g. when moving to a new provider.
// Afterwards set DATABASE_URL to the new string and redeploy.
app.post("/api/admin/copy-to-neon", raw(async req => {
  requireAdmin(req);
  const targetUrl = String(req.body?.connectionString || "").trim();
  if (!targetUrl) throw httpError(400, "Paste the target Postgres connection string first.");
  if (!/^postgres(ql)?:\/\//.test(targetUrl)) throw httpError(400, "That doesn't look like a valid Postgres connection string.");
  const targetPool = createPool(targetUrl);
  try {
    await targetPool.query(fs.readFileSync(SCHEMA_FILE, "utf8"));
    const blob = await exportBlob(pool);
    const client = await targetPool.connect();
    try {
      const result = await migrateBlob(client, blob);
      if (result.skipped) throw httpError(400, `The target database already contains ${result.existing} users. Use an EMPTY database.`);
      await client.query("INSERT INTO app_state (key, value) VALUES ('legacy_import', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [JSON.stringify({ source: "copy", at: nowIso() })]);
      return { ok: true, message: "Database copied successfully. Now update DATABASE_URL in Render's environment variables to this same connection string and redeploy - only then will the app actually start using it.", counts: result.counts };
    } finally { client.release(); }
  } catch (e) { if (e.status) throw e; throw httpError(500, "Copy failed: " + e.message); }
  finally { await targetPool.end().catch(() => {}); }
}));

// Full backup download in the legacy blob format (it can be re-imported with migrate-to-relational.js --file). For regular
// disaster recovery also enable your provider's automatic backups / point-in-time recovery (Neon, Render, Supabase all offer it).
app.get("/api/admin/backup/export", async (req, res) => {
  try {
    requireAdmin(req);
    const blob = await exportBlob(pool);
    res.setHeader("Content-Disposition", `attachment; filename="cjp-backup-${dayKey()}.json"`);
    res.setHeader("Content-Type", "application/json");
    res.send(JSON.stringify(blob));
  } catch (e) { fail(res, e); }
});

app.get("/api/admin/stats", admin(async (req, c) => {
  const t = await rowOf(c, "SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN vip_level > 0 THEN 1 ELSE 0 END), 0) AS vip, COALESCE(SUM(cjp_balance), 0) AS cjp, COALESCE(SUM(usdt_balance), 0) AS usdt FROM users");
  const pd = await rowOf(c, "SELECT COUNT(*) AS n FROM deposits WHERE status = 'pending'");
  const pw = await rowOf(c, "SELECT COUNT(*) AS n FROM withdrawals WHERE status = 'processing'");
  const pc = await rowOf(c, "SELECT COUNT(*) AS n FROM coin_withdrawals WHERE status = 'processing'");
  const cb = await rowOf(c, "SELECT COALESCE(SUM(coin_balance), 0) AS n FROM users");
  return { totalUsers: Number(t.total), vipUsers: Number(t.vip), cjpInCirculation: Number(t.cjp), usdtBalances: Number(t.usdt), pendingDeposits: Number(pd.n), pendingWithdrawals: Number(pw.n), pendingCoinWithdrawals: Number(pc.n), coinBalances: Number(cb.n), settings: await getSettings(c) };
}));

app.get("/api/admin/settings", admin((req, c) => getSettings(c)));
app.post("/api/admin/settings", admin(async (req, c) => {
  const b = req.body || {};
  for (const k of Object.keys(DEFAULT_SETTINGS)) {
    if (typeof b[k] === "boolean") await c.query("INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [k, JSON.stringify(b[k])]);
  }
  return { ok: true, settings: await getSettings(c) };
}));

app.get("/api/admin/referral-leaderboard", admin(async (req, c) => {
  const current = [];
  for (const r of (await currentBoard(c)).slice(0, 10)) { const nm = await memberName(c, r.id); current.push({ id: r.id, name: nm?.firstName || "", username: nm?.username || "", count: r.count }); }
  const history = [];
  for (const h of (await rowsOf(c, "SELECT * FROM ref_leaderboard_history ORDER BY month DESC LIMIT 12"))) {
    const winners = [];
    for (const w of parseJson(h.winners, [])) { const nm = await memberName(c, w.userId); winners.push({ ...w, name: nm?.firstName || w.name }); }
    history.push({ month: h.month, winners, skipped: h.skipped === true || h.skipped === 1, settledAt: iso(h.settled_at) });
  }
  return { month: monthKeyOf(Date.now()), rewards: REF_LB_REWARDS_POINTS, rewardUnit: "points", minReferrals: REF_LB_MIN_REFERRALS, current, history };
}));

app.get("/api/admin/users", admin(async (req, c) => {
  const q = String(req.query.q || "").trim().toLowerCase();
  const like = `%${q.replace(/[\\%_]/g, m => "\\" + m)}%`;
  const rows = await rowsOf(c, `SELECT * FROM users WHERE (CAST($1 AS TEXT) = '' OR CAST(id AS TEXT) LIKE $2 ESCAPE '\\' OR LOWER(username) LIKE $2 ESCAPE '\\' OR LOWER(first_name) LIKE $2 ESCAPE '\\') ORDER BY id DESC LIMIT 100`, [q, like]);
  return rows.map(mapUser).map(u => ({ id: u.id, username: u.username, firstName: u.firstName, cjpBalance: money(u.cjpBalance), usdtBalance: money(u.usdtBalance),
    depositUsdtBalance: money(u.depositUsdtBalance), swapUsdtBalance: money(u.swapUsdtBalance), vipLevel: currentVipLevel(u),
    referralCount: Number(u.referralCount || 0), isBlocked: Boolean(u.isBlocked), createdAt: u.createdAt }));
}));

// Only fields that actually changed are applied (a stale form can't overwrite fresh balances; unchanged VIP never closes a subscription).
app.post("/api/admin/users/:id/update", admin(async (req, c) => {
  const uid = parseId(req.params.id);
  const row = await rowOf(c, "SELECT * FROM users WHERE id = $1 FOR UPDATE", [uid]);
  if (!row) throw httpError(404, "User not found");
  const u = mapUser(row);
  const b = req.body || {};
  const LIMIT = 1e12;
  if (b.cjpBalance !== undefined) {
    const v = money(Number(b.cjpBalance));
    if (!Number.isFinite(v) || v < 0 || v > LIMIT) throw httpError(400, "Invalid CJP balance");
    const old = money(u.cjpBalance);
    if (v !== old) { u.cjpBalance = v; await addLedger(c, u.id, "admin_balance_edit", money(v - old), "CJP", { old, newValue: v }); }
  }
  if (b.usdtBalance !== undefined) {
    const v = money(Number(b.usdtBalance));
    if (!Number.isFinite(v) || v < 0 || v > LIMIT) throw httpError(400, "Invalid USDT balance");
    const old = money(u.usdtBalance); const delta = money(v - old);
    if (delta !== 0) {
      u.usdtBalance = v;
      if (delta > 0) u.depositUsdtBalance = money(u.depositUsdtBalance + delta);
      else { const take = Math.min(money(u.swapUsdtBalance), -delta); u.swapUsdtBalance = money(u.swapUsdtBalance - take); u.depositUsdtBalance = Math.max(0, money(u.depositUsdtBalance - (-delta - take))); }
      await addLedger(c, u.id, "admin_balance_edit", delta, "USDT", { old, newValue: v });
    }
  }
  if (b.vipLevel !== undefined) {
    const level = Number(b.vipLevel);
    if (!Number.isInteger(level) || level < 0 || level > 5) throw httpError(400, "VIP level must be 0-5");
    if (level !== currentVipLevel(u)) {
      await c.query("UPDATE subscriptions SET status = 'upgraded', upgraded_at = $2 WHERE user_id = $1 AND status = 'active'", [u.id, nowIso()]); // an admin-set level must not coexist with an old subscription
      u.vipLevel = level; u.vipPaidUsdt = 0; u.activeSubscriptionId = null;
      u.vipStartedAt = level > 0 ? (u.vipStartedAt || nowIso()) : null;
      await addLedger(c, u.id, "admin_vip_change", level, "VIP", { level });
    }
  }
  await saveUser(c, u);
  return { ok: true, user: { id: u.id, cjpBalance: money(u.cjpBalance), usdtBalance: money(u.usdtBalance), vipLevel: currentVipLevel(u) } };
}));

async function setBlocked(c, uidParam, blocked) {
  const uid = parseId(uidParam);
  const row = await rowOf(c, "SELECT id FROM users WHERE id = $1 FOR UPDATE", [uid]);
  if (!row) throw httpError(404, "User not found");
  await c.query("UPDATE users SET is_blocked = $2, blocked_at = $3 WHERE id = $1", [uid, blocked, blocked ? nowIso() : null]);
  await addLedger(c, uid, blocked ? "admin_block_user" : "admin_unblock_user", 0, "ACCOUNT", {});
  return { ok: true, message: blocked ? "User blocked." : "User unblocked." };
}
app.post("/api/admin/users/:id/block", admin((req, c) => setBlocked(c, req.params.id, true)));
app.post("/api/admin/users/:id/unblock", admin((req, c) => setBlocked(c, req.params.id, false)));

app.get("/api/admin/deposits", admin(async (req, c) => {
  const rows = await rowsOf(c, `SELECT d.*, u.username AS u_username, u.first_name AS u_first_name FROM deposits d LEFT JOIN users u ON u.id = d.user_id
    WHERE d.status = 'pending' ORDER BY d.id DESC LIMIT 200`);
  return rows.map(r => ({ ...mapDeposit(r), username: r.u_username || "", firstName: r.u_first_name || "" }));
}));
app.post("/api/admin/deposits/:id/approve", admin(async (req, c) => {
  const d = await rowOf(c, "SELECT * FROM deposits WHERE id = $1 FOR UPDATE", [parseId(req.params.id)]);
  if (!d) throw httpError(404, "Deposit not found");
  if (d.status !== "pending") throw httpError(400, "Deposit already processed");
  await c.query("UPDATE deposits SET status = 'verified', verified_at = $2 WHERE id = $1", [d.id, nowIso()]);
  await creditUsdtById(c, d.user_id, d.amount, "deposit_verified", { depositId: Number(d.id), network: d.network, txHash: d.tx_hash });
  return { ok: true, message: "Deposit verified and USDT credited." };
}));
app.post("/api/admin/deposits/:id/reject", admin(async (req, c) => {
  const d = await rowOf(c, "SELECT * FROM deposits WHERE id = $1 FOR UPDATE", [parseId(req.params.id)]);
  if (!d) throw httpError(404, "Deposit not found");
  if (d.status !== "pending") throw httpError(400, "Deposit already processed");
  await c.query("UPDATE deposits SET status = 'rejected', rejected_at = $2 WHERE id = $1", [d.id, nowIso()]);
  return { ok: true, message: "Deposit rejected." };
}));

app.get("/api/admin/withdrawals", admin(async (req, c) => {
  const rows = await rowsOf(c, `SELECT w.*, u.username AS u_username, u.first_name AS u_first_name FROM withdrawals w LEFT JOIN users u ON u.id = w.user_id
    WHERE w.status = 'processing' ORDER BY w.id DESC`);
  return rows.map(r => ({ ...mapWithdrawal(r), username: r.u_username || "", firstName: r.u_first_name || "" }));
}));
app.post("/api/admin/withdrawals/:id/complete", admin(async (req, c) => {
  const wid = parseId(req.params.id);
  const txHash = String(req.body?.txHash || "").trim();
  const w = await rowOf(c, "SELECT * FROM withdrawals WHERE id = $1 FOR UPDATE", [wid]);
  if (!w) throw httpError(404, "Withdrawal not found");
  if (w.status !== "processing") throw httpError(400, "Withdrawal is already processed");
  if (!TX_RE.test(txHash)) throw httpError(400, "Enter the real payout transaction hash (required for the public Proof of Payouts page).");
  await c.query("UPDATE withdrawals SET status = 'completed', tx_hash = $2, completed_at = $3 WHERE id = $1", [wid, txHash, nowIso()]);
  return { ok: true, message: "Withdrawal marked completed." };
}));
app.post("/api/admin/withdrawals/:id/reject", admin(async (req, c) => {
  const w = await rowOf(c, "SELECT * FROM withdrawals WHERE id = $1 FOR UPDATE", [parseId(req.params.id)]);
  if (!w) throw httpError(404, "Withdrawal not found");
  if (w.status !== "processing") throw httpError(400, "Withdrawal already processed");
  if (!await rowOf(c, "SELECT id FROM users WHERE id = $1 FOR UPDATE", [w.user_id])) throw httpError(404, "User not found");
  await c.query("UPDATE withdrawals SET status = 'rejected', rejected_at = $2 WHERE id = $1", [w.id, nowIso()]);
  await c.query("UPDATE users SET usdt_balance = usdt_balance + $2, swap_usdt_balance = swap_usdt_balance + $3, deposit_usdt_balance = deposit_usdt_balance + $4 WHERE id = $1",
    [w.user_id, money(w.amount), money(w.source_swap_usdt), money(w.source_deposit_usdt)]);
  await addLedger(c, w.user_id, "withdrawal_refund", w.amount, "USDT", { withdrawalId: Number(w.id) });
  return { ok: true, message: "Withdrawal rejected and amount returned to the member's USDT balance." };
}));

app.get("/api/admin/completed-withdrawals", admin(async (req, c) => {
  const rows = await rowsOf(c, `SELECT w.*, u.username AS u_username, u.first_name AS u_first_name FROM withdrawals w LEFT JOIN users u ON u.id = w.user_id
    WHERE w.status = 'completed' ORDER BY w.completed_at DESC, w.id DESC LIMIT 100`);
  return rows.map(r => ({ ...mapWithdrawal(r), username: r.u_username || "", firstName: r.u_first_name || "" }));
}));
app.post("/api/admin/withdrawals/:id/toggle-proof", admin(async (req, c) => {
  const r = await rowOf(c, "UPDATE withdrawals SET hidden_from_proof = NOT hidden_from_proof WHERE id = $1 RETURNING hidden_from_proof", [parseId(req.params.id)]);
  if (!r) throw httpError(404, "Withdrawal not found");
  const hidden = bool(r.hidden_from_proof);
  return { ok: true, hidden, message: hidden ? "Removed from Proof of Payouts page." : "Restored to Proof of Payouts page." };
}));

// ───────── Admin: CJP coin withdrawals (paid out manually from your Tonkeeper wallet, then marked completed with the tx hash) ─────────
app.get("/api/admin/coin-withdrawals", admin(async (req, c) => {
  const rows = await rowsOf(c, `SELECT w.*, u.username AS u_username, u.first_name AS u_first_name FROM coin_withdrawals w LEFT JOIN users u ON u.id = w.user_id
    WHERE w.status = 'processing' ORDER BY w.id`);
  return rows.map(r => ({ ...mapCoinWithdrawal(r), username: r.u_username || "", firstName: r.u_first_name || "" }));
}));
app.post("/api/admin/coin-withdrawals/:id/complete", admin(async (req, c) => {
  const wid = parseId(req.params.id), txHash = String(req.body?.txHash || "").trim();
  const w = await rowOf(c, "SELECT * FROM coin_withdrawals WHERE id = $1 FOR UPDATE", [wid]);
  if (!w) throw httpError(404, "Withdrawal not found");
  if (w.status !== "processing") throw httpError(400, "Withdrawal is already processed");
  if (!TX_RE.test(txHash)) throw httpError(400, "Enter the real transaction hash of your payout.");
  await c.query("UPDATE coin_withdrawals SET status = 'completed', tx_hash = $2, completed_at = $3 WHERE id = $1", [wid, txHash, nowIso()]);
  return { ok: true, message: "Coin withdrawal marked completed." };
}));
app.post("/api/admin/coin-withdrawals/:id/reject", admin(async (req, c) => {
  const w = await rowOf(c, "SELECT * FROM coin_withdrawals WHERE id = $1 FOR UPDATE", [parseId(req.params.id)]);
  if (!w) throw httpError(404, "Withdrawal not found");
  if (w.status !== "processing") throw httpError(400, "Withdrawal already processed");
  if (!await rowOf(c, "SELECT id FROM users WHERE id = $1 FOR UPDATE", [w.user_id])) throw httpError(404, "User not found");
  await c.query("UPDATE coin_withdrawals SET status = 'rejected', rejected_at = $2 WHERE id = $1", [w.id, nowIso()]);
  await c.query("UPDATE users SET coin_balance = coin_balance + $2 WHERE id = $1", [w.user_id, money(w.amount)]);
  await addLedger(c, w.user_id, "coin_withdrawal_refund", w.amount, "COIN", { withdrawalId: Number(w.id) });
  return { ok: true, message: "Coin withdrawal rejected and the coins were returned to the member." };
}));

// Static allow-list route (registered last so every specific route above wins).
app.get("/:file", (req, res, next) => {
  if (!PUBLIC_FILES.has(req.params.file)) return next();
  sendFile(res, req.params.file);
});

// ───────────────────────────── Startup / shutdown ─────────────────────────────
let server = null;
async function shutdown(signal) {
  console.log(`${signal} received - shutting down...`);
  try {
    if (server) { server.closeIdleConnections?.(); await Promise.race([new Promise(r => server.close(r)), new Promise(r => setTimeout(r, 5000))]); }
    if (pool) await pool.end();
  } catch (e) { console.error("Shutdown error:", e.message); }
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", e => console.error("Unhandled rejection:", e));

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set. Since v2.0 the app stores everything in PostgreSQL (use Render Postgres, Neon, Supabase or a local Postgres).");
  pool = createPool(process.env.DATABASE_URL);
  const boot = await bootstrap(pool, { forceReimport: process.env.FORCE_REIMPORT === "true" });
  console.log("Database ready:", boot.status);
  await pool.query("INSERT INTO app_state (key, value) VALUES ('ref_lb_last_settled', $1) ON CONFLICT DO NOTHING", [JSON.stringify(prevMonthKey(monthKeyOf(Date.now())))]);
  try { await settleReferralMonths(); } catch (e) { console.error("Referral settlement failed:", e.message); }
  setInterval(() => settleReferralMonths().catch(e => console.error("Referral settlement failed:", e.message)), 60 * 60 * 1000).unref();
  server = app.listen(PORT, "0.0.0.0", () => console.log(`Cjpearnigbot running on port ${PORT}`));
}
main().catch(err => { console.error("Startup failed:", err.message || err); process.exit(1); });

module.exports = { getPool: () => pool };
