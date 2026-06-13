import { createBrowserClient, createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import type { ClosedTrade, ClosedTradesFeed, CrowdedMarketSummary, CrowdMarketDetail, Database, EquityPoint, HorizonDays, LeaderboardRow, MarketRow, MarketSort, RecentTrade, RecentTradesFeed, WalletMetrics, WalletPosition, WalletProfile } from "./types";
import { HORIZONS } from "./types";
import { groupWalletTrades } from "./walletTrades";
import { groupRecentTrades, positionKey, type ClosedBasis, type OpenBasis } from "./recentTrades";
import { buildCrowdMarketDetail, summarizeCrowdedMarkets, type CrowdClosedPosition, type CrowdLookups, type CrowdOpenPosition, type CrowdTradeFill } from "./marketCrowd";

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
type SkillSelectRow = Pick<LeaderboardCacheRow, "address" | "skill_score" | "rank">;
type WalletPositionRowDb = Database["public"]["Tables"]["wallet_positions"]["Row"];
type WalletPositionSelectRow = Pick<
  WalletPositionRowDb,
  "condition_id" | "asset" | "market" | "outcome_index" | "size" | "avg_price" | "cur_price" | "initial_value" | "current_value" | "cash_pnl" | "end_date"
>;
type WalletTradeRowDb = Database["public"]["Tables"]["wallet_trades"]["Row"];
type WalletTradeSelectRow = Pick<
  WalletTradeRowDb,
  "condition_id" | "market" | "outcome_index" | "side" | "price" | "size" | "usdc_size" | "traded_at" | "transaction_hash"
>;
type WalletClosedPositionRowDb = Database["public"]["Tables"]["wallet_closed_positions"]["Row"];
// The feed's basis lookups: open state from wallet_positions, closed basis from wallet_closed_positions.
type FeedOpenPositionRow = Pick<
  WalletPositionRowDb,
  "address" | "condition_id" | "outcome_index" | "avg_price" | "cur_price" | "current_value" | "cash_pnl" | "size"
>;
type FeedClosedPositionRow = Pick<
  WalletClosedPositionRowDb,
  "address" | "condition_id" | "outcome_index" | "avg_price" | "realized_pnl" | "size"
>;
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

// Plain anon client for stateless server-side writes (the waitlist insert). The @supabase/ssr
// server client above is for session/cookie-bound reads; an anonymous INSERT needs no session, and
// that client's generics also mis-resolve write types (collapsing Insert to never). What this key
// may actually do is still governed by RLS — on `waitlist` that's INSERT-only, no read-back.
export function createSupabaseWriteClient() {
  return createClient<Database>(
    env("NEXT_PUBLIC_SUPABASE_URL"),
    env("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    { auth: { persistSession: false } }
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
      return { positions: [], traderCount: 0 };
    }

    throw error;
  }

  const tradeRows = (data ?? []) as unknown as RecentTradeSelectRow[];
  if (tradeRows.length === 0) {
    return { positions: [], traderCount: 0 };
  }

  const addresses = [...new Set(tradeRows.map((row) => row.address))];
  const { data: cacheData, error: cacheError } = await supabase
    .from("leaderboard_cache")
    .select("address, skill_score, rank")
    .in("address", addresses);

  if (cacheError) {
    if (isMissingSchemaError(cacheError)) {
      return { positions: [], traderCount: 0 };
    }

    throw cacheError;
  }

  // Best (highest) skill score per address across horizons; presence in this map == on the leaderboard.
  const skillByAddress = new Map<string, number | null>();
  // Best (lowest-number = highest) leaderboard rank per address across horizons.
  const rankByAddress = new Map<string, number>();
  ((cacheData ?? []) as unknown as SkillSelectRow[]).forEach((row) => {
    const next = row.skill_score;
    const prev = skillByAddress.get(row.address);
    if (prev === undefined || (next !== null && (prev === null || next > prev))) {
      skillByAddress.set(row.address, next);
    }
    const prevRank = rankByAddress.get(row.address);
    if (prevRank === undefined || row.rank < prevRank) {
      rankByAddress.set(row.address, row.rank);
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
        return { positions: [], traderCount: 0 };
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
      rank: rankByAddress.get(row.address) ?? null,
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

  // Basis lookups for the grouped feed: open state (wallet_positions) and closed basis
  // (wallet_closed_positions) for the wallets that traded. Both are best-effort — a missing table
  // (migration not yet applied) just degrades to fills-only grouping, never an empty feed.
  const feedAddresses = [...new Set(trades.map((trade) => trade.address))];
  const openByKey = new Map<string, OpenBasis>();
  const closedByKey = new Map<string, ClosedBasis>();
  if (feedAddresses.length > 0) {
    // Active leaderboard wallets hold thousands of positions combined (the closed cache especially),
    // so these MUST page — a single PostgREST response caps at 1000 rows, which would silently drop
    // most positions and leave the feed unable to find their basis (→ "P/L n/a" on otherwise-known
    // positions). Page through with the same .range() helper the board-wide scans use.
    const [openRes, closedRes] = await Promise.all([
      fetchAllPaged((from, to) =>
        supabase
          .from("wallet_positions")
          .select("address, condition_id, outcome_index, avg_price, cur_price, current_value, cash_pnl, size")
          .in("address", feedAddresses)
          .range(from, to)
      ),
      fetchAllPaged((from, to) =>
        supabase
          .from("wallet_closed_positions")
          .select("address, condition_id, outcome_index, avg_price, realized_pnl, size")
          .in("address", feedAddresses)
          .range(from, to)
      )
    ]);

    (openRes.rows as unknown as FeedOpenPositionRow[]).forEach((row) => {
      openByKey.set(positionKey(row.address, row.condition_id, row.outcome_index), {
        avgEntry: row.avg_price,
        curPrice: row.cur_price,
        currentValue: row.current_value,
        cashPnl: row.cash_pnl,
        size: row.size
      });
    });
    (closedRes.rows as unknown as FeedClosedPositionRow[]).forEach((row) => {
      closedByKey.set(positionKey(row.address, row.condition_id, row.outcome_index), {
        avgEntry: row.avg_price,
        realizedPnl: row.realized_pnl,
        size: row.size
      });
    });
  }

  const positions = groupRecentTrades(trades, openByKey, closedByKey);
  return { positions, traderCount };
}

interface ClosedTradeSelectRow {
  address: string;
  condition_id: string | null;
  outcome_index: number | null;
  market: string | null;
  avg_price: number | null;
  realized_pnl: number | null;
  size: number | null;
  close_time: string | null;
}

// Fully-closed / resolved positions by leaderboard wallets in the last `windowHours`, newest close
// first. Reads wallet_closed_positions directly (already board-scoped, and the ingest folds in
// held-to-resolution positions), so it carries the realized $ P/L without any fill-window join —
// which is why it covers trades the Acoustic Log's grouping can't. Joins rank/skill/handle for
// display. Capped at `limit` most-recent closes (the table scrolls).
export async function getRecentClosedTrades(
  opts: { windowHours?: number; limit?: number } = {}
): Promise<ClosedTradesFeed> {
  const supabase = createSupabaseServerClient();
  const windowHours = opts.windowHours ?? 24;
  const limit = opts.limit ?? 300;
  const cutoff = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from("wallet_closed_positions")
    .select("address, condition_id, outcome_index, market, avg_price, realized_pnl, size, close_time")
    .gte("close_time", cutoff)
    .order("close_time", { ascending: false })
    .limit(limit);

  if (error) {
    if (isMissingSchemaError(error)) {
      return { trades: [], traderCount: 0 };
    }
    throw error;
  }

  const rows = (data ?? []) as unknown as ClosedTradeSelectRow[];
  if (rows.length === 0) {
    return { trades: [], traderCount: 0 };
  }

  const addresses = [...new Set(rows.map((row) => row.address))];
  const { data: cacheData, error: cacheError } = await supabase
    .from("leaderboard_cache")
    .select("address, skill_score, rank")
    .in("address", addresses);

  if (cacheError) {
    if (isMissingSchemaError(cacheError)) {
      return { trades: [], traderCount: 0 };
    }
    throw cacheError;
  }

  // Best (highest) skill score / best (lowest-number) rank per address across horizons; presence in
  // the map == currently on the leaderboard.
  const skillByAddress = new Map<string, number | null>();
  const rankByAddress = new Map<string, number>();
  ((cacheData ?? []) as unknown as SkillSelectRow[]).forEach((row) => {
    const next = row.skill_score;
    const prev = skillByAddress.get(row.address);
    if (prev === undefined || (next !== null && (prev === null || next > prev))) {
      skillByAddress.set(row.address, next);
    }
    const prevRank = rankByAddress.get(row.address);
    if (prevRank === undefined || row.rank < prevRank) {
      rankByAddress.set(row.address, row.rank);
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

  const trades: ClosedTrade[] = rows
    .filter((row) => skillByAddress.has(row.address) && row.close_time !== null)
    .map((row) => {
      const avgEntry = row.avg_price;
      const size = row.size;
      const realizedPnl = row.realized_pnl;
      const basis = avgEntry !== null && size !== null ? avgEntry * size : null;
      const realizedPct = realizedPnl !== null && basis !== null && basis > 0 ? realizedPnl / basis : null;
      return {
        address: row.address,
        handle: handles.get(row.address) ?? null,
        rank: rankByAddress.get(row.address) ?? null,
        skillScore: skillByAddress.get(row.address) ?? null,
        conditionId: row.condition_id,
        market: row.market,
        outcomeIndex: row.outcome_index,
        avgEntry,
        size,
        realizedPnl,
        realizedPct,
        closeTime: row.close_time as string
      };
    });

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
    90: []
  };
}

function mapWalletPosition(row: WalletPositionSelectRow): WalletPosition {
  return {
    conditionId: row.condition_id,
    asset: row.asset,
    market: row.market,
    outcomeIndex: row.outcome_index,
    size: toNumber(row.size),
    avgPrice: toNumber(row.avg_price),
    curPrice: toNumber(row.cur_price),
    initialValue: toNumber(row.initial_value),
    currentValue: toNumber(row.current_value),
    cashPnl: toNumber(row.cash_pnl),
    endDate: row.end_date
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
  const [
    { data: stats, error: statsError },
    { data: curves, error: curvesError },
    { data: ranks, error: ranksError },
    { data: positionsData, error: positionsError },
    { data: tradesData, error: tradesError }
  ] = await Promise.all([
    supabase.from("wallet_stats").select("*").eq("address", normalized).in("horizon_days", [...HORIZONS]).order("horizon_days"),
    supabase.from("equity_curve").select("horizon_days, ts, cumulative_pnl").eq("address", normalized).in("horizon_days", [...HORIZONS]).order("ts"),
    supabase.from("leaderboard_cache").select("rank, horizon_days").eq("address", normalized).order("horizon_days"),
    supabase.from("wallet_positions").select("condition_id, asset, market, outcome_index, size, avg_price, cur_price, initial_value, current_value, cash_pnl, end_date").eq("address", normalized),
    supabase.from("wallet_trades").select("condition_id, market, outcome_index, side, price, size, usdc_size, traded_at, transaction_hash").eq("address", normalized).order("traded_at", { ascending: false })
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
  // The detail tables (migration 002) are optional: if not yet applied, degrade to empty lists rather
  // than blanking the whole profile. Other errors still throw.
  if (positionsError && !isMissingSchemaError(positionsError)) {
    throw positionsError;
  }
  if (tradesError && !isMissingSchemaError(tradesError)) {
    throw tradesError;
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
    })),
    positions: ((positionsData ?? []) as unknown as WalletPositionSelectRow[]).map(mapWalletPosition),
    tradeGroups: groupWalletTrades((tradesData ?? []) as unknown as WalletTradeSelectRow[])
  };
}

// ── Convergence ("Crowded Markets") readers ─────────────────────────────────────
// The wallet_positions / wallet_closed_positions / wallet_trades caches are already scoped to
// leaderboard wallets by ingest, so these readers aggregate them directly. Mirrors the read-time
// pattern of getRecentLeaderboardTrades; degrades to empty on a missing table (migration not applied).

interface PagedResult {
  rows: unknown[];
  missing: boolean;
}

// PostgREST caps a single response at 1000 rows, so the board-wide position scans page through with
// .range(). The factory rebuilds the query per page (a query builder is single-use). Returns
// `missing: true` when the table itself isn't there yet, so callers can degrade gracefully.
async function fetchAllPaged(
  factory: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: { code?: string } | null }>
): Promise<PagedResult> {
  const PAGE = 1000;
  const rows: unknown[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await factory(from, from + PAGE - 1);
    if (error) {
      if (isMissingSchemaError(error)) {
        return { rows: [], missing: true };
      }
      throw error;
    }
    const batch = data ?? [];
    rows.push(...batch);
    if (batch.length < PAGE) {
      break;
    }
    from += PAGE;
  }
  return { rows, missing: false };
}

interface OpenPositionRowDb {
  address: string;
  condition_id: string | null;
  asset: string;
  market: string | null;
  outcome_index: number | null;
  size: number | null;
  avg_price: number | null;
  cur_price: number | null;
  current_value: number | null;
  cash_pnl: number | null;
  first_traded_at: string | null;
  last_traded_at: string | null;
}
interface ClosedPositionRowDb {
  address: string;
  condition_id: string | null;
  outcome_index: number | null;
  market: string | null;
  avg_price: number | null;
  realized_pnl: number | null;
  size: number | null;
  close_time: string | null;
  first_traded_at: string | null;
}
interface CrowdFillRowDb {
  address: string;
  condition_id: string | null;
  market: string | null;
  outcome_index: number | null;
  side: string | null;
  price: number | null;
  size: number | null;
  usdc_size: number | null;
  traded_at: string;
}

const OPEN_POSITION_COLUMNS = "address, condition_id, asset, market, outcome_index, size, avg_price, cur_price, current_value, cash_pnl, first_traded_at, last_traded_at";
const CLOSED_POSITION_COLUMNS = "address, condition_id, outcome_index, market, avg_price, realized_pnl, size, close_time, first_traded_at";
const CROWD_FILL_COLUMNS = "address, condition_id, market, outcome_index, side, price, size, usdc_size, traded_at";

function toOpenPosition(row: OpenPositionRowDb): CrowdOpenPosition {
  return {
    address: row.address,
    conditionId: row.condition_id,
    asset: row.asset,
    market: row.market,
    outcomeIndex: row.outcome_index,
    size: toNumber(row.size),
    avgPrice: toNumber(row.avg_price),
    curPrice: toNumber(row.cur_price),
    currentValue: toNumber(row.current_value),
    cashPnl: toNumber(row.cash_pnl),
    firstTradedAt: row.first_traded_at,
    lastTradedAt: row.last_traded_at
  };
}
function toClosedPosition(row: ClosedPositionRowDb): CrowdClosedPosition {
  return {
    address: row.address,
    conditionId: row.condition_id,
    outcomeIndex: row.outcome_index,
    market: row.market,
    avgPrice: toNumber(row.avg_price),
    realizedPnl: toNumber(row.realized_pnl),
    size: toNumber(row.size),
    closeTime: row.close_time,
    firstTradedAt: row.first_traded_at
  };
}
function toCrowdFill(row: CrowdFillRowDb): CrowdTradeFill {
  return {
    address: row.address,
    conditionId: row.condition_id,
    market: row.market,
    outcomeIndex: row.outcome_index,
    side: row.side,
    price: row.price,
    size: row.size,
    usdcSize: row.usdc_size,
    tradedAt: row.traded_at
  };
}

// Best (lowest-number) leaderboard rank per address across horizons.
async function leaderboardRanks(
  supabase: ReturnType<typeof createSupabaseServerClient>
): Promise<Map<string, number> | null> {
  const { data, error } = await supabase.from("leaderboard_cache").select("address, rank");
  if (error) {
    if (isMissingSchemaError(error)) {
      return null;
    }
    throw error;
  }
  const ranks = new Map<string, number>();
  ((data ?? []) as unknown as { address: string; rank: number }[]).forEach((row) => {
    const prev = ranks.get(row.address);
    if (prev === undefined || row.rank < prev) {
      ranks.set(row.address, row.rank);
    }
  });
  return ranks;
}

// The ranked "crowded markets" list for the Activity page: the markets the most leaderboard wallets
// are converging on, with the YES/NO split and committed capital. Built from the position caches only.
export async function getCrowdedMarkets(limit = 40): Promise<CrowdedMarketSummary[]> {
  const supabase = createSupabaseServerClient();

  const rankByAddress = await leaderboardRanks(supabase);
  if (rankByAddress === null || rankByAddress.size === 0) {
    return [];
  }

  const [openRes, closedRes] = await Promise.all([
    fetchAllPaged((from, to) => supabase.from("wallet_positions").select(OPEN_POSITION_COLUMNS).range(from, to)),
    fetchAllPaged((from, to) => supabase.from("wallet_closed_positions").select(CLOSED_POSITION_COLUMNS).range(from, to))
  ]);
  if (openRes.missing && closedRes.missing) {
    return [];
  }

  const positions = (openRes.rows as unknown as OpenPositionRowDb[]).map(toOpenPosition);
  const closed = (closedRes.rows as unknown as ClosedPositionRowDb[]).map(toClosedPosition);
  return summarizeCrowdedMarkets(positions, closed, { rankByAddress }, limit);
}

// Full detail for one market: per-wallet participants (sides, P/L, fill dates) + the convergence
// timeline (cumulative net leaderboard holdings, with the YES price overlaid when known). Returns
// null when no leaderboard wallet participates in the given condition.
export async function getCrowdMarketDetail(conditionId: string): Promise<CrowdMarketDetail | null> {
  const supabase = createSupabaseServerClient();

  const [openRes, closedRes, fillsRes] = await Promise.all([
    supabase.from("wallet_positions").select(OPEN_POSITION_COLUMNS).eq("condition_id", conditionId),
    supabase.from("wallet_closed_positions").select(CLOSED_POSITION_COLUMNS).eq("condition_id", conditionId),
    supabase.from("wallet_trades").select(CROWD_FILL_COLUMNS).eq("condition_id", conditionId).order("traded_at", { ascending: false })
  ]);

  for (const res of [openRes, closedRes, fillsRes]) {
    if (res.error && !isMissingSchemaError(res.error)) {
      throw res.error;
    }
  }

  const positions = ((openRes.data ?? []) as unknown as OpenPositionRowDb[]).map(toOpenPosition);
  const closed = ((closedRes.data ?? []) as unknown as ClosedPositionRowDb[]).map(toClosedPosition);
  const fills = ((fillsRes.data ?? []) as unknown as CrowdFillRowDb[]).map(toCrowdFill);

  const addresses = [
    ...new Set([...positions.map((p) => p.address), ...closed.map((p) => p.address), ...fills.map((f) => f.address)])
  ];
  if (addresses.length === 0) {
    return null;
  }

  // Handles + leaderboard rank/skill for the participating wallets.
  const [walletsRes, cacheRes] = await Promise.all([
    supabase.from("wallets").select("address, handle").in("address", addresses),
    supabase.from("leaderboard_cache").select("address, rank, skill_score").in("address", addresses)
  ]);
  if (walletsRes.error && !isMissingSchemaError(walletsRes.error)) {
    throw walletsRes.error;
  }
  if (cacheRes.error && !isMissingSchemaError(cacheRes.error)) {
    throw cacheRes.error;
  }

  const handleByAddress = new Map<string, string | null>();
  ((walletsRes.data ?? []) as unknown as { address: string; handle: string | null }[]).forEach((row) =>
    handleByAddress.set(row.address, row.handle)
  );
  const rankByAddress = new Map<string, number>();
  const skillByAddress = new Map<string, number | null>();
  ((cacheRes.data ?? []) as unknown as { address: string; rank: number; skill_score: number | null }[]).forEach((row) => {
    const prevRank = rankByAddress.get(row.address);
    if (prevRank === undefined || row.rank < prevRank) {
      rankByAddress.set(row.address, row.rank);
    }
    const prevSkill = skillByAddress.get(row.address);
    if (prevSkill === undefined || (row.skill_score !== null && (prevSkill === null || row.skill_score > prevSkill))) {
      skillByAddress.set(row.address, row.skill_score);
    }
  });

  // Daily YES price overlay, best-effort: market_price_history is keyed by outcome token (asset). Use
  // the YES token (outcome 0) directly; fall back to the NO token (outcome 1) inverted (1 − price).
  const yesAsset = positions.find((p) => p.outcomeIndex === 0)?.asset ?? null;
  const noAsset = yesAsset === null ? positions.find((p) => p.outcomeIndex === 1)?.asset ?? null : null;
  const priceAsset = yesAsset ?? noAsset;
  const pricesByDay = new Map<string, number>();
  if (priceAsset) {
    const { data: priceData, error: priceError } = await supabase
      .from("market_price_history")
      .select("ts, price")
      .eq("asset", priceAsset)
      .order("ts", { ascending: true });
    if (priceError && !isMissingSchemaError(priceError)) {
      throw priceError;
    }
    ((priceData ?? []) as unknown as { ts: string; price: number }[]).forEach((row) => {
      const day = row.ts.slice(0, "YYYY-MM-DD".length);
      const yesPrice = yesAsset !== null ? row.price : 1 - row.price;
      pricesByDay.set(day, yesPrice);
    });
  }

  const lookups: CrowdLookups = { rankByAddress, handleByAddress, skillByAddress };
  return buildCrowdMarketDetail(conditionId, positions, closed, fills, lookups, pricesByDay);
}
