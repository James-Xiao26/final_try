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
  conditionId: string | null;
  market: string | null;
  outcomeIndex: number | null;
  side: string | null;
  price: number | null;
  size: number | null;
  usdcSize: number | null;
  tradedAt: string;
}

export interface RecentTradesFeed {
  trades: RecentTrade[];
  // Distinct leaderboard wallets that traded within the window.
  traderCount: number;
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
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
