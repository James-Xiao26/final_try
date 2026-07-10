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
import { buildCandidates, type Trade, type Candidate } from "./copyCandidates.js";
import { isSportsText } from "./sports.js";

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
const ENRICH_MAX = Number(process.env.COPY_ENRICH_MAX ?? 250); // how many top candidates to Gamma-enrich + sports-gate
// Elite-wallet gates (see eliteWallets.ts). Lower COPY_MIN_EDGE to widen the pool on a thin day.
const ELITE_OPTS = {
  minFamilies: Number(process.env.COPY_MIN_FAMILIES ?? 8),
  minHalfFamilies: 3,
  minEdge: Number(process.env.COPY_MIN_EDGE ?? 0.03)
};

async function main(): Promise<void> {
  selfCheck();
  // STRICTLY SPORTS: rank wallets on their sports-only archive history, so `elite` = the best SPORTS
  // bettors (proven, consistent forecasting edge on sports markets), not all-category leaders.
  const elite = await loadEliteWallets(supabase, ELITE_OPTS, (r) => isSportsText(r.market, r.event_slug));
  console.log(`Best SPORTS bettors (sports-only deep-archive edge>=${ELITE_OPTS.minEdge}/sh, consistent over time, >=${ELITE_OPTS.minFamilies} sports families): ${elite.size}`);
  if (elite.size === 0) {
    console.log("No wallets clear the sports elite gate — lower COPY_MIN_EDGE/COPY_MIN_FAMILIES or backfill the archive (archiveBackfill.ts).");
    return;
  }
  console.log("\nTop sports bettors to follow (address · sports edge/share · sports families):");
  for (const w of [...elite.values()].sort((a, b) => b.edge - a.edge).slice(0, 15)) {
    console.log(`  ${w.address}  +${w.edge.toFixed(3)}/sh  ${w.families} fam`);
  }
  console.log("");

  const trades: Trade[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from("recent_trades").select("address, condition_id, market, outcome_index, side, price, usdc_size, traded_at").range(from, from + 999);
    if (error) throw error;
    const batch = (data ?? []) as Trade[];
    trades.push(...batch);
    if (batch.length < 1000) break;
  }

  const client = new PolymarketClient();
  const now = Date.now();

  // First pass ranks candidate markets so we know which to Gamma-enrich. Enriching gives us each market's
  // kickoff (gameStartTime); a SECOND buildCandidates pass then drops in-game (live) entries so only
  // PRE-GAME bets count. Two passes because kickoff is per-market Gamma data, unknown until we enrich.
  interface Brief { outcomes: string[]; endDate: string | null; eventTitle: string | null; groupItemTitle: string | null }
  const first = buildCandidates(trades, elite, now, { freshDays: FRESH_DAYS, minPrice: MIN_PRICE, maxPrice: MAX_PRICE, minLiquidity: MIN_LIQUIDITY_USD });
  const briefs = new Map<string, Brief>(); // enriched + kept (sports, open) markets
  const gameStart = new Map<string, number>(); // conditionId -> kickoff ms (single-game markets only)
  let dropped = 0;
  let nonSports = 0;
  for (const c of first.slice(0, ENRICH_MAX)) {
    if (briefs.has(c.conditionId)) continue; // one Gamma call per market, not per side
    const brief = await client.getMarketBrief(c.conditionId).catch(() => null);
    if (!brief || brief.resolved) { dropped += 1; continue; }
    const endMs = brief.endDate ? Date.parse(brief.endDate) : NaN;
    if (!Number.isNaN(endMs) && endMs <= now) { dropped += 1; continue; } // already ended
    // STRICTLY SPORTS market gate — classify the richest text Gamma gives us (event title catches soccer/
    // World Cup games whose bare question, e.g. "Will Argentina win?", has no sports keyword).
    if (!isSportsText(brief.eventTitle, brief.groupItemTitle, c.question)) { nonSports += 1; continue; }
    briefs.set(c.conditionId, brief);
    const startMs = brief.gameStartTime ? Date.parse(brief.gameStartTime) : NaN;
    if (!Number.isNaN(startMs)) gameStart.set(c.conditionId, startMs); // single game -> pre-game cutoff
  }

  // Second pass: pre-game only. Re-aggregate from trades placed BEFORE each market's kickoff.
  const candidates = buildCandidates(trades, elite, now, { freshDays: FRESH_DAYS, minPrice: MIN_PRICE, maxPrice: MAX_PRICE, minLiquidity: MIN_LIQUIDITY_USD }, gameStart);
  interface Live { c: Candidate; bet: string; marketType: string; game: string; endDays: number }
  const live: Live[] = [];
  for (const c of candidates) {
    const brief = briefs.get(c.conditionId);
    if (!brief) continue; // not enriched/kept (non-sports, resolved, ended, or below the enrich cap)
    const endMs = brief.endDate ? Date.parse(brief.endDate) : NaN;
    const bet = brief.outcomes[c.outcomeIndex] ?? c.side; // exact label, fall back to YES/NO
    // Game = Polymarket's event title stem (before " - "), its authoritative grouping. Falls back to
    // the market question when a market has no event, so standalone markets stay their own group.
    const game = (brief.eventTitle ?? c.question).split(" - ")[0]!.trim();
    const marketType = brief.groupItemTitle ?? c.question;
    live.push({ c, bet, marketType, game, endDays: Number.isNaN(endMs) ? NaN : (endMs - now) / 86_400_000 });
  }
  const inGameMarkets = [...gameStart.keys()].filter((id) => !candidates.some((c) => c.conditionId === id)).length;

  // Group by game/event so one game occupies ONE slot (not 5). Distinct bet TYPES within a game stay
  // separate lines — never merged — so O/U isn't confused with the moneyline. Rank games by their single
  // strongest market (agreement, then edge), and within a game show markets strongest-first.
  const byGame = new Map<string, Live[]>();
  for (const l of live) (byGame.get(l.game) ?? byGame.set(l.game, []).get(l.game)!).push(l);
  for (const g of byGame.values()) g.sort((a, b) => b.c.avgEliteEdge - a.c.avgEliteEdge || b.c.wallets - a.c.wallets || b.c.usd - a.c.usd);
  const games = [...byGame.entries()].sort(([, a], [, b]) => b[0]!.c.avgEliteEdge - a[0]!.c.avgEliteEdge || b[0]!.c.wallets - a[0]!.c.wallets || b[0]!.c.usd - a[0]!.c.usd);

  console.log(`Feed: ${trades.length} board fills -> ${first.length} sports-elite candidates -> ${live.length} still-open sports markets (dropped ${dropped} resolved/ended, ${nonSports} non-sports, ${inGameMarkets} fully in-game).`);
  console.log(`PRE-GAME ONLY: entries placed after a game's kickoff (gameStartTime) are excluded.`);
  console.log(`Grouped into ${games.length} distinct games/events, best-first. Each ▸ block is ONE game — its lines are different bets, pick one.\n`);
  const fmtResolve = (d: number): string => (Number.isNaN(d) ? "?" : d < 1 ? "<1d" : `${d.toFixed(0)}d`);
  for (const [game, markets] of games.slice(0, 20)) {
    // Collapse the SAME market (same condition_id) so opposite sides don't show as two bets: keep the
    // side elite wallets favour, note the dissent. Safe — same condition_id is authoritatively one bet.
    const byMarket = new Map<string, Live[]>();
    for (const l of markets) (byMarket.get(l.c.conditionId) ?? byMarket.set(l.c.conditionId, []).get(l.c.conditionId)!).push(l);
    const lines = [...byMarket.values()].map((sides) => {
      sides.sort((a, b) => b.c.wallets - a.c.wallets || b.c.usd - a.c.usd);
      return { top: sides[0]!, dissent: sides[1] ?? null };
    });
    lines.sort((a, b) => b.top.c.avgEliteEdge - a.top.c.avgEliteEdge || b.top.c.wallets - a.top.c.wallets || b.top.c.usd - a.top.c.usd);
    console.log(`▸ ${game}   (resolves ${fmtResolve(lines[0]!.top.endDays)}, ${lines.length} elite market${lines.length > 1 ? "s" : ""})`);
    for (const { top, dissent } of lines) {
      const { c, bet, marketType } = top;
      const type = marketType === game ? "" : ` · ${marketType.replace(`${game}: `, "").slice(0, 22)}`;
      const split = dissent ? `  [${dissent.c.wallets}w disagree: ${dissent.bet.slice(0, 10)}]` : "";
      console.log(`    bet ${bet.slice(0, 14).padEnd(14)} @<=${c.avgPrice.toFixed(2)}  ${String(c.wallets).padStart(2)}w  +${c.avgEliteEdge.toFixed(3)}/sh  $${Math.round(c.usd).toString().padStart(5)}${type}${split}`);
    }
  }
  console.log(`\nEach ▸ game = one bet to consider; take the top line (strongest). Other lines are DIFFERENT bets on the same`);
  console.log(`game (correlated) — only add one if you want that separate angle. "[Nw disagree]" = elite wallets split on that`);
  console.log(`market. Buy within ~2-3c of the shown price or skip (spread). edge/sh = copiers' historical profit/share (proxy).`);
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
