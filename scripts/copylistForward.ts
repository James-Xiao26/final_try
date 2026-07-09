// Forward test for the COPYLIST signal — survivorship-free counterpart to the in-sample copy backtest.
//
//   pnpm --filter edgeboard-scripts copylist:record   # lock today's copylist candidates
//   pnpm --filter edgeboard-scripts copylist:score     # resolve settled ones + print the scorecard
//
// copyList surfaces markets elite wallets just bought. Backtesting that on the archive is rigged (elite =
// wallets selected because they already won). This closes the gap the only honest way: --record locks a
// prediction the moment a (market, side) would appear on the copylist — freezing the price you'd copy at
// and the elite-wallet agreement count — and --score settles it via Gamma/UMA after resolution. Over
// weeks it becomes a bias-free answer to "does copying elite wallets make money, and does agreement help?"
//
// Signal + gates match copyList.ts exactly (shared buildCandidates + loadEliteWallets), so the forward
// test measures the same thing the tool shows. See migration 032, ALPHA_RESEARCH_LOG §11.
import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { PolymarketClient } from "./polymarket.js";
import { loadEliteWallets } from "./eliteWallets.js";
import { buildCandidates, copyPnlPerDollar, type Trade } from "./copyCandidates.js";

loadEnv({ path: "../.env.local" });
loadEnv();

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}
const supabase = createClient(requiredEnv("NEXT_PUBLIC_SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"));

const ELITE_OPTS = {
  minFamilies: Number(process.env.COPY_MIN_FAMILIES ?? 8),
  minHalfFamilies: 3,
  minEdge: Number(process.env.COPY_MIN_EDGE ?? 0.03)
};
const FRESH_DAYS = Number(process.env.COPY_FRESH_DAYS ?? 3);
const MIN_LIQUIDITY_USD = Number(process.env.COPY_MIN_LIQ ?? 100);

async function fetchTrades(): Promise<Trade[]> {
  const rows: Trade[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from("recent_trades").select("address, condition_id, market, outcome_index, side, price, usdc_size, traded_at").range(from, from + 999);
    if (error) throw error;
    const batch = (data ?? []) as Trade[];
    rows.push(...batch);
    if (batch.length < 1000) break;
  }
  return rows;
}

export async function record(): Promise<void> {
  const [elite, trades] = await Promise.all([loadEliteWallets(supabase, ELITE_OPTS), fetchTrades()]);
  const candidates = buildCandidates(trades, elite, Date.now(), { freshDays: FRESH_DAYS, minPrice: 0.1, maxPrice: 0.9, minLiquidity: MIN_LIQUIDITY_USD });

  const { data: existingData, error: existingErr } = await supabase.from("copylist_predictions").select("condition_id, outcome_index");
  if (existingErr) throw existingErr;
  const existing = new Set((existingData ?? []).map((r: { condition_id: string; outcome_index: number }) => `${r.condition_id}:${r.outcome_index}`));

  const client = new PolymarketClient();
  interface Insert { condition_id: string; outcome_index: number; market: string | null; bet_label: string | null; entry_price: number; participant_count: number; avg_elite_edge: number; end_date: string | null }
  const inserts: Insert[] = [];
  let skipped = 0;
  for (const c of candidates) {
    if (existing.has(`${c.conditionId}:${c.outcomeIndex}`)) continue; // locked already — never revise
    const brief = await client.getMarketBrief(c.conditionId).catch(() => null);
    if (!brief || brief.resolved) { skipped += 1; continue; }
    const endMs = brief.endDate ? Date.parse(brief.endDate) : NaN;
    if (!Number.isNaN(endMs) && endMs <= Date.now()) { skipped += 1; continue; } // already ended
    inserts.push({
      condition_id: c.conditionId,
      outcome_index: c.outcomeIndex,
      market: c.question,
      bet_label: brief.outcomes[c.outcomeIndex] ?? c.side,
      entry_price: c.avgPrice,
      participant_count: c.wallets,
      avg_elite_edge: c.avgEliteEdge,
      end_date: brief.endDate
    });
  }

  if (inserts.length > 0) {
    const { error } = await supabase.from("copylist_predictions").upsert(inserts, { onConflict: "condition_id,outcome_index", ignoreDuplicates: true });
    if (error) throw error;
  }
  console.log(`${candidates.length} copylist candidates; ${existing.size} already locked, ${skipped} skipped (resolved/ended). Recorded ${inserts.length} new. Table now ~${existing.size + inserts.length}.`);
}

