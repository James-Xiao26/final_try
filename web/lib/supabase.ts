import { createBrowserClient, createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { Database, EquityPoint, HorizonDays, LeaderboardRow, WalletMetrics, WalletProfile } from "./types";
import { HORIZONS } from "./types";

type WalletRow = Database["public"]["Tables"]["wallets"]["Row"];
type WalletStatsRow = Database["public"]["Tables"]["wallet_stats"]["Row"];
type EquityCurveRow = Database["public"]["Tables"]["equity_curve"]["Row"];
type LeaderboardCacheRow = Database["public"]["Tables"]["leaderboard_cache"]["Row"];
type LeaderboardSelectRow = Pick<LeaderboardCacheRow, "rank" | "address" | "skill_score" | "avg_edge_per_share" | "win_rate" | "n_trades">;
type WalletHandleRow = Pick<WalletRow, "address" | "handle">;
type WalletProfileRow = Pick<WalletRow, "address" | "handle" | "bio" | "is_claimed" | "is_bot_suspected">;
type CurveSelectRow = Pick<EquityCurveRow, "horizon_days" | "ts" | "cumulative_pnl">;
type RankSelectRow = Pick<LeaderboardCacheRow, "rank" | "horizon_days">;

function env(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }

  return value;
}

export function createSupabaseServerClient() {
  const cookieStore = cookies();

  return createServerClient<Database>(
    env("NEXT_PUBLIC_SUPABASE_URL"),
    env("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    {
      cookies: {
        get(name: string) {
          return cookieStore.get(name)?.value;
        },
        set() {
          return undefined;
        },
        remove() {
          return undefined;
        }
      }
    }
  );
}

export function createSupabaseBrowserClient() {
  return createBrowserClient<Database>(
    env("NEXT_PUBLIC_SUPABASE_URL"),
    env("NEXT_PUBLIC_SUPABASE_ANON_KEY")
  );
}

function toNumber(value: number | null): number {
  return typeof value === "number" ? value : 0;
}

function isMissingSchemaError(error: { code?: string } | null): boolean {
  return error?.code === "PGRST205";
}

export async function getLeaderboard(horizonDays: number): Promise<LeaderboardRow[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("leaderboard_cache")
    .select("rank, address, skill_score, avg_edge_per_share, win_rate, n_trades")
    .eq("horizon_days", horizonDays)
    .order("rank", { ascending: true });

  if (error) {
    if (isMissingSchemaError(error)) {
      return [];
    }

    throw error;
  }

  const leaderboardRows = (data ?? []) as unknown as LeaderboardSelectRow[];
  const addresses = leaderboardRows.map((row) => row.address);
  const handles = new Map<string, string | null>();
  if (addresses.length > 0) {
    const { data: wallets, error: walletError } = await supabase
      .from("wallets")
      .select("address, handle")
      .in("address", addresses);

    if (walletError) {
      if (isMissingSchemaError(walletError)) {
        return [];
      }

      throw walletError;
    }

    const walletRows = (wallets ?? []) as unknown as WalletHandleRow[];
    walletRows.forEach((wallet) => handles.set(wallet.address, wallet.handle));
  }

  return leaderboardRows.map((row) => ({
    rank: row.rank,
    address: row.address,
    skillScore: toNumber(row.skill_score),
    avgEdgePerShare: toNumber(row.avg_edge_per_share),
    winRate: toNumber(row.win_rate),
    nTrades: row.n_trades ?? 0,
    handle: handles.get(row.address) ?? null
  }));
}

function mapMetric(row: Database["public"]["Tables"]["wallet_stats"]["Row"]): WalletMetrics {
  return {
    horizonDays: row.horizon_days,
    skillScore: row.skill_score,
    pctReturn: toNumber(row.pct_return),
    winRate: toNumber(row.win_rate),
    totalPnlUsd: toNumber(row.total_pnl_usd),
    unrealizedPnlUsd: toNumber(row.unrealized_pnl_usd),
    totalVolumeUsd: toNumber(row.total_volume_usd),
    nTrades: row.n_trades ?? 0,
    avgEdgePerShare: toNumber(row.avg_edge_per_share),
    nResolved: row.n_resolved ?? 0
  };
}

function emptyCurveMap(): Record<HorizonDays, EquityPoint[]> {
  return {
    30: [],
    90: [],
    365: []
  };
}

export async function getWalletProfile(address: string): Promise<WalletProfile | null> {
  const supabase = createSupabaseServerClient();
  const normalized = address.toLowerCase();
  const { data: walletData, error: walletError } = await supabase
    .from("wallets")
    .select("address, handle, bio, is_claimed, is_bot_suspected")
    .eq("address", normalized)
    .maybeSingle();

  if (walletError) {
    if (isMissingSchemaError(walletError)) {
      return null;
    }

    throw walletError;
  }

  if (!walletData) {
    return null;
  }

  const wallet = walletData as unknown as WalletProfileRow;
  const [{ data: stats, error: statsError }, { data: curves, error: curvesError }, { data: ranks, error: ranksError }] = await Promise.all([
    supabase.from("wallet_stats").select("*").eq("address", normalized).in("horizon_days", [...HORIZONS]).order("horizon_days"),
    supabase.from("equity_curve").select("horizon_days, ts, cumulative_pnl").eq("address", normalized).in("horizon_days", [...HORIZONS]).order("ts"),
    supabase.from("leaderboard_cache").select("rank, horizon_days").eq("address", normalized).order("horizon_days")
  ]);

  if (statsError) {
    if (isMissingSchemaError(statsError)) {
      return null;
    }

    throw statsError;
  }
  if (curvesError) {
    if (isMissingSchemaError(curvesError)) {
      return null;
    }

    throw curvesError;
  }
  if (ranksError) {
    if (isMissingSchemaError(ranksError)) {
      return null;
    }

    throw ranksError;
  }

  const equityCurves = emptyCurveMap();
  const curveRows = (curves ?? []) as unknown as CurveSelectRow[];
  curveRows.forEach((point) => {
    if (HORIZONS.includes(point.horizon_days as HorizonDays)) {
      equityCurves[point.horizon_days as HorizonDays].push({
        ts: point.ts,
        cumulativePnl: toNumber(point.cumulative_pnl)
      });
    }
  });

  return {
    address: wallet.address,
    handle: wallet.handle,
    bio: wallet.bio,
    isClaimed: wallet.is_claimed,
    isBotSuspected: wallet.is_bot_suspected,
    metrics: ((stats ?? []) as unknown as WalletStatsRow[]).map(mapMetric),
    equityCurve: equityCurves[90],
    equityCurves,
    badges: ((ranks ?? []) as unknown as RankSelectRow[]).map((rank) => ({
      label: `Top ${rank.rank} - ${rank.horizon_days}D`,
      horizonDays: rank.horizon_days
    }))
  };
}
