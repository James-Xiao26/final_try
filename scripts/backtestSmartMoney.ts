// Does a weighted "smart money" implied price (the leaderboard's aggregate entry price on a market)
// predict resolved outcomes — and does it diverge from the live market price in a tradeable way?
// Read-only, no writes to Supabase, no schema changes — just a report to stdout.
//
// Run from the repo root:  pnpm --filter edgeboard-scripts exec tsx backtestSmartMoney.ts
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// CRITICAL CORRECTION (2026-07-02) — why this file was rewritten.
//
// The previous version (v1–v22, ~2100 lines) accumulated every matched market into a persisted
// history file and FROZE each market's weighted "smart money" price the first time it was seen,
// never recomputing it. New weighting experiments were then computed on *current* data and compared
// against that *frozen* baseline. Those two numbers came from different daily snapshots of the
// leaderboard + the rolling-90-day wallet_closed_positions window, so a "same market" comparison was
// silently a "different underlying data" comparison. Measured drift between a market's frozen v1 price
// and a same-day recompute: mean 0.047, up to 0.49, with the predicted side flipping on ~5% of
// markets. That handicap flattered the frozen incumbent (v1) and made challengers look worse than
// they are. On a CLEAN single-snapshot recompute (every variant on identical current data, n=312),
// the ranking inverts — v1 is near the BOTTOM:
//     dollar size (no skill)   Brier 0.1085   <- best
//     sqrt(cost) (no skill)    Brier 0.1128
//     biggest bettor only      Brier 0.1144
//     skill * cost             Brier 0.1169
//     v1 skill * sqrt(cost)    Brier 0.1210   <- production formula, 2nd worst
//     equal weight             Brier 0.1239
// dollar-weighting beats v1 on 60% of markets, paired t = 3.29 (~99.9% confidence) — not noise.
//
// Takeaway: skill-weighting is not earning its place; plain dollar (or sqrt-dollar) size predicts
// outcomes better. The full v1–v22 investigation log lived in this file's header before this rewrite;
// its per-variant Brier numbers are NOT trustworthy for the reason above and were removed rather than
// kept with a disclaimer (misleading precision is worse than a summary). Git history preserves them.
//
// This rewrite computes EVERY weighting on one consistent pull of current data and reports (a) a
// Brier ranking, (b) directional accuracy, (c) a paired significance test of the two front-runners,
// and (d) the profit/alpha simulation (buy the side the formula diverges from the market on, at the
// market's own price at that time) — all on the same clean snapshot, so no frozen-baseline bias.
//
// The history file is now a pure IMMUTABLE-PRICE CACHE: a market's resolved outcome and its price on
// a given historical day are fixed facts, safe to cache so reruns don't re-hit Gamma/CLOB. Weighted
// prices are never cached — they depend on the mutable leaderboard and are always recomputed fresh.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
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

const supabase = createClient(requiredEnv("NEXT_PUBLIC_SUPABASE_URL"), requiredEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"));

// Same values the live feature (web/lib/trendingMarkets.ts) uses, so the backtest evaluates the
// population the product actually shows.
const DUST_FLOOR_USD = 10;
const MIN_PARTICIPANTS = 5;
const RESOLVE_EPSILON = 0.03; // same as web/lib/resolvedMarkets.ts — |exitValue - {0,1}| within this = held to resolution
const PRICE_MATCH_TOLERANCE_DAYS = 10; // nearest available daily price point within this many days of the entry date
const GAP_THRESHOLDS = [0, 0.05, 0.1, 0.2]; // profit-simulation buckets, probability points

// Immutable-price cache (see the header). Keyed by conditionId; stores only fixed historical facts.
const CACHE_FILE = join(dirname(fileURLToPath(import.meta.url)), "backtestSmartMoneyHistory.json");

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

const cost = (r: ClosedRow): number => (r.size ?? 0) * (r.avg_price ?? 0);
const yesEquivalentEntry = (r: ClosedRow): number => (r.outcome_index === 1 ? 1 - (r.avg_price ?? 0) : r.avg_price ?? 0);

// exitValue ~1 -> held to a winning resolution, ~0 -> held to a loss, mid-range -> sold early.
function exitValue(r: ClosedRow): number | null {
  if (r.size === null || r.size <= 0 || r.realized_pnl === null || r.avg_price === null) return null;
  return r.avg_price + r.realized_pnl / r.size;
}

// Weighted average of yes-equivalent entry prices under an arbitrary per-row weight function.
function weightedYes(rows: ClosedRow[], weightOf: (r: ClosedRow) => number): number | null {
  let weight = 0;
  let weighted = 0;
  for (const r of rows) {
    const w = weightOf(r);
    weight += w;
    weighted += w * yesEquivalentEntry(r);
  }
  return weight > 0 ? weighted / weight : null;
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
    if (row.skill_score !== null && (prev === undefined || row.skill_score > prev)) skill.set(row.address, row.skill_score);
  }
  return skill;
}

