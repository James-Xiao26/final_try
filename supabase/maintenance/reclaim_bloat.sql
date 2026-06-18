-- Fix A — one-time disk-bloat reclaim.
--
-- WHY: the ingest pipeline rewrites several tables by deleting every row and re-inserting
-- (wipe-and-replace) on a schedule — recent_trades + wallet_trades every ~10 min (feed job),
-- markets + leaderboard_cache + equity_curve + wallet_stats hourly, and the big position caches
-- daily. In Postgres a DELETE leaves a dead row behind for autovacuum to reclaim later, so these
-- tables accumulate "bloat" (wasted disk) and force autovacuum to run almost constantly (CPU + IO).
--
-- WHAT THIS DOES: VACUUM FULL physically rewrites each table, releasing the dead-row space back to
-- the OS, and ANALYZE refreshes the planner statistics so queries stay fast afterwards.
--
-- WHERE TO RUN: Supabase Dashboard -> SQL Editor (paste + Run). It must run here, NOT through the
-- app: VACUUM cannot run over Supabase's REST API (PostgREST), and there is no direct Postgres
-- connection string in this repo's env.
--
-- CAUTION: VACUUM FULL takes a brief exclusive lock per table (reads/writes to THAT table pause for
-- the few seconds it runs). Run it off-peak, and ideally when no ingest job is mid-run. If the SQL
-- Editor rejects it with "VACUUM cannot run inside a transaction block", run the statements one at a
-- time (the editor wraps multi-statement batches in a transaction).

VACUUM (FULL, ANALYZE) recent_trades;
VACUUM (FULL, ANALYZE) wallet_trades;
VACUUM (FULL, ANALYZE) wallet_positions;
VACUUM (FULL, ANALYZE) wallet_closed_positions;
VACUUM (FULL, ANALYZE) leaderboard_cache;
VACUUM (FULL, ANALYZE) equity_curve;
VACUUM (FULL, ANALYZE) wallet_stats;
VACUUM (FULL, ANALYZE) markets;
VACUUM (FULL, ANALYZE) market_price_history;
VACUUM (FULL, ANALYZE) market_price_meta;
