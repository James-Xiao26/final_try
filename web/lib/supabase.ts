import { createBrowserClient, createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { Database, EquityPoint, HorizonDays, LeaderboardRow, MarketRow, MarketSort, RecentTrade, RecentTradesFeed, WalletMetrics, WalletProfile } from "./types";
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
type RecentTradeRowDb = Database["public"]["Tables"]["recent_trades"]["Row"];
type RecentTradeSelectRow = Pick<
  RecentTradeRowDb,
  "address" | "condition_id" | "market" | "outcome_index" | "side" | "price" | "size" | "usdc_size" | "traded_at"
>;
type SkillSelectRow = Pick<LeaderboardCacheRow, "address" | "skill_score">;
type MarketRowDb = Database["public"]["Tables"]["markets"]["Row"];
type MarketSelectRow = Pick<
  MarketRowDb,
  | "id"
  | "question"
  | "slug"
  | "category"
  | "liquidity_usd"
  | "volume_usd"
  | "volume_24hr_usd"
  | "volume_1wk_usd"
  | "last_trade_price"
  | "top_outcome"
  | "one_day_price_change"
  | "end_date"
  | "image"
>;

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

// Landing-page activity feed: recent fills, restricted to wallets currently on the leaderboard.
// recent_trades holds fills for every leaderboard-eligible wallet; the join to leaderboard_cache both
// enforces "is on the leaderboard right now" and supplies the skill score (best across horizons).
export async function getRecentLeaderboardTrades(
  opts: { windowHours?: number; limit?: number } = {}
): Promise<RecentTradesFeed> {
  const supabase = createSupabaseServerClient();
  const windowHours = opts.windowHours ?? 24;
  const limit = opts.limit ?? 200;
  const cutoff = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from("recent_trades")
    .select("address, condition_id, market, outcome_index, side, price, size, usdc_size, traded_at")
    .gte("traded_at", cutoff)
    .order("traded_at", { ascending: false })
    .limit(limit);

  if (error) {
    if (isMissingSchemaError(error)) {
      return { trades: [], traderCount: 0 };
    }

    throw error;
  }

  const tradeRows = (data ?? []) as unknown as RecentTradeSelectRow[];
  if (tradeRows.length === 0) {
    return { trades: [], traderCount: 0 };
  }

  const addresses = [...new Set(tradeRows.map((row) => row.address))];
  const { data: cacheData, error: cacheError } = await supabase
    .from("leaderboard_cache")
    .select("address, skill_score")
    .in("address", addresses);

  if (cacheError) {
    if (isMissingSchemaError(cacheError)) {
      return { trades: [], traderCount: 0 };
    }

    throw cacheError;
  }

  // Best (highest) skill score per address across horizons; presence in this map == on the leaderboard.
  const skillByAddress = new Map<string, number | null>();
  ((cacheData ?? []) as unknown as SkillSelectRow[]).forEach((row) => {
    const next = row.skill_score;
    const prev = skillByAddress.get(row.address);
    if (prev === undefined || (next !== null && (prev === null || next > prev))) {
      skillByAddress.set(row.address, next);
    }
  });

  const memberAddresses = [...skillByAddress.keys()];
  const handles = new Map<string, string | null>();
  if (memberAddresses.length > 0) {
    const { data: wallets, error: walletError } = await supabase
      .from("wallets")
      .select("address, handle")
      .in("address", memberAddresses);

    if (walletError) {
      if (isMissingSchemaError(walletError)) {
        return { trades: [], traderCount: 0 };
      }

      throw walletError;
    }

    ((wallets ?? []) as unknown as WalletHandleRow[]).forEach((wallet) => handles.set(wallet.address, wallet.handle));
  }

  const trades: RecentTrade[] = tradeRows
    .filter((row) => skillByAddress.has(row.address))
    .map((row) => ({
      address: row.address,
      handle: handles.get(row.address) ?? null,
      skillScore: skillByAddress.get(row.address) ?? null,
      conditionId: row.condition_id,
      market: row.market,
      outcomeIndex: row.outcome_index,
      side: row.side,
      price: row.price,
      size: row.size,
      usdcSize: row.usdc_size,
      tradedAt: row.traded_at
    }));

  const traderCount = new Set(trades.map((trade) => trade.address)).size;
  return { trades, traderCount };
}

const MARKET_SORT_COLUMNS: Record<MarketSort, keyof MarketSelectRow> = {
  liquidity: "liquidity_usd",
  volume: "volume_usd",
  volume_24hr: "volume_24hr_usd",
  // 24h change orders by the stored leading-outcome one-day price change.
  change: "one_day_price_change"
};

export async function getMarkets(
  opts: { sort?: MarketSort; category?: string | null; limit?: number } = {}
): Promise<MarketRow[]> {
  const supabase = createSupabaseServerClient();
  const sort = opts.sort ?? "liquidity";
  const column = MARKET_SORT_COLUMNS[sort];

  let query = supabase
    .from("markets")
    .select("id, question, slug, category, liquidity_usd, volume_usd, volume_24hr_usd, volume_1wk_usd, last_trade_price, top_outcome, one_day_price_change, end_date, image")
    .eq("active", true)
    .eq("closed", false)
    .order(column, { ascending: false, nullsFirst: false })
    .limit(opts.limit ?? 100);

  if (opts.category) {
    query = query.eq("category", opts.category);
  }

  const { data, error } = await query;

  if (error) {
    if (isMissingSchemaError(error)) {
      return [];
    }

    throw error;
  }

  const rows = (data ?? []) as unknown as MarketSelectRow[];
  return rows.map((row) => ({
    id: row.id,
    question: row.question,
    slug: row.slug ?? "",
    category: row.category,
    liquidityUsd: toNumber(row.liquidity_usd),
    volumeUsd: toNumber(row.volume_usd),
    volume24hrUsd: toNumber(row.volume_24hr_usd),
    volume1wkUsd: toNumber(row.volume_1wk_usd),
    currentPrice: row.last_trade_price,
    topOutcome: row.top_outcome,
    oneDayPriceChange: row.one_day_price_change,
    endDate: row.end_date,
    image: row.image
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
