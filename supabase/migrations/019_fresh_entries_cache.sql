-- 019_fresh_entries_cache.sql
--
-- Signal #2 — "Fresh Entries": the flow counterpart to Convergence (crowded_markets_cache).
--
-- Convergence ranks markets by who is *holding* (stock), which is contaminated by bag-holders who
-- won't sell a loser. This ranks markets by how many leaderboard wallets just *opened a brand-new
-- position* (a buy in the last RECENT_TRADE_WINDOW_HOURS, in a market they weren't already in) —
-- pure flow, which inaction can't fake. Skill-weighted so a fresh buy by a high-skill wallet counts.
--
-- Precomputed by the ~10-min feed run (cacheFreshEntries) from the /activity it already pulls — same
-- cache-table pattern as 018: the web read collapses to a tiny "ORDER BY rank LIMIT n". One row per
-- market (condition_id natural key); `rank` is the entrant_count-then-skill_weight ordering.
--
-- No RLS, like the other read caches: reads via the anon key under default public grants, only the
-- service-role ingest writes it.
CREATE TABLE fresh_entries_cache (
  condition_id   TEXT PRIMARY KEY,
  rank           INT NOT NULL,              -- 1-based position in the ranked list
  market         TEXT,                      -- question text
  entrant_count  INT NOT NULL,              -- distinct leaderboard wallets newly entering in-window
  skill_weight   DOUBLE PRECISION NOT NULL, -- sum of entrants' skill scores (sort tiebreak)
  top_skill      DOUBLE PRECISION,          -- best single entrant skill score
  yes_entrants   INT NOT NULL,              -- entrants who entered on YES (outcome 0)
  no_entrants    INT NOT NULL,              -- entrants who entered on NO (outcome 1)
  committed_usd  DOUBLE PRECISION NOT NULL, -- total in-window buy USDC from the new entrants
  top_rank       INT,                       -- best (lowest-number) leaderboard rank among entrants
  last_entry_at  TIMESTAMPTZ,               -- most recent new-entry fill
  cached_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The reader orders by rank; back it with an index so the LIMIT read is an index scan.
CREATE INDEX idx_fresh_entries_cache_rank ON fresh_entries_cache(rank);
