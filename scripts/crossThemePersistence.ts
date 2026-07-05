// Cross-theme persistence test — the question the 90-day rolling cache couldn't answer.
//
//   pnpm --filter edgeboard-scripts exec tsx crossThemePersistence.ts
//
// The core alpha doubt (ALPHA_RESEARCH_LOG.md §5.5): the leaderboard's apparent skill might be ONE
// correct macro read (spring-2026 Iran) replicated across date-variant markets, not a repeatable
// forecasting process. Real skill leaves a trace on OTHER themes and PERSISTS over time; a one-lucky-
// -theme artifact does not. This reads the never-pruned closed_positions_archive (migration 031) and
// runs two persistence checks across wallets:
//
//   1. TIME-split    — each wallet's first-half vs second-half resolved history (by close_time).
//   2. THEME-split   — each wallet's Geopolitics edge vs its non-Geopolitics edge.
//
// For each split it computes every wallet's Bayesian-shrunk, FAMILY-COLLAPSED per-share edge on each
// side (same math as the Skill Score: correlated date/number variants of one series count once), then
// the Pearson correlation of side-A edge vs side-B edge across wallets. r≈0 => no persistence => the
// edge does NOT generalize (confirms the null result). r meaningfully positive => real, transferable
// skill. Needs the archive to have depth first — run archiveBackfill.ts once before this.
import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { strict as assert } from "node:assert";
import { CONFIG } from "./config.js";
import { isScorableMarket, marketFamilyKey } from "./metrics.js";
import { classifyMarket } from "./specialty.js";

loadEnv({ path: "../.env.local" });
loadEnv();

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

const supabase = createClient(requiredEnv("NEXT_PUBLIC_SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"));

const K = CONFIG.EDGE_SHRINKAGE_K; // shrinkage prior, same as the Skill Score
const MIN_FAMILIES_PER_SIDE = 4; // a side needs this many distinct market families to get a usable edge

interface Row {
  address: string;
  condition_id: string | null;
  market: string | null;
  avg_price: number | null;
  outcome: number | null;
  close_time: string | null;
}

async function fetchArchive(): Promise<Row[]> {
  const rows: Row[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("closed_positions_archive")
      .select("address, condition_id, market, avg_price, outcome, close_time")
      .not("outcome", "is", null)
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const batch = (data ?? []) as Row[];
    rows.push(...batch);
    if (batch.length < PAGE) break;
  }
  return rows;
}

// Per-position edge. RAW edge = outcome − entry price: profit/share over what they paid, which already
// has E=0 under an efficient market. But a wallet can still show positive raw edge WITHOUT skill by
// tilting to favorites (favorite-longshot bias: favorites tend to be underpriced) or simply by being a
// board winner (this whole sample beats its entry prices — that's why it's on the board). DE-BIASED edge
// nets that out: outcome − calibration(entry price), where calibration(p) is the realized win rate of
// ALL sampled positions entered at price p. It removes any price-level effect AND the common board-wide
// positive-edge baseline, leaving only each position's idiosyncratic beat over what its price predicted.
// The decisive question for §9: does the Iran→non-Iran persistence survive on the DE-BIASED edge?
type EdgeOf = (r: Row) => number;
const rawEdge: EdgeOf = (r) => r.outcome! - r.avg_price!;

// Realized win rate by entry-price bin, over all resolved positions. Empty bins fall back to the price
// itself (the efficient-market prior). 20 bins of width 0.05 — enough resolution without starving bins.
function buildCalibration(rows: Row[]): (price: number) => number {
  const BINS = 20;
  const sum = new Array<number>(BINS).fill(0);
  const cnt = new Array<number>(BINS).fill(0);
  const bin = (p: number): number => Math.min(BINS - 1, Math.max(0, Math.floor(p * BINS)));
  for (const r of rows) {
    if (r.outcome === null || r.avg_price === null) continue;
    const b = bin(r.avg_price);
    sum[b]! += r.outcome;
    cnt[b]! += 1;
  }
  return (price: number): number => (cnt[bin(price)]! > 0 ? sum[bin(price)]! / cnt[bin(price)]! : price);
}

