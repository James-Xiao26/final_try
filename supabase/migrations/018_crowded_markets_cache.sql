-- 018_crowded_markets_cache.sql
--
-- Fix C — precompute the Convergence ("crowded markets") ranked list.
--
-- Before this, getCrowdedMarkets() scanned the ENTIRE wallet_positions table (plus 90 days of
-- wallet_closed_positions) on every read, aggregating in the web process. That scan ran on the home
-- page's SSR path under a 1.5s timeout, spiking Supabase memory + disk IO and frequently timing out
-- to an empty Convergence section. The data only changes when the daily full ingest repopulates the
-- position caches, so it's pure waste to recompute it per request.
--
-- This table holds the already-ranked top markets, written once per full ingest by cacheCrowdedMarkets()
-- (the same summarizeCrowdedMarkets() aggregation, run server-side). The web read becomes a tiny
-- "SELECT ... ORDER BY rank LIMIT n". One row per market (condition_id is the natural key); `rank` is
-- the position in the trader-count-then-committed-capital ordering so the reader needs no re-sort.
--
-- Like the other read tables here, no RLS is enabled: reads go through the anon key under Supabase's
-- default public-schema grants, and only the service-role ingest writes it.
CREATE TABLE crowded_markets_cache (
  condition_id       TEXT PRIMARY KEY,
  rank               INT NOT NULL,             -- 1-based position in the ranked list
  market             TEXT,                     -- question text
  trader_count       INT NOT NULL,             -- distinct leaderboard wallets in this market
  yes_traders        INT NOT NULL,             -- wallets whose dominant side is YES (outcome 0)
  no_traders         INT NOT NULL,             -- wallets whose dominant side is NO (outcome 1)
  open_count         INT NOT NULL,             -- wallets still holding
  closed_count       INT NOT NULL,             -- wallets fully closed out
  committed_usd      DOUBLE PRECISION NOT NULL,-- gross leaderboard capital committed (YES + NO basis)
  net_exposure_usd   DOUBLE PRECISION NOT NULL,-- YES basis − NO basis (signed toward YES)
  top_rank           INT,                      -- best (lowest-number) leaderboard rank among participants
  cur_price          DOUBLE PRECISION,         -- current YES price, when known
  last_traded_at     TIMESTAMPTZ,              -- most recent tracked leaderboard fill in this market
  cached_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The reader orders by rank; back it with an index so the LIMIT read is an index scan.
CREATE INDEX idx_crowded_markets_cache_rank ON crowded_markets_cache(rank);
