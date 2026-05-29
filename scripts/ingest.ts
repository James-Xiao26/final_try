import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { isSuspectedBot } from "./botDetection.js";
import { CONFIG } from "./config.js";
import { computeMetrics, type WalletMetrics } from "./metrics.js";
import { discoverTopWallets, PolymarketClient, type DiscoveredWallet } from "./polymarket.js";

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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }

  return result;
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

  for (const batch of chunks(wallets, CONFIG.WALLET_BATCH_SIZE)) {
    const settled = await Promise.allSettled(
      batch.map((wallet) => processWallet(supabase, polymarket, wallet))
    );

    settled.forEach((result, index) => {
      if (result.status === "fulfilled") {
        processed += 1;
        bots += result.value.bot ? 1 : 0;
        insufficient += result.value.insufficient ? 1 : 0;
      } else {
        const wallet = batch[index]?.address ?? "unknown";
        console.error(`Wallet ${wallet} failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
      }
    });

    console.log(`Processed ${processed}/${wallets.length} wallets (bots=${bots}, insufficient=${insufficient})`);
    await sleep(CONFIG.BATCH_DELAY_MS);
  }

  await rebuildLeaderboardCache(supabase);
  const elapsedSeconds = (Date.now() - startedAt) / CONFIG.MS_PER_SECOND;
  console.log(`Processed ${processed} wallets; excluded bots=${bots}, insufficient=${insufficient}; elapsed=${elapsedSeconds.toFixed(1)}s`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
