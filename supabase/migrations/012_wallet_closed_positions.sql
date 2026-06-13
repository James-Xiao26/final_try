-- Per-position cost-basis cache for closed positions, powering the activity feed's grouped rows.
-- When a leaderboard wallet sells out of a position whose BUY fills predate the 24h feed window, the
-- feed can't reconstruct the cost basis from recent_trades alone. This table persists the avg entry
-- price + realized PnL that the full ingest ALREADY fetches via /closed-positions (see
-- scripts/polymarket.ts getClosedPositions), so no extra Polymarket API calls are added.
--
-- Population model (mirrors wallet_positions): full-ingest only, global wipe-and-replace, scoped to
-- the wallets written into leaderboard_cache (the only wallets the feed shows). The every-10-min feed
-- job does NOT refresh this, so a brand-new sell-out's realized P/L can be up to one full-ingest
-- (~24h) stale — an accepted trade-off to avoid restricted-lane calls on the cheap feed cadence.
-- No RLS, like the other feed/detail tables; the web read path uses the anon key.
CREATE TABLE wallet_closed_positions (
  id            BIGSERIAL PRIMARY KEY,
  address       TEXT NOT NULL,            -- lowercased, matches wallets.address
  condition_id  TEXT,
  outcome_index INTEGER,
  market        TEXT,
  avg_price     NUMERIC,                  -- cost basis of the closed position (ClosedPosition.avgPrice)
  realized_pnl  NUMERIC,                  -- ClosedPosition.realizedPnl
  size          NUMERIC,                  -- shares closed
  close_time    TIMESTAMPTZ,
  ingested_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Feed joins on (address, condition_id, outcome_index) to look up basis for a sold-out position.
CREATE INDEX idx_wallet_closed_positions_lookup
  ON wallet_closed_positions(address, condition_id, outcome_index);
