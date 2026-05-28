CREATE TABLE wallets (
  address           TEXT PRIMARY KEY,
  is_bot_suspected BOOLEAN NOT NULL DEFAULT FALSE,
  is_claimed       BOOLEAN NOT NULL DEFAULT FALSE,
  handle           TEXT,
  bio              TEXT,
  links            JSONB,
  first_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE wallet_stats (
  address          TEXT NOT NULL REFERENCES wallets(address) ON DELETE CASCADE,
  horizon_days     INTEGER NOT NULL CHECK (horizon_days IN (30, 90, 365)),
  skill_score      NUMERIC(10,4),
  pct_return       NUMERIC(10,4),
  win_rate         NUMERIC(6,4),
  max_drawdown     NUMERIC(6,4),
  total_pnl_usd    NUMERIC(14,2),
  total_volume_usd NUMERIC(14,2),
  n_trades         INTEGER,
  computed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (address, horizon_days)
);

CREATE TABLE equity_curve (
  id             BIGSERIAL PRIMARY KEY,
  address        TEXT NOT NULL REFERENCES wallets(address) ON DELETE CASCADE,
  horizon_days   INTEGER NOT NULL CHECK (horizon_days IN (30, 90, 365)),
  ts             DATE NOT NULL,
  cumulative_pnl NUMERIC(14,2),
  UNIQUE (address, horizon_days, ts)
);

CREATE TABLE leaderboard_cache (
  horizon_days INTEGER NOT NULL CHECK (horizon_days IN (30, 90, 365)),
  rank         INTEGER NOT NULL,
  address      TEXT NOT NULL REFERENCES wallets(address) ON DELETE CASCADE,
  skill_score  NUMERIC(10,4),
  pct_return   NUMERIC(10,4),
  win_rate     NUMERIC(6,4),
  max_drawdown NUMERIC(6,4),
  n_trades     INTEGER,
  cached_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (horizon_days, rank)
);

CREATE INDEX idx_wallet_stats_skill ON wallet_stats(horizon_days, skill_score DESC);
CREATE INDEX idx_equity_curve_lookup ON equity_curve(address, horizon_days, ts);

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER wallets_set_updated_at
BEFORE UPDATE ON wallets
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();
