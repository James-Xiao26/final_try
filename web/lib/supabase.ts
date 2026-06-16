import { createBrowserClient, createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import type { CrowdedMarketSummary, CrowdMarketDetail, Database, EquityPoint, HorizonDays, LeaderboardRow, MarketRow, MarketSort, RecentTrade, RecentTradesFeed, ResolvedMarket, WalletMetrics, WalletPosition, WalletProfile } from "./types";
import type { DECategoryWin, DELeaderboardEntry, DEMarket, DEPosition, DecisionEngineInputs } from "./decisionEngine";
import { HORIZONS } from "./types";
import { groupWalletTrades } from "./walletTrades";
import { groupRecentTrades, positionKey, type ClosedBasis, type OpenBasis } from "./recentTrades";
import { buildCrowdMarketDetail, summarizeCrowdedMarkets, type CrowdClosedPosition, type CrowdLookups, type CrowdOpenPosition, type CrowdTradeFill } from "./marketCrowd";
import type { MarketAnalytics, MarketMeta, PriceLine, PricePoint, WhaleFillInput } from "./marketAnalytics";
import { fetchEventCandidates, fetchLiveMarket, fetchLivePriceSeries, type LiveMarket } from "./polymarketLive";
import { summarizeResolvedMarkets } from "./resolvedMarkets";

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
  | "condition_id"
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
    .select("id, condition_id, question, slug, category, liquidity_usd, volume_usd, volume_24hr_usd, volume_1wk_usd, last_trade_price, top_outcome, one_day_price_change, end_date, image")
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
    conditionId: row.condition_id,
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

interface MarketMetaSelectRow {
  question: string;
  slug: string | null;
  category: string | null;
  image: string | null;
  end_date: string | null;
  liquidity_usd: number | null;
  volume_usd: number | null;
  volume_24hr_usd: number | null;
  volume_1wk_usd: number | null;
  spread: number | null;
  last_trade_price: number | null;
  top_outcome: string | null;
  one_day_price_change: number | null;
  outcomes: string[] | null;
  outcome_prices: number[] | null;
  active: boolean;
  closed: boolean;
}

// Full Market Analytics payload for one binary condition_id: the markets-table snapshot (`meta`), the
// leaderboard participation `detail` (participants + convergence timeline, null when untracked), the
// raw daily YES price series (`priceRows`), and the tracked fills joined with each wallet's
// leaderboard identity (`whaleFills`). The page derives every chart/metric from these via the pure
// helpers in marketAnalytics.ts. Either of `meta`/`detail` may be null; only an all-empty result (no
// market row AND no participation) is treated as "not found" by the page.
export async function getMarketAnalytics(conditionId: string): Promise<MarketAnalytics> {
  const supabase = createSupabaseServerClient();

  const [metaRes, openRes, closedRes, fillsRes] = await Promise.all([
    supabase
      .from("markets")
      .select(
        "question, slug, category, image, end_date, liquidity_usd, volume_usd, volume_24hr_usd, volume_1wk_usd, spread, last_trade_price, top_outcome, one_day_price_change, outcomes, outcome_prices, active, closed"
      )
      .eq("condition_id", conditionId)
      .order("volume_usd", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle(),
    supabase.from("wallet_positions").select(OPEN_POSITION_COLUMNS).eq("condition_id", conditionId),
    supabase.from("wallet_closed_positions").select(CLOSED_POSITION_COLUMNS).eq("condition_id", conditionId),
    supabase.from("wallet_trades").select(CROWD_FILL_COLUMNS).eq("condition_id", conditionId).order("traded_at", { ascending: false })
  ]);

  for (const res of [metaRes, openRes, closedRes, fillsRes]) {
    if (res.error && !isMissingSchemaError(res.error)) {
      throw res.error;
    }
  }

  const metaRow = (metaRes.data ?? null) as unknown as MarketMetaSelectRow | null;
  const meta: MarketMeta | null = metaRow
    ? {
        question: metaRow.question,
        slug: metaRow.slug,
        category: metaRow.category,
        image: metaRow.image,
        endDate: metaRow.end_date,
        liquidityUsd: toNumber(metaRow.liquidity_usd),
        volumeUsd: toNumber(metaRow.volume_usd),
        volume24hrUsd: toNumber(metaRow.volume_24hr_usd),
        volume1wkUsd: toNumber(metaRow.volume_1wk_usd),
        spread: metaRow.spread,
        lastTradePrice: metaRow.last_trade_price,
        topOutcome: metaRow.top_outcome,
        oneDayPriceChange: metaRow.one_day_price_change,
        outcomes: metaRow.outcomes,
        outcomePrices: metaRow.outcome_prices,
        active: metaRow.active,
        closed: metaRow.closed
      }
    : null;

  const positions = ((openRes.data ?? []) as unknown as OpenPositionRowDb[]).map(toOpenPosition);
  const closed = ((closedRes.data ?? []) as unknown as ClosedPositionRowDb[]).map(toClosedPosition);
  const fills = ((fillsRes.data ?? []) as unknown as CrowdFillRowDb[]).map(toCrowdFill);

  const addresses = [
    ...new Set([...positions.map((p) => p.address), ...closed.map((p) => p.address), ...fills.map((f) => f.address)])
  ];

  // Identity lookups for the participating wallets (handle + best rank/skill across horizons).
  const handleByAddress = new Map<string, string | null>();
  const rankByAddress = new Map<string, number>();
  const skillByAddress = new Map<string, number | null>();
  if (addresses.length > 0) {
    const [walletsRes, cacheRes] = await Promise.all([
      supabase.from("wallets").select("address, handle").in("address", addresses),
      supabase.from("leaderboard_cache").select("address, rank, skill_score").in("address", addresses)
    ]);
    if (walletsRes.error && !isMissingSchemaError(walletsRes.error)) throw walletsRes.error;
    if (cacheRes.error && !isMissingSchemaError(cacheRes.error)) throw cacheRes.error;

    ((walletsRes.data ?? []) as unknown as { address: string; handle: string | null }[]).forEach((row) =>
      handleByAddress.set(row.address, row.handle)
    );
    ((cacheRes.data ?? []) as unknown as { address: string; rank: number; skill_score: number | null }[]).forEach((row) => {
      const prevRank = rankByAddress.get(row.address);
      if (prevRank === undefined || row.rank < prevRank) rankByAddress.set(row.address, row.rank);
      const prevSkill = skillByAddress.get(row.address);
      if (prevSkill === undefined || (row.skill_score !== null && (prevSkill === null || row.skill_score > prevSkill))) {
        skillByAddress.set(row.address, row.skill_score);
      }
    });
  }

  // Daily YES price series, two sources (best-effort). Preferred: the listed-market series keyed by
  // condition_id (ingest caches the leading market's YES token there, so every Markets-page market has
  // a chart). Fallback: the leaderboard-held token series keyed by outcome token (asset) — for markets
  // a wallet holds that aren't in the listed-markets set; the cached YES token (outcome 0) is used
  // directly, else the NO token inverted (1 − price).
  const yesAsset = positions.find((p) => p.outcomeIndex === 0)?.asset ?? null;
  const noAsset = yesAsset === null ? positions.find((p) => p.outcomeIndex === 1)?.asset ?? null : null;
  const priceRows: PricePoint[] = [];
  const pricesByDay = new Map<string, number>();
  const pushPrice = (ts: string, yesPrice: number): void => {
    const day = ts.slice(0, "YYYY-MM-DD".length);
    priceRows.push({ ts: day, price: yesPrice });
    pricesByDay.set(day, yesPrice);
  };

  const { data: byConditionData, error: byConditionError } = await supabase
    .from("market_price_history")
    .select("ts, price, asset")
    .eq("condition_id", conditionId)
    .order("ts", { ascending: true });
  if (byConditionError && !isMissingSchemaError(byConditionError)) throw byConditionError;
  const byConditionRows = (byConditionData ?? []) as unknown as { ts: string; price: number; asset: string }[];
  const listedAsset = byConditionRows[0]?.asset ?? null; // the cached listed YES token, if any

  if (byConditionRows.length > 0) {
    byConditionRows.forEach((row) => pushPrice(row.ts, row.price));
  } else {
    const priceAsset = yesAsset ?? noAsset;
    if (priceAsset) {
      const { data: byAssetData, error: byAssetError } = await supabase
        .from("market_price_history")
        .select("ts, price")
        .eq("asset", priceAsset)
        .order("ts", { ascending: true });
      if (byAssetError && !isMissingSchemaError(byAssetError)) throw byAssetError;
      ((byAssetData ?? []) as unknown as { ts: string; price: number }[]).forEach((row) => {
        pushPrice(row.ts, yesAsset !== null ? row.price : 1 - row.price);
      });
    }
  }

  // ── Live enrichment ─────────────────────────────────────────────────────────────
  // Two gaps to fill live (server-side, Next-cached) so no market renders blank:
  //  • meta — markets not in the top-N listed set have no `markets` row.
  //  • intraday price line — the cache stores only one CLOSE per day, but the chart wants every
  //    intraday move so whale fills line up with the line. We source a multi-fidelity series from CLOB.
  // The YES token is known up-front for listed (cached asset) or wallet-held markets, so that fetch
  // runs concurrently with the Gamma meta lookup; only an unlisted, unheld market needs the token from
  // Gamma first (a rare market with no whale overlay anyway).
  let resolvedMeta = meta;
  const heldToken = yesAsset ?? noAsset; // an outcome token of this market from a tracked position
  const upfrontToken = listedAsset ?? heldToken; // a YES token we can fetch the series for immediately
  const upfrontInvert = listedAsset === null && yesAsset === null && noAsset !== null; // held NO → invert

  const [live, upfrontSeries] = await Promise.all([
    resolvedMeta === null ? fetchLiveMarket(conditionId) : Promise.resolve<LiveMarket | null>(null),
    upfrontToken ? fetchLivePriceSeries(upfrontToken, upfrontInvert) : Promise.resolve<PricePoint[]>([])
  ]);
  if (resolvedMeta === null && live) resolvedMeta = live.meta;

  let liveSeries = upfrontSeries;
  if (liveSeries.length === 0) {
    // No cached/held token — use Gamma's canonical YES token (or NO inverted).
    const liveYes = live?.yesTokenId ?? null;
    const liveNo = live?.noTokenId ?? null;
    const token = liveYes ?? liveNo;
    if (token) liveSeries = await fetchLivePriceSeries(token, liveYes === null && liveNo !== null);
  }

  // The live intraday series supersedes the close-only cache for the chart and the convergence overlay.
  if (liveSeries.length > 0) {
    priceRows.length = 0;
    pricesByDay.clear();
    for (const pt of liveSeries) {
      priceRows.push({ ts: pt.ts, price: pt.price });
      pricesByDay.set(pt.ts.slice(0, "YYYY-MM-DD".length), pt.price); // daily key for the YES overlay
    }
  }

  // ── Multi-outcome candidate lines ───────────────────────────────────────────────
  // For a grouped event (e.g. "World Cup Winner"), overlay the top-3 favored candidates. The tracked
  // market is the primary line (priceRows); fetch the two other top candidates' series as extras. Skip
  // the lookup for plain Yes/No markets to avoid a needless Gamma call.
  let extraLines: PriceLine[] = [];
  let primaryLabel: string | null = null;
  // A market is worth the candidate lookup when it might belong to a multi-candidate event. Two signals:
  //  • the live fetch found a `groupItemTitle` (this market is a leg of a grouped event) — required
  //    because grouped legs are themselves Yes/No markets, so topOutcome can't reveal them; and
  //  • the (listed) `markets` row's topOutcome isn't Yes/No — mapEvent rolls a multi-outcome event up to
  //    its favored candidate label there.
  // Plain standalone Yes/No markets match neither and skip the extra Gamma call.
  const liveGrouped = live?.groupItemTitle != null;
  const metaMaybeMulti = resolvedMeta !== null && resolvedMeta.topOutcome !== "Yes" && resolvedMeta.topOutcome !== "No";
  const maybeMulti = resolvedMeta === null || liveGrouped || metaMaybeMulti;
  if (maybeMulti) {
    const candidates = await fetchEventCandidates(conditionId);
    if (candidates && candidates.length > 1) {
      const lc = conditionId.toLowerCase();
      const top3 = candidates.slice(0, 3);
      primaryLabel = candidates.find((c) => c.conditionId.toLowerCase() === lc)?.label ?? resolvedMeta?.topOutcome ?? null;
      const others = top3.filter((c) => c.conditionId.toLowerCase() !== lc).slice(0, 2);
      const fetched = await Promise.all(
        others.map(async (c) => ({ label: c.label, points: await fetchLivePriceSeries(c.yesTokenId, false) }))
      );
      extraLines = fetched.filter((l) => l.points.length > 0);
    }
  }

  const lookups: CrowdLookups = { rankByAddress, handleByAddress, skillByAddress };
  const detail =
    addresses.length > 0
      ? buildCrowdMarketDetail(conditionId, positions, closed, fills, lookups, pricesByDay)
      : null;

  const whaleFills: WhaleFillInput[] = fills.map((f) => ({
    address: f.address,
    handle: handleByAddress.get(f.address) ?? null,
    rank: rankByAddress.get(f.address) ?? null,
    skillScore: skillByAddress.get(f.address) ?? null,
    outcomeIndex: f.outcomeIndex,
    side: f.side,
    price: f.price,
    size: f.size,
    usdcSize: f.usdcSize,
    tradedAt: f.tradedAt
  }));

  return { conditionId, meta: resolvedMeta, detail, priceRows, whaleFills, extraLines, primaryLabel };
}

// ── Decision Engine data assembly ────────────────────────────────────────────
// Assembles raw DB rows for buildRecommendations(). Separate from the page-level readers above
// because it spans several tables and intentionally keeps its own row-type definitions local.

interface DEPositionRow {
  address: string;
  condition_id: string | null;
  market: string | null;
  outcome_index: number | null;
  size: number | null;
  avg_price: number | null;
  cur_price: number | null;
  end_date: string | null;
  first_traded_at: string | null;
  last_traded_at: string | null;
}

interface DEMarketRow {
  condition_id: string | null;
  question: string;
  slug: string | null;
  category: string | null;
  liquidity_usd: number | null;
  last_trade_price: number | null;
  end_date: string | null;
  image: string | null;
  spread: number | null;
}

// Fetch everything the Decision Engine needs in parallel where possible.
// Optional `walletAddress` enables personalization: the requesting wallet's
// per-category win rate is computed from their closed positions.
export async function getDecisionEngineData(
  opts: { walletAddress?: string } = {}
): Promise<DecisionEngineInputs> {
  const supabase = createSupabaseServerClient();

  // Wave 1: leaderboard only — need the address set before we can scope subsequent queries.
  // wallet_positions accumulates stale rows from past leaderboard runs (the wipe-and-replace
  // in ingest only deletes the current board's addresses, leaving former wallets' rows). Querying
  // unfiltered gives 500+ unique addresses → 22KB .in() URL → PostgREST 414 headers overflow.
  const { data: cacheData, error: cacheError } = await supabase
    .from("leaderboard_cache")
    .select("address, skill_score, rank");

  if (cacheError && !isMissingSchemaError(cacheError)) throw cacheError;

  const leaderboard: DELeaderboardEntry[] = ((cacheData ?? []) as unknown as {
    address: string;
    skill_score: number | null;
    rank: number;
  }[]).map((row) => ({
    address: row.address,
    skillScore: row.skill_score ?? 0,
    rank: row.rank,
  }));

  const leaderboardAddresses = leaderboard.map((e) => e.address);

  // Wave 2: positions (filtered to leaderboard), markets, and handles — all independent, run in parallel.
  // Filtering wallet_positions to leaderboard addresses avoids scanning stale wallet data and keeps
  // the result set small (100 wallets × ~30 positions = ~3000 rows instead of ~16000 unfiltered).
  // Note: "Recent Accumulation" is derived from wallet_positions.last_traded_at (already fetched
  // here) rather than querying wallet_trades, which has no index on (traded_at, side).
  const [posRes, allMarketsRes, walletHandleRes] = await Promise.all([
    leaderboardAddresses.length > 0
      ? fetchAllPaged((from, to) =>
          supabase
            .from("wallet_positions")
            .select(
              "address, condition_id, market, outcome_index, size, avg_price, cur_price, end_date, first_traded_at, last_traded_at"
            )
            .in("address", leaderboardAddresses)
            .range(from, to)
        )
      : Promise.resolve<PagedResult>({ rows: [], missing: false }),
    supabase
      .from("markets")
      .select("condition_id, question, slug, category, liquidity_usd, last_trade_price, end_date, image, spread")
      .eq("active", true)
      .eq("closed", false),
    leaderboardAddresses.length > 0
      ? supabase.from("wallets").select("address, handle").in("address", leaderboardAddresses)
      : Promise.resolve({ data: [] as unknown[], error: null }),
  ]);

  const positions: DEPosition[] = (posRes.rows as unknown as DEPositionRow[]).map((row) => ({
    address: row.address,
    conditionId: row.condition_id,
    market: row.market,
    outcomeIndex: row.outcome_index,
    size: toNumber(row.size),
    avgPrice: toNumber(row.avg_price),
    curPrice: toNumber(row.cur_price),
    endDate: row.end_date,
    firstTradedAt: row.first_traded_at,
    lastTradedAt: row.last_traded_at,
  }));

  if (allMarketsRes.error && !isMissingSchemaError(allMarketsRes.error)) throw allMarketsRes.error;
  if (walletHandleRes.error && !isMissingSchemaError(walletHandleRes.error)) throw walletHandleRes.error;

  // Build the markets Map from positions (primary source: question, curPrice, endDate are in
  // wallet_positions). Markets in the top-300 table get enriched with slug, category, liquidity,
  // and spread; positions in less-liquid markets outside the top-300 still appear with nulls for
  // those fields — the recommendation signals degrade gracefully.
  const markets = new Map<string, DEMarket>();
  for (const pos of positions) {
    if (pos.conditionId && !markets.has(pos.conditionId)) {
      markets.set(pos.conditionId, {
        conditionId: pos.conditionId,
        question: pos.market ?? "",
        slug: null,
        category: null,
        liquidityUsd: 0,
        lastTradePrice: pos.curPrice,
        endDate: pos.endDate,
        image: null,
        spread: null,
      });
    }
  }

  // Enrich from markets table (top-300 by liquidity) — adds slug, category, liquidity, spread.
  ((allMarketsRes.data ?? []) as unknown as DEMarketRow[]).forEach((row) => {
    if (row.condition_id && markets.has(row.condition_id)) {
      const existing = markets.get(row.condition_id)!;
      markets.set(row.condition_id, {
        ...existing,
        slug: row.slug ?? existing.slug,
        category: row.category ?? existing.category,
        liquidityUsd: row.liquidity_usd != null ? toNumber(row.liquidity_usd) : existing.liquidityUsd,
        lastTradePrice: row.last_trade_price ?? existing.lastTradePrice,
        endDate: row.end_date ?? existing.endDate,
        image: row.image ?? existing.image,
        spread: row.spread ?? existing.spread,
      });
    }
  });

  const handles = new Map<string, string | null>();
  ((walletHandleRes.data ?? []) as unknown as WalletHandleRow[]).forEach((w) =>
    handles.set(w.address, w.handle)
  );

  // 6. Personalization: if a wallet address is provided, compute per-category win rate from
  //    that wallet's closed positions joined to the markets table for categories.
  let categoryWins: DECategoryWin[] | undefined;
  if (opts.walletAddress) {
    const normalized = opts.walletAddress.toLowerCase();
    const { data: closedData, error: closedError } = await supabase
      .from("wallet_closed_positions")
      .select("condition_id, realized_pnl")
      .eq("address", normalized);
    if (closedError && !isMissingSchemaError(closedError)) throw closedError;

    const closedRows = (closedData ?? []) as unknown as {
      condition_id: string | null;
      realized_pnl: number | null;
    }[];

    const closedConditionIds = [
      ...new Set(closedRows.map((r) => r.condition_id).filter((id): id is string => id !== null)),
    ];

    if (closedConditionIds.length > 0) {
      const { data: catData, error: catError } = await supabase
        .from("markets")
        .select("condition_id, category")
        .in("condition_id", closedConditionIds.slice(0, 200));
      if (catError && !isMissingSchemaError(catError)) throw catError;

      const categoryByCondition = new Map<string, string | null>();
      ((catData ?? []) as unknown as { condition_id: string | null; category: string | null }[]).forEach(
        (r) => {
          if (r.condition_id) categoryByCondition.set(r.condition_id, r.category);
        }
      );

      const catStats = new Map<string, { wins: number; total: number }>();
      for (const row of closedRows) {
        if (!row.condition_id) continue;
        const cat = categoryByCondition.get(row.condition_id) ?? "Unknown";
        const existing = catStats.get(cat) ?? { wins: 0, total: 0 };
        existing.total += 1;
        if ((row.realized_pnl ?? 0) > 0) existing.wins += 1;
        catStats.set(cat, existing);
      }

      categoryWins = [...catStats.entries()]
        .filter(([, s]) => s.total >= 5)
        .map(([category, { wins, total }]) => ({
          category,
          wins,
          total,
          winRate: wins / total,
        }))
        .sort((a, b) => b.winRate - a.winRate);
    }
  }

  return {
    leaderboard,
    positions,
    markets,
    handles,
    ...(categoryWins !== undefined ? { categoryWins } : {}),
    asOf: new Date(),
  };
}

// Resolved Markets panel: closed positions from the last 7 days, grouped by market (conditionId),
// filtered to confirmed-resolved markets only (≥1 wallet held to resolution at 0 or 1). Returns
// up to 40 markets, newest-resolved first, each with the winning side and per-wallet P/L.
interface ResolvedClosedSelectRow {
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

export async function getResolvedMarkets(limit = 40): Promise<ResolvedMarket[]> {
  const supabase = createSupabaseServerClient();
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const { rows, missing } = await fetchAllPaged((from, to) =>
    supabase
      .from("wallet_closed_positions")
      .select("address, condition_id, outcome_index, market, avg_price, realized_pnl, size, close_time, first_traded_at")
      .gte("close_time", cutoff)
      .order("close_time", { ascending: false })
      .range(from, to)
  );

  if (missing) return [];

  const rawRows = rows as unknown as ResolvedClosedSelectRow[];
  if (rawRows.length === 0) return [];

  const addresses = [...new Set(rawRows.map((r) => r.address))];

  // Leaderboard membership: rank + skill per address.
  const { data: cacheData, error: cacheError } = await supabase
    .from("leaderboard_cache")
    .select("address, skill_score, rank")
    .in("address", addresses);

  if (cacheError) {
    if (isMissingSchemaError(cacheError)) return [];
    throw cacheError;
  }

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
  const handleByAddress = new Map<string, string | null>();
  if (memberAddresses.length > 0) {
    const { data: wallets, error: walletError } = await supabase
      .from("wallets")
      .select("address, handle")
      .in("address", memberAddresses);

    if (walletError) {
      if (isMissingSchemaError(walletError)) return [];
      throw walletError;
    }

    ((wallets ?? []) as unknown as WalletHandleRow[]).forEach((wallet) =>
      handleByAddress.set(wallet.address, wallet.handle)
    );
  }

  const lookups: CrowdLookups = { rankByAddress, handleByAddress, skillByAddress };

  const inputs = rawRows.map((r) => ({
    address: r.address,
    conditionId: r.condition_id,
    market: r.market,
    outcomeIndex: r.outcome_index,
    avgPrice: toNumber(r.avg_price),
    size: toNumber(r.size),
    realizedPnl: r.realized_pnl,
    closeTime: r.close_time,
    firstTradedAt: r.first_traded_at
  }));

  return summarizeResolvedMarkets(inputs, lookups, limit);
}