interface PriceRow {
  asset: string;
  condition_id: string | null;
  ts: string;
  price: number;
}

// market_price_history has no index on condition_id, so a filtered query forces a full-table scan and
// hits the statement timeout. Sequential PK-ordered paging + client-side filtering is cheaper.
async function fetchPriceHistory(conditionIds: string[]): Promise<PriceRow[]> {
  const wanted = new Set(conditionIds);
  const rows: PriceRow[] = [];
  const PAGE = 1000;
  let pages = 0;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from("market_price_history").select("asset, condition_id, ts, price").range(from, from + PAGE - 1);
    if (error) throw error;
    const batch = (data ?? []) as PriceRow[];
    for (const row of batch) if (row.condition_id && wanted.has(row.condition_id)) rows.push(row);
    pages += 1;
    if (pages % 50 === 0) console.log(`  ...scanned ${pages * PAGE} price rows`);
    if (batch.length < PAGE) break;
  }
  return rows;
}

// market_price_history is keyed by outcome TOKEN, not YES/NO side. Disambiguate using the market's
// already-known actual outcome: whichever token settled near 1 is whatever actually happened.
function buildYesPriceSeries(priceRows: PriceRow[], actual: number): Map<string, number> | null {
  const byAsset = new Map<string, PriceRow[]>();
  for (const row of priceRows) {
    const group = byAsset.get(row.asset);
    if (group) group.push(row);
    else byAsset.set(row.asset, [row]);
  }
  const sums = new Map<string, [number, number]>();
  for (const assetRows of byAsset.values()) {
    const sorted = [...assetRows].sort((a, b) => a.ts.localeCompare(b.ts));
    const finalPrice = sorted[sorted.length - 1]?.price;
    if (finalPrice === undefined) continue;
    const tokenWon = finalPrice >= 0.97;
    const tokenLost = finalPrice <= 0.03;
    if (!tokenWon && !tokenLost) continue;
    const tokenIsYes = (tokenWon && actual === 1) || (tokenLost && actual === 0);
    for (const row of sorted) {
      const yesEquiv = tokenIsYes ? row.price : 1 - row.price;
      const prev = sums.get(row.ts);
      if (prev) {
        prev[0] += yesEquiv;
        prev[1] += 1;
      } else {
        sums.set(row.ts, [yesEquiv, 1]);
      }
    }
  }
  if (sums.size === 0) return null;
  const series = new Map<string, number>();
  for (const [day, [sum, count]] of sums) series.set(day, sum / count);
  return series;
}

function nearestPrice(series: Map<string, number>, targetMs: number, toleranceDays = PRICE_MATCH_TOLERANCE_DAYS): number | null {
  let best: { price: number; diffDays: number } | null = null;
  for (const [day, price] of series) {
    const diffDays = Math.abs(Date.parse(day) - targetMs) / 86_400_000;
    if (diffDays <= toleranceDays && (best === null || diffDays < best.diffDays)) best = { price, diffDays };
  }
  return best?.price ?? null;
}

// Immutable-price cache: conditionId -> the market's live YES price at the smart-money entry date,
// plus its resolved outcome. Both are fixed once resolved, so caching avoids re-fetching Gamma/CLOB.
// The old file stored many now-removed weighted-price fields; we read only the immutable ones and
// rewrite in the lean schema.
interface PricePoint {
  conditionId: string;
  livePriceAtEntry: number;
  actual: number;
  recordedAt: string;
}
function loadPriceCache(): Map<string, PricePoint> {
  if (!existsSync(CACHE_FILE)) return new Map();
  const raw = JSON.parse(readFileSync(CACHE_FILE, "utf8")) as Array<Partial<PricePoint>>;
  const cache = new Map<string, PricePoint>();
  for (const e of raw) {
    if (e.conditionId && typeof e.livePriceAtEntry === "number" && typeof e.actual === "number") {
      cache.set(e.conditionId, { conditionId: e.conditionId, livePriceAtEntry: e.livePriceAtEntry, actual: e.actual, recordedAt: e.recordedAt ?? new Date().toISOString() });
    }
  }
  return cache;
}
function savePriceCache(cache: Map<string, PricePoint>): void {
  const entries = [...cache.values()].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
  writeFileSync(CACHE_FILE, JSON.stringify(entries, null, 2) + "\n");
}

