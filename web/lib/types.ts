export const HORIZONS = [30, 90] as const;
export type HorizonDays = (typeof HORIZONS)[number];

export interface LeaderboardRow {
  rank: number;
  address: string;
  skillScore: number;
  avgEdgePerShare: number;
  winRate: number;
  nTrades: number;
  handle: string | null;
}

export interface WalletMetrics {
  horizonDays: number;
  skillScore: number | null;
  pctReturn: number;
  winRate: number;
  totalPnlUsd: number;
  unrealizedPnlUsd: number;
  totalVolumeUsd: number;
  nTrades: number;
  avgEdgePerShare: number;
  nResolved: number;
}

export interface EquityPoint {
  ts: string;
  cumulativePnl: number;
}

// One current open holding on a wallet profile (genuinely-open positions, redeemable === false).
// avgPrice is the entry cost basis; curPrice is the current mark; unrealized P/L = currentValue −
// initialValue.
export interface WalletPosition {
  conditionId: string | null;
  asset: string;
  market: string | null;
  outcomeIndex: number | null;
  size: number;
  avgPrice: number;
  curPrice: number;
  initialValue: number;
  currentValue: number;
  cashPnl: number;
  endDate: string | null;
}

// One raw fill within a trade group's dropdown.
export interface WalletFill {
  side: string | null;
  price: number | null;
  size: number | null;
  usdcSize: number | null;
  tradedAt: string;
  transactionHash: string | null;
}

// Raw fills collapsed per market position (conditionId + outcomeIndex) for the wallet-profile trade
// history. avgEntryPrice is the volume-weighted price of BUY fills; avgExitPrice that of SELL fills
// (null when the position has no sells — still held / held to resolution). `fills` are the raw fills
// (newest first) for the expandable dropdown.
export interface WalletTradeGroup {
  conditionId: string | null;
  market: string | null;
  outcomeIndex: number | null;
  avgEntryPrice: number | null;
  avgExitPrice: number | null;
  totalBoughtSize: number;
  totalSoldSize: number;
  totalUsdc: number;
  latestTradedAt: string;
  fills: WalletFill[];
}

export interface WalletProfile {
  address: string;
  handle: string | null;
  bio: string | null;
  isClaimed: boolean;
  isBotSuspected: boolean;
  metrics: WalletMetrics[];
  equityCurve: EquityPoint[];
  equityCurves: Record<HorizonDays, EquityPoint[]>;
  badges: { label: string; horizonDays: number }[];
  positions: WalletPosition[];
  tradeGroups: WalletTradeGroup[];
}

// Sortable columns on the Markets page. "change" maps to the leading outcome's 24h price change.
// Kept as a const array so the API route can validate against it.
export const MARKET_SORTS = ["liquidity", "volume", "volume_24hr", "change"] as const;
export type MarketSort = (typeof MARKET_SORTS)[number];

// One grouped Polymarket event, as shown on the Markets page. currentPrice/topOutcome describe the
// leading (favorite) outcome; oneDayPriceChange is that outcome's price change over the last 24h.
export interface MarketRow {
  id: string;
  question: string;
  slug: string;
  category: string | null;
  liquidityUsd: number;
  volumeUsd: number;
  volume24hrUsd: number;
  volume1wkUsd: number;
  currentPrice: number | null;
  topOutcome: string | null;
  oneDayPriceChange: number | null;
  endDate: string | null;
  image: string | null;
}

// One fill in the landing-page activity feed: a recent trade by a wallet currently on the
// leaderboard. skillScore/handle are joined in from leaderboard_cache/wallets at read time.
export interface RecentTrade {
  address: string;
  handle: string | null;
  skillScore: number | null;
  // Best (lowest-number = highest) leaderboard rank for this wallet across horizons.
  rank: number | null;
  conditionId: string | null;
  market: string | null;
  outcomeIndex: number | null;
  side: string | null;
  price: number | null;
  size: number | null;
  usdcSize: number | null;
  tradedAt: string;
}

