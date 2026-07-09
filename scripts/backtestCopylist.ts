// Walk-forward backtest of the copylist signal — the honest, non-circular in-sample cut.
//
//   pnpm --filter edgeboard-scripts exec tsx backtestCopylist.ts
//
// The problem with the §11a gut-check: "elite" is DEFINED by archive edge, then scored on the SAME
// archive — circular, guaranteed positive, tells you nothing. This splits the archive by time: select
// elite from the OLDER half (train), then score $1 copies of their NEWER trades (test). Copy P/L has a
// built-in null of 0 (a fair market gives 0 expected $/$1), so mean test $/$1 > 0 = the selection
// persists out of time. Still survivorship-scoped (archive = current board wallets), so the LEVEL is
// inflated — but the walk-forward removes the selected-on-what-I-score defect, which is the whole point.
//
// ponytail: split proxy is close_time (archive has no entry timestamp), so a test position ENTERED
// pre-cutoff but RESOLVED post-cutoff leaks a little look-ahead. Acceptable for a rough cut; the fix
// (store entry time) isn't worth it until the forward test says the signal is even real.
import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { strict as assert } from "node:assert";
import { rankWallets, type ArchiveRow, type WalletQuality } from "./eliteWallets.js";
import { isScorableMarket, marketFamilyKey } from "./metrics.js";

loadEnv({ path: "../.env.local" });
loadEnv();

const ELITE_OPTS = { minFamilies: 8, minHalfFamilies: 3, minEdge: 0.03 };
// Match the live copylist's price band (copyList.ts) so the walk-forward scores the SAME bets the
// product surfaces — without it, cheap-longshot winners pay 1/entry and dominate the mean $/$1.
const MIN_PRICE = 0.1, MAX_PRICE = 0.9;

// $1 copy P/L: win => 1/entry − 1, loss => −1. Same as copyCandidates.copyPnlPerDollar but the archive
// already stores `outcome` as THIS side's 0/1 settlement, so no YES-index gymnastics needed.
function copyPnl(entry: number, outcome: number): number {
  return outcome === 1 ? 1 / entry - 1 : -1;
}

interface Row extends ArchiveRow {
  outcome_index: number | null;
  condition_id: string | null;
}

function scorable(r: Row): boolean {
  return (
    r.outcome !== null && r.avg_price !== null && r.avg_price >= MIN_PRICE && r.avg_price <= MAX_PRICE &&
    !!r.market && isScorableMarket(r.market) && !!r.close_time
  );
}

// Mean + t-stat of a sample vs null 0. Clustered variant averages within each key first (one obs per
// family) so correlated date/number variants of one bet don't inflate n — the §11a/whale-exit lesson.
function stats(xs: number[]): { n: number; mean: number; t: number; winRate: number } {
  if (xs.length === 0) return { n: 0, mean: 0, t: 0, winRate: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, xs.length - 1));
  const wins = xs.filter((x) => x > 0).length;
  return { n: xs.length, mean, t: sd > 0 ? mean / (sd / Math.sqrt(xs.length)) : 0, winRate: wins / xs.length };
}
function clusterMean(rows: { key: string; v: number }[]): number[] {
  const m = new Map<string, { s: number; n: number }>();
  for (const r of rows) { const e = m.get(r.key) ?? { s: 0, n: 0 }; e.s += r.v; e.n += 1; m.set(r.key, e); }
  return [...m.values()].map((e) => e.s / e.n);
}

