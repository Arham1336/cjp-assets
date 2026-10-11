// Legacy JSONB blob  <->  relational tables.
//  - normalizeLegacy(blob): the one-time clean-up the old server ran on every load (legacy VIP -> permanent, counters, createdAt...).
//  - migrateBlob(client, blob): imports a blob into EMPTY relational tables in one transaction (used for the boot-time import,
//    the CLI, backup restore and "copy to another database").
//  - exportBlob(client): dumps the relational tables back into the same blob shape (admin backup download).
const { mapUser, mapSubscription, mapDeposit, mapWithdrawal, mapCoinExchange, mapCoinWithdrawal, parseJson, iso, money } = require("./db");

const SETTING_KEYS = ["channelJoinEnabled", "dailyCheckinEnabled", "miningEnabled", "gamesEnabled", "referralLeaderboardEnabled", "vipDailyUsdtEnabled", "coinExchangeEnabled"];
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const ts = v => { if (!v) return null; const t = new Date(v); return Number.isNaN(t.getTime()) ? null : t.toISOString(); };
const monthKeyOf = ms => new Date(ms).toISOString().slice(0, 7);
const prevMonthKey = key => { const [y, m] = key.split("-").map(Number); return monthKeyOf(Date.UTC(y, m - 2, 1)); };

function normalizeLegacy(d) {
  const users = d?.users || {};
  const subscriptions = d?.subscriptions || [];
  const ledger = d?.ledger || [];
  const nowStamp = new Date().toISOString();

  // Legacy active subscriptions -> permanent. Members who stacked several levels keep only their highest (upgrade-only model).
  const activeByUser = {};
  for (const s of subscriptions) {
    if (s.status !== "active") continue;
    if (s.expiresAt) { s.expiresAt = null; s.permanent = true; }
    (activeByUser[s.userId] = activeByUser[s.userId] || []).push(s);
  }
  for (const [userId, subs] of Object.entries(activeByUser)) {
    const highest = subs.reduce((a, b) => (Number(a.level) >= Number(b.level) ? a : b));
    subs.forEach(s => { if (s.id !== highest.id) { s.status = "upgraded"; s.upgradedAt = s.upgradedAt || nowStamp; } });
    const u = users[String(userId)];
    if (u) {
      if (Number(u.vipLevel || 0) < Number(highest.level)) u.vipLevel = Number(highest.level);
      if (!u.activeSubscriptionId) u.activeSubscriptionId = highest.id;
    }
  }

  const signupAt = {}, refBonus = {}, refComm = {};
  for (const l of ledger) {
    if (l.type === "signup_bonus" && !signupAt[l.userId]) signupAt[l.userId] = l.createdAt;
    else if (l.type === "referral_signup_bonus") refBonus[l.userId] = (refBonus[l.userId] || 0) + Number(l.amount || 0);
    else if (l.type === "referral_commission") refComm[l.userId] = (refComm[l.userId] || 0) + Number(l.amount || 0);
  }
  const paidByUser = {};
  for (const s of subscriptions) if (s.status === "active") paidByUser[s.userId] = money((paidByUser[s.userId] || 0) + money(s.priceUsdt));

  for (const u of Object.values(users)) {
    if (u.depositUsdtBalance == null && u.swapUsdtBalance == null) { u.depositUsdtBalance = 0; u.swapUsdtBalance = money(u.usdtBalance); }
    else { u.depositUsdtBalance = money(u.depositUsdtBalance); u.swapUsdtBalance = money(u.swapUsdtBalance); }
    u.usdtBalance = money(u.usdtBalance);
    u.vipLevel = Number(u.vipLevel) > 0 ? Math.min(5, Number(u.vipLevel)) : 0;
    if (u.vipPaidUsdt == null) u.vipPaidUsdt = paidByUser[u.id] || 0;
    if (!u.createdAt) u.createdAt = signupAt[u.id] || null;
    if (u.refBonusCjp == null) u.refBonusCjp = money(refBonus[u.id]);
    if (u.refCommissionCjp == null) u.refCommissionCjp = money(refComm[u.id]);
    u.spinCount = Number(u.spinCount || 0);
    u.bonusSpins = Math.max(0, Math.floor(Number(u.bonusSpins || 0)));
  }
  const settings = { ...(d?.settings || {}) };
  delete settings.adsEnabled;
  return {
    users, subscriptions, withdrawals: d?.withdrawals || [], deposits: d?.deposits || [], taskClaims: d?.taskClaims || [], ledger, settings,
    coinExchanges: d?.coinExchanges || [], coinWithdrawals: d?.coinWithdrawals || [],
    refLeaderboard: {
      lastSettled: d?.refLeaderboard?.lastSettled || prevMonthKey(monthKeyOf(Date.now())),
      history: Array.isArray(d?.refLeaderboard?.history) ? d.refLeaderboard.history : []
    }
  };
}

