export const CONFIG = {
  HORIZONS: [30, 90] as const,
  TOP_N: 500,
  MIN_TRADES: 20,
  MIN_VOLUME_USD: 100,
  // Min volume-weighted average entry price (USD/share). Longshot traders who only buy sub-cent
  // shares have a tiny capital-proxy denominator, which inflates pctReturn and distorts the score;
  // this gate excludes them. Volume-weighted (not median) so a few small dust bets among normal
  // positions don't trip it — only wallets whose *capital* sits in cheap shares are caught.
  MIN_AVG_ENTRY_PRICE: 0.02,
  OUTLIER_TRADE_FRACTION: 0.6,
  SKILL_WEIGHTS: {
    pctReturn: 0.5,
    winRate: 0.25,
    drawdown: 0.15,
    sampleSize: 0.1
  },
  DRAWDOWN_PENALTY_THRESHOLD: 0.2,
  SAMPLE_CONFIDENCE_FLOOR: 0.6,
  BOT: {
    MAX_TRADES_PER_DAY: 50,
    MAX_SIMULTANEOUS_MARKETS: 30,
    MIN_AVG_TRADE_SIZE_USD: 1
  },
  POLYMARKET_API_BASE: process.env.POLYMARKET_API_BASE ?? "https://data-api.polymarket.com",
  SEED_WALLET_COUNT: 10000,
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
