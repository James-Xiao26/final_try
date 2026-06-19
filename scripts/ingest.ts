import { pathToFileURL } from "node:url";
import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { botSignal, type BotSignal } from "./botDetection.js";
import { CONFIG } from "./config.js";
import { computeMetrics, type WalletMetrics } from "./metrics.js";
import { apiStats, discoverTopWallets, discoverCandidateAddresses, openUnrealizedPnl, PolymarketClient, resolvedToClosed, type DiscoveredWallet, type EventSummary } from "./polymarket.js";
import { recentTradesFromActivity, type RecentTrade } from "./recentTrades.js";
import { buildMarkToMarketCurve, type CurvePosition } from "./equityCurve.js";
import { dailyPointsFromHistory, planPriceFetches, type CacheState } from "./priceHistory.js";
import { earliestEntryDates, latestFillDates, openPositionRecords, profileFillsFromActivity, type OpenPositionRecord, type ProfileFill } from "./walletDetail.js";
import { bestSkillScore, computeScoringOutcome, selectCandidateBatch, type CandidateWallet, type CandidateStatus } from "./candidateDiscovery.js";
import { summarizeCrowdedMarkets, type CrowdClosedPosition, type CrowdOpenPosition } from "./marketCrowd.js";

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
          pct_return: number | null;
          win_rate: number | null;
          total_pnl_usd: number | null;
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
          skill_score: number | null;
          pct_return: number | null;
          win_rate: number | null;
          total_pnl_usd: number | null;
          unrealized_pnl_usd?: number | null;
          total_volume_usd: number | null;
          n_trades: number | null;
          pct_edge?: number | null;
          avg_edge_per_share?: number | null;
          n_resolved?: number | null;
          computed_at?: string;
        };
        Update: {
          skill_score?: number | null;
          pct_return?: number | null;
          win_rate?: number | null;
          total_pnl_usd?: number | null;
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
          cumulative_pnl: number | null;
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
          skill_score: number | null;
          pct_return: number | null;
          win_rate: number | null;
          n_trades: number | null;
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
      candidate_wallets: {
        Row: {
          address: string;
          discovery_source: string;
          status: CandidateStatus;
          first_seen_at: string;
          last_scored_at: string | null;
          skill_score: number | null;
          times_scored: number;
          consecutive_below_threshold: number;
          promoted_at: string | null;
          retired_at: string | null;
        };
        Insert: {
          address: string;
          discovery_source?: string;
          status?: CandidateStatus;
          first_seen_at?: string;
          last_scored_at?: string | null;
          skill_score?: number | null;
          times_scored?: number;
          consecutive_below_threshold?: number;
          promoted_at?: string | null;
          retired_at?: string | null;
        };
        Update: {
          discovery_source?: string;
          status?: CandidateStatus;
          last_scored_at?: string | null;
          skill_score?: number | null;
          times_scored?: number;
          consecutive_below_threshold?: number;
          promoted_at?: string | null;
          retired_at?: string | null;
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
  // First fill day (UTC "YYYY-MM-DD") for this outcome token, from /activity — the Convergence
  // "first buy" fallback when the capped fill cache lacks this market's fills. "Last trade" reuses
  // closeTime. Null when the token's fills predate the /activity window.
  firstTradedAt: string | null;
  // Outcome-token id, for the mark-to-market equity curve (joins to market_price_history). Not
  // persisted to wallet_closed_positions — used only in-memory by writeDailyEquityCurves.
  asset: string;
}

// Supabase throws PostgrestError-shaped plain objects ({ message, code, details, hint }), not
// Error instances, so String(reason) yields a useless "[object Object]". Surface the real fields.
export function describeError(reason: unknown): string {
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
  metrics: WalletMetrics,
  // The realized-PnL equity curve computeMetrics produces is sparse (a point per close-day + today).
  // The full ingest later overwrites board wallets' curves with the richer daily mark-to-market
  // series. The hourly rescore touches only scores, so it skips this write: upserting the sparse
  // realized points over an existing mark-to-market curve would leave a sawtooth until the next full
  // ingest. Defaults true so every other caller (full ingest, candidate batch) is unchanged.
  writeEquityCurve = true
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

  if (writeEquityCurve && metrics.equityCurve.length > 0) {
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

export async function processWallet(
  supabase: SupabaseClient,
  client: PolymarketClient,
  wallet: DiscoveredWallet,
  recentTradeCutoffMs: number,
  // When false, skips the realized equity-curve write (the hourly rescore owns only scores; the full
  // ingest owns the mark-to-market curve — see upsertMetrics). Defaults true for all other callers.
  writeEquityCurve = true
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

  await Promise.all(metrics.map((metric) => upsertMetrics(supabase, normalized, metric, writeEquityCurve)));

  // Only persist recent fills for wallets that can actually reach the leaderboard (some horizon has a
  // skill score). The feed's read path further restricts to wallets currently in leaderboard_cache.
  const insufficient = metrics.every((metric) => metric.skillScore === null);
  const recentTrades = insufficient ? [] : recentTradesFromActivity(activity, normalized, recentTradeCutoffMs);
  // Per-outcome-token first/last fill day from /activity. entryDates also feeds the equity curve
  // below; both stamp the Convergence "first buy"/"last trade" dates onto the position caches so the
  // read path has them when the capped fill cache (wallet_trades) lacks this market's fills.
  const entryDates = insufficient ? new Map<string, string>() : earliestEntryDates(activity);
  const lastFillDates = insufficient ? new Map<string, string>() : latestFillDates(activity);
  // Profile detail rides the payloads already in hand: open holdings from currentPositions, raw fill
  // history from activity. Same eligibility gate as recentTrades.
  const openPositions = insufficient ? [] : openPositionRecords(currentPositions, normalized, entryDates, lastFillDates);
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
        firstTradedAt: entryDates.get(position.asset) ?? null,
        asset: position.asset
      }));

  // Distinct outcome-token ids held at any point in the window — union of closed (sold/redeemed)
  // and current (open + resolved-unredeemed) positions. Seeds the price-history cache, later scoped
  // to the leaderboard subset. Same eligibility gate so we don't cache for never-ranked wallets.
  const assets = insufficient
    ? []
    : [...new Set([...closedPositions, ...currentPositions].map((p) => p.asset).filter((a) => a !== ""))];

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

export async function rebuildLeaderboardCache(supabase: SupabaseClient): Promise<void> {
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
  const rawEvents = await client.getTopEvents();
  if (rawEvents.length === 0) {
    return 0;
  }

  // Dedupe by event id (the markets primary key): Gamma pagination can return the same event on more
  // than one page when ordering shifts mid-scan, which would blow up the batch insert on the pkey.
  const byId = new Map<string, EventSummary>();
  for (const event of rawEvents) {
    if (!byId.has(event.id)) {
      byId.set(event.id, event);
    }
  }
  const events = [...byId.values()];

  const { error: deleteError } = await supabase.from("markets").delete().gte("cached_at", "1970-01-01T00:00:00Z");
  if (deleteError) {
    throw deleteError;
  }

  const { error } = await supabase.from("markets").insert(
    events.map((event) => ({
      id: event.id,
      condition_id: event.conditionId,
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

  const prices = await cacheListedMarketPrices(supabase, client, events);
  console.log(
    `Ingested ${events.length} markets; price-history ${prices.upserted} rows across ${prices.fetched} markets (deferred=${prices.deferred})`
  );

  return events.length;
}

interface ListedPriceResult {
  fetched: number;
  upserted: number;
  deferred: number;
}

// Cache a daily YES price series for each *listed* market's leading outcome token, keyed by
// condition_id, so the Market Analytics page has a price chart for every market on the Markets page —
// not just the ones a leaderboard wallet happens to hold (those are seeded separately by
// cacheMarketPriceHistory). Incremental and idempotent: planPriceFetches skips any token already
// fresh-through-today via market_price_meta, so after the first daily fill the hourly markets run is a
// near no-op. Rows carry condition_id (the page joins on it); pruning is handled by
// cacheMarketPriceHistory in the full run.
async function cacheListedMarketPrices(
  supabase: SupabaseClient,
  client: PolymarketClient,
  events: EventSummary[]
): Promise<ListedPriceResult> {
  // Keep the full market lifetime (capped at PRICE_HISTORY_LISTED_DAYS) so the chart can default to
  // "since creation"; the page windows it down to 7D/30D/etc. at read time.
  const historyDays = CONFIG.PRICE_HISTORY_LISTED_DAYS;
  const msPerDay = CONFIG.SECONDS_PER_DAY * CONFIG.MS_PER_SECOND;
  const nowMs = Date.now();
  const todayUtc = new Date(nowMs).toISOString().slice(0, "YYYY-MM-DD".length);
  const staleBeforeMs = Date.parse(todayUtc) - CONFIG.PRICE_HISTORY_STALE_DAYS * msPerDay;

  // token → condition_id for events exposing both. A token can map to one market only.
  const conditionByToken = new Map<string, string>();
  for (const event of events) {
    if (event.yesTokenId && event.conditionId) {
      conditionByToken.set(event.yesTokenId, event.conditionId);
    }
  }
  const needed = [...conditionByToken.keys()];
  if (needed.length === 0) {
    return { fetched: 0, upserted: 0, deferred: 0 };
  }

  // Newest cached day per token (market_price_meta); a stale tail is flagged resolved → skipped.
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

  const { fetch, deferred } = planPriceFetches(needed, state, todayUtc, CONFIG.PRICE_HISTORY_MAX_FETCHES_PER_RUN);

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
      const conditionId = conditionByToken.get(asset) ?? null;
      try {
        const history = await client.getPriceHistory(asset);
        const points = dailyPointsFromHistory(history, historyDays, nowMs);
        if (points.length === 0) {
          continue;
        }
        const rows = points.map((point) => ({ asset, condition_id: conditionId, ts: point.ts, price: point.price }));
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
        console.warn(`listed price-history ${asset}: ${describeError(reason)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONFIG.WALLET_CONCURRENCY, fetch.length) }, () => worker()));

  return { fetched, upserted, deferred };
}

export function toRecentTradeRow(trade: RecentTrade): Database["public"]["Tables"]["recent_trades"]["Insert"] {
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
    end_date: position.endDate,
    first_traded_at: position.firstTradedAt,
    last_traded_at: position.lastTradedAt
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
    close_time: record.closeTime,
    first_traded_at: record.firstTradedAt
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

// How many ranked markets to persist into crowded_markets_cache. The web reads the top 40; storing a
// bit more leaves headroom without bloating the table.
const CROWDED_MARKETS_CACHE_LIMIT = 100;

// Page through a leaderboard-scoped table (PostgREST caps one response at 1000 rows). The factory
// rebuilds the query per page (a query builder is single-use).
async function fetchAllRows<T>(
  factory: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message?: string } | null }>
): Promise<T[]> {
  const PAGE = 1000;
  const rows: T[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await factory(from, from + PAGE - 1);
    if (error) {
      throw error;
    }
    const batch = data ?? [];
    rows.push(...batch);
    if (batch.length < PAGE) {
      break;
    }
    from += PAGE;
  }
  return rows;
}

// Fix C — precompute the Convergence ("crowded markets") ranked list into crowded_markets_cache.
// Previously the web app rebuilt this on every request by scanning the whole wallet_positions table
// (+ 90 days of closed positions) and aggregating in-process — on the home page's SSR path under a
// 1.5s timeout. The inputs only change when this full ingest repopulates the position caches, so we
// run the same summarizeCrowdedMarkets() aggregation here once and store the ranked rows; the web
// read collapses to a tiny "ORDER BY rank LIMIT n". Must run after replaceWalletPositions /
// replaceWalletClosedPositions (reads them back) and after rebuildLeaderboardCache (for the ranks).
async function cacheCrowdedMarkets(supabase: SupabaseClient): Promise<number> {
  // Best (lowest-number) leaderboard rank per address, for the participant rank overlay.
  const { data: cacheData, error: cacheError } = await supabase.from("leaderboard_cache").select("address, rank");
  if (cacheError) {
    throw cacheError;
  }
  const rankByAddress = new Map<string, number>();
  for (const row of cacheData ?? []) {
    const prev = rankByAddress.get(row.address);
    if (prev === undefined || row.rank < prev) {
      rankByAddress.set(row.address, row.rank);
    }
  }

  // Match the read-time window: closed positions are limited to the last 90 days (older positions are
  // outside every displayed horizon and don't affect the ranking).
  const cutoff = new Date(Date.now() - 90 * CONFIG.SECONDS_PER_DAY * CONFIG.MS_PER_SECOND).toISOString();
  const [openRows, closedRows] = await Promise.all([
    fetchAllRows<{
      address: string;
      condition_id: string | null;
      market: string | null;
      outcome_index: number | null;
      size: number | null;
      avg_price: number | null;
      cur_price: number | null;
    }>((from, to) =>
      supabase
        .from("wallet_positions")
        .select("address, condition_id, market, outcome_index, size, avg_price, cur_price")
        .range(from, to)
    ),
    fetchAllRows<{
      address: string;
      condition_id: string | null;
      market: string | null;
      outcome_index: number | null;
      size: number | null;
      avg_price: number | null;
      close_time: string | null;
    }>((from, to) =>
      supabase
        .from("wallet_closed_positions")
        .select("address, condition_id, market, outcome_index, size, avg_price, close_time")
        .gte("close_time", cutoff)
        .range(from, to)
    )
  ]);

  const positions: CrowdOpenPosition[] = openRows.map((row) => ({
    address: row.address,
    conditionId: row.condition_id,
    market: row.market,
    outcomeIndex: row.outcome_index,
    size: row.size ?? 0,
    avgPrice: row.avg_price ?? 0,
    curPrice: row.cur_price ?? 0
  }));
  const closed: CrowdClosedPosition[] = closedRows.map((row) => ({
    address: row.address,
    conditionId: row.condition_id,
    market: row.market,
    outcomeIndex: row.outcome_index,
    size: row.size ?? 0,
    avgPrice: row.avg_price ?? 0,
    closeTime: row.close_time
  }));

  const summaries = summarizeCrowdedMarkets(positions, closed, rankByAddress, CROWDED_MARKETS_CACHE_LIMIT);

  // Wipe-and-replace: the table is tiny (≤100 rows) so the dead-row churn is negligible.
  const { error: deleteError } = await supabase.from("crowded_markets_cache").delete().gte("rank", 0);
  if (deleteError) {
    throw deleteError;
  }
  if (summaries.length === 0) {
    return 0;
  }

  const cachedAt = new Date().toISOString();
  const rows = summaries.map((s, index) => ({
    condition_id: s.conditionId,
    rank: index + 1,
    market: s.market,
    trader_count: s.traderCount,
    yes_traders: s.yesTraders,
    no_traders: s.noTraders,
    open_count: s.openCount,
    closed_count: s.closedCount,
    committed_usd: s.committedUsd,
    net_exposure_usd: s.netExposureUsd,
    top_rank: s.topRank,
    cur_price: s.curPrice,
    last_traded_at: s.lastTradedAt,
    cached_at: cachedAt
  }));
  const { error: insertError } = await supabase.from("crowded_markets_cache").insert(rows);
  if (insertError) {
    throw insertError;
  }
  return rows.length;
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

  // Bound growth with two retention windows: wallet-seeded rows (condition_id null — the equity-curve
  // cache) at the max scoring horizon; listed-market rows (condition_id set — the Markets-page chart)
  // at the deeper PRICE_HISTORY_LISTED_DAYS so the chart keeps a market's full lifetime.
  const dayStr = (daysBack: number): string =>
    new Date(Date.parse(todayUtc) - daysBack * msPerDay).toISOString().slice(0, "YYYY-MM-DD".length);
  const walletPruneBefore = dayStr(maxHorizon);
  const listedPruneBefore = dayStr(CONFIG.PRICE_HISTORY_LISTED_DAYS);
  let pruned = 0;
  const { error: walletPruneError, count: walletCount } = await supabase
    .from("market_price_history")
    .delete({ count: "exact" })
    .is("condition_id", null)
    .lt("ts", walletPruneBefore);
  if (walletPruneError) {
    throw walletPruneError;
  }
  const { error: listedPruneError, count: listedCount } = await supabase
    .from("market_price_history")
    .delete({ count: "exact" })
    .not("condition_id", "is", null)
    .lt("ts", listedPruneBefore);
  if (listedPruneError) {
    throw listedPruneError;
  }
  pruned = (walletCount ?? 0) + (listedCount ?? 0);
  // Meta tracks newest-day-per-token for fetch planning; drop only tokens whose tail is older than the
  // deeper window so listed tokens aren't re-fetched needlessly.
  const { error: pruneMetaError } = await supabase.from("market_price_meta").delete().lt("max_ts", listedPruneBefore);
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
  for (let offset = 0; offset < assets.length; offset += CONFIG.ASSET_FILTER_CHUNK) {
    const slice = assets.slice(offset, offset + CONFIG.ASSET_FILTER_CHUNK);
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

// ── Hourly leaderboard rescore ─────────────────────────────────────────────────────────

export interface RescoreResult {
  selected: number; // distinct wallets selected across all horizons (deduped)
  scored: number; // wallets processWallet completed without throwing
  failed: number; // wallets that threw (logged + skipped, never abort the batch)
  bots: number; // wallets newly flagged as bots during this rescore
}

// Collapse the per-horizon top-N address lists into a single deduped, lowercased work list,
// preserving first-seen order (horizon order, then rank within a horizon). A wallet ranking in
// both the 30d and 90d boards is processed once. Pure so the selection logic is unit-tested
// independently of the DB. Addresses are normalized to lowercase to match the rest of the
// pipeline; processWallet would lowercase again, but deduping pre-normalized keys here means a
// wallet listed under different casings across horizons collapses to one unit of work.
export function dedupeRescoreAddresses(perHorizonAddresses: string[][]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const list of perHorizonAddresses) {
    for (const address of list) {
      const normalized = address.toLowerCase();
      if (!seen.has(normalized)) {
        seen.add(normalized);
        ordered.push(normalized);
      }
    }
  }
  return ordered;
}

// Top-RESCORE_TOP_N addresses for one horizon from wallet_stats, ranked exactly as
// rebuildLeaderboardCache ranks (skill_score desc, then avg_edge_per_share desc as the tiebreak),
// so the rescored set is precisely the wallets at or near the top of the board — including ranks
// just past TOP_N that could break in if their score improved since the last full ingest. The
// server-side .limit() keeps the payload to RESCORE_TOP_N rows.
async function selectTopWalletsByHorizon(
  supabase: SupabaseClient,
  horizon: number,
  limit: number
): Promise<string[]> {
  const { data, error } = await supabase
    .from("wallet_stats")
    .select("address, skill_score, avg_edge_per_share")
    .eq("horizon_days", horizon)
    .not("skill_score", "is", null)
    .order("skill_score", { ascending: false })
    .order("avg_edge_per_share", { ascending: false, nullsFirst: false })
    .limit(limit);
  if (error) {
    throw error;
  }
  return (data ?? []).map((row) => row.address);
}

// Cheap, hourly-cadence refresh of the leaderboard standings without a full multi-thousand-wallet
// ingest. Selects the top RESCORE_TOP_N wallets per horizon from the already-scored wallet_stats
// table (deduped across horizons), re-runs each through the same processWallet pipeline the full
// ingest uses — re-pulling /activity, /closed-positions, /positions and recomputing every horizon's
// metrics into wallet_stats + equity_curve — then rebuilds leaderboard_cache so the new scores
// re-rank the board. A few hundred wallets instead of thousands, so it finishes in minutes.
//
// Scope is deliberately just the standings: the activity feed has its own --feed-only job and the
// open/closed-position caches + price-history equity curve are refreshed by the daily full ingest,
// so the recentTrades/positions processWallet returns are discarded here (same as the candidate
// batch). Requires a prior full ingest to have populated wallet_stats — with an empty table the
// selection is empty and the rebuild is a no-op.
export async function rescoreTopWallets(
  supabase: SupabaseClient,
  client: PolymarketClient,
  recentTradeCutoffMs: number
): Promise<RescoreResult> {
  // Select per horizon, then dedupe. Sequential is fine: two cheap general-lane reads.
  const perHorizon: string[][] = [];
  for (const horizon of CONFIG.HORIZONS) {
    perHorizon.push(await selectTopWalletsByHorizon(supabase, horizon, CONFIG.RESCORE_TOP_N));
  }
  const addresses = dedupeRescoreAddresses(perHorizon);
  if (addresses.length === 0) {
    return { selected: 0, scored: 0, failed: 0, bots: 0 };
  }

  // Worker pool over the deduped set, mirroring the main ingest loop. processWallet upserts
  // wallet_stats + equity_curve + the wallets row itself; we keep only the aggregate counters.
  let cursor = 0;
  let scored = 0;
  let failed = 0;
  let bots = 0;
  const worker = async (): Promise<void> => {
    while (cursor < addresses.length) {
      const address = addresses[cursor];
      cursor += 1; // single-threaded JS: read+increment is atomic between awaits, so no double-claim.
      if (!address) {
        continue;
      }
      try {
        // writeEquityCurve=false: the rescore refreshes only scores; the equity_curve mark-to-market
        // series is owned by the daily full ingest (see upsertMetrics).
        const result = await processWallet(
          supabase,
          client,
          { address, userName: null, lifetimePnl: null },
          recentTradeCutoffMs,
          false
        );
        scored += 1;
        bots += result.bot ? 1 : 0;
      } catch (reason) {
        failed += 1;
        console.warn(`Rescore ${address}: ${describeError(reason)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONFIG.WALLET_CONCURRENCY, addresses.length) }, () => worker()));

  // Re-rank the whole board from the refreshed scores. The rebuild ranks across ALL wallet_stats
  // rows, so a rescored wallet whose score dropped can fall below a wallet we didn't touch — exactly
  // the intended behavior, and why the selection window (RESCORE_TOP_N) is wider than TOP_N.
  await rebuildLeaderboardCache(supabase);

  return { selected: addresses.length, scored, failed, bots };
}

// ── Candidate discovery and promotion pipeline ─────────────────────────────────────────

// Load all 'tracked' candidates from candidate_wallets for inclusion in the main worker
// pool. Tracked wallets have demonstrated positive forecasting edge in at least one prior
// scoring pass and compete for the same TOP_N leaderboard slots as leaderboard-seeded
// wallets — no special treatment beyond being in the pool.
async function loadTrackedCandidates(supabase: SupabaseClient): Promise<DiscoveredWallet[]> {
  const { data, error } = await supabase
    .from("candidate_wallets")
    .select("address")
    .eq("status", "tracked");
  if (error) {
    throw error;
  }
  // userName/lifetimePnl are unknown for most candidate sources; processWallet only uses them
  // for the wallets upsert (handle + lifetime_pnl columns), so null is safe — prior full-ingest
  // runs may have already written a handle from /activity userName.
  return (data ?? []).map((row) => ({ address: row.address, userName: null, lifetimePnl: null }));
}

// Insert newly discovered candidate addresses into candidate_wallets. ignoreDuplicates
// ensures existing rows (with their status/scoring history) are never overwritten —
// only brand-new addresses produce a row.
async function registerCandidates(
  supabase: SupabaseClient,
  candidates: Array<{ address: string; discoverySource: string }>
): Promise<number> {
  if (candidates.length === 0) {
    return 0;
  }
  for (let offset = 0; offset < candidates.length; offset += CONFIG.RECENT_TRADES_INSERT_CHUNK) {
    const slice = candidates.slice(offset, offset + CONFIG.RECENT_TRADES_INSERT_CHUNK);
    const { error } = await supabase
      .from("candidate_wallets")
      .upsert(
        slice.map((c) => ({ address: c.address, discovery_source: c.discoverySource })),
        { onConflict: "address", ignoreDuplicates: true }
      );
    if (error) {
      throw error;
    }
  }
  return candidates.length;
}

// Run the candidate discovery pass: pull multi-source leaderboard variants + /trades
// stream, register genuinely-new addresses into candidate_wallets, and return summary
// counts. Fails gracefully — a partial failure (one leaderboard source down) still
// registers all other discovered addresses.
async function discoverAndRegisterCandidates(
  supabase: SupabaseClient,
  knownAddresses: Set<string>
): Promise<{ discovered: number; registered: number }> {
  const candidates = await discoverCandidateAddresses(knownAddresses);
  const registered = await registerCandidates(supabase, candidates);
  return { discovered: candidates.length, registered };
}

interface CandidateScoringResult {
  scored: number;
  promoted: number;  // candidate → tracked
  retired: number;   // tracked → retired (handled in updateTrackedCandidateStatuses)
}

// Score a batch of unscored/stale candidates using the same processWallet pipeline as
// the main leaderboard pass. Updates candidate_wallets with the new scores and status
// transitions. Errors on individual wallets are logged and skipped without aborting the
// batch — one bad wallet doesn't waste the rest of the run's quota.
async function scoreCandidateBatch(
  supabase: SupabaseClient,
  client: PolymarketClient,
  recentTradeCutoffMs: number
): Promise<CandidateScoringResult> {
  const rescoringIntervalMs = CONFIG.CANDIDATE_RESCORE_DAYS * CONFIG.SECONDS_PER_DAY * CONFIG.MS_PER_SECOND;

  // Load unscored/stale candidates (status='candidate' only — tracked wallets are handled
  // by the main worker pool; retired wallets are never scored again).
  const { data: candidateRows, error: loadError } = await supabase
    .from("candidate_wallets")
    .select("address, discovery_source, status, first_seen_at, last_scored_at, skill_score, times_scored, consecutive_below_threshold, promoted_at, retired_at")
    .eq("status", "candidate");
  if (loadError) {
    throw loadError;
  }

  const allCandidates: CandidateWallet[] = (candidateRows ?? []).map((row) => ({
    address: row.address,
    discoverySource: row.discovery_source,
    status: row.status as CandidateStatus,
    firstSeenAt: row.first_seen_at,
    lastScoredAt: row.last_scored_at,
    skillScore: row.skill_score,
    timesScored: row.times_scored,
    consecutiveBelowThreshold: row.consecutive_below_threshold,
    promotedAt: row.promoted_at,
    retiredAt: row.retired_at
  }));

  const batch = selectCandidateBatch(allCandidates, CONFIG.CANDIDATE_BATCH_PER_RUN, Date.now(), rescoringIntervalMs);
  if (batch.length === 0) {
    return { scored: 0, promoted: 0, retired: 0 };
  }

  // Score each candidate — same processWallet call as the main pass, just discarded
  // feeds/positions (they're not on the board yet; the leaderboard rebuild will include
  // them if they get promoted and rank in the top N).
  const scoreByAddress = new Map<string, number | null>();
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < batch.length) {
      const candidate = batch[cursor];
      cursor += 1;
      if (!candidate) {
        continue;
      }
      try {
        await processWallet(
          supabase,
          client,
          { address: candidate.address, userName: null, lifetimePnl: null },
          recentTradeCutoffMs
        );
        // Fetch the skill scores just written to wallet_stats (processWallet upserts them).
        const { data: statsRows } = await supabase
          .from("wallet_stats")
          .select("skill_score")
          .eq("address", candidate.address);
        const scores = (statsRows ?? []).map((r) => r.skill_score);
        scoreByAddress.set(candidate.address, bestSkillScore(scores));
      } catch (reason) {
        console.warn(`Candidate scoring ${candidate.address}: ${describeError(reason)}`);
        scoreByAddress.set(candidate.address, null); // treat as ineligible
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONFIG.WALLET_CONCURRENCY, batch.length) }, () => worker()));

  // Compute and persist status transitions.
  const nowIso = new Date().toISOString();
  const scoringConfig = {
    promotionThreshold: CONFIG.CANDIDATE_PROMOTION_THRESHOLD,
    retirementThreshold: CONFIG.CANDIDATE_RETIREMENT_THRESHOLD,
    retirementConsecutive: CONFIG.CANDIDATE_RETIREMENT_CONSECUTIVE
  };
  let promoted = 0;
  for (const candidate of batch) {
    const newScore = scoreByAddress.get(candidate.address) ?? null;
    const outcome = computeScoringOutcome(candidate, newScore, nowIso, scoringConfig);
    if (outcome.newStatus === "tracked") {
      promoted += 1;
    }
    const { error: updateError } = await supabase
      .from("candidate_wallets")
      .update({
        status: outcome.newStatus,
        skill_score: outcome.skillScore,
        times_scored: outcome.timesScored,
        consecutive_below_threshold: outcome.consecutiveBelowThreshold,
        last_scored_at: outcome.lastScoredAt,
        promoted_at: outcome.promotedAt,
        retired_at: outcome.retiredAt
      })
      .eq("address", candidate.address);
    if (updateError) {
      console.warn(`candidate_wallets update ${candidate.address}: ${describeError(updateError)}`);
    }
  }

  return { scored: batch.length, promoted, retired: 0 };
}

// After the main leaderboard rebuild, update tracked candidates whose wallet_stats
// changed. A tracked wallet that falls below CANDIDATE_RETIREMENT_THRESHOLD for
// CANDIDATE_RETIREMENT_CONSECUTIVE consecutive runs is retired.
async function updateTrackedCandidateStatuses(supabase: SupabaseClient): Promise<number> {
  const { data: trackedRows, error: loadError } = await supabase
    .from("candidate_wallets")
    .select("address, discovery_source, status, first_seen_at, last_scored_at, skill_score, times_scored, consecutive_below_threshold, promoted_at, retired_at")
    .eq("status", "tracked");
  if (loadError) {
    throw loadError;
  }
  if (!trackedRows || trackedRows.length === 0) {
    return 0;
  }

  // Read the latest skill scores from wallet_stats for all tracked wallets.
  const trackedAddresses = trackedRows.map((r) => r.address);
  const bestScores = new Map<string, number | null>();
  for (let offset = 0; offset < trackedAddresses.length; offset += CONFIG.LEADERBOARD_FILTER_CHUNK) {
    const slice = trackedAddresses.slice(offset, offset + CONFIG.LEADERBOARD_FILTER_CHUNK);
    const { data: statsRows, error: statsError } = await supabase
      .from("wallet_stats")
      .select("address, skill_score")
      .in("address", slice);
    if (statsError) {
      throw statsError;
    }
    for (const row of statsRows ?? []) {
      const current = bestScores.get(row.address) ?? null;
      const s = row.skill_score;
      if (s !== null && (current === null || s > current)) {
        bestScores.set(row.address, s);
      }
    }
  }

  const nowIso = new Date().toISOString();
  const scoringConfig = {
    promotionThreshold: CONFIG.CANDIDATE_PROMOTION_THRESHOLD,
    retirementThreshold: CONFIG.CANDIDATE_RETIREMENT_THRESHOLD,
    retirementConsecutive: CONFIG.CANDIDATE_RETIREMENT_CONSECUTIVE
  };
  let retired = 0;
  for (const row of trackedRows) {
    const wallet: CandidateWallet = {
      address: row.address,
      discoverySource: row.discovery_source,
      status: row.status as CandidateStatus,
      firstSeenAt: row.first_seen_at,
      lastScoredAt: row.last_scored_at,
      skillScore: row.skill_score,
      timesScored: row.times_scored,
      consecutiveBelowThreshold: row.consecutive_below_threshold,
      promotedAt: row.promoted_at,
      retiredAt: row.retired_at
    };
    const newScore = bestScores.get(row.address) ?? null;
    const outcome = computeScoringOutcome(wallet, newScore, nowIso, scoringConfig);
    if (outcome.newStatus === "retired") {
      retired += 1;
    }
    // Only write if something changed (status, streak counter, or score).
    const changed =
      outcome.newStatus !== wallet.status ||
      outcome.consecutiveBelowThreshold !== wallet.consecutiveBelowThreshold ||
      outcome.skillScore !== wallet.skillScore;
    if (!changed) {
      continue;
    }
    const { error: updateError } = await supabase
      .from("candidate_wallets")
      .update({
        status: outcome.newStatus,
        skill_score: outcome.skillScore,
        times_scored: outcome.timesScored,
        consecutive_below_threshold: outcome.consecutiveBelowThreshold,
        last_scored_at: outcome.lastScoredAt,
        promoted_at: outcome.promotedAt,
        retired_at: outcome.retiredAt
      })
      .eq("address", row.address);
    if (updateError) {
      console.warn(`candidate_wallets tracked update ${row.address}: ${describeError(updateError)}`);
    }
  }
  return retired;
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

  // Hourly leaderboard rescore: re-fetch positions/activity for the top RESCORE_TOP_N wallets per
  // horizon (deduped), recompute their scores, and rebuild leaderboard_cache. A few hundred wallets
  // instead of the full pass's thousands, so it runs in minutes and is safe to schedule hourly.
  // Requires a prior full ingest to have populated wallet_stats (the selection source).
  if (process.argv.includes("--rescore-top")) {
    const recentTradeCutoffMs = Date.now() - CONFIG.RECENT_TRADE_WINDOW_HOURS * 60 * 60 * CONFIG.MS_PER_SECOND;
    const result = await rescoreTopWallets(supabase, new PolymarketClient(), recentTradeCutoffMs);
    console.log(
      `Rescored top ${CONFIG.RESCORE_TOP_N}/horizon: selected=${result.selected} wallets, scored=${result.scored}, ` +
        `failed=${result.failed}, bots=${result.bots}; elapsed=${((Date.now() - startedAt) / CONFIG.MS_PER_SECOND).toFixed(1)}s`
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
  const discoveredWallets = await discoverTopWallets();
  const recentTradeCutoffMs = Date.now() - CONFIG.RECENT_TRADE_WINDOW_HOURS * 60 * 60 * CONFIG.MS_PER_SECOND;

  // ── Candidate pipeline: discover + register, then load tracked into main pool ──────────
  // Build the known address set from the main leaderboard discovery to avoid re-registering
  // addresses we're already about to score in this run.
  const mainAddressSet = new Set(discoveredWallets.map((w) => w.address));
  let candidatesDiscovered = 0;
  let candidatesRegistered = 0;
  try {
    const cdResult = await discoverAndRegisterCandidates(supabase, mainAddressSet);
    candidatesDiscovered = cdResult.discovered;
    candidatesRegistered = cdResult.registered;
    console.log(`Candidate discovery: ${candidatesDiscovered} new addresses found, ${candidatesRegistered} registered`);
  } catch (reason) {
    console.warn(`Candidate discovery failed (non-fatal): ${describeError(reason)}`);
  }
  // Load tracked candidates and append to the worker pool so they compete for leaderboard
  // slots on every full run — no separate pass needed, their scores land in wallet_stats
  // just like any leaderboard-seeded wallet.
  let trackedCandidates: DiscoveredWallet[] = [];
  try {
    trackedCandidates = await loadTrackedCandidates(supabase);
    console.log(`Loaded ${trackedCandidates.length} tracked candidates for main pool`);
  } catch (reason) {
    console.warn(`Loading tracked candidates failed (non-fatal): ${describeError(reason)}`);
  }
  // Deduplicate: a tracked candidate already in the main leaderboard set adds no work.
  const newTracked = trackedCandidates.filter((w) => !mainAddressSet.has(w.address));
  const wallets = [...discoveredWallets, ...newTracked];

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

  console.log(`Discovered ${discoveredWallets.length} wallets + ${newTracked.length} tracked candidates = ${wallets.length} total`);

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

  // Board-scope every collected detail buffer before the candidate batch and the memory-heavy tail.
  // The pass accumulates detail for every *eligible* wallet (hundreds), but only the ~TOP_N leaderboard
  // wallets are ever persisted or read back — the feed, positions, and Convergence read paths all filter
  // on leaderboard membership, so non-board rows are dead weight. Dropping them here keeps peak memory
  // (the persisted inserts, the crowded-markets position read-back, the equity curve) proportional to
  // TOP_N instead of the full eligible set — which is what pushed the 512MB dyno past its R15/SIGKILL line.
  const boardAddresses = await getLeaderboardAddresses(supabase);
  const boardTrades = collectedTrades.filter((trade) => boardAddresses.has(trade.address));
  collectedTrades.length = 0;
  const boardFills = collectedFills.filter((fill) => boardAddresses.has(fill.address));
  collectedFills.length = 0;
  const boardPositions = collectedPositions.filter((position) => boardAddresses.has(position.address));
  collectedPositions.length = 0;
  const boardClosed = collectedClosed.filter((record) => boardAddresses.has(record.address));
  collectedClosed.length = 0;
  for (const address of [...assetsByAddress.keys()]) {
    if (!boardAddresses.has(address)) {
      assetsByAddress.delete(address);
    }
  }
  for (const address of [...entryDatesByAddress.keys()]) {
    if (!boardAddresses.has(address)) {
      entryDatesByAddress.delete(address);
    }
  }

  // ── Candidate pipeline: score batch + update tracked statuses ────────────────────────
  // Score a batch of unscored/stale candidates. Runs after the main worker pool so the
  // restricted-lane budget has already been spent on leaderboard wallets — candidates get
  // the remaining slot allowance, capped by CANDIDATE_BATCH_PER_RUN.
  let candidateScored = 0;
  let candidatePromoted = 0;
  let candidateRetired = 0;
  try {
    const batchResult = await scoreCandidateBatch(supabase, polymarket, recentTradeCutoffMs);
    candidateScored = batchResult.scored;
    candidatePromoted = batchResult.promoted;
    console.log(`Candidate batch: scored=${candidateScored}, promoted=${candidatePromoted}`);
  } catch (reason) {
    console.warn(`Candidate batch scoring failed (non-fatal): ${describeError(reason)}`);
  }
  // Update tracked candidates whose scores changed in this run (promotion/retirement).
  try {
    candidateRetired = await updateTrackedCandidateStatuses(supabase);
    if (candidateRetired > 0) {
      console.log(`Candidate retirement: retired=${candidateRetired} tracked wallets`);
    }
  } catch (reason) {
    console.warn(`Tracked candidate status update failed (non-fatal): ${describeError(reason)}`);
  }

  // Persist the board-scoped detail collected during processing (filtered above, right after the
  // rebuild). All four tables are read only for leaderboard wallets, so this is the full set the
  // web app can surface.
  const recentTradeCount = await replaceRecentTrades(supabase, boardTrades);
  const walletTradeCount = await replaceWalletTrades(supabase, boardFills);
  const walletPositionCount = await replaceWalletPositions(supabase, boardPositions);
  // Closed-position basis cache. Already board-scoped above; replaceWalletClosedPositions re-applies
  // the boardAddresses filter defensively. Sourced from the /closed-positions payload already fetched.
  const closedPositionCount = await replaceWalletClosedPositions(supabase, boardClosed, boardAddresses);

  // Precompute the Convergence ("crowded markets") ranked list so the web app reads a tiny cache
  // instead of scanning the whole position table per request (Fix C). Must run after the position
  // caches above and the leaderboard rebuild — it reads both back. Non-fatal: a failure here just
  // leaves the previous cache in place rather than aborting the run.
  let crowdedMarketCount = 0;
  try {
    crowdedMarketCount = await cacheCrowdedMarkets(supabase);
  } catch (reason) {
    console.warn(`Crowded-markets cache failed (non-fatal): ${describeError(reason)}`);
  }

  // Historical daily price series for the markets leaderboard wallets hold, for the mark-to-market
  // equity curve. Append-only + immutable (resolved markets fetched once), so it's independent of
  // the wipe-and-replace tables above and the only step that hits the CLOB API.
  const priceHistory = await cacheMarketPriceHistory(supabase, polymarket, boardAddresses, assetsByAddress);

  // Daily mark-to-market equity curve for board wallets: marks each in-window position at the cached
  // daily price. Reads the price cache just written above, so it must run after it. Overwrites the
  // sparse realized curve in equity_curve for board wallets.
  const equityCurveCount = await writeDailyEquityCurves(supabase, boardAddresses, boardPositions, boardClosed, entryDatesByAddress);
  // Last consumer of the position buffers — free them before the markets pass.
  boardPositions.length = 0;
  boardClosed.length = 0;

  // Markets are global and independent of wallet processing; refresh them in the same run.
  const marketCount = await ingestMarkets(supabase, polymarket);

  const elapsedSeconds = (Date.now() - startedAt) / CONFIG.MS_PER_SECOND;
  console.log(`Processed ${processed} wallets (${newTracked.length} tracked candidates); excluded bots=${bots}, insufficient=${insufficient}; ingested ${marketCount} markets, ${recentTradeCount} recent trades, ${walletTradeCount} profile fills, ${walletPositionCount} open positions, ${closedPositionCount} closed positions, ${crowdedMarketCount} crowded markets; price-history ${priceHistory.upserted} rows across ${priceHistory.fetched} markets (deferred=${priceHistory.deferred}, pruned=${priceHistory.pruned}); equity-curve ${equityCurveCount} daily rows; elapsed=${elapsedSeconds.toFixed(1)}s`);
  console.log(`Bot breakdown: trade_rate=${botBreakdown.trade_rate}, dust_trades=${botBreakdown.dust_trades}, simultaneous_markets=${botBreakdown.simultaneous_markets}`);
  console.log(`Candidate pipeline: discovered=${candidatesDiscovered} new, registered=${candidatesRegistered}; scored=${candidateScored}, promoted=${candidatePromoted}, retired=${candidateRetired}`);

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

// Only run the pipeline when this file is the process entry point (e.g. `tsx ingest.ts`), not when
// it's imported (the unit tests import the exported functions, which must not trigger a live run).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(describeError(error));
    process.exitCode = 1;
  });
}