// One raw fill inside a grouped position's expandable history in the activity feed.
export interface RecentFill {
  side: string | null;
  price: number | null;
  size: number | null;
  usdcSize: number | null;
  tradedAt: string;
}

// A leaderboard wallet's recent activity in ONE market position (conditionId + outcomeIndex),
// collapsed from the fills in the feed window: adds and partial sells fold into a single row instead
// of one row per fill. The headline (lastSide/lastSize/lastPrice) is the most recent fill; the
// aggregate (avgEntry, mark, value, P/L) prefers the authoritative position cache (wallet_positions
// for open, wallet_closed_positions for closed) and falls back to the in-window fills. `basisSource`
// records where avgEntry came from: "cache" (Polymarket position data), "fills" (reconstructed from
// in-window buys), or "none" (opened before the window with no cache row → P/L unknown).
export interface RecentTradePosition {
  address: string;
  handle: string | null;
  skillScore: number | null;
  rank: number | null;
  conditionId: string | null;
  market: string | null;
  outcomeIndex: number | null;
  // headline: the most recent fill in the window
  lastSide: string | null;
  lastPrice: number | null;
  lastSize: number | null;
  lastUsdcSize: number | null; // USDC value of the headline fill (price·size when the API omits it)
  // aggregate position state
  state: "open" | "closed";
  basisSource: "cache" | "fills" | "none";
  avgEntry: number | null;        // cost basis; null when unknown
  mark: number | null;            // current outcome price (open positions); null otherwise
  remainingSize: number;          // shares still held (open); 0 when closed
  boughtSize: number;             // shares bought within the window
  soldSize: number;               // shares sold within the window
  positionValue: number | null;   // open: current value at mark; null when unknown
  unrealizedPct: number | null;   // open positions, vs current price
  realizedPct: number | null;     // closed positions with known basis
  realizedPnl: number | null;     // closed positions: realized $ P/L (from the cache), null otherwise
  latestTradedAt: string;
  fills: RecentFill[];            // newest-first, for the expandable ledger
}

export interface RecentTradesFeed {
  positions: RecentTradePosition[];
  // Distinct leaderboard wallets that traded within the window.
  traderCount: number;
}

// One fully-closed (sold-out) or resolved position by a leaderboard wallet, for the Closed Trades
// table on the Activity page. Read straight from the wallet_closed_positions cache (which already
// folds in held-to-resolution positions), so it carries the realized $ P/L directly — no fill-window
// join. realizedPct is realizedPnl / (avgEntry·size) when the basis is known.
export interface ClosedTrade {
  address: string;
  handle: string | null;
  rank: number | null;
  skillScore: number | null;
  conditionId: string | null;
  market: string | null;
  outcomeIndex: number | null;
  avgEntry: number | null;
  size: number | null;
  realizedPnl: number | null;
  realizedPct: number | null;
  closeTime: string;
}

export interface ClosedTradesFeed {
  trades: ClosedTrade[];
  traderCount: number;
}

// ── Convergence ("Crowded Markets") ─────────────────────────────────────────────
// A market (one binary condition_id) where multiple leaderboard wallets hold or held a
// position. Outcome 0 = YES, 1 = NO (Polymarket binary convention, matching outcomeLabel
// elsewhere). Derived at read time from the leaderboard-scoped wallet_positions /
// wallet_closed_positions / wallet_trades caches — no precompute.
export interface CrowdedMarketSummary {
  conditionId: string;
  market: string | null;        // question text
  traderCount: number;          // distinct leaderboard wallets in this market
  yesTraders: number;           // wallets whose position is YES (outcome 0)
  noTraders: number;            // wallets whose position is NO (outcome 1)
  openCount: number;            // wallets still holding
  closedCount: number;          // wallets fully closed out
  committedUsd: number;         // gross leaderboard capital committed (YES + NO cost basis)
  netExposureUsd: number;       // YES cost basis − NO cost basis (signed toward YES)
  topRank: number | null;       // best (lowest-number) leaderboard rank among participants
  curPrice: number | null;      // current YES price, when known
  lastTradedAt: string | null;  // most recent tracked leaderboard fill in this market
}

