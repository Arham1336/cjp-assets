-- ============================================================================
-- CJP Earning Bot - relational schema (source of truth since v2.0)
-- Idempotent: runs on every server start. Keep comments free of semicolons.
-- ============================================================================

CREATE TABLE IF NOT EXISTS users (
  id                     BIGINT PRIMARY KEY,
  username               TEXT NOT NULL DEFAULT '',
  first_name             TEXT NOT NULL DEFAULT '',
  cjp_balance            NUMERIC(20,6) NOT NULL DEFAULT 0 CHECK (cjp_balance >= 0),
  usdt_balance           NUMERIC(20,6) NOT NULL DEFAULT 0 CHECK (usdt_balance >= 0),
  deposit_usdt_balance   NUMERIC(20,6) NOT NULL DEFAULT 0 CHECK (deposit_usdt_balance >= 0),
  swap_usdt_balance      NUMERIC(20,6) NOT NULL DEFAULT 0 CHECK (swap_usdt_balance >= 0),
  last_daily             TIMESTAMPTZ,
  last_daily_day         DATE,
  daily_streak           INTEGER NOT NULL DEFAULT 0,
  last_mine_day          DATE,
  spin_day               DATE,
  spin_count             INTEGER NOT NULL DEFAULT 0,
  bonus_spins            INTEGER NOT NULL DEFAULT 0 CHECK (bonus_spins >= 0),
  vip_level              SMALLINT NOT NULL DEFAULT 0,
  vip_started_at         TIMESTAMPTZ,
  vip_paid_usdt          NUMERIC(20,6) NOT NULL DEFAULT 0,
  active_subscription_id BIGINT,
  is_blocked             BOOLEAN NOT NULL DEFAULT FALSE,
  blocked_at             TIMESTAMPTZ,
  referral_code          TEXT UNIQUE,
  referred_by            BIGINT REFERENCES users(id),
  referral_count         INTEGER NOT NULL DEFAULT 0,
  ref_bonus_cjp          NUMERIC(20,6) NOT NULL DEFAULT 0,
  ref_commission_cjp     NUMERIC(20,6) NOT NULL DEFAULT 0,
  last_mine_at           TIMESTAMPTZ,
  coin_balance           NUMERIC(20,6) NOT NULL DEFAULT 0 CHECK (coin_balance >= 0),
  last_coin_claim_day    DATE,
  last_vip_usdt_day      DATE,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Upgrades from the experimental v1.x relational schema
ALTER TABLE users ADD COLUMN IF NOT EXISTS bonus_spins INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS ref_bonus_cjp NUMERIC(20,6) NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS ref_commission_cjp NUMERIC(20,6) NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_mine_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS coin_balance NUMERIC(20,6) NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_coin_claim_day DATE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_vip_usdt_day DATE;
CREATE INDEX IF NOT EXISTS idx_users_referred_by ON users(referred_by);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_vip_level ON users(vip_level) WHERE vip_level > 0;

CREATE TABLE IF NOT EXISTS subscriptions (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES users(id),
  level         SMALLINT NOT NULL,
  price_usdt    NUMERIC(20,6) NOT NULL,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  status        TEXT NOT NULL DEFAULT 'active',
  upgraded_at   TIMESTAMPTZ,
  refunded      BOOLEAN NOT NULL DEFAULT FALSE,
  refund_amount NUMERIC(20,6),
  refunded_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_status ON subscriptions(user_id, status);

CREATE TABLE IF NOT EXISTS deposits (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id),
  network     TEXT NOT NULL,
  tx_hash     TEXT NOT NULL,
  amount      NUMERIC(20,6) NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  verified_at TIMESTAMPTZ,
  rejected_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_deposits_status ON deposits(status);
CREATE INDEX IF NOT EXISTS idx_deposits_user ON deposits(user_id);
-- A transaction hash can only ever be submitted once (case-insensitive)
CREATE UNIQUE INDEX IF NOT EXISTS uq_deposits_tx_hash_lower ON deposits (lower(tx_hash));

CREATE TABLE IF NOT EXISTS withdrawals (
  id                  BIGSERIAL PRIMARY KEY,
  user_id             BIGINT NOT NULL REFERENCES users(id),
  network             TEXT NOT NULL,
  address             TEXT NOT NULL,
  amount              NUMERIC(20,6) NOT NULL,
  fee_percent         NUMERIC(5,2) NOT NULL DEFAULT 5,
  fee_amount          NUMERIC(20,6) NOT NULL,
  net_amount          NUMERIC(20,6) NOT NULL,
  status              TEXT NOT NULL DEFAULT 'processing',
  tx_hash             TEXT,
  source_swap_usdt    NUMERIC(20,6) NOT NULL DEFAULT 0,
  source_deposit_usdt NUMERIC(20,6) NOT NULL DEFAULT 0,
  hidden_from_proof   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  available_at        TIMESTAMPTZ NOT NULL,
  completed_at        TIMESTAMPTZ,
  rejected_at         TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_withdrawals_status ON withdrawals(status);
CREATE INDEX IF NOT EXISTS idx_withdrawals_user ON withdrawals(user_id);
CREATE INDEX IF NOT EXISTS idx_withdrawals_completed ON withdrawals(status, completed_at) WHERE status = 'completed';
-- At most one withdrawal in Processing per member (enforced by the database itself)
CREATE UNIQUE INDEX IF NOT EXISTS uq_withdrawals_one_processing ON withdrawals(user_id) WHERE status = 'processing';

CREATE TABLE IF NOT EXISTS task_claims (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id),
  task_id    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, task_id)
);

CREATE TABLE IF NOT EXISTS ledger (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id),
  type       TEXT NOT NULL,
  amount     NUMERIC(20,6) NOT NULL,
  currency   TEXT NOT NULL,
  meta       JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ledger_user_id ON ledger(user_id, id);
CREATE INDEX IF NOT EXISTS idx_ledger_user_type_currency ON ledger(user_id, type, currency);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value JSONB NOT NULL
);
INSERT INTO settings (key, value) VALUES ('channelJoinEnabled', 'true') ON CONFLICT DO NOTHING;
INSERT INTO settings (key, value) VALUES ('dailyCheckinEnabled', 'true') ON CONFLICT DO NOTHING;
INSERT INTO settings (key, value) VALUES ('miningEnabled', 'true') ON CONFLICT DO NOTHING;
INSERT INTO settings (key, value) VALUES ('gamesEnabled', 'true') ON CONFLICT DO NOTHING;
INSERT INTO settings (key, value) VALUES ('referralLeaderboardEnabled', 'true') ON CONFLICT DO NOTHING;
INSERT INTO settings (key, value) VALUES ('vipDailyUsdtEnabled', 'true') ON CONFLICT DO NOTHING;
INSERT INTO settings (key, value) VALUES ('coinExchangeEnabled', 'true') ON CONFLICT DO NOTHING;

