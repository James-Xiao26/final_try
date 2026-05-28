export const HORIZONS = [30, 90, 365] as const;
export type HorizonDays = (typeof HORIZONS)[number];

export interface LeaderboardRow {
  rank: number;
  address: string;
  skillScore: number;
  pctReturn: number;
  winRate: number;
  maxDrawdown: number;
  nTrades: number;
  handle: string | null;
}

export interface WalletMetrics {
  horizonDays: number;
  skillScore: number | null;
  pctReturn: number;
  winRate: number;
  maxDrawdown: number;
  totalPnlUsd: number;
  totalVolumeUsd: number;
  nTrades: number;
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
        };
        Update: {
          is_bot_suspected?: boolean;
          is_claimed?: boolean;
          handle?: string | null;
          bio?: string | null;
          links?: Record<string, unknown> | null;
        };
        Relationships: [];
      };
      wallet_stats: {
        Row: {
          address: string;
          horizon_days: number;
          skill_score: number | null;
          pct_return: number | null;
          win_rate: number | null;
          max_drawdown: number | null;
          total_pnl_usd: number | null;
          total_volume_usd: number | null;
          n_trades: number | null;
          computed_at: string;
        };
        Insert: {
          address: string;
          horizon_days: number;
          skill_score?: number | null;
          pct_return?: number | null;
          win_rate?: number | null;
          max_drawdown?: number | null;
          total_pnl_usd?: number | null;
          total_volume_usd?: number | null;
          n_trades?: number | null;
          computed_at?: string;
        };
        Update: {
          skill_score?: number | null;
          pct_return?: number | null;
          win_rate?: number | null;
          max_drawdown?: number | null;
          total_pnl_usd?: number | null;
          total_volume_usd?: number | null;
          n_trades?: number | null;
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
          max_drawdown: number | null;
          n_trades: number | null;
          cached_at: string;
        };
        Insert: {
          horizon_days: number;
          rank: number;
          address: string;
          skill_score?: number | null;
          pct_return?: number | null;
          win_rate?: number | null;
          max_drawdown?: number | null;
          n_trades?: number | null;
          cached_at?: string;
        };
        Update: {
          skill_score?: number | null;
          pct_return?: number | null;
          win_rate?: number | null;
          max_drawdown?: number | null;
          n_trades?: number | null;
          cached_at?: string;
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
