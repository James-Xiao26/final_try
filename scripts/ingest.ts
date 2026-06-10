import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { botSignal, type BotSignal } from "./botDetection.js";
import { CONFIG } from "./config.js";
import { computeMetrics, type WalletMetrics } from "./metrics.js";
import { apiStats, discoverTopWallets, openUnrealizedPnl, PolymarketClient, resolvedToClosed, type DiscoveredWallet } from "./polymarket.js";
import { recentTradesFromActivity, type RecentTrade } from "./recentTrades.js";
import { buildMarkToMarketCurve, type CurvePosition } from "./equityCurve.js";
import { dailyPointsFromHistory, planPriceFetches, type CacheState } from "./priceHistory.js";
import { earliestEntryDates, openPositionRecords, profileFillsFromActivity, type OpenPositionRecord, type ProfileFill } from "./walletDetail.js";

loadEnv({ path: "../.env.local" });
loadEnv();

interface Database {
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
          pct_return: number;
          win_rate: number;          total_pnl_usd: number;
          unrealized_pnl_usd: number | null;
          total_volume_usd: number;
          n_trades: number;
          pct_edge: number | null;
          avg_edge_per_share: number | null;
          n_resolved: number | null;
          computed_at: string;
        };
        Insert: {
          address: string;
          horizon_days: number;
          skill_score: number | null;
          pct_return: number;
          win_rate: number;          total_pnl_usd: number;
          unrealized_pnl_usd?: number | null;
          total_volume_usd: number;
          n_trades: number;
          pct_edge?: number | null;
          avg_edge_per_share?: number | null;
          n_resolved?: number | null;
          computed_at?: string;
        };
        Update: {
          skill_score?: number | null;
          pct_return?: number;
          win_rate?: number;          total_pnl_usd?: number;
          unrealized_pnl_usd?: number | null;
          total_volume_usd?: number;
          n_trades?: number;
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
          cumulative_pnl: number;
        };
        Insert: {
          address: string;
          horizon_days: number;
          ts: string;
          cumulative_pnl: number;
        };
        Update: {
          cumulative_pnl?: number;
        };
        Relationships: [];
      };
      leaderboard_cache: {
        Row: {
          horizon_days: number;
          rank: number;
          address: string;
          skill_score: number | null;
          pct_return: number;
          win_rate: number;
          n_trades: number;
          avg_edge_per_share: number | null;
          cached_at: string;
        };
        Insert: {
          horizon_days: number;
          rank: number;
          address: string;
          skill_score: number | null;
          pct_return: number;
          win_rate: number;
          n_trades: number;
          avg_edge_per_share?: number | null;
          cached_at?: string;
        };
        Update: {
          skill_score?: number | null;
          pct_return?: number;
          win_rate?: number;
          n_trades?: number;
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
      market_price_meta: {
        Row: {
          asset: string;
          max_ts: string | null;
          updated_at: string;
        };
        Insert: {
          asset: string;
          max_ts?: string | null;
          updated_at?: string;
        };
        Update: {
          max_ts?: string | null;
          updated_at?: string;
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

type SupabaseClient = ReturnType<typeof createClient<Database>>;

interface ProcessResult {
  address: string;
  bot: boolean;
  botReason: BotSignal | null;
  insufficient: boolean;
  summary: string;
  // Recent fills for the landing-page feed, mapped from the activity already fetched for bot
  // detection. Empty for bots and for wallets that can never reach the leaderboard (no skill score).
  recentTrades: RecentTrade[];
  // Wallet-profile detail, mapped from the same already-fetched /positions and /activity payloads
  // (no extra API calls). Empty under the same gate as recentTrades.
  openPositions: OpenPositionRecord[];
  fills: ProfileFill[];
  // Closed positions (sold/redeemed) for the feed's basis cache: avg entry + realized PnL keyed by
  // condition/outcome, from the /closed-positions payload already fetched. Lets the feed show a
  // sold-out position's P/L when its buys predate the 24h window. Empty under the same gate.
  closedPositions: ClosedPositionRecord[];
  // Distinct outcome-token ids (CLOB asset ids) this wallet held at any point in the window —
  // union of closed + current positions. Drives the market price-history cache (later scoped to the
  // leaderboard subset). Empty under the same eligibility gate.
  assets: string[];
  // Earliest fill date ("YYYY-MM-DD") per outcome token, from /activity — each position's entry date
  // for the mark-to-market equity curve (writeDailyEquityCurves). Empty under the same gate.
  entryDates: Map<string, string>;
}

// A closed-position basis record bound to its wallet, ready to persist into wallet_closed_positions.
interface ClosedPositionRecord {
  address: string;
  conditionId: string;
  outcomeIndex: number;
  market: string;
  avgPrice: number;
  realizedPnl: number;
  size: number;
  closeTime: string;
  // Outcome-token id, for the mark-to-market equity curve (joins to market_price_history). Not
  // persisted to wallet_closed_positions — used only in-memory by writeDailyEquityCurves.
  asset: string;
}

// Supabase throws PostgrestError-shaped plain objects ({ message, code, details, hint }), not
// Error instances, so String(reason) yields a useless "[object Object]". Surface the real fields.
function describeError(reason: unknown): string {
  if (reason instanceof Error) {
    return reason.message;
  }
  if (reason && typeof reason === "object") {
    const e = reason as Record<string, unknown>;
    if (typeof e.message === "string") {
      return [e.message, e.code && `code=${String(e.code)}`, e.details && `details=${String(e.details)}`, e.hint && `hint=${String(e.hint)}`]
        .filter(Boolean)
        .join(" | ");
    }
    try {
      return JSON.stringify(reason);
    } catch {
      return String(reason);
    }
  }
  return String(reason);
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

async function upsertMetrics(
  supabase: SupabaseClient,
  address: string,
  metrics: WalletMetrics
): Promise<void> {
  const { error: statsError } = await supabase.from("wallet_stats").upsert({
    address,
    horizon_days: metrics.horizonDays,
    skill_score: metrics.skillScore,
    pct_return: metrics.pctReturn,
    win_rate: metrics.winRate,
    total_pnl_usd: metrics.totalPnlUsd,
    unrealized_pnl_usd: metrics.unrealizedPnlUsd,
    total_volume_usd: metrics.totalVolumeUsd,
    n_trades: metrics.nTrades,
    pct_edge: metrics.pctEdge,
    avg_edge_per_share: metrics.avgEdgePerShare,
    n_resolved: metrics.nResolved,
    computed_at: new Date().toISOString()
  }, { onConflict: "address,horizon_days" });

  if (statsError) {
    throw statsError;
  }

  if (metrics.equityCurve.length > 0) {
    const { error: curveError } = await supabase.from("equity_curve").upsert(
      metrics.equityCurve.map((point) => ({
        address,
        horizon_days: metrics.horizonDays,
        ts: point.ts,
        cumulative_pnl: point.cumulativePnl
      })),
      { onConflict: "address,horizon_days,ts" }
    );

    if (curveError) {
      throw curveError;
    }
  }
}

async function processWallet(
  supabase: SupabaseClient,
  client: PolymarketClient,
  wallet: DiscoveredWallet,
  recentTradeCutoffMs: number
): Promise<ProcessResult> {
  const normalized = wallet.address.toLowerCase();
  const activity = await client.getActivity(normalized);
  const botReason = botSignal(activity, CONFIG);
  const bot = botReason !== null;

  const handle = wallet.userName?.trim() || null;
  const walletRow: Database["public"]["Tables"]["wallets"]["Insert"] = {
    address: normalized,
    is_bot_suspected: bot,
    // Only set handle/lifetime_pnl when we have them, so re-runs without a value (e.g. /trades
    // fallback discovery) don't wipe a previously stored one.
    ...(handle ? { handle } : {}),
    ...(wallet.lifetimePnl !== null ? { lifetime_pnl: wallet.lifetimePnl } : {})
  };
  const { error: walletError } = await supabase.from("wallets").upsert(walletRow, { onConflict: "address" });

  if (walletError) {
    throw walletError;
  }

  if (bot) {
    return { address: normalized, bot: true, botReason, insufficient: false, summary: `skipped (bot: ${botReason})`, recentTrades: [], openPositions: [], fills: [], closedPositions: [], assets: [], entryDates: new Map() };
  }

  // Merge actually-closed positions with resolved-but-unredeemed ones. /closed-positions holds only
  // positions the trader sold/redeemed (winner-biased, since $0 losers get abandoned, not redeemed);
  // the resolved-unredeemed set restores those losses so the score reflects real edge. The two
  // endpoints are disjoint (sold/redeemed vs current holding), so they concatenate without dedup.
  // Fetch open positions once and derive both the resolved-but-unredeemed set (folded into the
  // realized metric set) and the current unrealized PnL (folded into the Total P/L curve endpoint).
  const [closedPositions, currentPositions] = await Promise.all([
    client.getClosedPositions(normalized),
    client.getCurrentPositions(normalized)
  ]);
  const resolvedPositions = resolvedToClosed(currentPositions);
  const unrealizedPnlUsd = openUnrealizedPnl(currentPositions);
  const positions = [...closedPositions, ...resolvedPositions];
  const metrics = CONFIG.HORIZONS.map((horizon) => computeMetrics(positions, horizon, CONFIG, unrealizedPnlUsd));

  await Promise.all(metrics.map((metric) => upsertMetrics(supabase, normalized, metric)));

  // Only persist recent fills for wallets that can actually reach the leaderboard (some horizon has a
  // skill score). The feed's read path further restricts to wallets currently in leaderboard_cache.
  const insufficient = metrics.every((metric) => metric.skillScore === null);
  const recentTrades = insufficient ? [] : recentTradesFromActivity(activity, normalized, recentTradeCutoffMs);
  // Profile detail rides the payloads already in hand: open holdings from currentPositions, raw fill
  // history from activity. Same eligibility gate as recentTrades.
  const openPositions = insufficient ? [] : openPositionRecords(currentPositions, normalized);
  const fills = insufficient ? [] : profileFillsFromActivity(activity, normalized, CONFIG.PROFILE_TRADES_LIMIT);
  // Closed-position basis for the feed cache, from the /closed-positions payload already in hand.
  const closedPositionRecords: ClosedPositionRecord[] = insufficient
    ? []
    : closedPositions.map((position) => ({
        address: normalized,
        conditionId: position.conditionId,
        outcomeIndex: position.outcomeIndex,
        market: position.market,
        avgPrice: position.avgPrice,
        realizedPnl: position.realizedPnl,
        size: position.size,
        closeTime: position.closeTime,
        asset: position.asset
      }));

  // Distinct outcome-token ids held at any point in the window — union of closed (sold/redeemed)
  // and current (open + resolved-unredeemed) positions. Seeds the price-history cache, later scoped
  // to the leaderboard subset. Same eligibility gate so we don't cache for never-ranked wallets.
  const assets = insufficient
    ? []
    : [...new Set([...closedPositions, ...currentPositions].map((p) => p.asset).filter((a) => a !== ""))];
  // Per-token entry dates for the mark-to-market equity curve (writeDailyEquityCurves).
  const entryDates = insufficient ? new Map<string, string>() : earliestEntryDates(activity);

  return {
    address: normalized,
    bot,
    botReason,
    insufficient,
    summary: `${closedPositions.length} closed + ${resolvedPositions.length} resolved positions`,
    recentTrades,
    openPositions,
    fills,
    closedPositions: closedPositionRecords,
    assets,
    entryDates
  };
}

async function rebuildLeaderboardCache(supabase: SupabaseClient): Promise<void> {
  for (const horizon of CONFIG.HORIZONS) {
    const { data, error } = await supabase
      .from("wallet_stats")
      .select("address, skill_score, pct_return, win_rate, n_trades, avg_edge_per_share")
      .eq("horizon_days", horizon)
      .not("skill_score", "is", null)
      // Rank by score, then break ties (notably the cluster clamped at SCORE_MAX) by raw edge so
      // the strongest forecasters surface within a tied score. nullsFirst:false keeps any
      // unknown-edge rows from jumping the tiebreak.
      .order("skill_score", { ascending: false })
      .order("avg_edge_per_share", { ascending: false, nullsFirst: false });

    if (error) {
      throw error;
    }

    const candidateAddresses = (data ?? []).map((row) => row.address);
    const allowedWallets = new Set<string>();
    // Filter out bot-suspected wallets and proven lifetime losers in chunks: `.in()` serializes
    // every address into the request URL, so a single call with thousands of candidates overflows
    // the server's URL-length limit (this is what silently failed the 10k run). Batches keep each
    // URL small.
    for (let offset = 0; offset < candidateAddresses.length; offset += CONFIG.LEADERBOARD_FILTER_CHUNK) {
      const slice = candidateAddresses.slice(offset, offset + CONFIG.LEADERBOARD_FILTER_CHUNK);
      const { data: walletRows, error: walletsError } = await supabase
        .from("wallets")
        .select("address")
        .in("address", slice)
        .eq("is_bot_suspected", false)
        // Drop proven lifetime losers; keep wallets whose all-time P/L is non-negative or unknown.
        .or(`lifetime_pnl.gte.${CONFIG.MIN_LIFETIME_PNL},lifetime_pnl.is.null`);

      if (walletsError) {
        throw walletsError;
      }

      (walletRows ?? []).forEach((row) => allowedWallets.add(row.address));
    }

    const { error: deleteError } = await supabase
      .from("leaderboard_cache")
      .delete()
      .eq("horizon_days", horizon);

    if (deleteError) {
      throw deleteError;
    }

    const rows = (data ?? [])
      .filter((row) => allowedWallets.has(row.address))
      .slice(0, CONFIG.TOP_N)
      .map((row, index) => ({
        horizon_days: horizon,
        rank: index + 1,
        address: row.address,
        skill_score: row.skill_score,
        pct_return: row.pct_return,
        win_rate: row.win_rate,
        n_trades: row.n_trades,
        avg_edge_per_share: row.avg_edge_per_share,
        cached_at: new Date().toISOString()
      }));

    if (rows.length > 0) {
      const { error: insertError } = await supabase.from("leaderboard_cache").insert(rows);
      if (insertError) {
        throw insertError;
      }
    }
  }
}

// Clear the computed tables so a re-ingest starts fresh. Stale rows from a prior, larger run would
// otherwise linger in wallet_stats and contaminate the rebuilt leaderboard (rebuildLeaderboardCache
// ranks across ALL wallet_stats rows). The wallets table is left intact — ingest re-upserts it.
// Each delete needs a filter because supabase-js refuses unconditional deletes; `horizon_days >= 0`
// matches every row.
async function resetComputedTables(supabase: SupabaseClient): Promise<void> {
  const { error: lbError } = await supabase.from("leaderboard_cache").delete().gte("horizon_days", 0);
  if (lbError) {
    throw lbError;
  }
  const { error: curveError } = await supabase.from("equity_curve").delete().gte("horizon_days", 0);
  if (curveError) {
    throw curveError;
  }
  const { error: statsError } = await supabase.from("wallet_stats").delete().gte("horizon_days", 0);
  if (statsError) {
    throw statsError;
  }
  const { error: tradesError } = await supabase.from("recent_trades").delete().gte("id", 0);
  if (tradesError) {
    throw tradesError;
  }
  const { error: walletTradesError } = await supabase.from("wallet_trades").delete().gte("id", 0);
  if (walletTradesError) {
    throw walletTradesError;
  }
  const { error: walletPositionsError } = await supabase.from("wallet_positions").delete().gte("id", 0);
  if (walletPositionsError) {
    throw walletPositionsError;
  }
}

// Global (not per-wallet) pass: pull the top events from the Gamma API for the Markets page, each
// grouping its per-outcome markets into one row. `last_trade_price` holds the leading outcome's
// implied probability (the displayed "current price"); `top_outcome` is that outcome's label.
// Rows are fully replaced each run: event ids differ from any prior per-market ids, so a plain
// upsert would leave stale rows behind — we clear the table first (only when we have fresh data).
async function ingestMarkets(supabase: SupabaseClient, client: PolymarketClient): Promise<number> {
  const events = await client.getTopEvents();
  if (events.length === 0) {
    return 0;
  }

  const { error: deleteError } = await supabase.from("markets").delete().gte("cached_at", "1970-01-01T00:00:00Z");
  if (deleteError) {
    throw deleteError;
  }

  const { error } = await supabase.from("markets").insert(
    events.map((event) => ({
      id: event.id,
      question: event.question,
      slug: event.slug,
      category: event.category,
      liquidity_usd: event.liquidityUsd,
      volume_usd: event.volumeUsd,
      volume_24hr_usd: event.volume24hrUsd,
      volume_1wk_usd: event.volume1wkUsd,
      spread: event.spread,
      one_day_price_change: event.oneDayPriceChange,
      last_trade_price: event.currentPrice,
      top_outcome: event.topOutcome,
      end_date: event.endDate,
      image: event.image,
      active: event.active,
      closed: event.closed,
      cached_at: new Date().toISOString()
    }))
  );

  if (error) {
    throw error;
  }

  return events.length;
}

function toRecentTradeRow(trade: RecentTrade): Database["public"]["Tables"]["recent_trades"]["Insert"] {
  return {
    address: trade.address,
    condition_id: trade.conditionId,
    market: trade.market,
    outcome_index: trade.outcomeIndex,
    side: trade.side,
    price: trade.price,
    size: trade.size,
    usdc_size: trade.usdcSize,
    traded_at: trade.tradedAt
  };
}

async function insertRecentTrades(supabase: SupabaseClient, trades: RecentTrade[]): Promise<void> {
  for (let offset = 0; offset < trades.length; offset += CONFIG.RECENT_TRADES_INSERT_CHUNK) {
    const rows = trades.slice(offset, offset + CONFIG.RECENT_TRADES_INSERT_CHUNK).map(toRecentTradeRow);
    const { error } = await supabase.from("recent_trades").insert(rows);
    if (error) {
      throw error;
    }
  }
}

// Wipe-and-replace the recent_trades feed from the fills collected during wallet processing (no extra
// API calls — they ride on the /activity payload bot detection already pulled). Mirrors ingestMarkets:
// a single delete-then-insert at the end of the run keeps writes off the rate-gated per-wallet path
// and avoids dedup keys. `id >= 0` matches every row (BIGSERIAL starts at 1); supabase-js refuses an
// unconditional delete.
async function replaceRecentTrades(supabase: SupabaseClient, trades: RecentTrade[]): Promise<number> {
  const { error: deleteError } = await supabase.from("recent_trades").delete().gte("id", 0);
  if (deleteError) {
    throw deleteError;
  }

  await insertRecentTrades(supabase, trades);
  return trades.length;
}

function toWalletTradeRow(fill: ProfileFill): Database["public"]["Tables"]["wallet_trades"]["Insert"] {
  return {
    address: fill.address,
    condition_id: fill.conditionId,
    market: fill.market,
    outcome_index: fill.outcomeIndex,
    side: fill.side,
    price: fill.price,
    size: fill.size,
    usdc_size: fill.usdcSize,
    traded_at: fill.tradedAt,
    transaction_hash: fill.transactionHash
  };
}

function toWalletPositionRow(position: OpenPositionRecord): Database["public"]["Tables"]["wallet_positions"]["Insert"] {
  return {
    address: position.address,
    condition_id: position.conditionId,
    asset: position.asset,
    market: position.market,
    outcome_index: position.outcomeIndex,
    size: position.size,
    avg_price: position.avgPrice,
    cur_price: position.curPrice,
    initial_value: position.initialValue,
    current_value: position.currentValue,
    cash_pnl: position.cashPnl,
    end_date: position.endDate
  };
}

async function insertWalletTrades(supabase: SupabaseClient, fills: ProfileFill[]): Promise<void> {
  for (let offset = 0; offset < fills.length; offset += CONFIG.RECENT_TRADES_INSERT_CHUNK) {
    const rows = fills.slice(offset, offset + CONFIG.RECENT_TRADES_INSERT_CHUNK).map(toWalletTradeRow);
    const { error } = await supabase.from("wallet_trades").insert(rows);
    if (error) {
      throw error;
    }
  }
}

// Global wipe-and-replace of the wallet-profile trade history, mirroring replaceRecentTrades. The
// full ingest writes fills for every eligible wallet; the feed job later scoped-replaces just the
// leaderboard subset (see refreshLeaderboardFeed). `id >= 0` matches every row.
async function replaceWalletTrades(supabase: SupabaseClient, fills: ProfileFill[]): Promise<number> {
  const { error: deleteError } = await supabase.from("wallet_trades").delete().gte("id", 0);
  if (deleteError) {
    throw deleteError;
  }

  await insertWalletTrades(supabase, fills);
  return fills.length;
}

// Full-ingest-only global wipe-and-replace of current open positions. Unlike wallet_trades these are
// not refreshed by the feed job (they need the restricted-lane /positions call), so the daily ingest
// is the sole writer.
async function replaceWalletPositions(supabase: SupabaseClient, positions: OpenPositionRecord[]): Promise<number> {
  const { error: deleteError } = await supabase.from("wallet_positions").delete().gte("id", 0);
  if (deleteError) {
    throw deleteError;
  }

  for (let offset = 0; offset < positions.length; offset += CONFIG.RECENT_TRADES_INSERT_CHUNK) {
    const rows = positions.slice(offset, offset + CONFIG.RECENT_TRADES_INSERT_CHUNK).map(toWalletPositionRow);
    const { error } = await supabase.from("wallet_positions").insert(rows);
    if (error) {
      throw error;
    }
  }
  return positions.length;
}

function toClosedPositionRow(record: ClosedPositionRecord): Database["public"]["Tables"]["wallet_closed_positions"]["Insert"] {
  return {
    address: record.address,
    condition_id: record.conditionId,
    outcome_index: record.outcomeIndex,
    market: record.market,
    avg_price: record.avgPrice,
    realized_pnl: record.realizedPnl,
    size: record.size,
    close_time: record.closeTime
  };
}

// Distinct addresses currently in leaderboard_cache (across horizons). The feed only shows these
// wallets, so the closed-position basis cache is scoped to them to keep the table small.
async function getLeaderboardAddresses(supabase: SupabaseClient): Promise<Set<string>> {
  const { data, error } = await supabase.from("leaderboard_cache").select("address");
  if (error) {
    throw error;
  }
  return new Set((data ?? []).map((row) => row.address));
}

// Full-ingest-only global wipe-and-replace of the closed-position basis cache, scoped to leaderboard
// wallets. Like wallet_positions it needs the restricted-lane /closed-positions data, so the feed job
// never refreshes it (the daily ingest is the sole writer) — closed-position P/L can be up to ~24h
// stale, the accepted trade-off documented in the migration.
async function replaceWalletClosedPositions(
  supabase: SupabaseClient,
  records: ClosedPositionRecord[],
  boardAddresses: Set<string>
): Promise<number> {
  const { error: deleteError } = await supabase.from("wallet_closed_positions").delete().gte("id", 0);
  if (deleteError) {
    throw deleteError;
  }

  const scoped = records.filter((record) => boardAddresses.has(record.address));
  for (let offset = 0; offset < scoped.length; offset += CONFIG.RECENT_TRADES_INSERT_CHUNK) {
    const rows = scoped.slice(offset, offset + CONFIG.RECENT_TRADES_INSERT_CHUNK).map(toClosedPositionRow);
    const { error } = await supabase.from("wallet_closed_positions").insert(rows);
    if (error) {
      throw error;
    }
  }
  return scoped.length;
}

interface PriceHistoryResult {
  fetched: number; // markets whose series we (re)pulled this run
  upserted: number; // total daily price rows written
  deferred: number; // eligible markets skipped past the per-run cap (next run picks them up)
  pruned: number; // history rows removed beyond the max horizon
}

// Caches a daily price series for every outcome token held (at any point in the window) by a
// leaderboard wallet, from the CLOB prices-history endpoint. Append-only and immutable: a token
// whose newest cached day has gone stale (no new daily point for PRICE_HISTORY_STALE_DAYS) is
// treated as resolved/final and never re-fetched — so the heavy first run amortizes to near-zero.
// The only step that hits the CLOB API; runs on its own "clob" rate lane.
async function cacheMarketPriceHistory(
  supabase: SupabaseClient,
  client: PolymarketClient,
  boardAddresses: Set<string>,
  assetsByAddress: Map<string, string[]>
): Promise<PriceHistoryResult> {
  const maxHorizon = Math.max(...CONFIG.HORIZONS);
  const msPerDay = CONFIG.SECONDS_PER_DAY * CONFIG.MS_PER_SECOND;
  const nowMs = Date.now();
  const todayUtc = new Date(nowMs).toISOString().slice(0, "YYYY-MM-DD".length);
  const staleBeforeMs = Date.parse(todayUtc) - CONFIG.PRICE_HISTORY_STALE_DAYS * msPerDay;

  // Tokens needed = union of in-window assets across leaderboard wallets only.
  const needed = new Set<string>();
  for (const address of boardAddresses) {
    for (const asset of assetsByAddress.get(address) ?? []) {
      needed.add(asset);
    }
  }
  if (needed.size === 0) {
    return { fetched: 0, upserted: 0, deferred: 0, pruned: 0 };
  }

  // Planning state: newest cached day per asset (one tiny row each in market_price_meta). An asset
  // whose max_ts is stale is flagged resolved so planPriceFetches skips it.
  const { data: metaRows, error: metaError } = await supabase.from("market_price_meta").select("asset, max_ts");
  if (metaError) {
    throw metaError;
  }
  const state = new Map<string, CacheState>();
  for (const row of metaRows ?? []) {
    const maxTs = row.max_ts;
    const resolved = maxTs !== null && Date.parse(maxTs) < staleBeforeMs;
    state.set(row.asset, { maxTs, resolved });
  }

  const { fetch, deferred } = planPriceFetches([...needed], state, todayUtc, CONFIG.PRICE_HISTORY_MAX_FETCHES_PER_RUN);

  // Worker pool over the fetch list — the clob rate gate is the real limiter, so a handful of
  // workers keeps it saturated without bursting past the cap.
  let cursor = 0;
  let fetched = 0;
  let upserted = 0;
  const worker = async (): Promise<void> => {
    while (cursor < fetch.length) {
      const asset = fetch[cursor];
      cursor += 1;
      if (!asset) {
        continue;
      }
      try {
        const history = await client.getPriceHistory(asset);
        const points = dailyPointsFromHistory(history, maxHorizon, nowMs);
        if (points.length === 0) {
          continue;
        }
        const rows = points.map((point) => ({ asset, ts: point.ts, price: point.price }));
        const { error } = await supabase.from("market_price_history").upsert(rows, { onConflict: "asset,ts" });
        if (error) {
          throw error;
        }
        const newestTs = points[points.length - 1]?.ts ?? null;
        const { error: metaUpsertError } = await supabase
          .from("market_price_meta")
          .upsert({ asset, max_ts: newestTs, updated_at: new Date().toISOString() }, { onConflict: "asset" });
        if (metaUpsertError) {
          throw metaUpsertError;
        }
        fetched += 1;
        upserted += rows.length;
      } catch (reason) {
        console.warn(`price-history ${asset}: ${describeError(reason)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONFIG.WALLET_CONCURRENCY, fetch.length) }, () => worker()));

  // Bound growth: drop daily rows (and stale meta) older than the max horizon.
  const pruneBefore = new Date(Date.parse(todayUtc) - maxHorizon * msPerDay).toISOString().slice(0, "YYYY-MM-DD".length);
  let pruned = 0;
  const { error: pruneError, count } = await supabase
    .from("market_price_history")
    .delete({ count: "exact" })
    .lt("ts", pruneBefore);
  if (pruneError) {
    throw pruneError;
  }
  pruned = count ?? 0;
  const { error: pruneMetaError } = await supabase.from("market_price_meta").delete().lt("max_ts", pruneBefore);
  if (pruneMetaError) {
    throw pruneMetaError;
  }

  return { fetched, upserted, deferred, pruned };
}

// Reads the daily price series a board wallet's tokens need from market_price_history, keyed by asset
// and ascending by ts (forward-fill friendly).
async function loadPricesForAssets(
  supabase: SupabaseClient,
  assets: string[]
): Promise<Map<string, { ts: string; price: number }[]>> {
  const byAsset = new Map<string, { ts: string; price: number }[]>();
  for (let offset = 0; offset < assets.length; offset += CONFIG.LEADERBOARD_FILTER_CHUNK) {
    const slice = assets.slice(offset, offset + CONFIG.LEADERBOARD_FILTER_CHUNK);
    const { data, error } = await supabase
      .from("market_price_history")
      .select("asset, ts, price")
      .in("asset", slice)
      .order("ts");
    if (error) {
      throw error;
    }
    for (const row of data ?? []) {
      const series = byAsset.get(row.asset) ?? [];
      series.push({ ts: row.ts, price: row.price });
      byAsset.set(row.asset, series);
    }
  }
  return byAsset;
}

// Builds and persists the daily mark-to-market equity curve for each leaderboard wallet, overwriting
// the sparse realized curve written into equity_curve during processing. Marks each in-window
// position (open + closed-in-window) at the cached daily price (buildMarkToMarketCurve). Reads the
// price cache cacheMarketPriceHistory just wrote, so it must run after it. Non-board wallets keep
// their realized curve.
async function writeDailyEquityCurves(
  supabase: SupabaseClient,
  boardAddresses: Set<string>,
  openPositions: OpenPositionRecord[],
  closedPositions: ClosedPositionRecord[],
  entryDatesByAddress: Map<string, Map<string, string>>
): Promise<number> {
  const msPerDay = CONFIG.SECONDS_PER_DAY * CONFIG.MS_PER_SECOND;
  const todayUtc = new Date().toISOString().slice(0, "YYYY-MM-DD".length);
  const todayMs = Date.parse(todayUtc);

  // Group the collected positions by board address.
  const openByAddress = new Map<string, OpenPositionRecord[]>();
  const closedByAddress = new Map<string, ClosedPositionRecord[]>();
  for (const position of openPositions) {
    if (!boardAddresses.has(position.address)) continue;
    const list = openByAddress.get(position.address) ?? [];
    list.push(position);
    openByAddress.set(position.address, list);
  }
  for (const position of closedPositions) {
    if (!boardAddresses.has(position.address)) continue;
    const list = closedByAddress.get(position.address) ?? [];
    list.push(position);
    closedByAddress.set(position.address, list);
  }

  const rows: Database["public"]["Tables"]["equity_curve"]["Insert"][] = [];
  for (const address of boardAddresses) {
    const open = openByAddress.get(address) ?? [];
    const closed = closedByAddress.get(address) ?? [];
    if (open.length === 0 && closed.length === 0) {
      continue;
    }
    const entryByAsset = entryDatesByAddress.get(address) ?? new Map<string, string>();
    const assets = [...new Set([...open.map((p) => p.asset), ...closed.map((p) => p.asset)].filter((a) => a !== ""))];
    const pricesByAsset = await loadPricesForAssets(supabase, assets);

    const curvePositions: CurvePosition[] = [
      ...open.map((p) => ({ asset: p.asset, size: p.size, avgCost: p.avgPrice, realizedPnl: null, closeTs: null })),
      ...closed.map((p) => ({ asset: p.asset, size: p.size, avgCost: p.avgPrice, realizedPnl: p.realizedPnl, closeTs: p.closeTime }))
    ];

    for (const horizon of CONFIG.HORIZONS) {
      const windowStartUtc = new Date(todayMs - horizon * msPerDay).toISOString().slice(0, "YYYY-MM-DD".length);
      const curve = buildMarkToMarketCurve({ positions: curvePositions, pricesByAsset, entryByAsset, windowStartUtc, todayUtc });
      for (const point of curve) {
        rows.push({ address, horizon_days: horizon, ts: point.ts, cumulative_pnl: point.cumulativePnl });
      }
    }
  }

  // Replace board wallets' equity_curve rows (delete-then-insert), leaving non-board wallets' realized
  // curves untouched. Chunk the address delete filter so the request URL can't overflow.
  const addresses = [...boardAddresses];
  for (let offset = 0; offset < addresses.length; offset += CONFIG.LEADERBOARD_FILTER_CHUNK) {
    const slice = addresses.slice(offset, offset + CONFIG.LEADERBOARD_FILTER_CHUNK);
    const { error } = await supabase.from("equity_curve").delete().in("address", slice);
    if (error) {
      throw error;
    }
  }
  for (let offset = 0; offset < rows.length; offset += CONFIG.RECENT_TRADES_INSERT_CHUNK) {
    const { error } = await supabase.from("equity_curve").insert(rows.slice(offset, offset + CONFIG.RECENT_TRADES_INSERT_CHUNK));
    if (error) {
      throw error;
    }
  }
  return rows.length;
}

// Lightweight, decoupled refresh of the activity feed for wallets currently on the leaderboard.
// Unlike a full ingest it touches neither closed-positions nor scoring: it reads the leaderboard
// address set from leaderboard_cache, re-pulls /activity (general rate lane) for just those wallets,
// and rewrites their recent_trades rows. Cheap enough to run every few minutes between full ingests.
// Requires a prior full ingest to have populated leaderboard_cache (scores come from there).
async function refreshLeaderboardFeed(
  supabase: SupabaseClient,
  client: PolymarketClient
): Promise<{ wallets: number; trades: number; walletTrades: number }> {
  const cutoffMs = Date.now() - CONFIG.RECENT_TRADE_WINDOW_HOURS * 60 * 60 * CONFIG.MS_PER_SECOND;

  const { data, error } = await supabase.from("leaderboard_cache").select("address");
  if (error) {
    throw error;
  }
  const addresses = [...new Set((data ?? []).map((row) => row.address))];
  if (addresses.length === 0) {
    return { wallets: 0, trades: 0, walletTrades: 0 };
  }

  // Worker pool over the (small) leaderboard set; /activity rides the general lane, so this is a few
  // seconds of gating even for the full set. The single /activity pull feeds both the landing feed
  // (collapsed, 24h-windowed) and the wallet-profile trade history (raw fills, last N) — no extra
  // API calls for the second.
  const collected: RecentTrade[] = [];
  const collectedFills: ProfileFill[] = [];
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < addresses.length) {
      const address = addresses[cursor];
      cursor += 1; // single-threaded JS: read+increment is atomic between awaits, so no double-claim.
      if (!address) {
        continue;
      }
      try {
        const activity = await client.getActivity(address);
        // pushing between awaits can't interleave mid-operation, so concurrent workers are safe here.
        collected.push(...recentTradesFromActivity(activity, address, cutoffMs));
        collectedFills.push(...profileFillsFromActivity(activity, address, CONFIG.PROFILE_TRADES_LIMIT));
      } catch (reason) {
        console.warn(`Feed refresh failed for ${address}: ${describeError(reason)}`);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CONFIG.WALLET_CONCURRENCY, addresses.length) }, () => worker())
  );

  // Scoped replace: delete only these addresses' rows, then insert the fresh data. Unlike the global
  // wipe, a concurrent read never sees the whole feed momentarily empty. Chunk the delete filter so
  // the `.in(...)` address list can't overflow the request URL at scale. Both recent_trades and the
  // profile trade history are scoped to the same leaderboard address set.
  for (let offset = 0; offset < addresses.length; offset += CONFIG.LEADERBOARD_FILTER_CHUNK) {
    const slice = addresses.slice(offset, offset + CONFIG.LEADERBOARD_FILTER_CHUNK);
    const { error: deleteError } = await supabase.from("recent_trades").delete().in("address", slice);
    if (deleteError) {
      throw deleteError;
    }
    const { error: tradesDeleteError } = await supabase.from("wallet_trades").delete().in("address", slice);
    if (tradesDeleteError) {
      throw tradesDeleteError;
    }
  }

  await insertRecentTrades(supabase, collected);
  await insertWalletTrades(supabase, collectedFills);
  return { wallets: addresses.length, trades: collected.length, walletTrades: collectedFills.length };
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const supabase = createClient<Database>(
    requiredEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requiredEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false } }
  );

  // Recovery path: rebuild leaderboard_cache from already-ingested wallet_stats without re-fetching
  // from Polymarket. Useful when processing succeeded but the cache rebuild failed.
  if (process.argv.includes("--rebuild-only")) {
    await rebuildLeaderboardCache(supabase);
    console.log(`Rebuilt leaderboard cache; elapsed=${((Date.now() - startedAt) / CONFIG.MS_PER_SECOND).toFixed(1)}s`);
    return;
  }

  // Recovery/refresh path: re-pull just the Markets data without a full wallet re-ingest. Markets
  // change far faster than the wallet leaderboard, so this can run on its own cadence.
  if (process.argv.includes("--markets-only")) {
    const marketCount = await ingestMarkets(supabase, new PolymarketClient());
    console.log(`Ingested ${marketCount} markets; elapsed=${((Date.now() - startedAt) / CONFIG.MS_PER_SECOND).toFixed(1)}s`);
    return;
  }

  // Live-feed refresh: re-pull /activity for just the wallets currently on the leaderboard and
  // rewrite their recent_trades rows. Cheap (general lane only) and decoupled from scoring, so it can
  // run every few minutes between full ingests. Requires leaderboard_cache from a prior full ingest.
  if (process.argv.includes("--feed-only")) {
    const { wallets, trades, walletTrades } = await refreshLeaderboardFeed(supabase, new PolymarketClient());
    console.log(
      `Refreshed feed: ${trades} recent trades + ${walletTrades} profile fills across ${wallets} leaderboard wallets; ` +
        `elapsed=${((Date.now() - startedAt) / CONFIG.MS_PER_SECOND).toFixed(1)}s`
    );
    return;
  }

  // Cadence gate for the FULL pass only (the partial modes above already returned). Heroku Scheduler
  // can't express "every N hours", so we schedule the full ingest hourly and no-op unless the current
  // UTC hour is a multiple of FULL_INGEST_EVERY_HOURS (e.g. 4 → runs at 00/04/08/12/16/20 UTC). The
  // skipped hourly invocations exit here in ~seconds, costing negligible dyno time. Unset/0 disables
  // the gate (every invocation runs the full pass).
  const everyHours = Number(process.env.FULL_INGEST_EVERY_HOURS ?? 0);
  if (Number.isFinite(everyHours) && everyHours > 0 && new Date().getUTCHours() % everyHours !== 0) {
    console.log(`Skipping full ingest: UTC hour ${new Date().getUTCHours()} is not a multiple of ${everyHours}`);
    return;
  }

  // Opt-in fresh start: wipe computed tables before ingesting so stale rows from a prior run don't
  // linger. Placed after --rebuild-only so the two flags never combine to wipe-then-rebuild-empty.
  if (process.argv.includes("--reset")) {
    await resetComputedTables(supabase);
    console.log("Reset: cleared wallet_stats, equity_curve, and leaderboard_cache");
  }

  const polymarket = new PolymarketClient();
  const wallets = await discoverTopWallets();
  const recentTradeCutoffMs = Date.now() - CONFIG.RECENT_TRADE_WINDOW_HOURS * 60 * 60 * CONFIG.MS_PER_SECOND;
  const collectedTrades: RecentTrade[] = [];
  const collectedFills: ProfileFill[] = [];
  const collectedPositions: OpenPositionRecord[] = [];
  const collectedClosed: ClosedPositionRecord[] = [];
  // Per-wallet distinct token ids (CLOB assets), for the price-history cache. Scoped to the
  // leaderboard subset after the rebuild.
  const assetsByAddress = new Map<string, string[]>();
  // Per-wallet per-token entry dates, for the mark-to-market equity curve (board-scoped later).
  const entryDatesByAddress = new Map<string, Map<string, string>>();
  let processed = 0;
  let bots = 0;
  let insufficient = 0;
  const botBreakdown: Record<BotSignal, number> = { trade_rate: 0, dust_trades: 0, simultaneous_markets: 0 };

  console.log(`Discovered ${wallets.length} wallets`);

  // Worker pool: each worker pulls the next wallet from a shared cursor and never waits on its
  // siblings, so fast wallets (bots) don't idle behind slow ones (deep-history whales). This keeps
  // the per-lane rate gates saturated instead of starving them during per-batch stragglers.
  const processingStartedAt = Date.now();
  let cursor = 0;
  const total = wallets.length;
  const worker = async (): Promise<void> => {
    while (cursor < total) {
      const wallet = wallets[cursor];
      cursor += 1; // single-threaded JS: read+increment is atomic between awaits, so no double-claim.
      if (!wallet) {
        continue;
      }
      let summary: string;
      try {
        const result = await processWallet(supabase, polymarket, wallet, recentTradeCutoffMs);
        bots += result.bot ? 1 : 0;
        if (result.botReason) {
          botBreakdown[result.botReason] += 1;
        }
        insufficient += result.insufficient ? 1 : 0;
        // Single-threaded JS: pushing between awaits can't interleave mid-operation, so concurrent
        // workers appending here is safe.
        collectedTrades.push(...result.recentTrades);
        collectedFills.push(...result.fills);
        collectedPositions.push(...result.openPositions);
        collectedClosed.push(...result.closedPositions);
        if (result.assets.length > 0) {
          assetsByAddress.set(result.address, result.assets);
        }
        if (result.entryDates.size > 0) {
          entryDatesByAddress.set(result.address, result.entryDates);
        }
        summary = result.summary;
      } catch (reason) {
        summary = `FAILED: ${describeError(reason)}`;
      }
      processed += 1;
      console.log(`[${processed}/${total}] ${wallet.address.toLowerCase()}: ${summary} (bots=${bots}, insufficient=${insufficient})`);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CONFIG.WALLET_CONCURRENCY, total) }, () => worker())
  );
  const processingSeconds = (Date.now() - processingStartedAt) / CONFIG.MS_PER_SECOND;

  await rebuildLeaderboardCache(supabase);

  // Persist the activity feed from fills collected during processing. Done after the leaderboard
  // rebuild so the read-time membership join has fresh ranks to filter against.
  const recentTradeCount = await replaceRecentTrades(supabase, collectedTrades);

  // Wallet-profile detail: open positions + raw fill history, both from payloads already fetched
  // during processing. Global wipe-and-replace, same as the feed.
  const walletTradeCount = await replaceWalletTrades(supabase, collectedFills);
  const walletPositionCount = await replaceWalletPositions(supabase, collectedPositions);
  // Closed-position basis cache, scoped to the wallets just written into leaderboard_cache (the only
  // wallets the feed shows). Sourced from the /closed-positions payload already fetched — no new API.
  const boardAddresses = await getLeaderboardAddresses(supabase);
  const closedPositionCount = await replaceWalletClosedPositions(supabase, collectedClosed, boardAddresses);

  // Historical daily price series for the markets leaderboard wallets hold, for the mark-to-market
  // equity curve. Append-only + immutable (resolved markets fetched once), so it's independent of
  // the wipe-and-replace tables above and the only step that hits the CLOB API.
  const priceHistory = await cacheMarketPriceHistory(supabase, polymarket, boardAddresses, assetsByAddress);

  // Daily mark-to-market equity curve for board wallets: marks each in-window position at the cached
  // daily price. Reads the price cache just written above, so it must run after it. Overwrites the
  // sparse realized curve in equity_curve for board wallets.
  const equityCurveCount = await writeDailyEquityCurves(supabase, boardAddresses, collectedPositions, collectedClosed, entryDatesByAddress);

  // Markets are global and independent of wallet processing; refresh them in the same run.
  const marketCount = await ingestMarkets(supabase, polymarket);

  const elapsedSeconds = (Date.now() - startedAt) / CONFIG.MS_PER_SECOND;
  console.log(`Processed ${processed} wallets; excluded bots=${bots}, insufficient=${insufficient}; ingested ${marketCount} markets, ${recentTradeCount} recent trades, ${walletTradeCount} profile fills, ${walletPositionCount} open positions, ${closedPositionCount} closed positions; price-history ${priceHistory.upserted} rows across ${priceHistory.fetched} markets (deferred=${priceHistory.deferred}, pruned=${priceHistory.pruned}); equity-curve ${equityCurveCount} daily rows; elapsed=${elapsedSeconds.toFixed(1)}s`);
  console.log(`Bot breakdown: trade_rate=${botBreakdown.trade_rate}, dust_trades=${botBreakdown.dust_trades}, simultaneous_markets=${botBreakdown.simultaneous_markets}`);

  // Diagnostic: the restricted lane (closed-positions) is the dominant cost. Its theoretical floor
  // is requests * interval; if processing took ~that, we're gate-bound (near the rate-limit ceiling)
  // and only a smaller interval would help. If processing >> floor, time is leaking elsewhere
  // (Supabase writes, retry backoff) and concurrency/those paths are the lever.
  const restrictedFloorSeconds =
    (apiStats.requests.restricted * CONFIG.REQUEST_INTERVAL_MS.restricted) / CONFIG.MS_PER_SECOND;
  console.log(
    `API requests: restricted=${apiStats.requests.restricted} general=${apiStats.requests.general} clob=${apiStats.requests.clob} retries=${apiStats.retries}`
  );
  console.log(
    `Processing=${processingSeconds.toFixed(1)}s vs restricted-gate floor=${restrictedFloorSeconds.toFixed(1)}s ` +
      `(ratio ${(processingSeconds / Math.max(restrictedFloorSeconds, 1)).toFixed(1)}x)`
  );
}

main().catch((error) => {
  console.error(describeError(error));
  process.exitCode = 1;
});