-- Small key/value store for internal flags (legacy import marker, last settled leaderboard month)
CREATE TABLE IF NOT EXISTS app_state (
  key   TEXT PRIMARY KEY,
  value JSONB NOT NULL
);

-- One row per settled month of Monthly Top Referrers
CREATE TABLE IF NOT EXISTS ref_leaderboard_history (
  month      TEXT PRIMARY KEY,
  winners    JSONB NOT NULL DEFAULT '[]',
  skipped    BOOLEAN NOT NULL DEFAULT FALSE,
  settled_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Points -> CJP coin exchanges. Each exchange locks points and releases coins linearly over 90 days (claimable once per day)
CREATE TABLE IF NOT EXISTS coin_exchanges (
  id           BIGSERIAL PRIMARY KEY,
  user_id      BIGINT NOT NULL REFERENCES users(id),
  points       NUMERIC(20,6) NOT NULL,
  coins_total  NUMERIC(20,6) NOT NULL,
  claimed_coins NUMERIC(20,6) NOT NULL DEFAULT 0,
  start_at     TIMESTAMPTZ NOT NULL,
  end_at       TIMESTAMPTZ NOT NULL,
  status       TEXT NOT NULL DEFAULT 'active'
);
CREATE INDEX IF NOT EXISTS idx_coin_exchanges_user ON coin_exchanges(user_id, status);

-- CJP coin withdrawals to a TON (Tonkeeper) wallet, paid out manually by an admin
CREATE TABLE IF NOT EXISTS coin_withdrawals (
  id           BIGSERIAL PRIMARY KEY,
  user_id      BIGINT NOT NULL REFERENCES users(id),
  address      TEXT NOT NULL,
  amount       NUMERIC(20,6) NOT NULL,
  status       TEXT NOT NULL DEFAULT 'processing',
  tx_hash      TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  rejected_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_coin_withdrawals_status ON coin_withdrawals(status);
CREATE INDEX IF NOT EXISTS idx_coin_withdrawals_user ON coin_withdrawals(user_id);
