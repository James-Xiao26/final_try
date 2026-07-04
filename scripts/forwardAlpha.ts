// Forward alpha test — the survivorship-free counterpart to backtestSmartMoney.ts.
//
//   pnpm --filter edgeboard-scripts forward:record   # snapshot today's signal for qualifying markets
//   pnpm --filter edgeboard-scripts forward:score     # resolve due predictions + print the running scorecard
//
// backtestSmartMoney.ts scores the PAST trades of wallets on the CURRENT leaderboard — wallets picked
// because they already won — so its absolute profit is survivorship-inflated (the ranking of weighting
// formulas is still valid; the +$/$1 is not). This closes that gap the only honest way: --record
// commits a prediction the instant a market first qualifies (>=5 leaderboard wallets each holding a
// non-dust open position), storing the smart-money implied price under each candidate formula next to
// the live market price, with leaderboard membership frozen at record time and never revised. --score
// checks which recorded markets have since resolved and scores the locked-in predictions against the
// real outcome. As markets resolve over the coming weeks the sample grows into a bias-free track
// record of whether smart money actually beats the market — and which weighting does it best.
//
// Signal definition matches web/lib/trendingMarkets.ts exactly (skill*sqrt(cost), $10 dust floor, 5+
// participants, YES-equivalent inversion for NO positions). The live market price is read straight
// from wallet_positions.cur_price (the outcome's current price) — so --record makes ZERO API calls.
import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { strict as assert } from "node:assert";
import { PolymarketClient } from "./polymarket.js";
import { dailyPointsFromHistory } from "./priceHistory.js";

loadEnv({ path: "../.env.local" });
loadEnv();

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

// Service-role key: --score writes resolved_outcome, --record inserts rows (see migration 028 — the
// table has no RLS, and the anon key isn't meant for writes anyway).
const supabase = createClient(requiredEnv("NEXT_PUBLIC_SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"));

const DUST_FLOOR_USD = 10; // same as web/lib/trendingMarkets.ts TRENDING_DUST_FLOOR_USD
const MIN_PARTICIPANTS = 5; // same as web/lib/trendingMarkets.ts TRENDING_MIN_PARTICIPANTS
const RESOLVE_EPSILON = 0.03; // final YES-token price within this of {0,1} => resolved
const ALREADY_DECIDED = 0.05; // skip recording a market already priced within this of {0,1} — no forward value
const GAP_THRESHOLDS = [0, 0.05, 0.1, 0.2];

interface PositionRow {
  address: string;
  condition_id: string | null;
  market: string | null;
  outcome_index: number | null;
  size: number | null;
  avg_price: number | null;
  cur_price: number | null;
  end_date: string | null;
}

const cost = (r: PositionRow): number => (r.size ?? 0) * (r.avg_price ?? 0);
const yesEqEntry = (r: PositionRow): number => (r.outcome_index === 1 ? 1 - (r.avg_price ?? 0) : r.avg_price ?? 0);
const yesEqCur = (r: PositionRow): number => (r.outcome_index === 1 ? 1 - (r.cur_price ?? 0) : r.cur_price ?? 0);

function weightedYes(rows: PositionRow[], weightOf: (r: PositionRow) => number): number | null {
  let weight = 0;
  let weighted = 0;
  for (const r of rows) {
    const w = weightOf(r);
    weight += w;
    weighted += w * yesEqEntry(r);
  }
  return weight > 0 ? weighted / weight : null;
}

// Consensus tightness: unweighted stdev of the wallets' YES-equivalent entries. Low = they agree.
function dispersion(rows: PositionRow[]): number {
  const xs = rows.map(yesEqEntry);
  const m = xs.reduce((a, x) => a + x, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / xs.length);
}

async function fetchPositions(): Promise<PositionRow[]> {
  const rows: PositionRow[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("wallet_positions")
      .select("address, condition_id, market, outcome_index, size, avg_price, cur_price, end_date")
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const batch = (data ?? []) as PositionRow[];
    rows.push(...batch);
    if (batch.length < PAGE) break;
  }
  return rows;
}

async function fetchSkillByAddress(): Promise<Map<string, number>> {
  const { data, error } = await supabase.from("leaderboard_cache").select("address, skill_score");
  if (error) throw error;
  const skill = new Map<string, number>();
  for (const row of (data ?? []) as { address: string; skill_score: number | null }[]) {
    const prev = skill.get(row.address);
    if (row.skill_score !== null && (prev === undefined || row.skill_score > prev)) skill.set(row.address, row.skill_score);
  }
  return skill;
}

