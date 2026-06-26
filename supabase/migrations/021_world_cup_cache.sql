-- 021_world_cup_cache.sql
--
-- Limited-time "World Cup" board: ranks traders purely by their forecasting edge on World Cup
-- soccer markets (the same Bayesian-shrunk per-share edge the main Skill Score uses, sliced to
-- World Cup markets — see scripts/worldCup.ts). One row per ranked wallet, written once per full
-- ingest by cacheWorldCup(); the web read is a tiny "ORDER BY rank LIMIT n" indexed scan.
--
-- Same precompute pattern as crowded_markets_cache (018) / fresh_entries_cache (019): a board-wide
-- aggregate can't be computed per request, and the non-leaderboard WC specialists it surfaces aren't
-- in the board-scoped position caches, so it must be built during ingest where every eligible
-- wallet's positions are in hand.
--
-- No RLS, like the other read caches: reads via the anon key under default public grants; only the
-- service-role ingest writes it.
CREATE TABLE world_cup_cache (
  address             TEXT PRIMARY KEY,
  rank                INT NOT NULL,              -- 1-based position in the ranked list
  handle              TEXT,                      -- @handle when known
  score               DOUBLE PRECISION NOT NULL, -- 0-10 World Cup skill score
  n_bets              INT NOT NULL,              -- resolved World Cup bets (sample size)
  win_rate            DOUBLE PRECISION NOT NULL,
  avg_edge_per_share  DOUBLE PRECISION NOT NULL, -- per-position mean (outcome - entry) on WC bets
  pnl_usd             DOUBLE PRECISION NOT NULL, -- realized $ on resolved WC bets
  open_bets           INT NOT NULL,              -- current open WC positions (live conviction)
  top_market          TEXT,                      -- largest open WC position's market title
  top_side            TEXT,                      -- 'YES' | 'NO' of that top open position
  cached_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The reader orders by rank; back it with an index so the LIMIT read is an index scan.
CREATE INDEX idx_world_cup_cache_rank ON world_cup_cache(rank);
