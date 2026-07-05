// Copy-trade buy list — the "start trading tomorrow" tool.
//
//   pnpm --filter edgeboard-scripts copylist
//
// Prints the markets that ELITE wallets BOUGHT in the last few days, so you can mirror their fresh
// entries at ~the price they paid — sorted best-signal-first, because you'll only take the top few.
//
// "Elite" is NOT the whole leaderboard: it's the stricter cut from eliteWallets.ts — wallets whose deep
// (~1yr archive) forecasting edge is both STRONG (family-collapsed shrunk per-share profit over entry)
// and CONSISTENT (positive in both halves of their history). That filters copy-worthiness far harder
// than a raw Skill Score floor.
//
// Deliberately NOT the Trending "divergence" signal: that compares a wallet's stale AVG ENTRY price to
// the current market and mis-fires on any position the market has moved since (you'd bet AGAINST a
// wallet that already won — ALPHA_RESEARCH_LOG §5.3 timing artifact). Fresh entries sidestep that. In
// practice they skew to fast-resolving sports/esports — good for tiny capital (quick feedback, liquid).
//
// This is NOT proven alpha (the forward test is the arbiter). It's the best-ranked way to start with
// pennies AND generate clean forward data. Rank favours MULTI-wallet agreement, then edge, then size.
//
// ponytail: reads the board-scoped recent_trades feed the ingest maintains (~last day of fills), so
// coverage is only as deep as the feed × the elite set. If a day is empty, lower COPY_MIN_EDGE (widen
// the elite pool) or COPY_FRESH_DAYS; don't add API calls to the fill path.
import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { strict as assert } from "node:assert";
import { PolymarketClient } from "./polymarket.js";
import { loadEliteWallets, type WalletQuality } from "./eliteWallets.js";

loadEnv({ path: "../.env.local" });
loadEnv();

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}
const supabase = createClient(requiredEnv("NEXT_PUBLIC_SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"));

// Tunables — override via env for a wider/narrower net.
const FRESH_DAYS = Number(process.env.COPY_FRESH_DAYS ?? 3); // only trades this recent
const MIN_PRICE = 0.1; // skip near-decided extremes (no edge, wide relative spread)
const MAX_PRICE = 0.9;
const MIN_LIQUIDITY_USD = Number(process.env.COPY_MIN_LIQ ?? 100); // total sharp $ into the side — a liquidity/spread proxy
// Elite-wallet gates (see eliteWallets.ts). Lower COPY_MIN_EDGE to widen the pool on a thin day.
const ELITE_OPTS = {
  minFamilies: Number(process.env.COPY_MIN_FAMILIES ?? 8),
  minHalfFamilies: 3,
  minEdge: Number(process.env.COPY_MIN_EDGE ?? 0.03)
};

interface Trade {
  address: string;
  condition_id: string | null;
  market: string | null;
  outcome_index: number | null;
  side: string;
  price: number;
  usdc_size: number;
  traded_at: string;
}

interface Candidate {
  conditionId: string;
  outcomeIndex: number;
  question: string;
  side: "YES" | "NO";
  wallets: number;
  avgEliteEdge: number; // mean historical per-share edge of the elite wallets copying this side
  usd: number;
  avgPrice: number;
  latestAgeDays: number;
}

// Collapse fresh ELITE BUYs into one candidate per (market, side): distinct elite wallets on it, mean
// elite edge, total $, $-weighted avg entry price, freshest trade. Only trades from wallets in the
// `elite` map count. Pure so it's unit-testable. Ranked best-first: agreement, then edge, then size.
export function buildCandidates(trades: Trade[], elite: Map<string, WalletQuality>, nowMs: number, opts: { freshDays: number; minPrice: number; maxPrice: number; minLiquidity: number }): Candidate[] {
  const ageDays = (t: string): number => (nowMs - Date.parse(t)) / 86_400_000;
  const fresh = trades.filter(
    (t) =>
      t.side === "BUY" &&
      t.condition_id !== null &&
      ageDays(t.traded_at) <= opts.freshDays &&
      elite.has(t.address) &&
      t.price >= opts.minPrice &&
      t.price <= opts.maxPrice
  );
  const agg = new Map<string, { conditionId: string; outcomeIndex: number; question: string; yes: boolean; wallets: Set<string>; usd: number; pSum: number; latest: string }>();
  for (const t of fresh) {
    const key = `${t.condition_id}:${t.outcome_index}`;
    const g = agg.get(key) ?? { conditionId: t.condition_id!, outcomeIndex: t.outcome_index ?? 0, question: t.market ?? "(unknown)", yes: t.outcome_index === 0, wallets: new Set<string>(), usd: 0, pSum: 0, latest: t.traded_at };
    g.wallets.add(t.address);
    g.usd += t.usdc_size;
    g.pSum += t.price * t.usdc_size;
    if (t.traded_at > g.latest) g.latest = t.traded_at;
    agg.set(key, g);
  }
  return [...agg.values()]
    .filter((g) => g.usd >= opts.minLiquidity)
    .map((g) => {
      const avgEliteEdge = [...g.wallets].reduce((a, w) => a + (elite.get(w)?.edge ?? 0), 0) / g.wallets.size;
      return { conditionId: g.conditionId, outcomeIndex: g.outcomeIndex, question: g.question, side: (g.yes ? "YES" : "NO") as "YES" | "NO", wallets: g.wallets.size, avgEliteEdge, usd: g.usd, avgPrice: g.usd > 0 ? g.pSum / g.usd : 0, latestAgeDays: ageDays(g.latest) };
    })
    .sort((a, b) => b.wallets - a.wallets || b.avgEliteEdge - a.avgEliteEdge || b.usd - a.usd);
}

