import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { isSuspectedBot } from "./botDetection.js";
import { CONFIG } from "./config.js";
import { computeMetrics, type WalletMetrics } from "./metrics.js";
import { apiStats, discoverTopWallets, PolymarketClient, type DiscoveredWallet } from "./polymarket.js";

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
          win_rate: number;
          max_drawdown: number;
          total_pnl_usd: number;
          total_volume_usd: number;
          n_trades: number;
          computed_at: string;
        };
        Insert: {
          address: string;
          horizon_days: number;
          skill_score: number | null;
          pct_return: number;
          win_rate: number;
          max_drawdown: number;
          total_pnl_usd: number;
          total_volume_usd: number;
          n_trades: number;
          computed_at?: string;
        };
        Update: {
          skill_score?: number | null;
          pct_return?: number;
          win_rate?: number;
          max_drawdown?: number;
          total_pnl_usd?: number;
          total_volume_usd?: number;
          n_trades?: number;
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
          max_drawdown: number;
          n_trades: number;
          cached_at: string;
        };
        Insert: {
          horizon_days: number;
          rank: number;
          address: string;
          skill_score: number | null;
          pct_return: number;
          win_rate: number;
          max_drawdown: number;
          n_trades: number;
          cached_at?: string;
        };
        Update: {
          skill_score?: number | null;
          pct_return?: number;
          win_rate?: number;
          max_drawdown?: number;
          n_trades?: number;
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
  insufficient: boolean;
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
    max_drawdown: metrics.maxDrawdown,
    total_pnl_usd: metrics.totalPnlUsd,
    total_volume_usd: metrics.totalVolumeUsd,
    n_trades: metrics.nTrades,
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
  const bot = isSuspectedBot(activity, CONFIG.HORIZONS[1], CONFIG);

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
    console.log(`  ${normalized}: skipped (bot)`);
    return { address: normalized, bot: true, insufficient: false };
  }

  const closedPositions = await client.getClosedPositions(normalized);
  const metrics = CONFIG.HORIZONS.map((horizon) => computeMetrics(closedPositions, horizon, CONFIG));

  await Promise.all(metrics.map((metric) => upsertMetrics(supabase, normalized, metric)));

  console.log(`  ${normalized}: ${closedPositions.length} closed positions`);

  return {
    address: normalized,
    bot,
    insufficient: metrics.every((metric) => metric.skillScore === null)
  };
}

async function rebuildLeaderboardCache(supabase: SupabaseClient): Promise<void> {
  for (const horizon of CONFIG.HORIZONS) {
    const { data, error } = await supabase
      .from("wallet_stats")
      .select("address, skill_score, pct_return, win_rate, max_drawdown, n_trades")
      .eq("horizon_days", horizon)
      .not("skill_score", "is", null)
      .order("skill_score", { ascending: false });

    if (error) {
      throw error;
    }

    const candidateAddresses = (data ?? []).map((row) => row.address);
    const allowedWallets = new Set<string>();
    if (candidateAddresses.length > 0) {
      const { data: walletRows, error: walletsError } = await supabase
        .from("wallets")
        .select("address")
        .in("address", candidateAddresses)
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
        max_drawdown: row.max_drawdown,
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

async function main(): Promise<void> {
  const startedAt = Date.now();
  const supabase = createClient<Database>(
    requiredEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requiredEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false } }
  );
  const polymarket = new PolymarketClient();
  const wallets = await discoverTopWallets();
  let processed = 0;
  let bots = 0;
  let insufficient = 0;

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
      try {
        const result = await processWallet(supabase, polymarket, wallet);
        bots += result.bot ? 1 : 0;
        insufficient += result.insufficient ? 1 : 0;
      } catch (reason) {
        console.error(`Wallet ${wallet.address} failed: ${describeError(reason)}`);
      }
      processed += 1;
      if (processed % 50 === 0 || processed === total) {
        console.log(`Processed ${processed}/${total} wallets (bots=${bots}, insufficient=${insufficient})`);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CONFIG.WALLET_CONCURRENCY, total) }, () => worker())
  );
  const processingSeconds = (Date.now() - processingStartedAt) / CONFIG.MS_PER_SECOND;

  await rebuildLeaderboardCache(supabase);
  const elapsedSeconds = (Date.now() - startedAt) / CONFIG.MS_PER_SECOND;
  console.log(`Processed ${processed} wallets; excluded bots=${bots}, insufficient=${insufficient}; elapsed=${elapsedSeconds.toFixed(1)}s`);

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
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
