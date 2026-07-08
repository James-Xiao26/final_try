// Sports copy list — discovery-driven, (almost) never blank.
//
//   pnpm --filter edgeboard-scripts copylist
//
// What it does, and why it's built this way:
//   * Enumerates UPCOMING sports games straight from Polymarket (Gamma tag_slug=sports, future kickoff).
//     Future kickoff is the trick: if a game hasn't started, EVERY current holder entered PRE-GAME by
//     definition — so "only count bets placed before the game" falls out for free, no per-trade timing.
//   * Pulls each game's HOLDERS from the public /holders endpoint. That surfaces sharp wallets whether or
//     not they're on our volume leaderboard — this is the "discover users outside the leaderboard" part.
//   * Vets each holder's SPORTS forecasting edge from their own resolved history, with the exact
//     family-collapsed, Bayesian-shrunk, consistent-in-both-halves math the board-elite ranking uses
//     (eliteWallets.walletQuality + passesGate). Evaluations are cached to sportsScouts.json so reruns
//     are cheap.
//   * Surfaces the games where vetted wallets currently hold a side, ranked by agreement × edge. The
//     vetting gate RELAXES step by step until at least MIN_BETS bets show, so the list is (almost) never
//     blank while any upcoming sports game has holders.
//
// This is a discovery/ranking tool, NOT proven alpha — the copylist forward test is the arbiter.
import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PolymarketClient } from "./polymarket.js";
import { walletQuality, passesGate, type WalletEval, type ArchiveRow } from "./eliteWallets.js";
import { isSportsText } from "./sports.js";
import { CONFIG } from "./config.js";

loadEnv({ path: "../.env.local" });
loadEnv();
function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}
const supabase = createClient(requiredEnv("NEXT_PUBLIC_SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"));

// Tunables (env-overridable).
const HORIZON_DAYS = Number(process.env.SCOUT_HORIZON_DAYS ?? 3); // only games kicking off within N days
const MARKETS_MAX = Number(process.env.SCOUT_MARKETS_MAX ?? 150); // cap game-markets processed (holders calls)
const HOLDERS_PER_MARKET = Number(process.env.SCOUT_HOLDERS ?? 20); // /holders limit per outcome token
const EVAL_MAX = Number(process.env.SCOUT_EVAL_MAX ?? 250); // cap NEW wallet evaluations per run (restricted lane); cache accumulates across runs
const EVAL_TTL_DAYS = Number(process.env.SCOUT_EVAL_TTL_DAYS ?? 21); // re-evaluate a cached wallet after this
const EVAL_DAYS = Number(process.env.SCOUT_EVAL_DAYS ?? 180); // history depth for the edge eval
const EVAL_PAGES = Number(process.env.SCOUT_EVAL_PAGES ?? 8); // cap /closed-positions pages/wallet (~400 positions; enough for a shrunk-edge estimate)
const MIN_BETS = Number(process.env.SCOUT_MIN_BETS ?? 8); // never-blank target
const MIN_LIQ = Number(process.env.SCOUT_MIN_LIQ ?? 3000); // only scout games liquid enough to actually copy
const DUST_SHARES = Number(process.env.SCOUT_DUST_SHARES ?? 20); // ignore a holder's dust position
const CACHE_FILE = new URL("./sportsScouts.json", import.meta.url);

export interface GameMarket {
  conditionId: string;
  gameStartMs: number;
  endMs: number;
  eventTitle: string;
  question: string; // the specific market within the event (groupItemTitle or question)
  outcomes: string[];
  prices: (number | null)[]; // current price per outcome index, for the copy price
  liquidity: number; // Gamma liquidity, to prefer games sharps actually trade over obscure thin matches
}
export interface HeldSide { conditionId: string; outcomeIndex: number; address: string; shares: number }
interface CacheRow extends WalletEval { at: string }

const p = (s: string | null | undefined): number => {
  if (!s) return NaN;
  let t = s.replace(" ", "T");
  if (t.endsWith("+00")) t = `${t.slice(0, -3)}+00:00`;
  return Date.parse(t);
};
const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};
const jsonArr = (v: unknown): unknown[] => {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") { try { const a = JSON.parse(v); return Array.isArray(a) ? a : []; } catch { return []; } }
  return [];
};

