// Postgres access layer: pool, transactions, row mappers, schema bootstrap and the one-time import of the old JSONB blob.
const fs = require("fs");
const path = require("path");
const { Pool, types } = require("pg");

// pg returns BIGINT/NUMERIC as strings by default. Ids stay far below 2^53 and money has 6 decimals, so Number is exact enough
// (every money write is rounded with money() before it is stored).
types.setTypeParser(20, v => Number(v));      // BIGINT / COUNT(*)
types.setTypeParser(1700, v => Number(v));    // NUMERIC
types.setTypeParser(1082, v => v);            // DATE stays 'YYYY-MM-DD'

const SCHEMA_FILE = path.join(__dirname, "schema.sql");
const nowIso = () => new Date().toISOString();
const money = n => { const v = Number(n || 0); return Math.round(v * 1e6) / 1e6; };
const iso = v => (v == null || v === "" ? null : v instanceof Date ? v.toISOString() : new Date(v).toISOString());
const dateStr = v => (v == null || v === "" ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
const bool = v => v === true || v === 1 || v === "t" || v === "true" || v === "1";
function parseJson(v, fallback = null) {
  if (v == null) return fallback;
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch { return v; }
}

function createPool(connectionString) {
  return new Pool({
    connectionString, max: Number(process.env.DB_POOL_MAX || 10),
    ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false }
  });
}

// Runs fn(client) in one transaction. Retries once on a deadlock (40P01) / serialization failure (40001).
async function withTx(pool, fn) {
  for (let attempt = 1; ; attempt++) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const out = await fn(client);
      await client.query("COMMIT");
      return out;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      if (attempt < 3 && (e.code === "40P01" || e.code === "40001")) continue;
      throw e;
    } finally { client.release(); }
  }
}

// ───────────── Row mappers (snake_case rows -> the camelCase objects the app logic and the client use) ─────────────
function mapUser(r) {
  if (!r) return null;
  return {
    id: Number(r.id), username: r.username || "", firstName: r.first_name || "", createdAt: iso(r.created_at),
    referralCode: r.referral_code || null, referredBy: r.referred_by == null ? null : Number(r.referred_by), referralCount: Number(r.referral_count || 0),
    refBonusCjp: Number(r.ref_bonus_cjp || 0), refCommissionCjp: Number(r.ref_commission_cjp || 0),
    cjpBalance: Number(r.cjp_balance || 0), usdtBalance: Number(r.usdt_balance || 0),
    depositUsdtBalance: Number(r.deposit_usdt_balance || 0), swapUsdtBalance: Number(r.swap_usdt_balance || 0),
    lastDaily: iso(r.last_daily), lastDailyDay: dateStr(r.last_daily_day), dailyStreak: Number(r.daily_streak || 0),
    lastMineDay: dateStr(r.last_mine_day), spinDay: dateStr(r.spin_day), spinCount: Number(r.spin_count || 0), bonusSpins: Number(r.bonus_spins || 0),
    vipLevel: Number(r.vip_level || 0), vipStartedAt: iso(r.vip_started_at), vipPaidUsdt: Number(r.vip_paid_usdt || 0),
    activeSubscriptionId: r.active_subscription_id == null ? null : Number(r.active_subscription_id),
    isBlocked: bool(r.is_blocked), blockedAt: iso(r.blocked_at),
    lastMineAt: iso(r.last_mine_at), coinBalance: Number(r.coin_balance || 0), lastCoinClaimDay: dateStr(r.last_coin_claim_day), lastVipUsdtDay: dateStr(r.last_vip_usdt_day)
  };
}
function mapCoinExchange(r) {
  return { id: Number(r.id), userId: Number(r.user_id), points: Number(r.points), coinsTotal: Number(r.coins_total), claimedCoins: Number(r.claimed_coins || 0),
    startAt: iso(r.start_at), endAt: iso(r.end_at), status: r.status };
}
function mapCoinWithdrawal(r) {
  return { id: Number(r.id), userId: Number(r.user_id), address: r.address, amount: Number(r.amount), status: r.status, txHash: r.tx_hash || null,
    createdAt: iso(r.created_at), completedAt: iso(r.completed_at), rejectedAt: iso(r.rejected_at) };
}
function mapSubscription(r) {
  return { id: Number(r.id), userId: Number(r.user_id), level: Number(r.level), priceUsdt: Number(r.price_usdt), startedAt: iso(r.started_at), expiresAt: null, permanent: true,
    status: r.status, upgradedAt: iso(r.upgraded_at), refunded: bool(r.refunded), refundAmount: r.refund_amount == null ? null : Number(r.refund_amount), refundedAt: iso(r.refunded_at) };
}
function mapDeposit(r) {
  return { id: Number(r.id), userId: Number(r.user_id), network: r.network, txHash: r.tx_hash, amount: Number(r.amount), status: r.status,
    createdAt: iso(r.created_at), verifiedAt: iso(r.verified_at), rejectedAt: iso(r.rejected_at) };
}
function mapWithdrawal(r) {
  return { id: Number(r.id), userId: Number(r.user_id), network: r.network, address: r.address, amount: Number(r.amount),
    feePercent: Number(r.fee_percent), feeAmount: Number(r.fee_amount), netAmount: Number(r.net_amount), status: r.status, txHash: r.tx_hash || null,
    sourceSwapUsdt: Number(r.source_swap_usdt || 0), sourceDepositUsdt: Number(r.source_deposit_usdt || 0), hiddenFromProof: bool(r.hidden_from_proof),
    createdAt: iso(r.created_at), availableAt: iso(r.available_at), completedAt: iso(r.completed_at), rejectedAt: iso(r.rejected_at) };
}

