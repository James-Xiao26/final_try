-- Scheduled real-world start time for sports/esports markets (Polymarket's Gamma API exposes
-- `gameStartTime` only for these — politics/economy/etc. have no equivalent "about to happen"
-- timestamp, so this stays null for everything else; see scripts/polymarket.ts mapEvent). Powers the
-- Trending Markets panel's "starts soon" ranking signal (web/lib/trendingMarkets.ts).
ALTER TABLE markets ADD COLUMN game_start_time TIMESTAMPTZ;