// 1. Enumerate upcoming sports game-markets from Polymarket (Gamma tag_slug=sports).
async function upcomingGames(client: PolymarketClient): Promise<GameMarket[]> {
  const now = Date.now();
  const cutoff = now + HORIZON_DAYS * 86_400_000;
  const games: GameMarket[] = [];
  const PAGE = 100; // Gamma caps an events page at ~100
  for (let offset = 0; offset < 2000; offset += PAGE) {
    const events = await client.getSportsEvents(PAGE, offset).catch(() => []);
    if (events.length === 0) break;
    for (const e of events) {
      const eventTitle = String((e as { title?: unknown }).title ?? "");
      const markets = Array.isArray((e as { markets?: unknown }).markets) ? (e as { markets: unknown[] }).markets : [];
      for (const mRaw of markets) {
        const m = mRaw as Record<string, unknown>;
        if (m.closed === true) continue;
        const startMs = p(m.gameStartTime as string | undefined);
        if (!Number.isFinite(startMs) || startMs <= now || startMs > cutoff) continue; // upcoming only
        const outcomes = jsonArr(m.outcomes).map(String);
        const prices = jsonArr(m.outcomePrices).map(num);
        games.push({
          conditionId: String(m.conditionId ?? ""),
          gameStartMs: startMs,
          endMs: p((m.endDate as string) ?? undefined),
          eventTitle,
          question: String(m.groupItemTitle || m.question || eventTitle),
          outcomes,
          prices: outcomes.map((_, i) => prices[i] ?? null),
          liquidity: num(m.liquidityNum ?? m.liquidity) ?? 0
        });
      }
    }
    if (events.length < PAGE) break;
    // Events are liquidity-ordered, so once we have enough liquid-enough upcoming games the rest of the
    // pages are only thinner — stop.
    if (games.filter((g) => g.liquidity >= MIN_LIQ).length >= MARKETS_MAX) break;
  }
  // Only scout games liquid enough to actually copy (thin markets = wide spreads, uncopyable dust and a
  // waste of the holder-pull budget). Fall back to no floor if too few clear it (keeps it non-blank).
  // Then most-liquid first, capped.
  const withId = games.filter((g) => g.conditionId);
  const liquid = withId.filter((g) => g.liquidity >= MIN_LIQ);
  return (liquid.length >= 20 ? liquid : withId).sort((a, b) => b.liquidity - a.liquidity).slice(0, MARKETS_MAX);
}

// 3. Vet one wallet's SPORTS edge from its resolved history (cached across runs).
async function evaluate(client: PolymarketClient, address: string): Promise<WalletEval> {
  const closed = await client.getClosedPositions(address, EVAL_DAYS, EVAL_PAGES).catch(() => []);
  const rows: ArchiveRow[] = closed
    .filter((c) => c.outcome !== null && isSportsText(c.market, c.eventSlug))
    .map((c) => ({ address, market: c.market, avg_price: c.avgPrice, outcome: c.outcome, close_time: c.closeTime, event_slug: c.eventSlug }));
  return walletQuality(rows);
}

// Progressive vetting gates — strictest first. The list uses the strictest one that yields >= MIN_BETS
// (else the loosest that yields anything), so it is never needlessly blank.
const LEVELS: { label: string; ok: (q: WalletEval) => boolean }[] = [
  { label: "strict", ok: (q) => passesGate(q, { minFamilies: 8, minHalfFamilies: 3, minEdge: 0.05 }) },
  { label: "standard", ok: (q) => passesGate(q, { minFamilies: 6, minHalfFamilies: 2, minEdge: 0.03 }) },
  { label: "relaxed", ok: (q) => passesGate(q, { minFamilies: 5, minHalfFamilies: 2, minEdge: 0.015 }) },
  { label: "loose", ok: (q) => passesGate(q, { minFamilies: 4, minHalfFamilies: 1, minEdge: 0 }) && q.edge > 0 },
  { label: "floor", ok: (q) => q.families >= 3 && q.edge > 0 }, // positive overall, consistency dropped
  { label: "last-resort", ok: (q) => q.families >= 2 && q.edge > 0 }
];

export interface Bet { g: GameMarket; outcomeIndex: number; wallets: number; avgEdge: number; usd: number; price: number | null }