// Family-collapsed, Bayesian-shrunk per-share edge over a set of resolved positions, or null if the
// set has fewer than MIN_FAMILIES_PER_SIDE distinct families (too thin to trust).
function shrunkEdge(rows: Row[], edgeOf: EdgeOf): number | null {
  const fam = new Map<string, { sum: number; n: number }>();
  for (const r of rows) {
    if (r.outcome === null || r.avg_price === null || !r.market) continue;
    if (!isScorableMarket(r.market)) continue;
    const key = marketFamilyKey(r.market);
    const e = fam.get(key) ?? { sum: 0, n: 0 };
    e.sum += edgeOf(r);
    e.n += 1;
    fam.set(key, e);
  }
  const familyEdges = [...fam.values()].map((e) => e.sum / e.n);
  if (familyEdges.length < MIN_FAMILIES_PER_SIDE) return null;
  const total = familyEdges.reduce((a, b) => a + b, 0);
  return total / (familyEdges.length + K);
}

// Pearson correlation of two equal-length series (returns null if <3 points or a side is constant).
function pearson(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 3) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    sxy += (xs[i]! - mx) * (ys[i]! - my);
    sxx += (xs[i]! - mx) ** 2;
    syy += (ys[i]! - my) ** 2;
  }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

// ── De-herding ────────────────────────────────────────────────────────────────────────────────────
// The confound that keeps r=0.352 at "suggestive": convergence means board wallets hold the SAME bets,
// so their edges are not independent observations — the crowd is double-counted, inflating n and the
// significance. This greedily keeps only wallets with DISTINCT books: process richest-book-first, and
// drop any wallet whose held-market set overlaps an already-kept wallet's by more than JACCARD_MAX. If
// r survives on the distinct-book subset, the signal isn't just the herd; if it collapses, it was.
// ponytail: greedy O(n²) dedup (n≈150, trivial); a full linkage clustering isn't worth it here.
const JACCARD_MAX = 0.5;

function conditionSet(rows: Row[]): Set<string> {
  const set = new Set<string>();
  for (const r of rows) if (r.condition_id) set.add(r.condition_id);
  return set;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function deherd(byWallet: Map<string, Row[]>): Map<string, Row[]> {
  const wallets = [...byWallet.entries()].sort((a, b) => b[1].length - a[1].length); // richest book first
  const kept: Set<string>[] = [];
  const out = new Map<string, Row[]>();
  for (const [address, rows] of wallets) {
    const set = conditionSet(rows);
    if (kept.some((k) => jaccard(set, k) > JACCARD_MAX)) continue; // near-duplicate of a kept book → skip
    kept.push(set);
    out.set(address, rows);
  }
  return out;
}

// Pairs of (side-A edge, side-B edge) across wallets, for wallets where BOTH sides are usable.
function correlate(byWallet: Map<string, Row[]>, split: (rows: Row[]) => [Row[], Row[]], edgeOf: EdgeOf): { xs: number[]; ys: number[] } {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const rows of byWallet.values()) {
    const [a, b] = split(rows);
    const ea = shrunkEdge(a, edgeOf);
    const eb = shrunkEdge(b, edgeOf);
    if (ea === null || eb === null) continue;
    xs.push(ea);
    ys.push(eb);
  }
  return { xs, ys };
}

// kind distinguishes the two split types. A TIME split cannot separate themes, so a single long-running
// theme (the Iran cluster) resolving across both halves inflates r — high time-persistence is NOT
// evidence of transferable skill and is labelled as theme-confounded. Only a THEME split (edge on one
// kind of market vs a DIFFERENT kind) can claim transfer.
function report(label: string, xs: number[], ys: number[], sideA: string, sideB: string, kind: "time" | "theme"): void {
  const r = pearson(xs, ys);
  const mean = (v: number[]): number => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0);
  const signAgree = xs.length ? xs.filter((x, i) => Math.sign(x) === Math.sign(ys[i]!)).length / xs.length : 0;
  console.log(`\n── ${label} (n=${xs.length} wallets with both sides usable) ──`);
  if (xs.length < 3) {
    console.log("  Too few wallets have enough resolved history on BOTH sides yet. Backfill deeper / wait.");
    return;
  }
  console.log(`  mean shrunk edge — ${sideA}: ${mean(xs) >= 0 ? "+" : ""}${mean(xs).toFixed(4)}   ${sideB}: ${mean(ys) >= 0 ? "+" : ""}${mean(ys).toFixed(4)}`);
  // Sign agreement is a base-rate artifact when both sides skew positive (a winner sample) — reported
  // for completeness, but it is NOT informative. r is the signal.
  console.log(`  edge-sign agreement across sides: ${(signAgree * 100).toFixed(0)}% (base-rate artifact on a winner sample — ignore; use r)`);
  console.log(`  Pearson r(${sideA} edge, ${sideB} edge) = ${r === null ? "n/a" : r.toFixed(3)}`);
  if (r === null) return;
  if (kind === "time") {
    console.log(`  → persistence over time, but THEME-CONFOUNDED: a time split does not separate themes, so one`);
    console.log(`    long-running theme (e.g. the Iran cluster) resolving across both halves inflates this.`);
    console.log(`    NOT evidence of transferable skill — read the theme splits below for that.`);
  } else {
    // Deliberately conservative bands. A cross-theme r is confounded by (a) survivorship — the sample
    // is board WINNERS, and (b) wallet non-independence — convergence means board wallets hold the SAME
    // bets, so effective n is well below the wallet count and face-value significance is overstated. And
    // "everything else" may hide a SECOND correlated theme-cluster, so a moderate r can mean "two macro
    // reads" not "general skill." So 0.25–0.45 is "suggestive, not conclusive" — the forward test is the
    // arbiter, not this. (Mirrors §4f: a backtest r that looked significant died under clustering.)
    const verdict =
      r >= 0.45 ? "TRANSFERS (strong) — but still verify on the forward test before trusting"
      : r >= 0.25 ? "SUGGESTIVE — positive but NOT conclusive; survivorship + wallet-herding confounds remain"
      : r <= 0.15 ? "does NOT transfer — edge is theme-specific, not general skill"
      : "weak/ambiguous";
    console.log(`  → ${verdict}`);
  }
}

