-- Daily historical token prices for leaderboard-held markets, sourced from the CLOB
-- prices-history endpoint (clob.polymarket.com/prices-history?market={tokenId}). Token-keyed
-- (a position holds one outcome token, so price is per-token, not per-condition). Append-only
-- and immutable for past days; only the active tail is re-fetched, and resolved markets are
-- never re-fetched. No RLS, matching the other tables (reads go through the anon key under
-- Supabase's default public-schema grants). Pruned beyond the max horizon to bound growth.
--
-- This cache is the source for daily mark-to-market equity curves: on any past day, a wallet's
-- unrealized value = size_held(day) * price(day), with size_held reconstructed from fills.
CREATE TABLE market_price_history (
  asset        TEXT NOT NULL,           -- CLOB token id (= wallet_positions.asset)
  condition_id TEXT,                    -- for joins/debugging; not unique across markets
  ts           DATE NOT NULL,           -- UTC calendar day
  price        NUMERIC(6,4) NOT NULL,   -- token price in [0,1] for that day
  PRIMARY KEY (asset, ts)
);

CREATE INDEX idx_mph_asset ON market_price_history(asset, ts);

-- One row per cached token: the newest cached day, for cheap fetch-planning without scanning the
-- full history table. The ingest treats an asset whose max_ts has gone stale (no new daily point for
-- several days) as resolved/final and stops re-fetching it — the immutability amortization. Pruned
-- alongside the history rows.
CREATE TABLE market_price_meta (
  asset      TEXT PRIMARY KEY,
  max_ts     DATE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