// Aggregate GOOD wallets' held sides into one bet per (game, side): distinct good wallets, their mean
// edge, total $ at current price. Pure — unit-tested.
export function buildBets(held: HeldSide[], gamesById: Map<string, GameMarket>, evals: Map<string, WalletEval>, good: (q: WalletEval) => boolean): Bet[] {
  const agg = new Map<string, { g: GameMarket; oi: number; addrs: Set<string>; edgeSum: number; shares: number }>();
  for (const h of held) {
    const q = evals.get(h.address);
    if (!q || !good(q)) continue;
    const g = gamesById.get(h.conditionId);
    if (!g) continue;
    const key = `${h.conditionId}:${h.outcomeIndex}`;
    const a = agg.get(key) ?? { g, oi: h.outcomeIndex, addrs: new Set<string>(), edgeSum: 0, shares: 0 };
    if (!a.addrs.has(h.address)) { a.addrs.add(h.address); a.edgeSum += q.edge; }
    a.shares += h.shares;
    agg.set(key, a);
  }
  return [...agg.values()]
    .map((a) => {
      const price = a.g.prices[a.oi] ?? null;
      return { g: a.g, outcomeIndex: a.oi, wallets: a.addrs.size, avgEdge: a.edgeSum / a.addrs.size, usd: a.shares * (price ?? 0), price };
    })
    .sort((x, y) => y.wallets - x.wallets || y.avgEdge - x.avgEdge || y.g.liquidity - x.g.liquidity || y.usd - x.usd);
}