function medianCloseSplit(rows: Row[]): [Row[], Row[]] {
  const dated = rows.filter((r) => r.close_time).sort((a, b) => Date.parse(a.close_time!) - Date.parse(b.close_time!));
  const mid = Math.floor(dated.length / 2);
  return [dated.slice(0, mid), dated.slice(mid)];
}

function geoSplit(rows: Row[]): [Row[], Row[]] {
  const geo: Row[] = [];
  const other: Row[] = [];
  for (const r of rows) {
    if (!r.market) continue;
    (classifyMarket(r.market) === "Geopolitics" ? geo : other).push(r);
  }
  return [geo, other];
}

// The sharpened theme test. "Geopolitics" lumps the spring-2026 Iran cluster (the one theme the entire
// in-sample edge traces to — §4e/§5.5) together with elections and other geo, muddying both sides. This
// isolates Iran specifically: does a wallet's edge on the Iran cluster transfer to LITERALLY anything
// else? \b before "iran" avoids matching e.g. "Tirana"; the hyphen in "US-Iran" is a word boundary.
const IRAN_THEME = /\b(?:iran|hormuz|tehran|khamenei|ayatollah|strait of hormuz)/i;
function iranSplit(rows: Row[]): [Row[], Row[]] {
  const iran: Row[] = [];
  const other: Row[] = [];
  for (const r of rows) {
    if (!r.market) continue;
    (IRAN_THEME.test(r.market) ? iran : other).push(r);
  }
  return [iran, other];
}

