-- 016_candidate_wallets.sql
--
-- Expands the talent-discovery pool beyond the top-5000-by-volume leaderboard pass.
-- The main /v1/leaderboard?orderBy=VOL query only surfaces the highest-volume traders;
-- skilled traders with smaller capital bases are invisible to it.
--
-- Strategy:
--   1. discoverCandidateAddresses() pulls five additional leaderboard variants
--      (VOL/PNL × ALL/1m/1w) plus the live /trades stream → candidate_wallets
--   2. Each full ingest scores CANDIDATE_BATCH_PER_RUN unscored/stale candidates
--      using the same computeMetrics + computeSkillScore pipeline.
--   3. Candidates with skill_score >= CANDIDATE_PROMOTION_THRESHOLD are promoted to
--      'tracked' and re-scored on every subsequent full ingest alongside the main
--      leaderboard-seeded wallets — competing for the same TOP_N slots.
--   4. Tracked wallets that fall below CANDIDATE_RETIREMENT_THRESHOLD for
--      CANDIDATE_RETIREMENT_CONSECUTIVE consecutive runs are retired.

CREATE TABLE candidate_wallets (
  address TEXT PRIMARY KEY,

  -- Which source first surfaced this wallet; never overwritten so the lineage is preserved.
  --   leaderboard_vol_all   – /v1/leaderboard?orderBy=VOL&timePeriod=ALL (the main pass)
  --   leaderboard_pnl_all   – ordered by all-time profit (different population than VOL)
  --   leaderboard_pnl_1m    – ordered by monthly profit
  --   leaderboard_vol_1m    – ordered by monthly volume
  --   leaderboard_pnl_1w    – ordered by weekly profit
  --   leaderboard_vol_1w    – ordered by weekly volume
  --   trades_stream         – seen in the live /trades feed (active but not leaderboard-ranked)
  --   manual                – added outside the automated pipeline
  discovery_source TEXT NOT NULL DEFAULT 'unknown',

  -- Lifecycle state:
  --   candidate – discovered but not yet scored, or scored below the promotion threshold.
  --               Eligible to appear in the scoring batch (up to CANDIDATE_BATCH_PER_RUN
  --               per full ingest, oldest-scored first).
  --   tracked   – scored above CANDIDATE_PROMOTION_THRESHOLD; included in every full
  --               ingest's main worker pool alongside the leaderboard-seeded wallets.
  --               Competes for the same TOP_N leaderboard slots via rebuildLeaderboardCache.
  --   retired   – was tracked but fell below CANDIDATE_RETIREMENT_THRESHOLD for
  --               CANDIDATE_RETIREMENT_CONSECUTIVE consecutive runs. wallet_stats and
  --               equity_curve rows are kept for historical lookups; scoring stops.
  status TEXT NOT NULL DEFAULT 'candidate'
    CONSTRAINT candidate_wallets_status_check
      CHECK (status IN ('candidate', 'tracked', 'retired')),

  first_seen_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- When this wallet was last run through the scoring pipeline. NULL = never scored.
  last_scored_at            TIMESTAMPTZ,

  -- Best skill_score across all horizons from the most recent scoring pass.
  -- NULL means never scored or ineligible (bot, too few trades, etc.).
  skill_score               FLOAT,

  -- Total number of times this wallet has been through the scoring pipeline.
  times_scored              INT NOT NULL DEFAULT 0,

  -- For tracked wallets: how many consecutive full-ingest runs produced a skill_score
  -- below CANDIDATE_RETIREMENT_THRESHOLD. Resets to 0 whenever the score is >= threshold.
  -- When it reaches CANDIDATE_RETIREMENT_CONSECUTIVE, the wallet transitions to 'retired'.
  consecutive_below_threshold INT NOT NULL DEFAULT 0,

  promoted_at               TIMESTAMPTZ,  -- when status changed candidate → tracked
  retired_at                TIMESTAMPTZ   -- when status changed tracked → retired
);

-- Candidate batch selection: "status = 'candidate' ORDER BY last_scored_at NULLS FIRST"
-- surfaces never-scored wallets before recently-attempted ones.
CREATE INDEX idx_candidate_wallets_status_scored
  ON candidate_wallets (status, last_scored_at NULLS FIRST);

-- Fast load of all tracked wallets at the start of each full ingest run.
CREATE INDEX idx_candidate_wallets_tracked
  ON candidate_wallets (status)
  WHERE status = 'tracked';