async function main(): Promise<void> {
  const client = new PolymarketClient();
  const now = Date.now();

  const games = await upcomingGames(client);
  const gamesById = new Map(games.map((g) => [g.conditionId, g]));
  console.log(`Upcoming sports game-markets (kickoff within ${HORIZON_DAYS}d): ${games.length}`);
  if (games.length === 0) {
    console.log("No upcoming sports games on Polymarket right now (unusual). Widen SCOUT_HORIZON_DAYS and retry.");
    return;
  }

  // 2. Holders of each game -> pre-game held sides + the discovery pool.
  const held: HeldSide[] = [];
  const sharesByWallet = new Map<string, number>();
  for (const g of games) {
    const holders = await client.getMarketHolders(g.conditionId, HOLDERS_PER_MARKET).catch(() => []);
    for (const h of holders) {
      if (h.shares < DUST_SHARES) continue;
      held.push({ conditionId: g.conditionId, outcomeIndex: h.outcomeIndex, address: h.address, shares: h.shares });
      sharesByWallet.set(h.address, (sharesByWallet.get(h.address) ?? 0) + h.shares);
    }
  }
  const pool = [...sharesByWallet.keys()];
  console.log(`Pulled holders -> ${pool.length} distinct wallets holding an upcoming game (all pre-game).`);

  // 3. Load eval cache; evaluate new/stale wallets (biggest holders first), capped per run.
  const cache: Record<string, CacheRow> = existsSync(CACHE_FILE) ? JSON.parse(readFileSync(CACHE_FILE, "utf8")) : {};
  const staleMs = now - EVAL_TTL_DAYS * 86_400_000;
  const toEval = pool
    .filter((a) => !cache[a] || Date.parse(cache[a]!.at) < staleMs)
    .sort((a, b) => (sharesByWallet.get(b) ?? 0) - (sharesByWallet.get(a) ?? 0))
    .slice(0, EVAL_MAX);
  console.log(`Evaluating ${toEval.length} new/stale wallets (${pool.length - toEval.length} cached fresh)...`);
  let done = 0;
  for (const a of toEval) {
    const q = await evaluate(client, a);
    cache[a] = { ...q, at: new Date().toISOString() };
    if (++done % 50 === 0) { console.log(`  ...${done}/${toEval.length}`); writeFileSync(CACHE_FILE, JSON.stringify(cache)); }
  }
  writeFileSync(CACHE_FILE, JSON.stringify(cache));
  const evals = new Map<string, WalletEval>(pool.filter((a) => cache[a]).map((a) => [a, cache[a]!]));

  // 4. Pick the strictest gate that yields >= MIN_BETS bets (else the loosest non-empty). Iterating
  // strict→loose: the first level clearing MIN_BETS wins; if none clears, each non-empty level overwrites
  // so we end on the loosest non-empty.
  let chosen: { label: string; ok: (q: WalletEval) => boolean; bets: Bet[] } = { label: "none", ok: () => false, bets: [] };
  for (const lvl of LEVELS) {
    const bets = buildBets(held, gamesById, evals, lvl.ok);
    if (bets.length > 0) chosen = { label: lvl.label, ok: lvl.ok, bets };
    if (bets.length >= MIN_BETS) break;
  }

  // Good wallets = pool wallets clearing the chosen gate. They all hold an upcoming game (that's the pool),
  // so they're the discovered sports-skilled wallets. Cross-ref the leaderboard for the OFF-board count.
  const goodAddrs = new Set(pool.filter((a) => evals.has(a) && chosen.ok(evals.get(a)!)));
  const boardSet = await loadBoardAddresses();
  const discovered = [...goodAddrs].filter((a) => !boardSet.has(a));

  // --- Report: discovered wallets ---
  const rankedWallets = [...goodAddrs]
    .map((a) => [a, evals.get(a)!] as const)
    .filter(([, q]) => q.families > 0)
    .sort(([, a], [, b]) => b.edge - a.edge);
  console.log(`\nSports-skilled wallets behind these picks: ${goodAddrs.size} (${discovered.length} OFF our leaderboard).`);
  console.log("Top (address · sports edge/share · sports families · on/off board):");
  for (const [a, q] of rankedWallets.slice(0, 15)) {
    console.log(`  ${a}  +${q.edge.toFixed(3)}/sh  ${q.families} fam  ${boardSet.has(a) ? "board" : "OFF-BOARD"}`);
  }

  // --- Report: the bets, grouped by game/event ---
  console.log(`\nVetting level used: ${chosen.label.toUpperCase()} (relaxes toward looser gates only to stay non-blank).`);
  // Group by event STEM (before " - ") so a game's sub-markets ("… - More Markets", "… - Exact Score")
  // collapse under one game. Rank games by their strongest bet's agreement, then edge.
  const stem = (t: string): string => t.split(" - ")[0]!.trim();
  const byEvent = new Map<string, Bet[]>();
  for (const b of chosen.bets) { const k = stem(b.g.eventTitle); (byEvent.get(k) ?? byEvent.set(k, []).get(k)!).push(b); }
  const events = [...byEvent.entries()].sort(([, a], [, b]) => Math.max(...b.map((x) => x.wallets)) - Math.max(...a.map((x) => x.wallets)) || b[0]!.avgEdge - a[0]!.avgEdge);
  const fmtIn = (ms: number): string => { const h = (ms - now) / 3_600_000; return h < 1 ? "<1h" : h < 24 ? `${h.toFixed(0)}h` : `${(h / 24).toFixed(0)}d`; };
  console.log(`\n=== SPORTS BETS TO TAKE (${chosen.bets.length}) — all pre-game, best-first ===\n`);
  for (const [event, bets] of events.slice(0, 25)) {
    bets.sort((a, b) => b.wallets - a.wallets || b.avgEdge - a.avgEdge || b.usd - a.usd);
    const liq = Math.round(Math.max(...bets.map((b) => b.g.liquidity)));
    console.log(`▸ ${event}   (starts ${fmtIn(bets[0]!.g.gameStartMs)}, ~$${liq.toLocaleString()} liq)`);
    for (const b of bets) {
      const bet = b.g.outcomes[b.outcomeIndex] ?? `outcome ${b.outcomeIndex}`;
      const type = stem(b.g.question) === event ? "" : ` · ${b.g.question.slice(0, 26)}`;
      const px = b.price === null ? "?" : b.price.toFixed(2);
      console.log(`    bet ${bet.slice(0, 16).padEnd(16)} @${px.padEnd(4)} ${String(b.wallets).padStart(2)}w  +${b.avgEdge.toFixed(3)}/sh  $${Math.round(b.usd).toString().padStart(6)}${type}`);
    }
  }
  console.log(`\nPay near the shown price or skip (spread). "w" = distinct vetted wallets holding that side pre-game;`);
  console.log(`edge/sh = their historical sports profit per share (proxy). Discovery + eval cached in sportsScouts.json.`);
}

async function loadBoardAddresses(): Promise<Set<string>> {
  const out = new Set<string>();
  const { data } = await supabase.from("leaderboard_cache").select("address");
  for (const r of (data ?? []) as { address: string }[]) out.add(r.address.toLowerCase());
  return out;
}

// Run only as the entry point (not when imported by the unit test).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
