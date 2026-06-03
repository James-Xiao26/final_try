-- Markets shown on the Markets page. Sourced from Polymarket's Gamma API (gamma-api.polymarket.com),
-- the only Polymarket source that lists markets with liquidity/volume/price fields. Global (not
-- per-wallet), so no FK to wallets. `id` is the Gamma market id — the stable primary key, since a
-- conditionId is not unique across markets. Like the other tables here, no RLS is enabled: reads go
-- through the anon key under Supabase's default public-schema grants.
CREATE TABLE markets (
  id                   TEXT PRIMARY KEY,         -- Gamma market id
  condition_id         TEXT,
  question             TEXT NOT NULL,
  slug                 TEXT,
  category             TEXT,
  liquidity_usd        NUMERIC(14,2),
  volume_usd           NUMERIC(14,2),
  volume_24hr_usd      NUMERIC(14,2),
  volume_1wk_usd       NUMERIC(14,2),
  one_day_price_change NUMERIC(8,4),
  spread               NUMERIC(8,4),            -- volatility proxy: bid/ask spread
  last_trade_price     NUMERIC(6,4),
  outcomes             JSONB,
  outcome_prices       JSONB,
  end_date             TIMESTAMPTZ,
  image                TEXT,
  active               BOOLEAN NOT NULL DEFAULT TRUE,
  closed               BOOLEAN NOT NULL DEFAULT FALSE,
  cached_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Descending indexes back the sortable Markets columns.
CREATE INDEX idx_markets_liquidity   ON markets(liquidity_usd DESC);
CREATE INDEX idx_markets_volume_24hr ON markets(volume_24hr_usd DESC);
CREATE INDEX idx_markets_volume      ON markets(volume_usd DESC);
CREATE INDEX idx_markets_category    ON markets(category);