// Multi-row INSERT in batches. Returns the number of rows actually inserted (rows skipped by ON CONFLICT DO NOTHING are not counted).
async function bulkInsert(client, table, cols, rows, suffix = "") {
  if (!rows.length) return 0;
  const size = Math.max(1, Math.min(500, Math.floor(30000 / cols.length)));
  let inserted = 0;
  for (let i = 0; i < rows.length; i += size) {
    const params = [];
    const tuples = rows.slice(i, i + size).map(r => `(${r.map(v => { params.push(v); return "$" + params.length; }).join(",")})`);
    const res = await client.query(`INSERT INTO ${table} (${cols.join(",")}) VALUES ${tuples.join(",")} ${suffix}`, params);
    inserted += res.rowCount;
  }
  return inserted;
}

async function clearTables(client) {
  for (const t of ["coin_withdrawals", "coin_exchanges", "ledger", "task_claims", "deposits", "withdrawals", "subscriptions", "ref_leaderboard_history"]) await client.query(`DELETE FROM ${t}`);
  await client.query("UPDATE users SET referred_by = NULL, active_subscription_id = NULL");
  await client.query("DELETE FROM users");
  await client.query("DELETE FROM app_state WHERE key = 'ref_lb_last_settled'");
}

async function migrateBlob(client, blobIn, opts = {}) {
  const log = opts.log || (() => {});
  const blob = normalizeLegacy(JSON.parse(JSON.stringify(blobIn)));
  const warnings = [];
  await client.query("BEGIN");
  try {
    if (opts.replace) await clearTables(client);
    const existing = Number((await client.query("SELECT COUNT(*) AS n FROM users")).rows[0].n);
    if (existing > 0) { await client.query("ROLLBACK"); return { skipped: true, existing }; }

    const users = Object.values(blob.users);
    const known = new Set(users.map(u => Number(u.id)));
    log(`Importing ${users.length} users...`);
    const userCols = ["id", "username", "first_name", "cjp_balance", "usdt_balance", "deposit_usdt_balance", "swap_usdt_balance", "last_daily", "last_daily_day", "daily_streak",
      "last_mine_day", "spin_day", "spin_count", "bonus_spins", "vip_level", "vip_started_at", "vip_paid_usdt", "is_blocked", "blocked_at", "referral_code", "referral_count",
      "ref_bonus_cjp", "ref_commission_cjp", "last_mine_at", "coin_balance", "last_coin_claim_day", "last_vip_usdt_day", "created_at"];
    const clamp = (u, field) => { const v = num(u[field]); if (v < 0) { warnings.push(`user ${u.id}: negative ${field} (${v}) set to 0`); return 0; } return v; };
    await bulkInsert(client, "users", userCols, users.map(u => [
      Number(u.id), u.username || "", u.firstName || "", clamp(u, "cjpBalance"), clamp(u, "usdtBalance"), clamp(u, "depositUsdtBalance"), clamp(u, "swapUsdtBalance"),
      ts(u.lastDaily), u.lastDailyDay || null, num(u.dailyStreak), u.lastMineDay || null, u.spinDay || null, num(u.spinCount), num(u.bonusSpins),
      num(u.vipLevel), ts(u.vipStartedAt), num(u.vipPaidUsdt), !!u.isBlocked, ts(u.blockedAt), u.referralCode || null, num(u.referralCount),
      num(u.refBonusCjp), num(u.refCommissionCjp), ts(u.lastMineAt), clamp(u, "coinBalance"), u.lastCoinClaimDay || null, u.lastVipUsdtDay || null, ts(u.createdAt) || new Date().toISOString()
    ]));
    // Second pass: all rows exist, so the referred_by foreign key is safe whatever the order was.
    for (const u of users) {
      if (u.referredBy && known.has(Number(u.referredBy)) && Number(u.referredBy) !== Number(u.id)) {
        await client.query("UPDATE users SET referred_by = $1 WHERE id = $2", [Number(u.referredBy), Number(u.id)]);
      }
    }

    const subIdMap = {};
    const subs = blob.subscriptions.filter(s => known.has(Number(s.userId)));
    log(`Importing ${subs.length} subscriptions...`);
    for (const s of subs) { // one by one: we need the new generated id of each subscription
      const r = await client.query(
        `INSERT INTO subscriptions (user_id, level, price_usdt, started_at, status, upgraded_at, refunded, refund_amount, refunded_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [Number(s.userId), Number(s.level), num(s.priceUsdt), ts(s.startedAt) || new Date().toISOString(), s.status || "active", ts(s.upgradedAt),
         !!s.refunded, s.refundAmount != null ? num(s.refundAmount) : null, ts(s.refundedAt)]);
      subIdMap[s.id] = Number(r.rows[0].id);
    }
    for (const u of users) {
      if (u.activeSubscriptionId && subIdMap[u.activeSubscriptionId]) await client.query("UPDATE users SET active_subscription_id = $1 WHERE id = $2", [subIdMap[u.activeSubscriptionId], Number(u.id)]);
    }

    const deposits = blob.deposits.filter(d => known.has(Number(d.userId)));
    log(`Importing ${deposits.length} deposits...`);
    const depInserted = await bulkInsert(client, "deposits", ["user_id", "network", "tx_hash", "amount", "status", "created_at", "verified_at", "rejected_at"],
      deposits.map(d => [Number(d.userId), d.network, String(d.txHash), num(d.amount), d.status || "pending", ts(d.createdAt) || new Date().toISOString(), ts(d.verifiedAt), ts(d.rejectedAt)]),
      "ON CONFLICT DO NOTHING");
    if (depInserted < deposits.length) warnings.push(`${deposits.length - depInserted} deposit row(s) skipped: duplicate transaction hash (case-insensitive)`);

    const withdrawals = blob.withdrawals.filter(w => known.has(Number(w.userId)));
    log(`Importing ${withdrawals.length} withdrawals...`);
    await bulkInsert(client, "withdrawals",
      ["user_id", "network", "address", "amount", "fee_percent", "fee_amount", "net_amount", "status", "tx_hash", "source_swap_usdt", "source_deposit_usdt", "hidden_from_proof", "created_at", "available_at", "completed_at", "rejected_at"],
      withdrawals.map(w => [Number(w.userId), w.network, String(w.address), num(w.amount), num(w.feePercent, 5), num(w.feeAmount), num(w.netAmount, num(w.amount)), w.status || "processing",
        w.txHash || null, num(w.sourceSwapUsdt), num(w.sourceDepositUsdt), !!w.hiddenFromProof, ts(w.createdAt) || new Date().toISOString(), ts(w.availableAt) || ts(w.createdAt) || new Date().toISOString(),
        ts(w.completedAt), ts(w.rejectedAt)]));

    const claims = blob.taskClaims.filter(t => known.has(Number(t.userId)));
    log(`Importing ${claims.length} task claims...`);
    const claimsInserted = await bulkInsert(client, "task_claims", ["user_id", "task_id", "created_at"], claims.map(t => [Number(t.userId), String(t.taskId), ts(t.createdAt) || new Date().toISOString()]), "ON CONFLICT DO NOTHING");

    const ledger = blob.ledger.filter(l => known.has(Number(l.userId)));
    log(`Importing ${ledger.length} ledger entries...`);
    await bulkInsert(client, "ledger", ["user_id", "type", "amount", "currency", "meta", "created_at"],
      ledger.map(l => [Number(l.userId), String(l.type), num(l.amount), String(l.currency), JSON.stringify(l.meta || {}), ts(l.createdAt) || new Date().toISOString()]));

    const coinEx = (blob.coinExchanges || []).filter(e => known.has(Number(e.userId)));
    await bulkInsert(client, "coin_exchanges", ["user_id", "points", "coins_total", "claimed_coins", "start_at", "end_at", "status"],
      coinEx.map(e => [Number(e.userId), num(e.points), num(e.coinsTotal), num(e.claimedCoins), ts(e.startAt) || new Date().toISOString(), ts(e.endAt) || new Date().toISOString(), e.status || "active"]));
    const coinWd = (blob.coinWithdrawals || []).filter(w => known.has(Number(w.userId)));
    await bulkInsert(client, "coin_withdrawals", ["user_id", "address", "amount", "status", "tx_hash", "created_at", "completed_at", "rejected_at"],
      coinWd.map(w => [Number(w.userId), String(w.address), num(w.amount), w.status || "processing", w.txHash || null, ts(w.createdAt) || new Date().toISOString(), ts(w.completedAt), ts(w.rejectedAt)]));

    for (const k of SETTING_KEYS) {
      if (typeof blob.settings[k] === "boolean") await client.query("INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [k, JSON.stringify(blob.settings[k])]);
    }
    for (const h of blob.refLeaderboard.history) {
      if (!h?.month) continue;
      await client.query("INSERT INTO ref_leaderboard_history (month, winners, skipped, settled_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING",
        [h.month, JSON.stringify(Array.isArray(h.winners) ? h.winners : []), !!h.skipped, ts(h.settledAt) || new Date().toISOString()]);
    }
    await client.query("INSERT INTO app_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", ["ref_lb_last_settled", JSON.stringify(blob.refLeaderboard.lastSettled)]);

    await client.query("COMMIT");
    return { skipped: false, warnings, counts: { users: users.length, subscriptions: subs.length, deposits: depInserted, withdrawals: withdrawals.length, taskClaims: claimsInserted, ledger: ledger.length, coinExchanges: coinEx.length, coinWithdrawals: coinWd.length } };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  }
}

// Whole database as one legacy-shaped blob (backup download, copy to another database, round-trip tests).
async function exportBlob(client) {
  const all = async sql => (await client.query(sql)).rows;
  const users = {};
  for (const r of await all("SELECT * FROM users ORDER BY id")) users[String(r.id)] = { ...mapUser(r), vipExpiresAt: null };
  const settings = {};
  for (const r of await all("SELECT key, value FROM settings")) settings[r.key] = parseJson(r.value);
  const last = (await client.query("SELECT value FROM app_state WHERE key = 'ref_lb_last_settled'")).rows[0];
  return {
    exportedAt: new Date().toISOString(), format: "cjp-blob-v1",
    users,
    subscriptions: (await all("SELECT * FROM subscriptions ORDER BY id")).map(mapSubscription),
    deposits: (await all("SELECT * FROM deposits ORDER BY id")).map(mapDeposit),
    withdrawals: (await all("SELECT * FROM withdrawals ORDER BY id")).map(mapWithdrawal),
    taskClaims: (await all("SELECT * FROM task_claims ORDER BY id")).map(r => ({ id: Number(r.id), userId: Number(r.user_id), taskId: r.task_id, createdAt: iso(r.created_at) })),
    ledger: (await all("SELECT * FROM ledger ORDER BY id")).map(r => ({ id: Number(r.id), userId: Number(r.user_id), type: r.type, amount: Number(r.amount), currency: r.currency, meta: parseJson(r.meta, {}), createdAt: iso(r.created_at) })),
    settings,
    coinExchanges: (await all("SELECT * FROM coin_exchanges ORDER BY id")).map(mapCoinExchange),
    coinWithdrawals: (await all("SELECT * FROM coin_withdrawals ORDER BY id")).map(mapCoinWithdrawal),
    refLeaderboard: {
      lastSettled: last ? parseJson(last.value) : null,
      history: (await all("SELECT * FROM ref_leaderboard_history ORDER BY month")).map(r => ({ month: r.month, winners: parseJson(r.winners, []), skipped: r.skipped === true || r.skipped === 1, settledAt: iso(r.settled_at) }))
    }
  };
}

// Compares a legacy blob with the relational tables. Meant to be run right after the import (before many members have been active).
async function verifyBlob(client, blobIn) {
  const blob = normalizeLegacy(JSON.parse(JSON.stringify(blobIn)));
  const issues = [];
  const rows = (await client.query("SELECT * FROM users")).rows.map(mapUser);
  const byId = new Map(rows.map(u => [u.id, u]));
  const users = Object.values(blob.users);
  if (rows.length !== users.length) issues.push(`users: ${users.length} in the old data vs ${rows.length} in the tables`);
  const fields = [["cjpBalance", "CJP"], ["usdtBalance", "USDT"], ["depositUsdtBalance", "deposit USDT"], ["swapUsdtBalance", "swap USDT"], ["vipLevel", "VIP level"], ["bonusSpins", "bonus spins"]];
  for (const u of users) {
    const r = byId.get(Number(u.id));
    if (!r) { issues.push(`user ${u.id} is missing in the tables`); continue; }
    for (const [f, label] of fields) {
      const old = ["cjpBalance", "usdtBalance", "depositUsdtBalance", "swapUsdtBalance"].includes(f) ? Math.max(0, Number(u[f] || 0)) : Number(u[f] || 0); // the import clamps negatives to 0
      if (Math.abs(old - Number(r[f] || 0)) > 1e-6) issues.push(`user ${u.id}: ${label} ${u[f]} (old) vs ${r[f]} (new)`);
    }
  }
  const count = async t => Number((await client.query(`SELECT COUNT(*) AS n FROM ${t}`)).rows[0].n);
  const known = new Set(users.map(u => Number(u.id)));
  const expect = { subscriptions: blob.subscriptions.filter(s => known.has(Number(s.userId))).length, withdrawals: blob.withdrawals.filter(w => known.has(Number(w.userId))).length,
    task_claims: new Set(blob.taskClaims.filter(t => known.has(Number(t.userId))).map(t => t.userId + ":" + t.taskId)).size, ledger: blob.ledger.filter(l => known.has(Number(l.userId))).length };
  for (const [t, n] of Object.entries(expect)) { const got = await count(t); if (got !== n) issues.push(`${t}: ${n} in the old data vs ${got} in the tables`); }
  const sum = f => users.reduce((a, u) => a + Number(u[f] || 0), 0);
  const totals = { cjp: money(sum("cjpBalance")), usdt: money(sum("usdtBalance")), dbCjp: money(rows.reduce((a, u) => a + u.cjpBalance, 0)), dbUsdt: money(rows.reduce((a, u) => a + u.usdtBalance, 0)) };
  return { ok: issues.length === 0, issues, totals };
}

module.exports = { verifyBlob, normalizeLegacy, migrateBlob, exportBlob, clearTables, SETTING_KEYS };