// One tracked fill in a participant's per-market ledger.
export interface CrowdFill {
  outcomeIndex: number | null;
  side: string | null;
  price: number | null;
  size: number | null;
  usdcSize: number | null;
  tradedAt: string;
}

// One leaderboard wallet's stake in a crowded market's detail view. Position state prefers the
// authoritative caches (wallet_positions for open, wallet_closed_positions for closed); the
// first/last dates and fill ledger come from the tracked wallet_trades fills in this market.
export interface CrowdParticipant {
  address: string;
  handle: string | null;
  rank: number | null;
  skillScore: number | null;
  outcomeIndex: number | null;
  side: "YES" | "NO" | "—";
  state: "open" | "closed";
  size: number;                 // shares held (open) or size closed
  avgEntry: number | null;      // cost basis
  curPrice: number | null;      // current mark (open positions)
  value: number | null;         // current value at mark (open positions)
  pnl: number | null;           // unrealized (open) or realized (closed) USD
  pnlPct: number | null;
  firstTradedAt: string | null; // earliest tracked fill date in this market
  lastTradedAt: string | null;  // latest tracked fill date in this market
  fills: CrowdFill[];           // this wallet's tracked fills in this market, newest-first
}

// One UTC day on the convergence timeline: cumulative net leaderboard holdings on each side,
// reconstructed forward from the tracked fills, plus the day's YES market price when known.
export interface CrowdTimelinePoint {
  ts: string;                   // UTC day ("YYYY-MM-DD")
  yesShares: number;            // cumulative net shares held on YES
  noShares: number;             // cumulative net shares held on NO
  yesCostUsd: number;           // cumulative net USDC cost on YES
  noCostUsd: number;            // cumulative net USDC cost on NO
  price: number | null;         // YES token price that day (best-effort)
}

export interface CrowdMarketDetail {
  conditionId: string;
  market: string | null;
  curPrice: number | null;
  traderCount: number;
  yesTraders: number;
  noTraders: number;
  totalVolumeUsd: number;
  netExposureUsd: number;
  participants: CrowdParticipant[];
  timeline: CrowdTimelinePoint[];
}