async function main(): Promise<void> {
  selfCheck();
  const elite = await loadEliteWallets(supabase, ELITE_OPTS);
  console.log(`Elite wallets (deep-archive edge>=${ELITE_OPTS.minEdge}/sh, consistent over time, >=${ELITE_OPTS.minFamilies} families): ${elite.size}`);
  if (elite.size === 0) {
    console.log("No wallets clear the elite gate — lower COPY_MIN_EDGE or backfill the archive (archiveBackfill.ts).");
    return;
  }

  const trades: Trade[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from("recent_trades").select("address, condition_id, market, outcome_index, side, price, usdc_size, traded_at").range(from, from + 999);
    if (error) throw error;
    const batch = (data ?? []) as Trade[];
    trades.push(...batch);
    if (batch.length < 1000) break;
  }

  const candidates = buildCandidates(trades, elite, Date.now(), { freshDays: FRESH_DAYS, minPrice: MIN_PRICE, maxPrice: MAX_PRICE, minLiquidity: MIN_LIQUIDITY_USD });

  // Enrich with Gamma: the exact side label (outcomes[outcomeIndex] — "Over"/team/"Yes", NOT a bare
  // YES/NO), and drop markets already resolved or past their end date (you can't bet a played game).
  const client = new PolymarketClient();
  const now = Date.now();
  interface Live { c: Candidate; bet: string; endDays: number }
  const live: Live[] = [];
  let dropped = 0;
  for (const c of candidates.slice(0, 80)) {
    const brief = await client.getMarketBrief(c.conditionId).catch(() => null);
    if (!brief || brief.resolved) { dropped += 1; continue; }
    const endMs = brief.endDate ? Date.parse(brief.endDate) : NaN;
    if (!Number.isNaN(endMs) && endMs <= now) { dropped += 1; continue; } // already ended
    const bet = brief.outcomes[c.outcomeIndex] ?? c.side; // exact label, fall back to YES/NO
    live.push({ c, bet, endDays: Number.isNaN(endMs) ? NaN : (endMs - now) / 86_400_000 });
  }

  console.log(`Feed: ${trades.length} board fills -> ${candidates.length} elite candidates -> ${live.length} still-open (dropped ${dropped} resolved/ended).\n`);
  console.log(`BET (exact side) | ~price | agree | edge/sh | sharp$ | ~resolves | market`);
  console.log(`-----------------+--------+-------+---------+--------+-----------+-----------------------------------`);
  for (const { c, bet, endDays } of live.slice(0, 40)) {
    const resolves = Number.isNaN(endDays) ? "?" : endDays < 1 ? "<1d" : `${endDays.toFixed(0)}d`;
    const edge = `+${c.avgEliteEdge.toFixed(3)}`;
    console.log(`${bet.slice(0, 16).padEnd(16)} |  ${c.avgPrice.toFixed(2)}  |  ${String(c.wallets).padStart(2)}w  |  ${edge.padStart(6)} | ${Math.round(c.usd).toString().padStart(6)} | ${resolves.padStart(9)} | ${c.question.slice(0, 52)}`);
  }
  console.log(`\nEach row = buy the "BET" side at <=~the shown price. Top few are best: prefer agree>=2, higher edge/sh, higher sharp$.`);
  console.log(`edge/sh = the copying elite wallets' historical profit per share over entry (a quality proxy, not a guarantee).`);
  console.log(`Skip anything you can't buy within ~2-3c of the shown price — the spread eats a tiny bet.`);
}

function selfCheck(): void {
  const now = Date.parse("2026-07-05T00:00:00Z");
  const mk = (address: string, cond: string, oi: number, side: string, price: number, usd: number, ageDays: number): Trade => ({ address, condition_id: cond, market: `Market ${cond}`, outcome_index: oi, side, price, usdc_size: usd, traded_at: new Date(now - ageDays * 86_400_000).toISOString() });
  // elite: a (edge 0.08), b (edge 0.05); c is NOT elite -> its trades ignored.
  const elite = new Map<string, WalletQuality>([
    ["a", { address: "a", edge: 0.08, families: 10, firstHalfEdge: 0.05, secondHalfEdge: 0.06 }],
    ["b", { address: "b", edge: 0.05, families: 9, firstHalfEdge: 0.04, secondHalfEdge: 0.05 }]
  ]);
  const trades: Trade[] = [
    mk("a", "m1", 0, "BUY", 0.6, 200, 1), // elite YES
    mk("b", "m1", 0, "BUY", 0.7, 100, 0.5), // 2nd elite same side -> wallets=2, avgEdge=(0.08+0.05)/2
    mk("c", "m1", 0, "BUY", 0.5, 999, 0.1), // NON-elite -> excluded
    mk("a", "m2", 1, "BUY", 0.4, 50, 1), // elite but below MIN_LIQUIDITY (50<100) -> dropped
    mk("a", "m3", 0, "SELL", 0.6, 500, 1), // SELL -> excluded
    mk("a", "m4", 0, "BUY", 0.95, 500, 1) // price above MAX_PRICE -> excluded
  ];
  const out = buildCandidates(trades, elite, now, { freshDays: 3, minPrice: 0.1, maxPrice: 0.9, minLiquidity: 100 });
  assert.equal(out.length, 1); // only m1 survives all filters
  assert.equal(out[0]!.wallets, 2);
  assert.equal(out[0]!.side, "YES");
  assert.ok(Math.abs(out[0]!.avgPrice - (0.6 * 200 + 0.7 * 100) / 300) < 1e-9);
  assert.ok(Math.abs(out[0]!.avgEliteEdge - (0.08 + 0.05) / 2) < 1e-9);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
