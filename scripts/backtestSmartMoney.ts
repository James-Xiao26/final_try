// Does the skill-weighted "smart money" implied price (web/lib/trendingMarkets.ts's
// smartMoneyImpliedPrice, same skill*sqrt(cost) weighting, ported here since scripts/ and web/ don't
// share code) actually predict resolved-market outcomes better than a naive baseline? Read-only,
// no writes, no schema changes — just a report to stdout.
//
// Run from the repo root:  pnpm --filter edgeboard-scripts exec tsx backtestSmartMoney.ts
//
// v1 (aggregate Brier score + conviction buckets) found high-conviction predictions 98% accurate —
// but that's confounded: a position entered the day before resolution on an already-obvious outcome
// isn't insight, it's just riding a market that already converged. v2 adds a lead-time breakdown
// (skill*sqrt(cost)-weighted entry date vs. resolution date) to separate "saw it early" from "piled
// on late" — ponytail: this reuses first_traded_at (already in the table) rather than reconstructing
// a point-in-time live price from market_price_history, which would need YES/NO token disambiguation
// closed positions don't retain (a real v3, not a simplest-version one).
import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";

loadEnv({ path: "../.env.local" });
loadEnv();

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

const supabase = createClient(requiredEnv("NEXT_PUBLIC_SUPABASE_URL"), requiredEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"));

// Same thresholds the live feature uses (web/lib/trendingMarkets.ts) — the backtest should evaluate
// exactly the population the feature would actually have shown.
const DUST_FLOOR_USD = 10;
const MIN_PARTICIPANTS = 5;
const RESOLVE_EPSILON = 0.03; // same as web/lib/resolvedMarkets.ts

interface ClosedRow {
  address: string;
  condition_id: string | null;
  outcome_index: number | null;
  avg_price: number | null;
  realized_pnl: number | null;
  size: number | null;
  first_traded_at: string | null;
  close_time: string | null;
}

async function fetchAllClosedPositions(): Promise<ClosedRow[]> {
  const rows: ClosedRow[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("wallet_closed_positions")
      .select("address, condition_id, outcome_index, avg_price, realized_pnl, size, first_traded_at, close_time")
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const batch = (data ?? []) as ClosedRow[];
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
    if (row.skill_score !== null && (prev === undefined || row.skill_score > prev)) {
      skill.set(row.address, row.skill_score);
    }
  }
  return skill;
}

// exitValue ~1 -> held to a winning resolution, ~0 -> held to a loss. Mid-range -> sold early
// (not a resolution confirmation), same logic as web/lib/resolvedMarkets.ts.
function exitValue(row: ClosedRow): number | null {
  if (row.size === null || row.size <= 0 || row.realized_pnl === null || row.avg_price === null) return null;
  return row.avg_price + row.realized_pnl / row.size;
}

function cost(row: ClosedRow): number {
  return (row.size ?? 0) * (row.avg_price ?? 0);
}

function yesEquivalentEntry(row: ClosedRow): number {
  return row.outcome_index === 1 ? 1 - (row.avg_price ?? 0) : row.avg_price ?? 0;
}

async function main(): Promise<void> {
  console.log("Fetching closed positions + leaderboard skill scores...");
  const [allClosed, skillByAddress] = await Promise.all([fetchAllClosedPositions(), fetchSkillByAddress()]);
  console.log(`${allClosed.length} closed-position rows, ${skillByAddress.size} leaderboard wallets\n`);

  const byCondition = new Map<string, ClosedRow[]>();
  for (const row of allClosed) {
    if (!row.condition_id) continue;
    const group = byCondition.get(row.condition_id);
    if (group) group.push(row);
    else byCondition.set(row.condition_id, [row]);
  }

  interface Sample {
    smartPct: number;
    dollarPct: number;
    actual: number; // 1 = YES won, 0 = NO won
    daysEarly: number | null; // resolution date minus smart money's weighted entry date
  }
  const samples: Sample[] = [];

  for (const rows of byCondition.values()) {
    // Determine the market's actual resolved outcome by majority vote among confirmed exits
    // (same approach as web/lib/resolvedMarkets.ts summarizeResolvedMarkets). Also take the latest
    // close_time among confirmed rows as the resolution date — an early-sold row's close_time is
    // just its sale date, not the market's actual resolution, so rows[0] isn't safe to use for that.
    const votes = new Map<number, number>();
    let resolutionMs = -Infinity;
    for (const row of rows) {
      const ev = exitValue(row);
      if (ev === null || row.outcome_index === null) continue;
      const won = ev >= 1 - RESOLVE_EPSILON;
      const lost = ev <= RESOLVE_EPSILON;
      if (!won && !lost) continue; // sold early, not a resolution signal
      const winningOutcome = won ? row.outcome_index : 1 - row.outcome_index;
      votes.set(winningOutcome, (votes.get(winningOutcome) ?? 0) + 1);
      const closeMs = row.close_time ? Date.parse(row.close_time) : NaN;
      if (Number.isFinite(closeMs) && closeMs > resolutionMs) resolutionMs = closeMs;
    }
    if (votes.size === 0) continue;
    let winningOutcomeIndex = 0;
    let bestCount = -1;
    for (const [outcome, count] of votes) {
      if (count > bestCount) {
        bestCount = count;
        winningOutcomeIndex = outcome;
      }
    }
    const actual = winningOutcomeIndex === 0 ? 1 : 0;

    // Same population the live panel would show: 5+ distinct wallets, each with a non-dust position.
    const positioned = rows.filter((r) => cost(r) >= DUST_FLOOR_USD);
    const distinctWallets = new Set(positioned.map((r) => r.address));
    if (distinctWallets.size < MIN_PARTICIPANTS) continue;

    let smartWeight = 0;
    let smartWeighted = 0;
    let dollarWeight = 0;
    let dollarWeighted = 0;
    let dateWeight = 0;
    let dateWeighted = 0; // sum(weight * entry epoch ms) -> weighted-average entry date
    for (const row of positioned) {
      const c = cost(row);
      const yesEq = yesEquivalentEntry(row);
      const skill = Math.max(0, skillByAddress.get(row.address) ?? 0);
      const w = skill * Math.sqrt(c);
      smartWeight += w;
      smartWeighted += w * yesEq;
      dollarWeight += c;
      dollarWeighted += c * yesEq;
      const entryMs = row.first_traded_at ? Date.parse(row.first_traded_at) : NaN;
      if (Number.isFinite(entryMs)) {
        dateWeight += w;
        dateWeighted += w * entryMs;
      }
    }
    if (smartWeight <= 0 || dollarWeight <= 0) continue;

    // Lead time = how many days before resolution smart money's (weighted) entry was — the proxy
    // for "did they see it early" vs. "did they pile onto an already-obvious outcome late."
    let daysEarly: number | null = null;
    if (dateWeight > 0 && Number.isFinite(resolutionMs)) {
      const entryMs = dateWeighted / dateWeight;
      daysEarly = (resolutionMs - entryMs) / 86_400_000;
    }

    samples.push({ smartPct: smartWeighted / smartWeight, dollarPct: dollarWeighted / dollarWeight, actual, daysEarly });
  }

  console.log(`${samples.length} resolved markets clear the 5-participant / $10 floor\n`);
  if (samples.length === 0) {
    console.log("Nothing to score.");
    return;
  }

  const brier = (pred: number, actual: number): number => (pred - actual) ** 2;
  const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
  const accuracy = (preds: number[], actuals: number[]): number =>
    mean(preds.map((p, i) => (p > 0.5 === actuals[i]! > 0.5 ? 1 : 0)));

  const smartBrier = mean(samples.map((s) => brier(s.smartPct, s.actual)));
  const dollarBrier = mean(samples.map((s) => brier(s.dollarPct, s.actual)));
  const naiveBrier = mean(samples.map((s) => brier(0.5, s.actual)));

  console.log("Mean Brier score (lower is better; 0.25 = coin flip, 0 = perfect):");
  console.log(`  smart money (skill*sqrt(cost) weighted): ${smartBrier.toFixed(4)}`);
  console.log(`  dollar-weighted only (no skill):          ${dollarBrier.toFixed(4)}`);
  console.log(`  naive 50/50 baseline:                     ${naiveBrier.toFixed(4)}`);
  console.log();
  console.log("Directional accuracy (predicted majority side matched the actual winner):");
  console.log(`  smart money:  ${(accuracy(samples.map((s) => s.smartPct), samples.map((s) => s.actual)) * 100).toFixed(1)}%`);
  console.log(`  dollar-only:  ${(accuracy(samples.map((s) => s.dollarPct), samples.map((s) => s.actual)) * 100).toFixed(1)}%`);

  // Bucket by conviction (distance from 50/50) as a proxy for "how big a signal is this" — the
  // question that actually matters: does a stronger signal predict better, or is it noise?
  console.log("\nBy conviction (|smart money % - 50%|):");
  const buckets: [string, (s: Sample) => boolean][] = [
    ["  low  (<10pt)", (s) => Math.abs(s.smartPct - 0.5) < 0.1],
    ["  med  (10-25pt)", (s) => Math.abs(s.smartPct - 0.5) >= 0.1 && Math.abs(s.smartPct - 0.5) < 0.25],
    ["  high (>=25pt)", (s) => Math.abs(s.smartPct - 0.5) >= 0.25]
  ];
  for (const [label, filter] of buckets) {
    const bucket = samples.filter(filter);
    if (bucket.length === 0) {
      console.log(`${label}: n=0`);
      continue;
    }
    const b = mean(bucket.map((s) => brier(s.smartPct, s.actual)));
    const a = accuracy(bucket.map((s) => s.smartPct), bucket.map((s) => s.actual));
    console.log(`${label}: n=${bucket.length}, brier=${b.toFixed(4)}, accuracy=${(a * 100).toFixed(1)}%`);
  }

  // The actual confound check: restrict to the high-conviction bucket and require increasing lead
  // time before resolution. If accuracy erodes toward 50% as the required lead time grows, v1's 98%
  // was mostly late entries riding an already-obvious outcome. If it holds up, that's real evidence
  // smart money saw something early rather than just piling on late.
  console.log("\nHigh-conviction (>=25pt) accuracy by minimum lead time before resolution:");
  const highConviction = samples.filter((s) => Math.abs(s.smartPct - 0.5) >= 0.25 && s.daysEarly !== null);
  for (const minDays of [0, 3, 7, 14, 30]) {
    const bucket = highConviction.filter((s) => s.daysEarly! >= minDays);
    if (bucket.length === 0) {
      console.log(`  >=${minDays}d early: n=0`);
      continue;
    }
    const b = mean(bucket.map((s) => brier(s.smartPct, s.actual)));
    const a = accuracy(bucket.map((s) => s.smartPct), bucket.map((s) => s.actual));
    console.log(`  >=${minDays}d early: n=${bucket.length}, brier=${b.toFixed(4)}, accuracy=${(a * 100).toFixed(1)}%`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
