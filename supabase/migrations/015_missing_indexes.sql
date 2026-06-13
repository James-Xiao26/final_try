-- Missing indexes identified by high disk IO analysis.
--
-- 1. wallet_closed_positions(close_time DESC)
--    getRecentClosedTrades() filters .gte("close_time", cutoff) and orders by close_time DESC
--    without any index on that column, forcing a full table scan on every activity-feed request.
--
-- 2. wallet_positions(condition_id) and wallet_closed_positions(condition_id)
--    getCrowdMarketDetail() filters .eq("condition_id", ...) on both tables with no index,
--    causing a full table scan for every Convergence detail page load.
--
-- 3. wallet_trades(condition_id)
--    Same getCrowdMarketDetail() query; existing idx_wallet_trades_address covers address-based
--    lookups but not condition_id equality scans.
--
-- 4. market_price_history(ts)
--    The ingest pruning step deletes rows with .lt("ts", pruneBefore). The composite PK/index
--    (asset, ts) can't satisfy a range filter on ts alone — it requires scanning the entire index.
--    A standalone ts index makes pruning a cheap index range scan.

CREATE INDEX idx_wallet_closed_positions_close_time
  ON wallet_closed_positions(close_time DESC);

CREATE INDEX idx_wallet_positions_condition_id
  ON wallet_positions(condition_id);

CREATE INDEX idx_wallet_closed_positions_condition_id
  ON wallet_closed_positions(condition_id);

CREATE INDEX idx_wallet_trades_condition_id
  ON wallet_trades(condition_id);

CREATE INDEX idx_market_price_history_ts
  ON market_price_history(ts);
