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
  // Market category the wallet is demonstrably best at, or null if it has no standout specialty.
  specialty: string | null;
  // Polymarket leaderboards this wallet ranks in the top N of, as "code:rank" entries (e.g.
  // "pnl-all:3", "vol-month:241"); empty if none. See parseChip for display.
  leaderboardChips: string[];
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
  // Real outcome label ("Over"/"Under"/team/"Yes"/"No") and event slug from Polymarket, so the row
  // shows which side was taken and which event it was (the market title alone can omit both).
  outcomeLabel: string | null;
  eventSlug: string | null;
  avgEntryPrice: number | null;
  avgExitPrice: number | null;
  totalBoughtSize: number;
  totalSoldSize: number;
  totalUsdc: number;
  // Realized P/L for the position, from the closed-positions cache (null when still fully open or no
  // matching closed row). Backfilled by applyClosedBasis, not derived from the windowed fills.
  realizedPnl: number | null;
  // Realized P/L as a fraction of cost basis (realizedPnl / (avgPrice·size) of the closed row). Same
  // source as realizedPnl so the two reconcile; null when there's no usable cost basis.
  realizedPnlPct: number | null;
  latestTradedAt: string;
  fills: WalletFill[];
}

export interface WalletProfile {
  address: string;
  handle: string | null;
  bio: string | null;
  isClaimed: boolean;
  isBotSuspected: boolean;
  // Polymarket leaderboards this wallet ranks on, as "code:rank" entries (see parseChip).
  leaderboardChips: string[];
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
  conditionId: string | null;
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
// for open, wallet_closed_positions for closed) and falls back to the blended fill history, then
// in-window fills. `basisSource` records where avgEntry came from:
// - "cache"  = Polymarket position data (wallet_positions or wallet_closed_positions)
// - "trades" = wallet_trades fill history (pre-window buys blended with in-window adds, covers most
//              positions beyond the 24h window)
// - "fills"  = in-window fills only (24h window)
// - "none"   = genuinely unknown (no buy data available anywhere)
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
  basisSource: "cache" | "trades" | "fills" | "none";
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

// One row of the "Fresh Entries" signal: a market the most leaderboard wallets *just opened a new
// position* in (flow), the counterpart to CrowdedMarketSummary's holdings (stock). Served from
// fresh_entries_cache, precomputed by the ~10-min feed run.
export interface FreshEntrySummary {
  conditionId: string;
  market: string | null;        // question text
  entrantCount: number;         // distinct leaderboard wallets newly entering in-window (headline)
  skillWeight: number;          // sum of entrants' skill scores (sort tiebreak)
  topSkill: number | null;      // best single entrant skill score
  yesEntrants: number;          // entrants who entered on YES (outcome 0)
  noEntrants: number;           // entrants who entered on NO (outcome 1)
  committedUsd: number;         // total in-window buy USDC from the new entrants
  topRank: number | null;       // best (lowest-number) leaderboard rank among entrants
  lastEntryAt: string | null;   // most recent new-entry fill
}

// One row of the limited-time World Cup board: a trader ranked purely by forecasting edge on World
// Cup soccer markets. Served from world_cup_cache, precomputed by the daily full ingest.
export interface WorldCupRow {
  rank: number;
  address: string;
  handle: string | null;
  score: number;                // 0-10 World Cup skill score
  nBets: number;                // resolved WC bets (sample size)
  winRate: number;              // 0-1
  avgEdgePerShare: number;      // per-position mean (outcome − entry) on WC bets
  pnlUsd: number;               // realized $ on resolved WC bets
  openBets: number;             // current open WC positions (live conviction)
  topMarket: string | null;     // largest open WC position's market title
  topSide: "YES" | "NO" | null; // its side
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

// ── Resolved Markets panel ────────────────────────────────────────────────────
// One leaderboard wallet's closed position in a confirmed-resolved market.
export interface ResolvedParticipant {
  address: string;
  handle: string | null;
  rank: number | null;
  skillScore: number | null;
  outcomeIndex: number | null;
  side: "YES" | "NO" | "—";
  won: boolean;
  avgEntry: number | null;
  size: number;
  realizedPnl: number | null;
  realizedPct: number | null;
  closeTime: string | null;
  firstTradedAt: string | null;
}

// One confirmed-resolved market, aggregated from the leaderboard's closed positions.
export interface ResolvedMarket {
  conditionId: string;
  market: string | null;
  winningOutcomeIndex: number;
  winningSide: "YES" | "NO";
  resolvedAt: string;
  traderCount: number;
  winners: number;
  losers: number;
  totalRealizedPnl: number;
  participants: ResolvedParticipant[];
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

// ── Decision Engine ───────────────────────────────────────────────────────────

// One of six signals that contribute to a recommendation's confidence.
export interface DecisionSignalResult {
  name: string;
  description: string;
  fired: boolean;
  strength: "none" | "weak" | "moderate" | "strong";
  value: string;
}

// One leaderboard wallet holding a position that drives a recommendation.
export interface SmartMoneyHolder {
  address: string;
  handle: string | null;
  rank: number | null;
  skillScore: number;
  side: "YES" | "NO";
  avgEntry: number;
  size: number;
  currentValue: number;
  lastTradedAt: string | null;
}

export type ConfidenceLevel = "low" | "medium" | "high" | "very_high";

// One trade recommendation from the Decision Engine.
export interface TradeRecommendation {
  conditionId: string;
  market: string;
  side: "YES" | "NO";
  maxEntryPrice: number;
  currentPrice: number;
  smartMoneyPrice: number;
  edgeCents: number;
  edgePct: number;
  confidenceLevel: ConfidenceLevel;
  confidenceRange: [number, number];
  signalsFired: number;
  totalSignals: number;
  signals: DecisionSignalResult[];
  topHolders: SmartMoneyHolder[];
  holderCount: number;
  avgHolderSkill: number;
  totalCommittedUsd: number;
  category: string | null;
  slug: string | null;
  endDate: string | null;
  daysToExpiry: number | null;
  liquidityUsd: number;
  spread: number | null;
  image: string | null;
  explanation: string;
  warnings: string[];
  rankingScore: number;
}

export interface DecisionEngineUniverseSummary {
  marketsScanned: number;
  marketsWithSmartMoney: number;
  totalLeaderboardHolders: number;
  generatedAt: string;
}

export interface DecisionEngineResult {
  recommendations: TradeRecommendation[];
  universeSummary: DecisionEngineUniverseSummary;
  disclaimer: string;
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
          specialty: string | null;
          leaderboard_chips: string[] | null;
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
          specialty?: string | null;
          leaderboard_chips?: string[] | null;
        };
        Update: {
          is_bot_suspected?: boolean;
          is_claimed?: boolean;
          handle?: string | null;
          bio?: string | null;
          links?: Record<string, unknown> | null;
          lifetime_pnl?: number | null;
          specialty?: string | null;
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
      world_cup_cache: {
        Row: {
          address: string;
          rank: number;
          handle: string | null;
          score: number;
          n_bets: number;
          win_rate: number;
          avg_edge_per_share: number;
          pnl_usd: number;
          open_bets: number;
          top_market: string | null;
          top_side: string | null;
          cached_at: string;
        };
        Insert: {
          address: string;
          rank: number;
          handle?: string | null;
          score: number;
          n_bets: number;
          win_rate: number;
          avg_edge_per_share: number;
          pnl_usd: number;
          open_bets: number;
          top_market?: string | null;
          top_side?: string | null;
          cached_at?: string;
        };
        Update: {
          rank?: number;
          cached_at?: string;
        };
        Relationships: [];
      };
      crowded_markets_cache: {
        Row: {
          condition_id: string;
          rank: number;
          market: string | null;
          trader_count: number;
          yes_traders: number;
          no_traders: number;
          open_count: number;
          closed_count: number;
          committed_usd: number;
          net_exposure_usd: number;
          top_rank: number | null;
          cur_price: number | null;
          last_traded_at: string | null;
          cached_at: string;
        };
        Insert: {
          condition_id: string;
          rank: number;
          market?: string | null;
          trader_count: number;
          yes_traders: number;
          no_traders: number;
          open_count: number;
          closed_count: number;
          committed_usd: number;
          net_exposure_usd: number;
          top_rank?: number | null;
          cur_price?: number | null;
          last_traded_at?: string | null;
          cached_at?: string;
        };
        Update: {
          rank?: number;
          cached_at?: string;
        };
        Relationships: [];
      };
      fresh_entries_cache: {
        Row: {
          condition_id: string;
          rank: number;
          market: string | null;
          entrant_count: number;
          skill_weight: number;
          top_skill: number | null;
          yes_entrants: number;
          no_entrants: number;
          committed_usd: number;
          top_rank: number | null;
          last_entry_at: string | null;
          cached_at: string;
        };
        Insert: {
          condition_id: string;
          rank: number;
          market?: string | null;
          entrant_count: number;
          skill_weight: number;
          top_skill?: number | null;
          yes_entrants: number;
          no_entrants: number;
          committed_usd: number;
          top_rank?: number | null;
          last_entry_at?: string | null;
          cached_at?: string;
        };
        Update: {
          rank?: number;
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
          outcome_label: string | null;
          event_slug: string | null;
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
          outcome_label: string | null;
          event_slug: string | null;
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
