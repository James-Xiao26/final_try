-- All-time profit/loss per wallet, captured from Polymarket's /v1/leaderboard `pnl` field
-- (timePeriod=ALL) during discovery. Used to exclude proven lifetime losers from leaderboard_cache.
-- Nullable: unknown for wallets discovered via the /trades fallback (no pnl there), and backfilled
-- on the next ingest. Null is treated as "unknown" (not excluded), only a known negative is dropped.
ALTER TABLE wallets ADD COLUMN lifetime_pnl NUMERIC(14,2);
