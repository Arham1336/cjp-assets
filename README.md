# CJP Earning Bot

Telegram Mini App for CJP points, a CJP coin (TON Jetton) exchange, permanent VIP, USDT wallet, referrals, deposits and withdrawals.
**v1.1** - rewarded ads removed; Daily Mining + Spin game added; security/bug-fix pass.
**v1.2** - Spin game reworked (12-slot wheel, 1 free spin/day, buy extra spins with CJP), 100% VIP upgrade refund, Monthly Top Referrers (USDT prizes).
**v2.0** - all data now lives in **relational PostgreSQL tables** (no more single JSONB blob): transactions + row locks per request, DB-enforced uniqueness, scalable queries. Existing data is imported automatically on the first start.
**v2.1** - the CJP→USDT swap is gone: **CJP points** can be exchanged for the **CJP coin** (Jetton) with a 90-day release; mining every 8 hours, new VIP levels of mining/spins, daily VIP USDT, USDT spin shop, points-only referral rewards, 5%/2% commission, top-10 leaderboard in points.

## Current rules
**Two currencies inside the app:** *CJP points* (earned everywhere, shown as "points") and the *CJP coin* (a TON Jetton, only obtained by exchanging points). USDT is separate (deposits, VIP purchase, bonuses, withdrawals). Every number below is a constant at the top of `server.js` - edit and redeploy to rebalance.
- **No CJP -> USDT swap any more.** Points can only be exchanged for CJP coin (see below). Existing balances keep their numbers and are now "points".
- **VIP plans:** 10 / 25 / 50 / 100 / 250 USDT, permanent, upgrade-only (buying a higher level refunds **100%** of the previous level's price to the withdrawable USDT balance, `VIP_UPGRADE_REFUND_PERCENT`). Buying VIP needs verified deposited USDT only.
- **Mining:** one claim every **8 hours** (3 per day, a cooldown from your last claim). Non-VIP **100 points** per claim, VIP1 **200**, VIP2 **300**, VIP3 **500**, VIP4 **750**, VIP5 **1,500** (`NON_VIP_MINING_POINTS`, `VIP_PLANS[l].miningPoints`).
- **CJP coin exchange:** members exchange points for coin at **1,000 points = 1 CJP coin**, **minimum 100,000 points** per exchange (`POINTS_PER_COIN`, `COIN_MIN_EXCHANGE_POINTS`). Each exchange locks its points and releases the coins **linearly over 90 days** ("mining in the coin", proportional to the points exchanged); several exchanges can run in parallel. Mined coins can be **claimed once per UTC day** (the rest is released exactly at day 90, no dust).
- **CJP coin withdrawal:** only to a **TON (Tonkeeper) wallet address**, **opens 1 Jan 2027 00:00 UTC** (`COIN_WITHDRAW_OPEN_AT`), minimum 1 coin, one request in "Processing" at a time. Payouts are **manual**: the request appears in Admin > Withdrawals > *CJP Coin Withdrawals*; you send the coins from your wallet and mark it sent with the transaction hash (or reject it to refund the member). No wallet key is ever stored on the server.
- **Referral commission (points only):** the referrer earns **5% if the referrer is VIP, 2% otherwise** on referred members' earnings.
- **Referral tasks (Tasks tab):** VIP referrals - 5 = **1,000 points + 2 USDT**, 10 = **2,500 points + 5 USDT**, 50 = **10,000 points + 30 USDT**. Non-VIP referrals (points only) - 5 = 500, 10 = 1,250, 50 = 5,000 points (`REFERRAL_MILESTONES`; the non-VIP amounts and the USDT part of the VIP tasks are assumptions - edit them).
- **VIP daily USDT (Tasks tab):** a VIP member can claim USDT once per UTC day: plan price x **10% per month**, paid as 1/30 per day (`VIP_DAILY_USDT_MONTHLY_PERCENT`). VIP1 0.033333, VIP5 0.833333 USDT/day. Goes to the withdrawable balance. Admin toggle: *VIP Daily USDT*. Note: this is a fixed return on a deposit (120%/year), see "Business risk" below.
- **Spin game:** free spins per day: non-VIP **1**, VIP1 **2**, VIP2 **3**, VIP3 **5**, VIP4 **7**, VIP5 **10** (reset 00:00 UTC). Extra spins are bought with **USDT: 0.1 per spin, 0.9 for 10** (taken from the withdrawable balance first). Bought spins never expire. 12-slot wheel: 250 (3%) / 10 (20%) / 1,000 (0.4%) / 50 (14%) / 0 (20.2%) / **0.002 USDT (0.8%)** / 150 (4%) / 25 (18%) / 500 (1.5%) / 75 (10%) / 100 (7%) / **0.001 USDT (1.1%)**; point prizes are CJP points. Expected return about 53 points per spin. API: `POST /api/spin`, `POST /api/spin/buy {pack: 1|10}`.
- **Monthly Top Referrers:** the **top 10** members with the most **VIP referrals** in a UTC month win **CJP points**: 1st **10,000**, then 7,000 / 5,000 / 4,000 / 3,000 / 2,000 / 1,500 / 1,000 / 750 / 500 (`REF_LB_REWARDS_POINTS`; ranks 2-10 are placeholders). Winners need at least **5 VIP referrals**. Each referral counts for the month the invited member first became VIP (blocked members never count). Paid automatically after the month ends, once per month. Past USDT prizes stay visible in the history.
- **Daily Check-in:** once per calendar day, day 1 = 10 points, +10 per consecutive day, capped at 300 from day 30. Channel Join and Chat Join: 100 points each (once). Signup: 200 points; the referrer gets 100 points per signup.
- **USDT withdrawal:** VIP only, minimum 0.1 USDT, 5% fee, one request per 24 h and one in "Processing" at a time; address format-checked. **Deposit:** TON / TRC20 / BEP20, minimum 10 USDT, verified by an admin.

### Business risk (please read)
- **Daily USDT = a fixed 10%/month on deposits.** A VIP member gets their price back in 10 months and keeps earning. Payouts are funded by the deposits of later members, which is the structure regulators treat as a high-yield / investment scheme in many countries, and it is not sustainable unless new deposits keep growing. Consider a lifetime cap (for example total claims <= 100-150% of the price), and talk to a lawyer before running it. You can switch it off at any time in the admin Settings.
- **Points inflation:** mining now gives 300 points/day to a non-VIP (was 80) and up to 4,500 to VIP5. Since points convert to the coin at a fixed 1,000:1, size the coin supply from the real emission (see the launch checklist).

## Database (relational since v2.0)
`DATABASE_URL` (PostgreSQL) is **required** - Render Postgres, Neon and Supabase all work. Tables are created automatically from `schema.sql` on every start (idempotent): `users`, `subscriptions`, `deposits`, `withdrawals`, `task_claims`, `ledger`, `settings`, `ref_leaderboard_history`, `app_state`.
- Every request runs in **one transaction** and locks the member's row (`SELECT ... FOR UPDATE`), so parallel taps/requests can never double-claim or lose a balance update. Claims are additionally protected by `UNIQUE (user_id, task_id)`; transaction hashes by a unique index on `lower(tx_hash)`.
- Balances have `CHECK (>= 0)` constraints. Money is `NUMERIC(20,6)`.
- **Several server instances are now safe** (state is no longer held in memory; the monthly leaderboard payout uses an advisory lock).
- `GET /health` also checks the database.

### Cutover from the old JSONB version (one time)
The old `cjp_app_state` table is **never modified**, so it stays as your backup.
1. **Make a backup first**: in your database provider create a snapshot/branch (Neon: create a branch) or run `pg_dump`. Also download the JSON backup from the admin panel of the old version.
2. **Stop the old service** (Render: Suspend) so nobody writes to the old data while you switch. Deploy this version and start it.
3. On its first start the server imports `cjp_app_state` into the tables in a single transaction (log: `Importing legacy data...`, then `Legacy import complete`). If anything fails nothing is changed and the server refuses to start.
4. Run `node migrate-to-relational.js --verify` (Render Shell or locally with `DATABASE_URL`). It compares every member's balances, VIP level and spins with the old data. Expect `OK` right after the import.
5. Open the admin panel > **Database Status** to see the row counts, and test one deposit/spin/mining claim yourself.
- Import warnings (negative balance set to 0, duplicate deposit hash skipped, orphan rows dropped) are printed in the log.
- **If the tables already contain data from an earlier test migration** the server stops with a clear message instead of guessing. Start once with `FORCE_REIMPORT=true` (wipes the relational tables and imports `cjp_app_state` again), then remove the variable.
- **Rollback:** redeploy the previous version; it still reads `cjp_app_state`. Anything members did after the cutover exists only in the tables.

### Backups
- Admin panel > Backup downloads the whole database as one JSON file (same format as the old state). Restore it into an EMPTY database with `node migrate-to-relational.js --file backup.json` (`--replace` wipes the tables first).
- For real disaster recovery also turn on your provider's automatic backups / point-in-time recovery. The old in-database snapshot/restore buttons were removed because they only made sense for the JSON blob.
- Moving to another provider: admin panel > Copy database (target must be an EMPTY Postgres), then change `DATABASE_URL` and redeploy.

### Tests
`npm test` (Node 22+) runs the whole server in-process against an SQLite-backed Postgres stand-in (`tests/pg-shim.js`): money flows, spins, VIP/refunds, deposits/withdrawals, admin, leaderboard payout, the legacy import (with awkward data), backup round trip and the client UI. It does **not** replace a run against real PostgreSQL: try the cutover on a copy/branch of your database first.

## Render
- Build: `npm install` · Start: `node server.js` · Root Directory: blank · Node 18+
- Environment: `BOT_TOKEN`, `BOT_USERNAME`, `CHANNEL_USERNAME`, `CHAT_USERNAME` (optional), `ADMIN_KEY`, `ALLOW_DEMO=false`, `DEPOSIT_TON`, `DEPOSIT_TRC20`, `DEPOSIT_BEP20`, `MINI_APP_URL`, `DATABASE_URL` (required), `DATABASE_SSL=true`. Optional: `AUTH_MAX_AGE_SEC` (default 86400), `DB_POOL_MAX` (default 10), `FORCE_REIMPORT=true` (see cutover).
- **No longer needed:** `ADSGRAM_BLOCK_ID`, `ADSGRAM_REWARD_SECRET` and the AdsGram Reward URL - delete them. Old ad entries stay readable in history as "Ad Reward (legacy)".
- **Public Proof of Payouts:** `https://YOUR-DOMAIN/payouts` lists completed withdrawals **that have an on-chain tx hash**. Completing a withdrawal in the admin panel now requires a valid tx hash.

## Security notes
- Static files are served from an explicit allow-list (`app.js`, `style.css`, `admin.js`, `admin.css`, plus `/`, `/admin`, `/payouts`). `server.js`, `package.json`, `schema.sql`, `.env` can never be downloaded (the old blocklist could be bypassed with %-encoded paths).
- Admin panel: no inline scripts/handlers, strict Content-Security-Policy, all dynamic values escaped (fixes a stored-XSS that could steal `ADMIN_KEY`). Admin key compared in constant time; 10 failed attempts → 15-minute lockout per IP.
- Telegram `initData` must be fresh (`auth_date` ≤ 24 h) - stale/replayed data is rejected.
- Join-reward claims are enforced by the database (`UNIQUE (user_id, task_id)` inside a transaction) - no double-claim by parallel taps, even across instances.
- Deposit hashes are validated and de-duplicated case-insensitively; `/api/qr` only encodes your own deposit addresses; per-IP rate limits on the API.
- Referral tracking trusts Telegram's verified `start_param`; self-referral is blocked.

## Private Admin Panel
- Open `https://YOUR-RENDER-DOMAIN/admin`, enter `ADMIN_KEY` (kept only in the browser session).
- Features: stats, deposit verification, withdrawal completion/rejection, user search/edit (only changed fields are saved), block/unblock, proof-page control, settings toggles (Channel Join, Daily Check-in, Daily Mining, Spin Game, Monthly Top Referrers), backup export, database status and copy tools.
- Never share `ADMIN_KEY` in Telegram, GitHub, screenshots, or chat.