interface Pred {
  condition_id: string;
  outcome_index: number;
  market: string | null;
  entry_price: number;
  participant_count: number;
  avg_elite_edge: number | null;
  end_date: string | null;
  recorded_at: string;
  resolved_outcome: number | null;
}

export async function score(): Promise<void> {
  const { data: pendingData, error: pendingErr } = await supabase
    .from("copylist_predictions")
    .select("condition_id, outcome_index, end_date, recorded_at")
    .is("resolved_outcome", null);
  if (pendingErr) throw pendingErr;
  const pending = (pendingData ?? []) as { condition_id: string; outcome_index: number; end_date: string | null; recorded_at: string }[];

  const client = new PolymarketClient();
  const nowMs = Date.now();
  let newlyResolved = 0;
  let checked = 0;
  for (const p of pending) {
    const due = p.end_date ? Date.parse(p.end_date) <= nowMs : Date.parse(p.recorded_at) <= nowMs - 86_400_000;
    if (!due) continue;
    checked += 1;
    const outcome = await client.getResolvedOutcome(p.condition_id).catch(() => null);
    if (outcome === null) continue;
    const { error } = await supabase
      .from("copylist_predictions")
      .update({ resolved_outcome: outcome, resolved_at: new Date().toISOString() })
      .eq("condition_id", p.condition_id)
      .eq("outcome_index", p.outcome_index);
    if (error) throw error;
    newlyResolved += 1;
  }
  console.log(`${pending.length} pending; checked ${checked} due; ${newlyResolved} newly resolved.\n`);

  const { data: resolvedData, error: resolvedErr } = await supabase
    .from("copylist_predictions")
    .select("condition_id, outcome_index, market, entry_price, participant_count, avg_elite_edge, end_date, recorded_at, resolved_outcome")
    .not("resolved_outcome", "is", null);
  if (resolvedErr) throw resolvedErr;
  const resolved = (resolvedData ?? []) as Pred[];

  console.log(`── COPYLIST FORWARD SCORECARD — ${resolved.length} settled, ${pending.length - newlyResolved} pending ──`);
  if (resolved.length === 0) {
    console.log("No copylist predictions have resolved yet. Re-run --score once some markets close.");
    return;
  }
  const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
  const summarize = (label: string, rows: Pred[]): void => {
    if (rows.length === 0) { console.log(`  ${label.padEnd(20)} n=0`); return; }
    const pnl = rows.map((r) => copyPnlPerDollar(r.outcome_index, r.entry_price, r.resolved_outcome!));
    const wins = rows.filter((r) => copyPnlPerDollar(r.outcome_index, r.entry_price, r.resolved_outcome!) > 0).length;
    console.log(`  ${label.padEnd(20)} n=${String(rows.length).padStart(4)}  win ${((wins / rows.length) * 100).toFixed(1)}%  mean $/$1 ${mean(pnl) >= 0 ? "+" : ""}${mean(pnl).toFixed(3)}`);
  };
  console.log(`(mean $/$1 > 0 = copying made money after paying the entry price. No survivorship — locked before resolution.)`);
  summarize("ALL copies", resolved);
  console.log(`  --- does agreement help? ---`);
  summarize("1 wallet", resolved.filter((r) => r.participant_count === 1));
  summarize("2 wallets", resolved.filter((r) => r.participant_count === 2));
  summarize("3+ wallets", resolved.filter((r) => r.participant_count >= 3));
  // The walk-forward's strongest survivor was per-wallet edge, not agreement — slice by the copiers'
  // historical edge (frozen at record time) so the forward test judges the edge-ranked policy directly.
  console.log(`  --- does copier edge help? (edge tertiles among resolved) ---`);
  const byEdge = [...resolved].sort((a, b) => (b.avg_elite_edge ?? 0) - (a.avg_elite_edge ?? 0));
  const third = Math.ceil(byEdge.length / 3);
  summarize("high-edge third", byEdge.slice(0, third));
  summarize("mid third", byEdge.slice(third, 2 * third));
  summarize("low-edge third", byEdge.slice(2 * third));
  console.log(`\n(Still gross of fees/slippage; entry_price is the copylist avg, your real fill may differ a few cents.)`);
}

async function main(): Promise<void> {
  if (process.argv.includes("--score")) await score();
  else await record();
}

// CLI entry only — ingest.ts imports record/score for the daily piggyback, which must not auto-run main.
if (process.argv[1]?.replace(/\\/g, "/").includes("copylistForward")) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