export interface Database {
  public: {
    Tables: {
      wallets: {
        Row: {
          address: string;
          is_bot_suspected: boolean;
          is_claimed: boolean;
          handle: string | null;
          bio: string | null;
          links: Record<string, unknown> | null;
          lifetime_pnl: number | null;
          first_seen_at: string;
          updated_at: string;
        };
        Insert: {
          address: string;
          is_bot_suspected?: boolean;
          is_claimed?: boolean;
          handle?: string | null;
          bio?: string | null;
          links?: Record<string, unknown> | null;
          lifetime_pnl?: number | null;
        };
        Update: {
          is_bot_suspected?: boolean;
          is_claimed?: boolean;
          handle?: string | null;
          bio?: string | null;
          links?: Record<string, unknown> | null;
          lifetime_pnl?: number | null;
        };
        Relationships: [];
      };
      wallet_stats: {
        Row: {
          address: string;
          horizon_days: number;
          skill_score: number | null;
          pct_return: number | null;
          win_rate: number | null;          total_pnl_usd: number | null;
          unrealized_pnl_usd: number | null;
          total_volume_usd: number | null;
          n_trades: number | null;
          pct_edge: number | null;
          avg_edge_per_share: number | null;
          n_resolved: number | null;
          computed_at: string;
        };
        Insert: {
          address: string;
          horizon_days: number;
          skill_score?: number | null;
          pct_return?: number | null;
          win_rate?: number | null;          total_pnl_usd?: number | null;
          unrealized_pnl_usd?: number | null;
          total_volume_usd?: number | null;
          n_trades?: number | null;
          pct_edge?: number | null;
          avg_edge_per_share?: number | null;
          n_resolved?: number | null;
          computed_at?: string;
        };
        Update: {
          skill_score?: number | null;
          pct_return?: number | null;
          win_rate?: number | null;          total_pnl_usd?: number | null;
          unrealized_pnl_usd?: number | null;
          total_volume_usd?: number | null;
          n_trades?: number | null;
          pct_edge?: number | null;
          avg_edge_per_share?: number | null;
          n_resolved?: number | null;
          computed_at?: string;
        };
        Relationships: [];
      };
      equity_curve: {
        Row: {
          id: number;
          address: string;
          horizon_days: number;
          ts: string;
          cumulative_pnl: number | null;
        };
        Insert: {
          address: string;
          horizon_days: number;
          ts: string;
          cumulative_pnl?: number | null;
        };
        Update: {
          cumulative_pnl?: number | null;
        };
        Relationships: [];
      };
      leaderboard_cache: {
        Row: {
          horizon_days: number;
          rank: number;
          address: string;
          skill_score: number | null;
          pct_return: number | null;
          win_rate: number | null;
          n_trades: number | null;
          avg_edge_per_share: number | null;
          cached_at: string;
        };
        Insert: {
          horizon_days: number;
          rank: number;
          address: string;
          skill_score?: number | null;
          pct_return?: number | null;
          win_rate?: number | null;
          n_trades?: number | null;
          avg_edge_per_share?: number | null;
          cached_at?: string;
        };
        Update: {
          skill_score?: number | null;
          pct_return?: number | null;
          win_rate?: number | null;
          n_trades?: number | null;
          avg_edge_per_share?: number | null;
          cached_at?: string;
        };
        Relationships: [];
      };
      markets: {
        Row: {
          id: string;
          condition_id: string | null;
          question: string;
          slug: string | null;
          category: string | null;
          liquidity_usd: number | null;
          volume_usd: number | null;
          volume_24hr_usd: number | null;
          volume_1wk_usd: number | null;
          one_day_price_change: number | null;
          spread: number | null;
          last_trade_price: number | null;
          top_outcome: string | null;
          outcomes: string[] | null;
          outcome_prices: number[] | null;
          end_date: string | null;
          image: string | null;
          active: boolean;
          closed: boolean;
          cached_at: string;
        };
        Insert: {
          id: string;
          condition_id?: string | null;
          question: string;
          slug?: string | null;
          category?: string | null;
          liquidity_usd?: number | null;
          volume_usd?: number | null;
          volume_24hr_usd?: number | null;
          volume_1wk_usd?: number | null;
          one_day_price_change?: number | null;
          spread?: number | null;
          last_trade_price?: number | null;
          top_outcome?: string | null;
          outcomes?: string[] | null;
          outcome_prices?: number[] | null;
          end_date?: string | null;
          image?: string | null;
          active?: boolean;
          closed?: boolean;
          cached_at?: string;
        };
        Update: {
          condition_id?: string | null;
          question?: string;
          slug?: string | null;
          category?: string | null;
          liquidity_usd?: number | null;
          volume_usd?: number | null;
          volume_24hr_usd?: number | null;
          volume_1wk_usd?: number | null;
          one_day_price_change?: number | null;
          spread?: number | null;
          last_trade_price?: number | null;
          top_outcome?: string | null;
          outcomes?: string[] | null;
          outcome_prices?: number[] | null;
          end_date?: string | null;
          image?: string | null;
          active?: boolean;
          closed?: boolean;
          cached_at?: string;
        };
        Relationships: [];
      };
      recent_trades: {
        Row: {
          id: number;
          address: string;
          condition_id: string | null;
          market: string | null;
          outcome_index: number | null;
          side: string | null;
          price: number | null;
          size: number | null;
          usdc_size: number | null;
          traded_at: string;
          ingested_at: string;
        };
        Insert: {
          address: string;
          condition_id?: string | null;
          market?: string | null;
          outcome_index?: number | null;
          side?: string | null;
          price?: number | null;
          size?: number | null;
          usdc_size?: number | null;
          traded_at: string;
          ingested_at?: string;
        };
        Update: {
          condition_id?: string | null;
          market?: string | null;
          outcome_index?: number | null;
          side?: string | null;
          price?: number | null;
          size?: number | null;
          usdc_size?: number | null;
          traded_at?: string;
          ingested_at?: string;
        };
        Relationships: [];
      };
      wallet_positions: {
        Row: {
          id: number;
          address: string;
          condition_id: string | null;
          asset: string;
          market: string | null;
          outcome_index: number | null;
          size: number | null;
          avg_price: number | null;
          cur_price: number | null;
          initial_value: number | null;
          current_value: number | null;
          cash_pnl: number | null;
          end_date: string | null;
          first_traded_at: string | null;
          last_traded_at: string | null;
          ingested_at: string;
        };
        Insert: {
          address: string;
          condition_id?: string | null;
          asset: string;
          market?: string | null;
          outcome_index?: number | null;
          size?: number | null;
          avg_price?: number | null;
          cur_price?: number | null;
          initial_value?: number | null;
          current_value?: number | null;
          cash_pnl?: number | null;
          end_date?: string | null;
          first_traded_at?: string | null;
          last_traded_at?: string | null;
          ingested_at?: string;
        };
        Update: {
          condition_id?: string | null;
          asset?: string;
          market?: string | null;
          outcome_index?: number | null;
          size?: number | null;
          avg_price?: number | null;
          cur_price?: number | null;
          initial_value?: number | null;
          current_value?: number | null;
          cash_pnl?: number | null;
          end_date?: string | null;
          first_traded_at?: string | null;
          last_traded_at?: string | null;
          ingested_at?: string;
        };
        Relationships: [];
      };
      wallet_trades: {
        Row: {
          id: number;
          address: string;
          condition_id: string | null;
          market: string | null;
          outcome_index: number | null;
          side: string | null;
          price: number | null;
          size: number | null;
          usdc_size: number | null;
          traded_at: string;
          transaction_hash: string | null;
          ingested_at: string;
        };
        Insert: {
          address: string;
          condition_id?: string | null;
          market?: string | null;
          outcome_index?: number | null;
          side?: string | null;
          price?: number | null;
          size?: number | null;
          usdc_size?: number | null;
          traded_at: string;
          transaction_hash?: string | null;
          ingested_at?: string;
        };
        Update: {
          condition_id?: string | null;
          market?: string | null;
          outcome_index?: number | null;
          side?: string | null;
          price?: number | null;
          size?: number | null;
          usdc_size?: number | null;
          traded_at?: string;
          transaction_hash?: string | null;
          ingested_at?: string;
        };
        Relationships: [];
      };
      wallet_closed_positions: {
        Row: {
          id: number;
          address: string;
          condition_id: string | null;
          outcome_index: number | null;
          market: string | null;
          avg_price: number | null;
          realized_pnl: number | null;
          size: number | null;
          close_time: string | null;
          first_traded_at: string | null;
          ingested_at: string;
        };
        Insert: {
          address: string;
          condition_id?: string | null;
          outcome_index?: number | null;
          market?: string | null;
          avg_price?: number | null;
          realized_pnl?: number | null;
          size?: number | null;
          close_time?: string | null;
          first_traded_at?: string | null;
          ingested_at?: string;
        };
        Update: {
          condition_id?: string | null;
          outcome_index?: number | null;
          market?: string | null;
          avg_price?: number | null;
          realized_pnl?: number | null;
          size?: number | null;
          close_time?: string | null;
          first_traded_at?: string | null;
          ingested_at?: string;
        };
        Relationships: [];
      };
      market_price_history: {
        Row: {
          asset: string;
          condition_id: string | null;
          ts: string;
          price: number;
        };
        Insert: {
          asset: string;
          condition_id?: string | null;
          ts: string;
          price: number;
        };
        Update: {
          condition_id?: string | null;
          price?: number;
        };
        Relationships: [];
      };
      waitlist: {
        Row: {
          id: number;
          email: string;
          source: string | null;
          created_at: string;
        };
        Insert: {
          email: string;
          source?: string | null;
          created_at?: string;
        };
        Update: {
          email?: string;
          source?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
