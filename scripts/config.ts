export const CONFIG = {
  HORIZONS: [30, 90] as const,
  TOP_N: 100,
  MIN_TRADES: 20,
  MIN_VOLUME_USD: 100,
  // Wallets with a known all-time P/L below this are excluded from the leaderboard (captured from
  // /v1/leaderboard `pnl`, timePeriod=ALL). Unknown (null) P/L is NOT excluded — only proven losers.
  MIN_LIFETIME_PNL: 0,
  // Min volume-weighted average entry price (USD/share). Longshot traders who only buy sub-cent
  // shares have a tiny capital-proxy denominator, which inflates pctReturn and distorts the score;
  // this gate excludes them. Volume-weighted (not median) so a few small dust bets among normal
  // positions don't trip it — only wallets whose *capital* sits in cheap shares are caught.
  MIN_AVG_ENTRY_PRICE: 0.02,
  OUTLIER_TRADE_FRACTION: 0.6,
  // Skill Score = pure statistical forecasting edge, on a 0-SCORE_MAX scale. Each resolved
  // position is a Bernoulli trial whose entry price is the market's implied probability; per-share
  // edge is (outcome - price). The score is the Bayesian-shrunk mean edge, remapped so that any
  // proven positive edge lands in [SCORE_FLOOR, SCORE_MAX]:
  //   shrunkEdge = sum(outcome - price) / (nResolved + EDGE_SHRINKAGE_K)
  //   score      = shrunkEdge <= 0 ? 0
  //              : clamp(SCORE_FLOOR, SCORE_MAX,
  //                      SCORE_FLOOR + (SCORE_MAX - SCORE_FLOOR) * shrunkEdge / EDGE_FOR_TEN)
  // Shrinkage toward 0 means small/lucky samples can't earn a high score; zero/negative edge -> 0,
  // and any positive shrunk edge floors at SCORE_FLOOR (a hard jump at edge = 0).
  SCORE_MAX: 10,
  // Floor for any wallet with positive (proven) shrunk edge. Reserves the 0-SCORE_FLOOR band for
  // zero/negative-edge wallets only: a hair of positive edge jumps to SCORE_FLOOR, then climbs
  // linearly toward SCORE_MAX. Changing this requires updating the score constants in metrics.test.ts.
  SCORE_FLOOR: 4,
  // Prior strength: everyone starts as if they had this many zero-edge resolved bets. Higher = more
  // skeptical (slower to reward a short hot streak).
  EDGE_SHRINKAGE_K: 20,
  // The proven (shrunk) per-share edge that earns a perfect SCORE_MAX. 0.096 = a ~9.6-cents-per-share
  // edge over the market's implied price. Calibrated so a ~5-cent shrunk edge lands near 7 given the
  // SCORE_FLOOR=4 band. Changing this (or EDGE_SHRINKAGE_K / SCORE_FLOOR) requires updating the exact
  // score constants in metrics.test.ts.
  EDGE_FOR_TEN: 0.096,
  BOT: {
    // Calibrated against a working trades/day denominator (see MIN_RATE_WINDOW_DAYS). The old 50
    // was a dead constant: activity is capped at ACTIVITY_LIMIT and the rate used to be divided by
    // a fixed horizon, so the check could never exceed ~5.6/day and never fired. With the observed
    // span as denominator, 50/day swept up ~63% of leaderboard-seeded (i.e. very active) traders.
    // 250 flags only the sustained high-frequency tail — the 500-trade sample caps measurable rate
    // near 500/day, so real market-making bots cluster high while discretionary traders sit well
    // below even on event days. Retune from the trades/day distribution if exclusions look off.
    MAX_TRADES_PER_DAY: 250,
    MAX_SIMULTANEOUS_MARKETS: 30,
    MIN_AVG_TRADE_SIZE_USD: 1,
    // Floor (days) for the trades/day denominator. /activity returns the most recent
    // ACTIVITY_LIMIT trades with no date filter, so trades/day is computed over the span the
    // returned trades actually occupy (max - min timestamp), not a fixed horizon. This floor
    // stops a handful of quick trades in a single session from dividing by a near-zero window
    // and looking automated, while a genuine burst (>MAX_TRADES_PER_DAY within a day) still trips.
    MIN_RATE_WINDOW_DAYS: 1
  },
  POLYMARKET_API_BASE: process.env.POLYMARKET_API_BASE ?? "https://data-api.polymarket.com",
  // The Gamma API (a different host than the Data API above) is the only Polymarket source that
  // lists markets with liquidity/volume/price fields. It powers the Markets page. The markets pass
  // is a single cheap global fetch (not per-wallet), so it reuses the "general" rate lane.
  GAMMA_API_BASE: process.env.GAMMA_API_BASE ?? "https://gamma-api.polymarket.com",
  // How many top markets to persist for the Markets page. One liquidity-sorted superset is stored;
  // the read layer re-orders it by volume/24h/volatility, so no per-sort fetch is needed.
  MARKETS_TOP_N: 300,
  MARKETS_PAGE_SIZE: 100,
  // Floors applied to the Gamma query so dust markets never enter the set.
  MARKETS_MIN_LIQUIDITY: 1000,
  MARKETS_MIN_VOLUME: 1000,
  // Landing-page activity feed: only fills within this window are persisted to recent_trades and
  // shown on the home page. Reuses the /activity payload already fetched for bot detection, so it
  // adds no Polymarket API calls. Read-side freshness is bounded by ingest cadence.
  RECENT_TRADE_WINDOW_HOURS: 24,
  // Chunk size for the recent_trades bulk insert (keeps each insert payload modest).
  RECENT_TRADES_INSERT_CHUNK: 500,
  SEED_WALLET_COUNT: 5000,
  API_RETRIES: 5,
  RETRY_BASE_DELAY_MS: 1000,
  // Number of wallets processed concurrently by the worker pool. The per-lane request gates
  // (below) are the real rate limiter, so this only needs to be high enough to keep those gates
  // saturated despite uneven per-wallet work (bots finish in 1 request; whales paginate deeply).
  // Raising it past that point costs nothing on the API but a little memory; it does NOT raise
  // the request rate, which the gates cap independently.
  WALLET_CONCURRENCY: 24,
  // Per-endpoint request spacing (ms), honoring Polymarket's Data API limits over a 10s
  // sliding window. Each lane is a separate serial gate (see polymarket.ts), so cheap
  // general calls don't queue behind expensive closed-position pagination.
  //   restricted: /closed-positions & /positions share 150 req/10s -> 90ms ~= 111 req/10s (~75% of cap)
  //   general:    /activity, /value, /v1/leaderboard, /trades (>=200 req/10s) -> 30ms ~= 333 req/10s
  REQUEST_INTERVAL_MS: {
    restricted: 90,
    general: 30
  },
  ACTIVITY_LIMIT: 500,
  CLOSED_POSITION_PAGE_SIZE: 50,
  MAX_CLOSED_POSITION_PAGES: 40,
  // /positions pagination: resolved-but-unredeemed positions (abandoned losers, unredeemed winners)
  // are folded into the metric set so the score reflects real edge, not just redeemed winners.
  POSITION_PAGE_SIZE: 500,
  MAX_POSITION_PAGES: 40,
  LEADERBOARD_PAGE_SIZE: 50,
  // Max addresses per `.in(...)` filter when rebuilding the leaderboard cache. Each address adds
  // ~45 chars to the request URL, so this bounds URL length below the server's limit at any scale.
  LEADERBOARD_FILTER_CHUNK: 200,
  TRADES_DISCOVERY_LIMIT: 10000,
  SECONDS_PER_DAY: 86400,
  MS_PER_SECOND: 1000
};

export type HorizonDays = (typeof CONFIG.HORIZONS)[number];
