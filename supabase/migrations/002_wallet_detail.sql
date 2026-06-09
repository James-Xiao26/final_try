-- Wallet-profile detail tables: current open positions and recent raw fills.
-- Both are populated from data the ingest pipeline already fetches per wallet
-- (/positions and /activity), so they add no Polymarket API cost. Like the
-- earlier tables they carry no RLS policies — the web read path uses the anon
-- key against a schema with RLS left disabled (see markets/recent_trades).
--
-- Population model (mirrors recent_trades):
--   wallet_positions — full-ingest only, global wipe-and-replace.
--   wallet_trades    — full ingest writes all eligible wallets; the every-10-min
--                      feed job re-pulls /activity for leaderboard wallets and
--                      scoped-replaces just their rows. No unique constraint is
--                      needed because both writers delete-then-insert.

CREATE TABLE wallet_positions (
  id            BIGSERIAL PRIMARY KEY,
  address       TEXT NOT NULL REFERENCES wallets(address) ON DELETE CASCADE,
  condition_id  TEXT,
  asset         TEXT NOT NULL,
  market        TEXT,
  outcome_index INTEGER,
  size          NUMERIC,
  avg_price     NUMERIC,
  cur_price     NUMERIC,
  initial_value NUMERIC,
  current_value NUMERIC,
  cash_pnl      NUMERIC,
  end_date      TIMESTAMPTZ,
  ingested_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_wallet_positions_address ON wallet_positions(address);

CREATE TABLE wallet_trades (
  id               BIGSERIAL PRIMARY KEY,
  address          TEXT NOT NULL REFERENCES wallets(address) ON DELETE CASCADE,
  condition_id     TEXT,
  market           TEXT,
  outcome_index    INTEGER,
  side             TEXT,
  price            NUMERIC,
  size             NUMERIC,
  usdc_size        NUMERIC,
  traded_at        TIMESTAMPTZ NOT NULL,
  transaction_hash TEXT,
  ingested_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_wallet_trades_address ON wallet_trades(address, traded_at DESC);
