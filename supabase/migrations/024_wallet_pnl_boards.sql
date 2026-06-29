-- Leaderboard "PnL board" chips: which Polymarket PnL leaderboards (all-time/monthly/weekly) a wallet
-- ranks in the top N of. Captured for free during the full ingest's candidate-discovery scan (those
-- boards are already paged) and stamped onto the board wallets. Codes: 'pnl-all' / 'pnl-month' /
-- 'pnl-week'. Null/empty = not on any scanned PnL board's top N.
alter table wallets add column if not exists pnl_boards text[];
