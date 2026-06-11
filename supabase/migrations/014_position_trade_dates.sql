-- Per-position trade dates for the Convergence ("crowded markets") participant table.
--
-- The detail page derives each wallet's "first buy" / "last trade" from wallet_trades, but that
-- cache holds only the last PROFILE_TRADES_LIMIT (200) fills per wallet across ALL markets. A wallet
-- can be a participant (via its open/closed position cache) yet have no fills for that specific
-- market in the window, so both dates render blank. These columns persist the dates the full ingest
-- already derives from each wallet's /activity (earliestEntryDates / latestFillDates, keyed by the
-- outcome-token asset), so the read path can fall back to them when fills are absent.
--
-- Population model mirrors the parent tables: full-ingest only, global wipe-and-replace (the feed job
-- never writes positions). Nullable — when a wallet's fills for a token predate the capped /activity
-- window (ACTIVITY_LIMIT), the date is simply absent (same trade-off as the equity-curve entry date).
-- For closed positions, "last trade" reuses the existing close_time column, so only first_traded_at
-- is added here.
ALTER TABLE wallet_positions
  ADD COLUMN first_traded_at TIMESTAMPTZ,
  ADD COLUMN last_traded_at  TIMESTAMPTZ;

ALTER TABLE wallet_closed_positions
  ADD COLUMN first_traded_at TIMESTAMPTZ;