// Every weighting under test. `special` formulas (biggest bettor) don't fit the weighted-average shape.
type Formula = { name: string; weightOf?: (r: ClosedRow, skill: (r: ClosedRow) => number) => number; special?: (rows: ClosedRow[]) => number };
const FORMULAS: Formula[] = [
  { name: "dollar size (no skill)", weightOf: (r) => cost(r) },
  { name: "sqrt(cost) (no skill)", weightOf: (r) => Math.sqrt(cost(r)) },
  { name: "v1 skill*sqrt(cost)", weightOf: (r, s) => s(r) * Math.sqrt(cost(r)) },
  { name: "skill*cost", weightOf: (r, s) => s(r) * cost(r) },
  { name: "equal (1/wallet)", weightOf: () => 1 },
  {
    name: "biggest bettor only",
    special: (rows) => {
      let biggest = rows[0]!;
      for (const r of rows) if (cost(r) > cost(biggest)) biggest = r;
      return yesEquivalentEntry(biggest);
    }
  }
];
// Formulas to run the profit/alpha simulation on (the front-runners + the incumbent for reference).
const PROFIT_FORMULAS = ["dollar size (no skill)", "sqrt(cost) (no skill)", "v1 skill*sqrt(cost)"];

const brier = (pred: number, actual: number): number => (pred - actual) ** 2;
const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
const accuracy = (preds: number[], actuals: number[]): number => mean(preds.map((p, i) => (p > 0.5 === actuals[i]! > 0.5 ? 1 : 0)));

// Guards the core math against silent breakage (ponytail: one runnable check for non-trivial logic).
function selfCheck(): void {
  const rows: ClosedRow[] = [
    { address: "a", condition_id: "c", outcome_index: 0, avg_price: 0.6, realized_pnl: 0, size: 100, first_traded_at: null, close_time: null },
    { address: "b", condition_id: "c", outcome_index: 1, avg_price: 0.3, realized_pnl: 0, size: 100, first_traded_at: null, close_time: null }
  ];
  // yes-equiv: row a = 0.6, row b = 1 - 0.3 = 0.7; equal-weighted avg = 0.65.
  assert.ok(Math.abs(weightedYes(rows, () => 1)! - 0.65) < 1e-9);
  // dollar-weighted: costs 60 and 30 -> (60*0.6 + 30*0.7) / 90 = 0.6333...
  assert.ok(Math.abs(weightedYes(rows, cost)! - (60 * 0.6 + 30 * 0.7) / 90) < 1e-9);
  assert.ok(Math.abs(brier(0.7, 1) - 0.09) < 1e-9);
  assert.equal(accuracy([0.7, 0.3], [1, 0]), 1);
}

