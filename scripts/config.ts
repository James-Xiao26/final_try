export const CONFIG = {
  HORIZONS: [30, 90] as const,
  TOP_N: 100,
  MIN_TRADES: 20,
  MIN_VOLUME_USD: 100,
  // Min volume-weighted average entry price (USD/share). Longshot traders who only buy sub-cent
  // shares have a tiny capital-proxy denominator, which inflates pctReturn and distorts the score;
  // this gate excludes them. Volume-weighted (not median) so a few small dust bets among normal
  // positions don't trip it — only wallets whose *capital* sits in cheap shares are caught.
  MIN_AVG_ENTRY_PRICE: 0.02,
  OUTLIER_TRADE_FRACTION: 0.6,
  // Additive reward weights (drawdown is subtracted as a penalty). The positive weights
  // (pctReturn + edge + winRate + sampleSize) sum to 0.85, matching the pre-edge total so the
  // score stays on the same ~0-850 scale. `edge` is forecasting edge: entry price vs. the market's
  // eventual resolution (see computeMetrics), weighted by its own nResolved confidence ramp so a
  // few lucky resolved bets don't move it. It overlaps pctReturn by design — both reward being
  // right — but edge isolates prediction from exit/trading skill.
  SKILL_WEIGHTS: {
    pctReturn: 0.4,
    edge: 0.2,
    winRate: 0.2,
    drawdown: 0.15,
    sampleSize: 0.05
  },
  DRAWDOWN_PENALTY_THRESHOLD: 0.2,
  SAMPLE_CONFIDENCE_FLOOR: 0.6,
  // Resolved-position count at which the edge term reaches full weight (saturates at 3x, like the
  // trade-count ramp). Below it, edge is discounted toward 0 — a 5pp edge over a handful of
  // resolved bets is noise, and it also damps the term while sold-position outcome coverage is
  // still partial (only held-to-resolution positions carry a guaranteed outcome today).
  MIN_RESOLVED: 10,
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
  SEED_WALLET_COUNT: 1000,
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
