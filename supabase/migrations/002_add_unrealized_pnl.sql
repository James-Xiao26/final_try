-- Total P/L curve (Option 2): wallet_stats.total_pnl_usd now holds realized + current unrealized
-- PnL, and the equity_curve's final point is marked to market. Store the unrealized component
-- separately so the UI can show the realized/open split. Nullable: rows ingested before this
-- migration won't have it until the next ingest backfills them.
ALTER TABLE wallet_stats ADD COLUMN unrealized_pnl_usd NUMERIC(14,2);