async function main(): Promise<void> {
  selfCheck();

  console.log("Fetching closed positions + leaderboard skill scores...");
  const [allClosed, skillByAddress] = await Promise.all([fetchAllClosedPositions(), fetchSkillByAddress()]);
  console.log(`${allClosed.length} closed-position rows, ${skillByAddress.size} leaderboard wallets\n`);
  const skillOf = (r: ClosedRow): number => Math.max(0, skillByAddress.get(r.address) ?? 0);

  const byCondition = new Map<string, ClosedRow[]>();
  for (const row of allClosed) {
    if (!row.condition_id) continue;
    const group = byCondition.get(row.condition_id);
    if (group) group.push(row);
    else byCondition.set(row.condition_id, [row]);
  }

  interface Sample {
    conditionId: string;
    actual: number;
    refEntryMs: number | null; // dollar-weighted entry date, the common "when did smart money enter" clock
    preds: Map<string, number>; // formula name -> predicted YES price
  }
  const samples: Sample[] = [];

  for (const [conditionId, rows] of byCondition) {
    const positioned = rows.filter((r) => cost(r) >= DUST_FLOOR_USD);
    if (new Set(positioned.map((r) => r.address)).size < MIN_PARTICIPANTS) continue;

    // Resolved outcome by majority vote among confirmed exits (same as web/lib/resolvedMarkets.ts).
    const votes = new Map<number, number>();
    for (const r of rows) {
      const ev = exitValue(r);
      if (ev === null || r.outcome_index === null) continue;
      const won = ev >= 1 - RESOLVE_EPSILON;
      const lost = ev <= RESOLVE_EPSILON;
      if (!won && !lost) continue;
      const winningOutcome = won ? r.outcome_index : 1 - r.outcome_index;
      votes.set(winningOutcome, (votes.get(winningOutcome) ?? 0) + 1);
    }
    if (votes.size === 0) continue;
    let winningOutcomeIndex = 0;
    let bestCount = -1;
    for (const [outcome, count] of votes) if (count > bestCount) [bestCount, winningOutcomeIndex] = [count, outcome];
    const actual = winningOutcomeIndex === 0 ? 1 : 0;

    // Every formula, computed on the identical `positioned` set — this is what makes the comparison
    // clean: the ONLY thing that differs between variants is the weight function.
    const preds = new Map<string, number>();
    for (const f of FORMULAS) {
      const value = f.special ? f.special(positioned) : weightedYes(positioned, (r) => f.weightOf!(r, skillOf));
      if (value !== null) preds.set(f.name, value);
    }
    if (!preds.has("v1 skill*sqrt(cost)")) continue; // needs a defined incumbent baseline to compare

    // Dollar-weighted entry date (a formula-neutral clock; all these wallets enter around the same
    // window, so the price-match date barely moves between formulas — ponytail: good enough, and it
    // biases every formula's gap identically so the ranking is unaffected).
    let dateWeight = 0;
    let dateWeighted = 0;
    for (const r of positioned) {
      const entryMs = r.first_traded_at ? Date.parse(r.first_traded_at) : NaN;
      if (Number.isFinite(entryMs)) {
        const w = cost(r);
        dateWeight += w;
        dateWeighted += w * entryMs;
      }
    }
    samples.push({ conditionId, actual, refEntryMs: dateWeight > 0 ? dateWeighted / dateWeight : null, preds });
  }

  console.log(`${samples.length} resolved markets clear the ${MIN_PARTICIPANTS}-participant / $${DUST_FLOOR_USD} floor\n`);
  if (samples.length === 0) {
    console.log("Nothing to score.");
    return;
  }

  // ── Brier ranking: every formula on the same n markets ────────────────────────────────────────
  const actuals = samples.map((s) => s.actual);
  console.log(`Mean Brier score (lower is better; 0.25 = coin flip, 0 = perfect) + directional accuracy, n=${samples.length}:`);
  const ranked = FORMULAS.map((f) => {
    const preds = samples.map((s) => s.preds.get(f.name)!);
    return { name: f.name, brier: mean(preds.map((p, i) => brier(p, actuals[i]!))), acc: accuracy(preds, actuals) };
  }).sort((a, b) => a.brier - b.brier);
  for (const r of ranked) console.log(`  ${r.name.padEnd(24)} Brier ${r.brier.toFixed(4)}   accuracy ${(r.acc * 100).toFixed(1)}%`);
  console.log(`  ${"naive 50/50".padEnd(24)} Brier ${mean(actuals.map((a) => brier(0.5, a))).toFixed(4)}`);

  // ── Paired significance: the two front-runners (dollar vs v1) on identical markets ──────────────
  const dollarP = samples.map((s) => s.preds.get("dollar size (no skill)")!);
  const v1P = samples.map((s) => s.preds.get("v1 skill*sqrt(cost)")!);
  const diffs = samples.map((_, i) => brier(v1P[i]!, actuals[i]!) - brier(dollarP[i]!, actuals[i]!)); // + => v1 worse
  const dMean = mean(diffs);
  const dSd = Math.sqrt(mean(diffs.map((d) => (d - dMean) ** 2)) * (diffs.length / (diffs.length - 1)));
  const dSe = dSd / Math.sqrt(diffs.length);
  const dollarWins = diffs.filter((d) => d > 0).length;
  console.log(`\nPaired v1 vs dollar-weighted, n=${samples.length}:`);
  console.log(`  mean Brier(v1) - Brier(dollar) = ${dMean >= 0 ? "+" : ""}${dMean.toFixed(5)}  (positive => v1 worse)`);
  console.log(`  t = ${(dMean / dSe).toFixed(2)}  (|t|>2 ~ significant at 95%);  dollar strictly better on ${dollarWins}/${samples.length} (${((100 * dollarWins) / samples.length).toFixed(0)}%)`);

  // ── Price matching for the profit/alpha sim: market_price_history cache, then the immutable price
  // cache, then a live Gamma+CLOB fetch for anything still missing. ───────────────────────────────
  console.log("\nMatching each market's live price at the smart-money entry date...");
  const withDate = samples.filter((s): s is Sample & { refEntryMs: number } => s.refEntryMs !== null);
  const conditionIds = withDate.map((s) => s.conditionId);
  const priceRows = await fetchPriceHistory(conditionIds);
  const priceRowsByCondition = new Map<string, PriceRow[]>();
  for (const row of priceRows) {
    if (!row.condition_id) continue;
    const group = priceRowsByCondition.get(row.condition_id);
    if (group) group.push(row);
    else priceRowsByCondition.set(row.condition_id, [row]);
  }
  console.log(`${priceRows.length} price rows across ${conditionIds.length} markets from the history table`);

  const cache = loadPriceCache();
  const cacheStart = cache.size;
  const client = new PolymarketClient();
  const now = new Date().toISOString();

  interface Matched {
    conditionId: string;
    actual: number;
    livePriceAtEntry: number;
    preds: Map<string, number>;
  }
  const matched: Matched[] = [];
  let fetched = 0;
  let toFetch = 0;
  for (const s of withDate) {
    let live: number | null = null;
    // 1. market_price_history (bulk-loaded above).
    const rows = priceRowsByCondition.get(s.conditionId);
    if (rows) {
      const series = buildYesPriceSeries(rows, s.actual);
      if (series) live = nearestPrice(series, s.refEntryMs);
    }
    // 2. immutable price cache from a prior run.
    if (live === null) {
      const cached = cache.get(s.conditionId);
      if (cached) live = cached.livePriceAtEntry;
    }
    // 3. live Gamma+CLOB fetch, then cache it.
    if (live === null) {
      toFetch += 1;
      if (toFetch % 25 === 0) console.log(`  ...live-fetched ${fetched}, checked ${toFetch}`);
      const yesTokenId = await client.getYesTokenId(s.conditionId);
      if (yesTokenId) {
        const raw = await client.getPriceHistory(yesTokenId);
        if (raw.length > 0) {
          const points = dailyPointsFromHistory(raw, 3650, Date.now());
          if (points.length > 0) {
            const series = new Map(points.map((p) => [p.ts, p.price]));
            live = nearestPrice(series, s.refEntryMs);
          }
        }
      }
      if (live !== null) fetched += 1;
    }
    if (live === null) continue;
    if (!cache.has(s.conditionId)) cache.set(s.conditionId, { conditionId: s.conditionId, livePriceAtEntry: live, actual: s.actual, recordedAt: now });
    matched.push({ conditionId: s.conditionId, actual: s.actual, livePriceAtEntry: live, preds: s.preds });
  }
  savePriceCache(cache);
  console.log(`${matched.length} markets matched (${fetched} newly live-fetched; cache ${cacheStart} -> ${cache.size})\n`);
  if (matched.length === 0) {
    console.log("No markets matched a price — nothing to simulate.");
    return;
  }

  // ── Profit/alpha simulation: for each profiled formula, buy the side it diverges from the market
  // on, AT the market's own price at that time. This is the real bankroll question — being
  // well-calibrated (low Brier) doesn't imply a tradeable gap vs the market. ───────────────────────
  console.log("Simulated return per $1 staked — buy the formula's tilt vs the market, at the market price:");
  for (const name of PROFIT_FORMULAS) {
    console.log(`\n  [${name}]`);
    for (const minGap of GAP_THRESHOLDS) {
      const trades = matched
        .map((m) => ({ m, gap: m.preds.get(name)! - m.livePriceAtEntry }))
        .filter((t) => Math.abs(t.gap) >= minGap);
      if (trades.length === 0) {
        console.log(`    >=${(minGap * 100).toFixed(0)}pt gap: n=0`);
        continue;
      }
      const profits = trades.map((t) => (t.gap >= 0 ? t.m.actual - t.m.livePriceAtEntry : t.m.livePriceAtEntry - t.m.actual));
      const avg = mean(profits);
      const winRate = mean(profits.map((p) => (p > 0 ? 1 : 0)));
      console.log(`    >=${(minGap * 100).toFixed(0)}pt gap: n=${trades.length}, avg profit/$1=${avg >= 0 ? "+" : ""}${avg.toFixed(3)}, win rate=${(winRate * 100).toFixed(1)}%`);
    }
  }
  console.log(
    "\nNote: these profit numbers are RELATIVE-COMPARISON-ONLY, not a forward alpha estimate. The sample\n" +
      "is wallet_closed_positions, scoped to wallets on the CURRENT leaderboard — i.e. wallets selected\n" +
      "*because* they won in the past. Backtesting their own past trades is survivorship-biased and\n" +
      "inflates absolute profit (same trap that sank the v8/v9 'held-to-resolution' experiments). The bias\n" +
      "hits every formula equally, so the RANKING (dollar > v1) is valid; the absolute +$/\\$1 is not. It's\n" +
      "also gross of fees/slippage and assumes a fill at the market's daily price. A real forward test\n" +
      "needs point-in-time leaderboard membership (who was ranked *at trade time*), which we don't retain."
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
