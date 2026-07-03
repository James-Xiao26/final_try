-- Forward alpha test: a point-in-time log of the smart-money signal vs. the live market price for
-- markets that qualify RIGHT NOW (>=5 leaderboard wallets each holding a non-dust open position),
-- recorded BEFORE the market resolves and scored only once it does.
--
-- Why this exists (vs. scripts/backtestSmartMoney.ts): the backtest scores the PAST closed trades of
-- wallets on the *current* leaderboard — wallets selected because they already won, so it is
-- survivorship-biased and its absolute profit is not a forward estimate. This table instead commits a
-- prediction the moment a market first qualifies, with leaderboard membership fixed at record time,
-- and never revises it. As predictions resolve over the coming weeks it accumulates an honest,
-- bias-free track record. One row per market (first sighting wins). Written only by
-- scripts/forwardAlpha.ts (--record populates, --score fills resolved_outcome); never read by web.
--
-- Like the other batch/cache tables here, no RLS is enabled — the script uses the service-role key.
CREATE TABLE forward_alpha_predictions (
  condition_id      TEXT PRIMARY KEY,
  recorded_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  question          TEXT,
  participant_count INTEGER NOT NULL,
  market_price      NUMERIC NOT NULL,   -- live YES-equivalent market price at record time
  smart_v1          NUMERIC NOT NULL,   -- skill*sqrt(cost) weighted YES entry (current production formula)
  smart_dollar      NUMERIC NOT NULL,   -- cost-weighted YES entry (the challenger the backtest favored)
  smart_sqrt        NUMERIC NOT NULL,   -- sqrt(cost) weighted YES entry (no skill)
  end_date          TIMESTAMPTZ,        -- market's scheduled end, so --score only checks markets that are due
  resolved_outcome  NUMERIC,            -- 1 = YES won, 0 = NO won, NULL = still pending
  resolved_at       TIMESTAMPTZ
);

-- Partial index: --score repeatedly scans for the (shrinking) set of still-pending predictions.
CREATE INDEX idx_forward_alpha_pending ON forward_alpha_predictions (recorded_at) WHERE resolved_outcome IS NULL;