async function record(): Promise<void> {
  console.log("Reading current leaderboard positions...");
  const [positions, skillByAddress] = await Promise.all([fetchPositions(), fetchSkillByAddress()]);
  const skillOf = (r: PositionRow): number => Math.max(0, skillByAddress.get(r.address) ?? 0);

  const byCondition = new Map<string, PositionRow[]>();
  for (const row of positions) {
    if (!row.condition_id) continue;
    const group = byCondition.get(row.condition_id);
    if (group) group.push(row);
    else byCondition.set(row.condition_id, [row]);
  }

  const { data: existingData, error: existingErr } = await supabase.from("forward_alpha_predictions").select("condition_id");
  if (existingErr) throw existingErr;
  const existing = new Set((existingData ?? []).map((r: { condition_id: string }) => r.condition_id));

  interface Insert {
    condition_id: string;
    question: string | null;
    participant_count: number;
    market_price: number;
    smart_v1: number;
    smart_dollar: number;
    smart_sqrt: number;
    smart_payout: number;
    entry_dispersion: number;
    end_date: string | null;
  }
  const inserts: Insert[] = [];
  let skippedDecided = 0;
  for (const [conditionId, rows] of byCondition) {
    if (existing.has(conditionId)) continue; // first sighting wins — never revise a locked prediction
    const positioned = rows.filter((r) => cost(r) >= DUST_FLOOR_USD);
    if (new Set(positioned.map((r) => r.address)).size < MIN_PARTICIPANTS) continue;

    // Live market price = average YES-equivalent current price across holders (all see the same live
    // book, just their own side; averaging collapses to the true live YES).
    const curable = positioned.filter((r) => r.cur_price !== null);
    if (curable.length === 0) continue;
    const marketPrice = curable.reduce((a, r) => a + yesEqCur(r), 0) / curable.length;
    if (marketPrice <= ALREADY_DECIDED || marketPrice >= 1 - ALREADY_DECIDED) {
      skippedDecided += 1;
      continue; // already basically resolved — no forward signal to test
    }

    const v1 = weightedYes(positioned, (r) => skillOf(r) * Math.sqrt(cost(r)));
    const dollar = weightedYes(positioned, cost);
    const sqrt = weightedYes(positioned, (r) => Math.sqrt(cost(r)));
    // Payout-if-it-wins weight = shares * $1 = size; drops entry price from the weight (see migration 030).
    const payout = weightedYes(positioned, (r) => r.size ?? 0);
    if (v1 === null || dollar === null || sqrt === null || payout === null) continue;

    const endDate = positioned.map((r) => r.end_date).filter((d): d is string => d !== null).sort().at(-1) ?? null;
    inserts.push({
      condition_id: conditionId,
      question: positioned.find((r) => r.market)?.market ?? null,
      participant_count: new Set(positioned.map((r) => r.address)).size,
      market_price: marketPrice,
      smart_v1: v1,
      smart_dollar: dollar,
      smart_sqrt: sqrt,
      smart_payout: payout,
      entry_dispersion: dispersion(positioned),
      end_date: endDate
    });
  }

  if (inserts.length > 0) {
    // ignoreDuplicates so a race with a concurrent run can't clobber an existing locked prediction.
    const { error } = await supabase.from("forward_alpha_predictions").upsert(inserts, { onConflict: "condition_id", ignoreDuplicates: true });
    if (error) throw error;
  }
  console.log(
    `${byCondition.size} markets have leaderboard positions; ${existing.size} already logged, ${skippedDecided} skipped (already decided).`
  );
  console.log(`Recorded ${inserts.length} new prediction(s). Table now holds ${existing.size + inserts.length}.`);
}

// A market's YES token settles to ~1 (YES won) or ~0 (NO won); anything in between = still open.
async function resolvedOutcome(conditionId: string, client: PolymarketClient): Promise<number | null> {
  const yesTokenId = await client.getYesTokenId(conditionId);
  if (!yesTokenId) return null;
  const raw = await client.getPriceHistory(yesTokenId);
  const points = dailyPointsFromHistory(raw, 3650, Date.now());
  let latest: { ts: string; price: number } | null = null;
  for (const p of points) if (latest === null || p.ts > latest.ts) latest = p;
  if (latest === null) return null;
  if (latest.price >= 1 - RESOLVE_EPSILON) return 1;
  if (latest.price <= RESOLVE_EPSILON) return 0;
  return null; // still open
}

