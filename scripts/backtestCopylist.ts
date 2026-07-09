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
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { strict as assert } from "node:assert";
import { rankWallets, type ArchiveRow, type WalletQuality } from "./eliteWallets.js";
import { isScorableMarket, marketFamilyKey } from "./metrics.js";
import { classifyMarket } from "./specialty.js";
import { PolymarketClient } from "./polymarket.js";
import { dailyPointsFromHistory } from "./priceHistory.js";

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

  // ── BEST-TRADES POLICY SEARCH ────────────────────────────────────────────────────────────────────
  // The copylist shows a ranked list and the user copies the TOP few — so what matters isn't the mean
  // of everything, it's whether some ranking's top slice is +EV out-of-time under retail costs. Model
  // 1-share copying with a 2c haircut (you fill at ask, they filled mid-ish). Policies compete on the
  // same test bets, clustered by market family. Score ties break arbitrarily but deterministically.
  const HAIRCUT = 0.02;
  interface Bet { key: string; entry: number; outcome: number; agree: number; maxEdge: number; meanEdge: number }
  const bets: Bet[] = [];
  for (const rows of byBet.values()) {
    const first = rows[0]!;
    if (!first.market) continue;
    const copiers = [...new Set(rows.map((r) => r.address))];
    const edges = copiers.map((a) => elite.get(a)?.edge ?? 0);
    bets.push({
      key: marketFamilyKey(first.market),
      entry: rows.reduce((a, r) => a + r.avg_price!, 0) / rows.length,
      outcome: first.outcome!,
      agree: copiers.length,
      maxEdge: Math.max(...edges),
      meanEdge: edges.reduce((a, b) => a + b, 0) / edges.length
    });
  }
  const pnlH = (b: Bet): number => copyPnl(Math.min(0.99, b.entry + HAIRCUT), b.outcome);
  const policies: [string, (b: Bet) => number][] = [
    ["max copier train edge", (b) => b.maxEdge],
    ["mean copier train edge", (b) => b.meanEdge],
    ["agreement (live rank)", (b) => b.agree],
    ["agreement, then edge", (b) => b.agree * 10 + b.meanEdge]
  ];
  console.log(`\n── BEST-TRADES POLICY (test bets ranked, top slice copied @entry+${HAIRCUT * 100}c; family-clustered) ──`);
  console.log(`  ${bets.length} test bets; ALL bets baseline: ${fmt(stats(clusterMean(bets.map((b) => ({ key: b.key, v: pnlH(b) })))))}`);
  for (const [name, score] of policies) {
    const ranked = [...bets].sort((a, b) => score(b) - score(a));
    for (const frac of [0.1, 0.25]) {
      const top = ranked.slice(0, Math.max(1, Math.floor(ranked.length * frac)));
      const cl = clusterMean(top.map((b) => ({ key: b.key, v: pnlH(b) })));
      console.log(`  ${name.padEnd(24)} top ${String(frac * 100).padStart(2)}%  ${fmt(stats(cl))}`);
    }
  }

  // Where does the edge live? Category and entry-price sub-band splits of elite test copies (haircut).
  console.log(`\n── ELITE TEST COPIES BY CATEGORY (family-clustered, @entry+${HAIRCUT * 100}c) ──`);
  const byCat = new Map<string, { key: string; v: number }[]>();
  for (const r of eliteTest) {
    const cat = classifyMarket(r.market!) ?? "Other";
    (byCat.get(cat) ?? byCat.set(cat, []).get(cat)!).push({ key: label(r), v: copyPnl(Math.min(0.99, r.avg_price! + HAIRCUT), r.outcome!) });
  }
  for (const [cat, rows] of [...byCat.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${cat.padEnd(12)} ${fmt(stats(clusterMean(rows)))}`);
  }
  console.log(`\n── ELITE TEST COPIES BY ENTRY BAND (family-clustered, @entry+${HAIRCUT * 100}c) ──`);
  for (const [lo, hi] of [[0.1, 0.3], [0.3, 0.5], [0.5, 0.7], [0.7, 0.9]] as const) {
    const rows = eliteTest.filter((r) => r.avg_price! >= lo && r.avg_price! < hi).map((r) => ({ key: label(r), v: copyPnl(Math.min(0.99, r.avg_price! + HAIRCUT), r.outcome!) }));
    console.log(`  ${lo.toFixed(1)}-${hi.toFixed(1)}       ${fmt(stats(clusterMean(rows)))}`);
  }
  // ── COPY AT MARKET PRICE (the "can YOU actually get it" test) ───────────────────────────────────
  // Everything above prices the copy at the ELITE WALLET'S fill — which may be an in-game/latency fill
  // a copier can never match (the suspected source of the too-good numbers: 95% win at ~50c). Here we
  // reprice every elite test position at the MARKET's daily close D days before resolution — a price a
  // copier could genuinely trade at — and ask if the position still profits. Survives → accessible
  // edge. Dies → the "edge" is their fill, not their forecast, and copying cannot work.
  const topWallets = new Set([...elite.values()].sort((a, b) => b.edge - a.edge).slice(0, 15).map((w) => w.address));
  const wanted = eliteTest.filter((r) => r.condition_id);
  const conds = [...new Set(wanted.map((r) => r.condition_id!))];
  const priceMap = await loadMarketPrices(conds);
  console.log(`\n── COPY AT MARKET PRICE, D days pre-resolution (+${HAIRCUT * 100}c; null = 0) ──`);
  console.log(`  price series found for ${priceMap.size}/${conds.length} elite test markets`);
  for (const D of [3, 7]) {
    const all: { key: string; v: number }[] = [];
    const top: { key: string; v: number }[] = [];
    for (const r of wanted) {
      const series = priceMap.get(r.condition_id!);
      if (!series) continue;
      const yes = priceAtDay(series, Date.parse(r.close_time!) - D * 86_400_000);
      if (yes === null) continue;
      const side = r.outcome_index === 0 ? yes : 1 - yes; // price of THEIR side at T−D
      if (side < MIN_PRICE || side > MAX_PRICE) continue;
      const v = copyPnl(Math.min(0.99, side + HAIRCUT), r.outcome!);
      all.push({ key: marketFamilyKey(r.market!), v });
      if (topWallets.has(r.address)) top.push({ key: marketFamilyKey(r.market!), v });
    }
    console.log(`  D=${D}  all elite        ${fmt(stats(clusterMean(all)))}`);
    console.log(`  D=${D}  top-15 by edge   ${fmt(stats(clusterMean(top)))}`);
  }
  // Lookahead check: at T−D we "copy" a position the wallet may not have OPENED yet (no entry
  // timestamps in the archive). For short-lived markets (sports games) that's clairvoyance — knowing
  // Thursday which side the sharp buys on Sunday. Long-lived markets are mostly legitimate: a position
  // held for weeks is observable in wallet_positions at T−D. So split D=7 by category and by market
  // lifetime; if the edge lives only in short-lived/sports markets, it's lookahead, not copyable.
  console.log(`\n── D=7 COPY-AT-MARKET SPLIT (where is it legitimate?) ──`);
  const d7: { cat: string; life: number; key: string; v: number }[] = [];
  for (const r of wanted) {
    const series = priceMap.get(r.condition_id!);
    if (!series || series.length < 2) continue;
    const yes = priceAtDay(series, Date.parse(r.close_time!) - 7 * 86_400_000);
    if (yes === null) continue;
    const side = r.outcome_index === 0 ? yes : 1 - yes;
    if (side < MIN_PRICE || side > MAX_PRICE) continue;
    const life = (Date.parse(series[series.length - 1]!.ts) - Date.parse(series[0]!.ts)) / 86_400_000;
    d7.push({ cat: classifyMarket(r.market!) ?? "Other", life, key: marketFamilyKey(r.market!), v: copyPnl(Math.min(0.99, side + HAIRCUT), r.outcome!) });
  }
  for (const cat of [...new Set(d7.map((x) => x.cat))].sort()) {
    const rows = d7.filter((x) => x.cat === cat);
    console.log(`  ${cat.padEnd(12)}            ${fmt(stats(clusterMean(rows)))}`);
  }
  for (const [label, pred] of [["life <= 30d (suspect)", (x: number) => x <= 30], ["life > 30d (cleaner)", (x: number) => x > 30], ["life > 60d (cleanest)", (x: number) => x > 60]] as const) {
    const rows = d7.filter((x) => pred(x.life));
    console.log(`  ${label.padEnd(22)}  ${fmt(stats(clusterMean(rows)))}`);
  }
  console.log("\n(Survivorship-scoped: archive = current board wallets, so LEVEL is inflated. Walk-forward");
  console.log(" removes the circular 'selected on what I score' defect. Gross of fees/slippage beyond the haircut.)");
}

// Market daily YES closes for a set of condition ids, cached to disk (Gamma id-batch → CLOB history).
async function loadMarketPrices(conds: string[]): Promise<Map<string, { ts: string; price: number }[]>> {
  interface CacheShape { [cond: string]: { ts: string; price: number }[] }
  const file = join(dirname(fileURLToPath(import.meta.url)), "backtestCopylistPrices.cache.json");
  const cache: CacheShape = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as CacheShape) : {};
  const missing = conds.filter((c) => !(c in cache));
  if (missing.length > 0) {
    console.log(`\nFetching market price series for ${missing.length} markets (cached: ${conds.length - missing.length})…`);
    const client = new PolymarketClient();
    // Gamma: resolve conditionId -> YES token id, 20 ids per request.
    const tokenOf = new Map<string, string>();
    for (let i = 0; i < missing.length; i += 20) {
      const batch = missing.slice(i, i + 20);
      // closed=true is required — Gamma hides resolved markets by default (same gotcha as fetchLiveMarket).
      const url = `https://gamma-api.polymarket.com/markets?limit=100&closed=true&${batch.map((c) => `condition_ids=${c}`).join("&")}`;
      try {
        const res = await fetch(url);
        if (res.ok) {
          for (const m of (await res.json()) as Record<string, unknown>[]) {
            try {
              const toks = JSON.parse(String(m.clobTokenIds ?? "[]")) as string[];
              if (toks[0]) tokenOf.set(String(m.conditionId), toks[0]);
            } catch { /* skip */ }
          }
        }
      } catch { /* skip batch */ }
      await new Promise((r) => setTimeout(r, 60));
    }
    let done = 0;
    for (const c of missing) {
      const tok = tokenOf.get(c);
      cache[c] = tok ? dailyPointsFromHistory(await client.getPriceHistory(tok).catch(() => []), 3650, Date.now()) : [];
      done += 1;
      if (done % 250 === 0) { writeFileSync(file, JSON.stringify(cache)); console.log(`  ${done}/${missing.length}`); }
    }
    writeFileSync(file, JSON.stringify(cache));
  }
  const map = new Map<string, { ts: string; price: number }[]>();
  for (const c of conds) if ((cache[c]?.length ?? 0) >= 2) map.set(c, cache[c]!);
  return map;
}

// Last daily close at or before the target day, within 5d staleness (same rule as backtestDeadline).
function priceAtDay(prices: { ts: string; price: number }[], targetMs: number): number | null {
  const targetTs = new Date(targetMs).toISOString().slice(0, 10);
  const floorTs = new Date(targetMs - 5 * 86_400_000).toISOString().slice(0, 10);
  let best: number | null = null;
  for (const p of prices) {
    if (p.ts <= targetTs && p.ts >= floorTs) best = p.price;
    if (p.ts > targetTs) break;
  }
  return best;
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
