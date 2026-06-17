-- Indexes that eliminate full-table scans on the two most expensive read paths:
--
-- 1. leaderboard_cache: primary key is (horizon_days, rank), so .in("address", addresses)
--    queries (getLeaderboard, getRecentLeaderboardTrades, getCrowdedMarkets) do full scans.
--    An address index lets PostgREST use index-only lookups for all .in("address", ...) calls.
--
-- 2. wallet_closed_positions: getCrowdedMarkets now filters by close_time (90-day window), but
--    the feed also filters by .in("address", feedAddresses). A composite (address, close_time)
--    index covers both patterns; the existing close_time-only index covers the time-range-only scan
--    in getResolvedMarkets.

CREATE INDEX IF NOT EXISTS idx_leaderboard_cache_address
  ON leaderboard_cache(address);

CREATE INDEX IF NOT EXISTS idx_wallet_closed_positions_address_close_time
  ON wallet_closed_positions(address, close_time DESC);