async function score(): Promise<void> {
  const { data: pendingData, error: pendingErr } = await supabase
    .from("forward_alpha_predictions")
    .select("condition_id, end_date, recorded_at")
    .is("resolved_outcome", null);
  if (pendingErr) throw pendingErr;
  const pending = (pendingData ?? []) as { condition_id: string; end_date: string | null; recorded_at: string }[];

  const client = new PolymarketClient();
  const nowMs = Date.now();
  let newlyResolved = 0;
  let checked = 0;
  for (const p of pending) {
    // Only spend an API call on markets that are plausibly resolved: past their end date, or (if no
    // end date is known) at least a day old.
    const due = p.end_date ? Date.parse(p.end_date) <= nowMs : Date.parse(p.recorded_at) <= nowMs - 86_400_000;
    if (!due) continue;
    checked += 1;
    const outcome = await resolvedOutcome(p.condition_id, client);
    if (outcome === null) continue;
    const { error } = await supabase
      .from("forward_alpha_predictions")
      .update({ resolved_outcome: outcome, resolved_at: new Date().toISOString() })
      .eq("condition_id", p.condition_id);
    if (error) throw error;
    newlyResolved += 1;
  }
  console.log(`${pending.length} pending; checked ${checked} due; ${newlyResolved} newly resolved.\n`);

  const { data: resolvedData, error: resolvedErr } = await supabase
    .from("forward_alpha_predictions")
    .select("market_price, smart_v1, smart_dollar, smart_sqrt, smart_payout, entry_dispersion, resolved_outcome")
    .not("resolved_outcome", "is", null);
  if (resolvedErr) throw resolvedErr;
  const resolved = (resolvedData ?? []) as {
    market_price: number;
    smart_v1: number;
    smart_dollar: number;
    smart_sqrt: number;
    smart_payout: number | null;
    entry_dispersion: number | null;
    resolved_outcome: number;
  }[];

  console.log(`── FORWARD SCORECARD — ${resolved.length} resolved prediction(s), ${pending.length - newlyResolved} still pending ──`);
  if (resolved.length === 0) {
    console.log("No predictions have resolved yet. Re-run --score once some markets close.");
    return;
  }

  const brier = (pred: number, a: number): number => (pred - a) ** 2;
  const mean = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;
  const acc = (preds: number[], a: number[]): number => mean(preds.map((p, i) => (p > 0.5 === a[i]! > 0.5 ? 1 : 0)));
  const actuals = resolved.map((r) => r.resolved_outcome);

  // The alpha question: does the smart-money signal beat the MARKET's own price? Market price is the
  // benchmark row — a formula only has edge if its Brier is below the market's.
  // smart_payout is nullable (rows predating migration 030), so a column's getter may return null and
  // each row is scored only on the formulas it has — hence the per-column non-null filter below.
  const cols: [string, (r: (typeof resolved)[number]) => number | null][] = [
    ["market price (benchmark)", (r) => r.market_price],
    ["smart v1 (skill*sqrt)", (r) => r.smart_v1],
    ["smart dollar", (r) => r.smart_dollar],
    ["smart sqrt(cost)", (r) => r.smart_sqrt],
    ["smart payout (size)", (r) => r.smart_payout]
  ];
  console.log("\nBrier vs. outcome (lower = better) + directional accuracy:");
  for (const [label, get] of cols) {
    const rowsF = resolved.filter((r) => get(r) !== null);
    const preds = rowsF.map((r) => get(r)!);
    const acts = rowsF.map((r) => r.resolved_outcome);
    console.log(
      `  ${label.padEnd(26)} Brier ${mean(preds.map((p, i) => brier(p, acts[i]!))).toFixed(4)}   accuracy ${(acc(preds, acts) * 100).toFixed(1)}%   n=${rowsF.length}`
    );
  }

  console.log("\nSimulated return per $1 — buy the side each formula diverges from the market on, at the market price:");
  for (const [label, get] of cols.slice(1)) {
    console.log(`\n  [${label}]`);
    for (const minGap of GAP_THRESHOLDS) {
      const trades = resolved
        .filter((r) => get(r) !== null)
        .map((r) => ({ r, gap: get(r)! - r.market_price }))
        .filter((t) => Math.abs(t.gap) >= minGap);
      if (trades.length === 0) {
        console.log(`    >=${(minGap * 100).toFixed(0)}pt gap: n=0`);
        continue;
      }
      const profits = trades.map((t) => (t.gap >= 0 ? t.r.resolved_outcome - t.r.market_price : t.r.market_price - t.r.resolved_outcome));
      const avg = mean(profits);
      const winRate = mean(profits.map((p) => (p > 0 ? 1 : 0)));
      console.log(`    >=${(minGap * 100).toFixed(0)}pt gap: n=${trades.length}, avg profit/$1=${avg >= 0 ? "+" : ""}${avg.toFixed(3)}, win rate=${(winRate * 100).toFixed(1)}%`);
    }
  }
  // Consensus split: does a TIGHT smart-money cluster (low entry_dispersion) beat a scattered one?
  // Split the resolved sample at its median dispersion and score each formula's tilt within each half.
  // Skips rows recorded before the entry_dispersion column existed (029).
  const withDisp = resolved.filter((r) => r.entry_dispersion !== null);
  if (withDisp.length >= 4) {
    const sortedDisp = withDisp.map((r) => r.entry_dispersion!).sort((a, b) => a - b);
    const medianDisp = sortedDisp[Math.floor(sortedDisp.length / 2)]!;
    console.log(`\nConsensus split — tight vs loose smart-money agreement (median dispersion ${medianDisp.toFixed(3)}):`);
    for (const [label, get] of cols.slice(1)) {
      console.log(`\n  [${label}]`);
      for (const [tag, keep] of [["tight", true], ["loose", false]] as const) {
        const half = withDisp.filter((r) => (r.entry_dispersion! <= medianDisp) === keep && get(r) !== null);
        const profits = half.map((r) => {
          const gap = get(r)! - r.market_price;
          return gap >= 0 ? r.resolved_outcome - r.market_price : r.market_price - r.resolved_outcome;
        });
        if (profits.length === 0) {
          console.log(`    ${tag.padEnd(5)}: n=0`);
          continue;
        }
        const avg = mean(profits);
        const winRate = mean(profits.map((p) => (p > 0 ? 1 : 0)));
        console.log(`    ${tag.padEnd(5)}: n=${profits.length}, avg profit/$1=${avg >= 0 ? "+" : ""}${avg.toFixed(3)}, win rate=${(winRate * 100).toFixed(1)}%`);
      }
    }
  }

  console.log("\n(No survivorship bias here — predictions were locked before resolution. Still gross of fees/slippage.)");
}