async function main(): Promise<void> {
  selfCheck();
  const rows = await fetchArchive();
  console.log(`Loaded ${rows.length} resolved archived positions.`);
  if (rows.length === 0) {
    console.log("Archive is empty. Apply migration 031 and run archiveBackfill.ts (or a full ingest) first.");
    return;
  }
  const byWallet = new Map<string, Row[]>();
  for (const r of rows) {
    const g = byWallet.get(r.address);
    if (g) g.push(r);
    else byWallet.set(r.address, [r]);
  }
  console.log(`${byWallet.size} distinct wallets in the archive.`);

  // ── Favorite-baseline decomposition: how much of the board's edge is skill vs "favorites win"? ──
  // Wallet strategy = bet their own side (correct iff outcome=1). Favorite baseline = bet whichever side
  // the market favored at entry (their side if avg_price>0.5, else the other side). Marginal = the part
  // that isn't free. This is the money question in miniature: a copier only profits on the marginal.
  const resolvedRows = rows.filter((r) => r.outcome !== null && r.avg_price !== null);
  const meanOf = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
  const walletAcc = meanOf(resolvedRows.map((r) => r.outcome!));
  const favAcc = meanOf(resolvedRows.map((r) => (r.avg_price! > 0.5 ? r.outcome! : 1 - r.outcome!)));
  console.log(`\n── Favorite-baseline decomposition (${resolvedRows.length} resolved positions) ──`);
  console.log(`  wallet side wins: ${(walletAcc * 100).toFixed(1)}%   always-favorite wins: ${(favAcc * 100).toFixed(1)}%   MARGINAL: ${(walletAcc - favAcc >= 0 ? "+" : "")}${((walletAcc - favAcc) * 100).toFixed(1)}pt`);
  console.log(`  (marginal ≈ 0 ⇒ the board's directional edge is mostly 'favorites win', not skill a copier can sell)`);

  const time = correlate(byWallet, medianCloseSplit, rawEdge);
  report("TIME-split: first-half vs second-half history", time.xs, time.ys, "1st-half", "2nd-half", "time");

  const iran = correlate(byWallet, iranSplit, rawEdge);
  report("THEME-split (SHARPENED): Iran cluster vs everything else — RAW edge", iran.xs, iran.ys, "iran", "non-iran", "theme");

  // Same test, but on distinct books only — strips the herding that inflates the significance above.
  const deherded = deherd(byWallet);
  console.log(`\nDe-herding: ${byWallet.size} wallets → ${deherded.size} with distinct books (Jaccard ≤ ${JACCARD_MAX}).`);
  const iranDeherd = correlate(deherded, iranSplit, rawEdge);
  report("THEME-split (Iran-isolated, DE-HERDED — distinct books only)", iranDeherd.xs, iranDeherd.ys, "iran", "non-iran", "theme");

  // The decisive refinement: de-bias every position by the pooled price-calibration, then re-run the
  // Iran split. If persistence survives DE-BIASED edge, it isn't favorite-longshot tilt or the common
  // board-wide baseline — it's idiosyncratic per-wallet skill. If it collapses, the raw 0.352 was price.
  const cal = buildCalibration(resolvedRows);
  const debiasedEdge: EdgeOf = (r) => r.outcome! - cal(r.avg_price!);
  const iranDebiased = correlate(byWallet, iranSplit, debiasedEdge);
  report("THEME-split (Iran-isolated, DE-BIASED — favorite/price effect removed)", iranDebiased.xs, iranDebiased.ys, "iran", "non-iran", "theme");

  const geo = correlate(byWallet, geoSplit, rawEdge);
  report("THEME-split: Geopolitics (all) vs everything else — RAW edge", geo.xs, geo.ys, "geo", "non-geo", "theme");

  console.log("\n(Decisive test = the DE-BIASED Iran split: it strips both favorite-longshot tilt and the");
  console.log(" board-wide baseline. If r holds there, that's the real cross-theme skill signal.)");
}

// Guards the shrinkage + Pearson math (ponytail: one runnable check for the non-trivial logic).
function selfCheck(): void {
  // Perfectly correlated series -> r = 1; anti-correlated -> r = -1.
  assert.ok(Math.abs(pearson([1, 2, 3, 4], [2, 4, 6, 8])! - 1) < 1e-9);
  assert.ok(Math.abs(pearson([1, 2, 3, 4], [8, 6, 4, 2])! + 1) < 1e-9);
  // shrunkEdge (raw): 4 distinct families each +0.5 edge -> 2.0 / (4 + 50) = 0.037.
  const mk = (fam: string): Row => ({ address: "a", condition_id: fam, market: `topic ${fam} thing`, avg_price: 0.5, outcome: 1, close_time: null });
  const edge = shrunkEdge([mk("alpha"), mk("bravo"), mk("charlie"), mk("delta")], rawEdge);
  assert.ok(edge !== null && Math.abs(edge - 2 / 54) < 1e-9);
  // Below the family floor -> null.
  assert.equal(shrunkEdge([mk("alpha"), mk("bravo")], rawEdge), null);
  // Calibration: two positions entered at 0.2, one wins one loses -> realized win rate 0.5 at that bin.
  const cal = buildCalibration([
    { address: "a", condition_id: "c1", market: "m", avg_price: 0.2, outcome: 1, close_time: null },
    { address: "a", condition_id: "c2", market: "m", avg_price: 0.2, outcome: 0, close_time: null }
  ]);
  assert.ok(Math.abs(cal(0.2) - 0.5) < 1e-9);
  assert.ok(Math.abs(cal(0.95) - 0.95) < 1e-9); // empty bin -> falls back to the price itself
  // Jaccard: identical sets -> 1, disjoint -> 0, one-shared-of-three -> 1/3.
  assert.ok(Math.abs(jaccard(new Set(["a", "b"]), new Set(["a", "b"])) - 1) < 1e-9);
  assert.equal(jaccard(new Set(["a"]), new Set(["b"])), 0);
  assert.ok(Math.abs(jaccard(new Set(["a", "b"]), new Set(["b", "c"])) - 1 / 3) < 1e-9);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