async function main(): Promise<void> {
  selfCheck();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  const supabase = createClient(url, key);

  const rows: Row[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("closed_positions_archive")
      .select("address, condition_id, outcome_index, market, avg_price, outcome, close_time")
      .not("outcome", "is", null)
      .range(from, from + 999);
    if (error) throw error;
    const batch = (data ?? []) as Row[];
    rows.push(...batch);
    if (batch.length < 1000) break;
  }
  const clean = rows.filter(scorable);
  console.log(`Archive: ${rows.length} resolved rows, ${clean.length} scorable.`);

  // Global time cutoff = median close_time. Train = resolved before it, test = after.
  const times = clean.map((r) => Date.parse(r.close_time!)).sort((a, b) => a - b);
  const cutoff = times[Math.floor(times.length / 2)]!;
  const train = clean.filter((r) => Date.parse(r.close_time!) < cutoff);
  const test = clean.filter((r) => Date.parse(r.close_time!) >= cutoff);
  console.log(`Cutoff ${new Date(cutoff).toISOString().slice(0, 10)}: train ${train.length} rows, test ${test.length} rows.\n`);

  // Select elite from TRAIN ONLY (this is the non-circular step).
  const elite = new Map<string, WalletQuality>();
  for (const w of rankWallets(train as ArchiveRow[], ELITE_OPTS)) elite.set(w.address, w);
  const trainAddrs = new Set(train.map((r) => r.address));
  console.log(`Elite selected on train: ${elite.size} of ${trainAddrs.size} wallets active in train.\n`);

  // Score $1 copies on TEST. Elite wallets' test positions vs all board wallets' test positions.
  const eliteTest = test.filter((r) => elite.has(r.address));
  const label = (r: Row) => `${r.address}:${marketFamilyKey(r.market!)}`; // per-wallet-per-family cluster
  const eliteRaw = eliteTest.map((r) => copyPnl(r.avg_price!, r.outcome!));
  const eliteClustered = clusterMean(eliteTest.map((r) => ({ key: label(r), v: copyPnl(r.avg_price!, r.outcome!) })));
  const boardRaw = test.map((r) => copyPnl(r.avg_price!, r.outcome!));
  const boardClustered = clusterMean(test.map((r) => ({ key: label(r), v: copyPnl(r.avg_price!, r.outcome!) })));

  const fmt = (s: ReturnType<typeof stats>) => `n=${String(s.n).padStart(5)}  mean $/$1 ${s.mean >= 0 ? "+" : ""}${s.mean.toFixed(3)}  win ${(s.winRate * 100).toFixed(1)}%  t=${s.t.toFixed(2)}`;
  console.log("── WALK-FORWARD COPY P/L ON TEST (null = 0; >0 = out-of-time edge) ──");
  console.log(`  elite   (raw positions)   ${fmt(stats(eliteRaw))}`);
  console.log(`  elite   (family-clustered)${fmt(stats(eliteClustered))}   <- the honest significance`);
  console.log(`  board   (raw positions)   ${fmt(stats(boardRaw))}`);
  console.log(`  board   (family-clustered)${fmt(stats(boardClustered))}\n`);

  // Agreement gradient on TEST: for each (condition_id, outcome_index) how many DISTINCT elite wallets
  // held it? Copylist's core claim is multi-wallet agreement copies better. Bucket 1 / 2 / 3+.
  // ponytail: "agreement" here = held-same-market anytime in the test half, NOT co-timed within
  // COPY_FRESH_DAYS like the live signal (archive has no entry timestamp, only close_time). So this
  // OVERSTATES agreement vs the product — read the gradient's shape, not its absolute buckets.
  const byBet = new Map<string, Row[]>();
  for (const r of eliteTest) {
    if (!r.condition_id) continue;
    const k = `${r.condition_id}:${r.outcome_index}`;
    (byBet.get(k) ?? byBet.set(k, []).get(k)!).push(r);
  }
  const buckets: Record<string, number[]> = { "1": [], "2": [], "3+": [] };
  for (const bet of byBet.values()) {
    const wallets = new Set(bet.map((r) => r.address)).size;
    const b = wallets === 1 ? "1" : wallets === 2 ? "2" : "3+";
    // one entry per bet (average its wallets' copies) so a 5-wallet bet is one observation, not five
    buckets[b]!.push(bet.reduce((a, r) => a + copyPnl(r.avg_price!, r.outcome!), 0) / bet.length);
  }
  console.log("── AGREEMENT GRADIENT ON TEST (distinct elite wallets on same bet; one obs per bet) ──");
  for (const b of ["1", "2", "3+"]) console.log(`  ${b.padEnd(3)} wallet(s)  ${fmt(stats(buckets[b]!))}`);

  // Per-wallet persistence: does train edge predict test copy P/L? (the §9 signal, time-split not theme-split)
  const perWallet: { train: number; test: number }[] = [];
  for (const [addr, q] of elite) {
    const tr = eliteTest.filter((r) => r.address === addr).map((r) => copyPnl(r.avg_price!, r.outcome!));
    if (tr.length >= 5) perWallet.push({ train: q.edge, test: tr.reduce((a, b) => a + b, 0) / tr.length });
  }
  console.log(`\n── PER-WALLET PERSISTENCE (train edge vs test copy $/$1, n=${perWallet.length} elite w/ >=5 test bets) ──`);
  console.log(`  correlation r = ${pearson(perWallet.map((p) => p.train), perWallet.map((p) => p.test)).toFixed(3)}`);
  console.log("\n(Survivorship-scoped: archive = current board wallets, so LEVEL is inflated. Walk-forward");
  console.log(" removes the circular 'selected on what I score' defect. Gross of fees/slippage.)");
}

function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i]! - mx, dy = ys[i]! - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
}

function selfCheck(): void {
  assert.ok(Math.abs(copyPnl(0.5, 1) - 1) < 1e-9); // win at 0.5 => +1
  assert.equal(copyPnl(0.5, 0), -1); // loss => -1
  assert.ok(Math.abs(copyPnl(0.25, 1) - 3) < 1e-9); // win at 0.25 => +3
  const s = stats([1, -1, 1, -1]);
  assert.equal(s.n, 4);
  assert.ok(Math.abs(s.mean) < 1e-9);
  assert.equal(s.winRate, 0.5);
  assert.ok(Math.abs(pearson([1, 2, 3], [1, 2, 3]) - 1) < 1e-9);
  assert.deepEqual(clusterMean([{ key: "a", v: 1 }, { key: "a", v: 3 }, { key: "b", v: 10 }]).sort((x, y) => x - y), [2, 10]);
}

main().catch((e) => { console.error(e); process.exit(1); });
