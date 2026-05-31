import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { botSignal, type BotSignal } from "./botDetection.js";
import { CONFIG } from "./config.js";
import { computeMetrics, type WalletMetrics } from "./metrics.js";
import { apiStats, discoverTopWallets, openUnrealizedPnl, PolymarketClient, resolvedToClosed, type DiscoveredWallet } from "./polymarket.js";

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
          win_rate: number;          n_trades: number;
          cached_at: string;
        };
        Insert: {
          horizon_days: number;
          rank: number;
          address: string;
          skill_score: number | null;
          pct_return: number;
          win_rate: number;          n_trades: number;
          cached_at?: string;
        };
        Update: {
          skill_score?: number | null;
          pct_return?: number;
          win_rate?: number;          n_trades?: number;
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

type SupabaseClient = ReturnType<typeof createClient<Database>>;

interface ProcessResult {
  address: string;
  bot: boolean;
  botReason: BotSignal | null;
  insufficient: boolean;
  summary: string;
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
  wallet: DiscoveredWallet
): Promise<ProcessResult> {
  const normalized = wallet.address.toLowerCase();
  const activity = await client.getActivity(normalized);
  const botReason = botSignal(activity, CONFIG);
  const bot = botReason !== null;

  const handle = wallet.userName?.trim() || null;
  const walletRow: Database["public"]["Tables"]["wallets"]["Insert"] = {
    address: normalized,
    is_bot_suspected: bot,
    // Only set handle when we have one, so re-runs without a name don't wipe a stored handle.
    ...(handle ? { handle } : {})
  };
  const { error: walletError } = await supabase.from("wallets").upsert(walletRow, { onConflict: "address" });

  if (walletError) {
    throw walletError;
  }

  if (bot) {
    return { address: normalized, bot: true, botReason, insufficient: false, summary: `skipped (bot: ${botReason})` };
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

  return {
    address: normalized,
    bot,
    botReason,
    insufficient: metrics.every((metric) => metric.skillScore === null),
    summary: `${closedPositions.length} closed + ${resolvedPositions.length} resolved positions`
  };
}

async function rebuildLeaderboardCache(supabase: SupabaseClient): Promise<void> {
  for (const horizon of CONFIG.HORIZONS) {
    const { data, error } = await supabase
      .from("wallet_stats")
      .select("address, skill_score, pct_return, win_rate, n_trades")
      .eq("horizon_days", horizon)
      .not("skill_score", "is", null)
      .order("skill_score", { ascending: false });

    if (error) {
      throw error;
    }

    const candidateAddresses = (data ?? []).map((row) => row.address);
    const allowedWallets = new Set<string>();
    // Filter out bot-suspected wallets in chunks: `.in()` serializes every address into the
    // request URL, so a single call with thousands of candidates overflows the server's URL-length
    // limit (this is what silently failed the 10k run). Batches keep each URL small.
    for (let offset = 0; offset < candidateAddresses.length; offset += CONFIG.LEADERBOARD_FILTER_CHUNK) {
      const slice = candidateAddresses.slice(offset, offset + CONFIG.LEADERBOARD_FILTER_CHUNK);
      const { data: walletRows, error: walletsError } = await supabase
        .from("wallets")
        .select("address")
        .in("address", slice)
        .eq("is_bot_suspected", false);

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

  // Opt-in fresh start: wipe computed tables before ingesting so stale rows from a prior run don't
  // linger. Placed after --rebuild-only so the two flags never combine to wipe-then-rebuild-empty.
  if (process.argv.includes("--reset")) {
    await resetComputedTables(supabase);
    console.log("Reset: cleared wallet_stats, equity_curve, and leaderboard_cache");
  }

  const polymarket = new PolymarketClient();
  const wallets = await discoverTopWallets();
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
        const result = await processWallet(supabase, polymarket, wallet);
        bots += result.bot ? 1 : 0;
        if (result.botReason) {
          botBreakdown[result.botReason] += 1;
        }
        insufficient += result.insufficient ? 1 : 0;
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
  const elapsedSeconds = (Date.now() - startedAt) / CONFIG.MS_PER_SECOND;
  console.log(`Processed ${processed} wallets; excluded bots=${bots}, insufficient=${insufficient}; elapsed=${elapsedSeconds.toFixed(1)}s`);
  console.log(`Bot breakdown: trade_rate=${botBreakdown.trade_rate}, dust_trades=${botBreakdown.dust_trades}, simultaneous_markets=${botBreakdown.simultaneous_markets}`);

  // Diagnostic: the restricted lane (closed-positions) is the dominant cost. Its theoretical floor
  // is requests * interval; if processing took ~that, we're gate-bound (near the rate-limit ceiling)
  // and only a smaller interval would help. If processing >> floor, time is leaking elsewhere
  // (Supabase writes, retry backoff) and concurrency/those paths are the lever.
  const restrictedFloorSeconds =
    (apiStats.requests.restricted * CONFIG.REQUEST_INTERVAL_MS.restricted) / CONFIG.MS_PER_SECOND;
  console.log(
    `API requests: restricted=${apiStats.requests.restricted} general=${apiStats.requests.general} retries=${apiStats.retries}`
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