// Persists every column the app logic changes. Referral counters (referral_count / ref_*) are deliberately NOT written here:
// they only change through atomic SQL increments, so an in-memory copy can never overwrite them.
const SAVE_USER_SQL = `UPDATE users SET username = $2, first_name = $3, cjp_balance = $4, usdt_balance = $5, deposit_usdt_balance = $6, swap_usdt_balance = $7,
  last_daily = $8, last_daily_day = $9, daily_streak = $10, last_mine_day = $11, spin_day = $12, spin_count = $13, bonus_spins = $14,
  vip_level = $15, vip_started_at = $16, vip_paid_usdt = $17, active_subscription_id = $18, is_blocked = $19, blocked_at = $20,
  last_mine_at = $21, coin_balance = $22, last_coin_claim_day = $23, last_vip_usdt_day = $24 WHERE id = $1`;
async function saveUser(c, u) {
  await c.query(SAVE_USER_SQL, [u.id, u.username || "", u.firstName || "", money(u.cjpBalance), money(u.usdtBalance), money(u.depositUsdtBalance), money(u.swapUsdtBalance),
    u.lastDaily, u.lastDailyDay, u.dailyStreak, u.lastMineDay, u.spinDay, u.spinCount, Math.max(0, Math.floor(u.bonusSpins || 0)),
    u.vipLevel, u.vipStartedAt, money(u.vipPaidUsdt), u.activeSubscriptionId, !!u.isBlocked, u.blockedAt,
    u.lastMineAt, money(u.coinBalance), u.lastCoinClaimDay, u.lastVipUsdtDay]);
}

// ───────────── Boot: schema + one-time import of the legacy JSONB blob ─────────────
const LEGACY_FLAG = "legacy_import";
async function readLegacyBlob(pool) {
  try { return parseJson((await pool.query("SELECT data FROM cjp_app_state WHERE id = 1")).rows[0]?.data, null); }
  catch (e) { if (e.code === "42P01") return null; throw e; } // 42P01 = table does not exist (fresh install)
}
async function setFlag(c, value) {
  await c.query("INSERT INTO app_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [LEGACY_FLAG, JSON.stringify(value)]);
}

async function bootstrap(pool, { forceReimport = false, log = console.log } = {}) {
  await pool.query(fs.readFileSync(SCHEMA_FILE, "utf8"));
  const flag = (await pool.query("SELECT value FROM app_state WHERE key = $1", [LEGACY_FLAG])).rows[0];
  if (flag) return { status: "ready", ...parseJson(flag.value, {}) };

  const legacy = await readLegacyBlob(pool);          // read outside the transaction: a missing table must not abort it
  const { migrateBlob } = require("./migration-core"); // lazy: migration-core also uses this module's mappers
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(727001)"); // two instances starting together: only one imports
    const again = (await client.query("SELECT value FROM app_state WHERE key = $1", [LEGACY_FLAG])).rows[0];
    if (again) { await client.query("COMMIT"); return { status: "ready", ...parseJson(again.value, {}) }; }
    const existing = Number((await client.query("SELECT COUNT(*) AS n FROM users")).rows[0].n);
    if (!legacy) {
      await setFlag(client, { source: "fresh", at: nowIso() });
      await client.query("COMMIT");
      return { status: "fresh" };
    }
    if (existing > 0 && !forceReimport) {
      await client.query("ROLLBACK");
      throw new Error(`The relational tables already contain ${existing} users, but the old cjp_app_state data was never imported by this version. ` +
        "They probably come from an earlier test migration and may be stale. Start once with FORCE_REIMPORT=true to wipe the relational tables and import cjp_app_state again, then remove the variable.");
    }
    await client.query("COMMIT");
  } catch (e) { await client.query("ROLLBACK").catch(() => {}); throw e; }
  finally { client.release(); }

  // Import (migrateBlob runs in its own transaction on a dedicated connection).
  const c2 = await pool.connect();
  try {
    log(`Importing legacy data from cjp_app_state${forceReimport ? " (FORCE_REIMPORT: relational tables are replaced)" : ""}...`);
    const result = await migrateBlob(c2, legacy, { log, replace: forceReimport });
    if (result.skipped) throw new Error(`Import skipped: users table already has ${result.existing} rows.`);
    await c2.query("BEGIN");
    await setFlag(c2, { source: "legacy_blob", at: nowIso(), counts: result.counts, warnings: result.warnings });
    await c2.query("COMMIT");
    log("Legacy import complete:", JSON.stringify(result.counts), result.warnings.length ? `(${result.warnings.length} warnings)` : "");
    result.warnings.slice(0, 20).forEach(w => log("  warning:", w));
    return { status: "imported", counts: result.counts };
  } finally { c2.release(); }
}

module.exports = { createPool, withTx, bootstrap, saveUser, mapUser, mapCoinExchange, mapCoinWithdrawal, mapSubscription, mapDeposit, mapWithdrawal, nowIso, money, iso, dateStr, bool, parseJson, SCHEMA_FILE };