// Guards the weighted-average + scoring math (ponytail: one runnable check for non-trivial logic).
function selfCheck(): void {
  const rows: PositionRow[] = [
    { address: "a", condition_id: "c", market: null, outcome_index: 0, size: 100, avg_price: 0.6, cur_price: 0.55, end_date: null },
    { address: "b", condition_id: "c", market: null, outcome_index: 1, size: 100, avg_price: 0.3, cur_price: 0.45, end_date: null }
  ];
  assert.ok(Math.abs(weightedYes(rows, () => 1)! - 0.65) < 1e-9); // (0.6 + 0.7) / 2
  assert.ok(Math.abs(weightedYes(rows, cost)! - (60 * 0.6 + 30 * 0.7) / 90) < 1e-9);
  // payout(size) weight drops entry price: two equal-share YES entries at 0.8 and 0.2 -> dollar 0.68, payout 0.50.
  const favLong: PositionRow[] = [
    { address: "a", condition_id: "c", market: null, outcome_index: 0, size: 100, avg_price: 0.8, cur_price: null, end_date: null },
    { address: "b", condition_id: "c", market: null, outcome_index: 0, size: 100, avg_price: 0.2, cur_price: null, end_date: null }
  ];
  assert.ok(Math.abs(weightedYes(favLong, cost)! - 0.68) < 1e-9);
  assert.ok(Math.abs(weightedYes(favLong, (r) => r.size ?? 0)! - 0.5) < 1e-9);
  assert.ok(Math.abs(yesEqCur(rows[1]!) - 0.55) < 1e-9); // NO holder cur 0.45 -> YES-equiv 0.55
  assert.ok(Math.abs(dispersion(rows) - 0.05) < 1e-9); // yes-equiv entries {0.6, 0.7}, stdev = 0.05
}

async function main(): Promise<void> {
  selfCheck();
  if (process.argv.includes("--score")) await score();
  else await record();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
