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
  EDGE_FOR_TEN: 0.13,
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
  // The CLOB API (a third host) is the only Polymarket source for historical price series.
  // We hit /prices-history?market={tokenId}&interval=max&fidelity=1440 to cache each held
  // token's daily price for the mark-to-market equity curve. Runs on its own "clob" rate lane.
  CLOB_API_BASE: process.env.CLOB_API_BASE ?? "https://clob.polymarket.com",
  // Daily fidelity (minutes/point) for prices-history; we window/dedupe to one point per UTC day.
  PRICE_HISTORY_FIDELITY_MIN: 1440,
  // A cached token whose newest daily point is older than this is treated as resolved/final (live
  // markets get a point every day; a settled one stops), so it's never re-fetched. The trade-off: a
  // genuinely-open but illiquid market with no trades for this many days won't have its tail extended.
  PRICE_HISTORY_STALE_DAYS: 3,
  // Safety cap on price-history fetches per ingest. Above the cold-start universe (~3k tokens),
  // so a first run backfills in one pass; resolved markets are skipped on later runs, so steady
  // state is just newly-seen markets + active-tail refreshes. Lower it to spread a huge backfill
  // across several daily runs.
  PRICE_HISTORY_MAX_FETCHES_PER_RUN: 4000,
  // How many days of daily history to keep for *listed* markets (the Markets-page price chart, keyed
  // by condition_id). Much deeper than the scoring HORIZONS so the chart can default to a market's
  // full lifetime; bounds storage / prunes orphaned markets that rotate out of the top set. Wallet-
  // seeded rows (condition_id null, the equity-curve cache) still prune at the max scoring horizon.
  PRICE_HISTORY_LISTED_DAYS: 365,
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
  // Chunk size for the recent_trades bulk insert (keeps each insert payload modest). Reused by the
  // wallet_trades / wallet_positions bulk inserts.
  RECENT_TRADES_INSERT_CHUNK: 500,
  // Per-wallet raw fills kept for the wallet-profile trade history (wallet_trades). Sliced from the
  // most recent /activity fills already fetched for bot detection, so it adds no API calls; the read
  // layer collapses these into per-position groups (avg entry/exit) with the raw fills as a dropdown.
  PROFILE_TRADES_LIMIT: 200,
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
    general: 30,
    // CLOB prices-history (/prices-history) falls under the CLOB General limit of 9,000 req/10s —
    // far above the Data API caps. Separate host/bucket, so this gate doesn't serialize behind the
    // restricted/general lanes. 10ms ~= 1,000 req/10s is only ~11% of the cap, leaving wide headroom
    // while the per-token Supabase upsert is what actually paces throughput; drop toward ~1.5ms (75%
    // of cap) only if the one-time cold-start backfill speed ever matters. fetchJson honors
    // Retry-After on the rare 429.
    clob: 10
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
