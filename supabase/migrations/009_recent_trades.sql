-- Recent individual trade fills by leaderboard-eligible wallets, powering the landing-page "last
-- 24h" activity feed. Sourced from the same /activity payload that bot detection already consumes
-- during ingest, so populating this table adds no extra Polymarket API calls. Wiped and re-inserted
-- each full ingest, like the markets table. No FK to wallets (addresses are upserted in the same
-- run); reads go through the anon key under the default public-schema grants, no RLS. Skill score is
-- intentionally NOT stored here — the read path joins to leaderboard_cache, which also enforces that
-- the trader is currently on the leaderboard.
CREATE TABLE recent_trades (
  id            BIGSERIAL PRIMARY KEY,
  address       TEXT NOT NULL,            -- lowercased, matches wallets.address
  condition_id  TEXT,
  market        TEXT,                     -- market title for display
  outcome_index INTEGER,
  side          TEXT,                     -- BUY / SELL / UNKNOWN
  price         NUMERIC(6,4),             -- per-share entry price (implied probability, 0..1)
  size          NUMERIC(18,4),            -- shares
  usdc_size     NUMERIC(14,2),            -- money placed on the fill
  traded_at     TIMESTAMPTZ NOT NULL,
  ingested_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Feed reads order by recency and filter to a 24h window; the address index backs the membership join.
CREATE INDEX idx_recent_trades_traded_at ON recent_trades(traded_at DESC);
CREATE INDEX idx_recent_trades_address   ON recent_trades(address);
