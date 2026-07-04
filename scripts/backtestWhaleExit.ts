// Rigorous stress test of the hold-to-resolution copy idea, targeting the two things backtestSmartMoney.ts
// can't answer honestly:
//   1. Is the sold-early win rate just "they buy favorites"?  -> every group carries a FAVORITE BASELINE
//      (bet whichever side the MARKET priced >50c at entry, hold to resolution). Signal only has alpha if
//      it beats that, not a coin.
//   2. What about markets where the whole crowd bailed?  -> outcome is resolved from the CLOB settlement
//      price (YES token -> ~1 or ~0), NOT from wallet exits. So markets where nobody held to resolution
//      (the ugliest abandonment cases) are INCLUDED, and the outcome is independent of the signal (kills
//      the circularity where a whale riding to $1 defines both the signal and the outcome).
//
//   pnpm --filter edgeboard-scripts exec tsx backtestWhaleExit.ts
//
// Caches (conditionId -> entry/final YES price) to whaleExitCache.json so reruns are instant.
import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { strict as assert } from "node:assert";
import { PolymarketClient } from "./polymarket.js";
import { dailyPointsFromHistory } from "./priceHistory.js";
import { classifyMarket } from "./specialty.js";

loadEnv({ path: "../.env.local" });
loadEnv();
const need = (n: string): string => { const v = process.env[n]; if (!v) throw new Error(`Missing ${n}`); return v; };
const supabase = createClient(need("NEXT_PUBLIC_SUPABASE_URL"), need("NEXT_PUBLIC_SUPABASE_ANON_KEY"));

const DUST = 10, MINP = 5, EPS = 0.03, ENTRY_TOL_DAYS = 14;

interface R { address: string; condition_id: string | null; outcome_index: number | null; avg_price: number | null; realized_pnl: number | null; size: number | null; first_traded_at: string | null; market: string | null; event_slug: string | null; }
const cost = (r: R) => (r.size ?? 0) * (r.avg_price ?? 0);
const yesEq = (r: R) => (r.outcome_index === 1 ? 1 - (r.avg_price ?? 0) : r.avg_price ?? 0);
const exitVal = (r: R): number | null => (r.size && r.size > 0 && r.realized_pnl != null && r.avg_price != null ? r.avg_price + r.realized_pnl / r.size : null);
const heldToResolution = (r: R): boolean => { const e = exitVal(r); return e != null && (e >= 1 - EPS || e <= EPS); };
function wYes(rows: R[], w: (r: R) => number): number | null { let W = 0, S = 0; for (const r of rows) { const x = w(r); W += x; S += x * yesEq(r); } return W > 0 ? S / W : null; }

async function fetchAllClosed(): Promise<R[]> {
  const rows: R[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from("wallet_closed_positions").select("address, condition_id, outcome_index, avg_price, realized_pnl, size, first_traded_at, market, event_slug").range(from, from + 999);
    if (error) throw error;
    const b = (data ?? []) as R[];
    rows.push(...b);
    if (b.length < 1000) break;
  }
  return rows;
}

// conditionId -> {entryYes at the crowd's entry date, finalYes at settlement}. Both come from the YES
// token's own CLOB history in one fetch. finalYes near 1/0 => resolved; mid-range => still open (skip).
interface Px { entryYes: number | null; finalYes: number | null; }
const CACHE = join(dirname(fileURLToPath(import.meta.url)), "whaleExitCache.json");
function loadCache(): Map<string, Px> { if (!existsSync(CACHE)) return new Map(); return new Map(Object.entries(JSON.parse(readFileSync(CACHE, "utf8")) as Record<string, Px>)); }
function saveCache(c: Map<string, Px>): void { writeFileSync(CACHE, JSON.stringify(Object.fromEntries(c), null, 0) + "\n"); }

function nearest(points: { ts: string; price: number }[], targetMs: number): number | null {
  let best: { p: number; d: number } | null = null;
  for (const pt of points) { const d = Math.abs(Date.parse(pt.ts) - targetMs) / 86_400_000; if (d <= ENTRY_TOL_DAYS && (best === null || d < best.d)) best = { p: pt.price, d }; }
  return best?.p ?? null;
}

// Collapse date/number variants of the same recurring market into one family key (kills "by May 31" vs
// "by June 30", "40-64 tweets" vs "200-219 tweets" as separate events). Tighter than event_slug.
const MONTHS = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/gi;
const familyKey = (t: string): string =>
  t.toLowerCase().replace(/\b\d[\d,.:-]*\b/g, "#").replace(MONTHS, "").replace(/\b(st|nd|rd|th)\b/g, "").replace(/[?,.'"]/g, "").replace(/\s+/g, " ").trim();

const brier = (p: number, a: number) => (p - a) ** 2;
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

interface Mkt { cid: string; eventSlug: string | null; question: string; category: string; participants: number; totalUsd: number; whalePct: number; refEntryMs: number; payout: number; dollar: number; whaleSoldEarly: boolean; allBailed: boolean; }

function report(label: string, set: (Mkt & { entryYes: number | null; outcome: number })[]): void {
  if (set.length === 0) { console.log(`  ${label.padEnd(30)} n=0`); return; }
  const win = (pred: (m: (typeof set)[number]) => number) => 100 * mean(set.map((m) => ((pred(m) > 0.5 ? 1 : 0) === m.outcome ? 1 : 0)));
  const br = (pred: (m: (typeof set)[number]) => number) => mean(set.map((m) => brier(pred(m), m.outcome)));
  const withEntry = set.filter((m) => m.entryYes !== null) as (typeof set[number] & { entryYes: number })[];
  const sigWin = win((m) => m.payout), sigBr = br((m) => m.payout);
  const meanEntryYes = mean(set.map((m) => m.payout));
  let favStr = "  favorite: n/a (no entry price)";
  if (withEntry.length > 0) {
    const favWin = 100 * mean(withEntry.map((m) => ((m.entryYes > 0.5 ? 1 : 0) === m.outcome ? 1 : 0)));
    const favBr = mean(withEntry.map((m) => brier(m.entryYes, m.outcome)));
    favStr = `  FAVORITE bet: win ${favWin.toFixed(1)}%  Brier ${favBr.toFixed(4)}  (n=${withEntry.length})  |  signal EDGE over favorite: ${(sigWin - favWin >= 0 ? "+" : "")}${(sigWin - favWin).toFixed(1)}pt`;
  }
  console.log(`  ${label.padEnd(30)} n=${String(set.length).padStart(3)}  outcome=${(100 * mean(set.map((m) => m.outcome))).toFixed(0)}%YES`);
  console.log(`      SIGNAL(payout) hold-to-resolution: win ${sigWin.toFixed(1)}%  Brier ${sigBr.toFixed(4)}   (mean smart-money YES entry ${meanEntryYes.toFixed(3)})`);
  console.log(`    ${favStr}`);
}

async function main(): Promise<void> {
  // self-check
  const s: R[] = [{ address: "a", condition_id: "c", outcome_index: 0, avg_price: 0.8, realized_pnl: 0.2 * 100, size: 100, first_traded_at: null, market: null, event_slug: null }];
  assert.ok(Math.abs(exitVal(s[0]!)! - 1.0) < 1e-9 && heldToResolution(s[0]!)); // won: 0.8 + 20/100 = 1.0
  assert.ok(Math.abs(wYes(s, (r) => r.size ?? 0)! - 0.8) < 1e-9);

  const all = await fetchAllClosed();
  console.log(`${all.length} closed rows`);
  const byC = new Map<string, R[]>();
  for (const r of all) { if (!r.condition_id) continue; (byC.get(r.condition_id) ?? byC.set(r.condition_id, []).get(r.condition_id)!).push(r); }

  const mkts: Mkt[] = [];
  for (const [cid, rows] of byC) {
    const pos = rows.filter((r) => cost(r) >= DUST);
    if (new Set(pos.map((r) => r.address)).size < MINP) continue;
    const payout = wYes(pos, (r) => r.size ?? 0), dollar = wYes(pos, cost);
    if (payout === null || dollar === null) continue;
    let dw = 0, dwd = 0;
    for (const r of pos) { const ms = r.first_traded_at ? Date.parse(r.first_traded_at) : NaN; if (Number.isFinite(ms)) { dw += cost(r); dwd += cost(r) * ms; } }
    if (dw <= 0) continue;
    let whale = pos[0]!;
    for (const r of pos) if (cost(r) > cost(whale)) whale = r;
    const we = exitVal(whale);
    const totalUsd = pos.reduce((a, r) => a + cost(r), 0);
    const question = pos.find((r) => r.market)?.market ?? cid;
    mkts.push({
      cid, eventSlug: pos.find((r) => r.event_slug)?.event_slug ?? null,
      question, category: classifyMarket(question) ?? "Other",
      participants: new Set(pos.map((r) => r.address)).size, totalUsd, whalePct: cost(whale) / totalUsd,
      refEntryMs: dwd / dw, payout, dollar,
      whaleSoldEarly: we != null && we > EPS && we < 1 - EPS, allBailed: pos.every((r) => !heldToResolution(r))
    });
  }
  console.log(`${mkts.length} markets clear >=${MINP} wallets / $${DUST} (BEFORE any outcome filter)\n`);

  // Resolve each via CLOB settlement price, independent of wallets.
  const cache = loadCache();
  const client = new PolymarketClient();
  let fetched = 0;
  const resolved: (Mkt & { entryYes: number | null; outcome: number })[] = [];
  let unresolved = 0;
  for (let i = 0; i < mkts.length; i++) {
    const m = mkts[i]!;
    let px = cache.get(m.cid);
    if (!px) {
      const yes = await client.getYesTokenId(m.cid);
      if (yes) {
        const pts = dailyPointsFromHistory(await client.getPriceHistory(yes), 3650, Date.now());
        if (pts.length > 0) {
          let last = pts[0]!;
          for (const p of pts) if (p.ts > last.ts) last = p;
          px = { entryYes: nearest(pts, m.refEntryMs), finalYes: last.price };
        } else px = { entryYes: null, finalYes: null };
      } else px = { entryYes: null, finalYes: null };
      cache.set(m.cid, px);
      if (++fetched % 25 === 0) { console.log(`  ...fetched ${fetched}`); saveCache(cache); }
    }
    const f = px.finalYes;
    const outcome = f == null ? null : f >= 1 - EPS ? 1 : f <= EPS ? 0 : null;
    if (outcome === null) { unresolved++; continue; }
    resolved.push({ ...m, entryYes: px.entryYes, outcome });
  }
  saveCache(cache);
  console.log(`${resolved.length} CLOB-resolved; ${unresolved} still open/unresolvable (skipped)\n`);

  const rode = resolved.filter((m) => !m.whaleSoldEarly);
  const soldEarly = resolved.filter((m) => m.whaleSoldEarly);
  const ugliest = resolved.filter((m) => m.allBailed);
  console.log("═══ Hold-to-resolution, CLOB-resolved outcomes (signal = payout/size weighting) ═══");
  report("ALL resolved", resolved);
  report("whale RODE to resolution", rode);
  report("whale SOLD OUT early", soldEarly);
  report("EVERYONE bailed (ugliest)", ugliest);
  // ── Is it all World Cup? Category breakdown + per-category signal edge over the favorite. ──
  console.log(`\n═══ WHAT MARKETS DID smart money actually converge on? (resolved set, n=${resolved.length}) ═══`);
  const cats = [...new Set(resolved.map((m) => m.category))];
  const catRows = cats
    .map((c) => {
      const set = resolved.filter((m) => m.category === c);
      const withE = set.filter((m) => m.entryYes !== null) as (typeof set[number] & { entryYes: number })[];
      const sigWin = 100 * mean(set.map((m) => ((m.payout > 0.5 ? 1 : 0) === m.outcome ? 1 : 0)));
      const favWin = withE.length ? 100 * mean(withE.map((m) => ((m.entryYes > 0.5 ? 1 : 0) === m.outcome ? 1 : 0))) : NaN;
      return { c, n: set.length, sigWin, favWin, edge: sigWin - favWin };
    })
    .sort((a, b) => b.n - a.n);
  for (const r of catRows) {
    const edge = Number.isNaN(r.edge) ? "n/a" : `${r.edge >= 0 ? "+" : ""}${r.edge.toFixed(1)}pt`;
    console.log(`  ${r.c.padEnd(12)} n=${String(r.n).padStart(3)} (${((100 * r.n) / resolved.length).toFixed(0)}%)   signal win ${r.sigWin.toFixed(1)}%   vs favorite ${Number.isNaN(r.favWin) ? "n/a" : r.favWin.toFixed(1) + "%"}   edge ${edge}`);
  }

  // ── Full CSV so you can open every converged market and judge for yourself. ──
  const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const header = "category,question,participants,total_usd,whale_pct,whale_sold_early,everyone_bailed,market_entry_yes,signal_payout_yes,outcome,signal_correct,favorite_correct";
  const lines = resolved
    .sort((a, b) => b.participants - a.participants)
    .map((m) =>
      [
        m.category, esc(m.question.slice(0, 120)), m.participants, m.totalUsd.toFixed(0), m.whalePct.toFixed(2),
        m.whaleSoldEarly ? 1 : 0, m.allBailed ? 1 : 0,
        m.entryYes == null ? "" : m.entryYes.toFixed(3), m.payout.toFixed(3), m.outcome,
        (m.payout > 0.5 ? 1 : 0) === m.outcome ? 1 : 0,
        m.entryYes == null ? "" : (m.entryYes > 0.5 ? 1 : 0) === m.outcome ? 1 : 0
      ].join(",")
    );
  const csvPath = join(dirname(fileURLToPath(import.meta.url)), "convergedMarkets.csv");
  writeFileSync(csvPath, [header, ...lines].join("\n") + "\n");
  console.log(`\nFull list written to scripts/convergedMarkets.csv — ${resolved.length} converged+resolved markets, sorted by participant count.`);

  // ── EVENT-CLUSTERED: the real significance test. Date-variants of one event ("peace deal by May 31"
  // vs "by June 30") are correlated, not independent — counting each as a win fakes the sample size.
  // Treat each event_slug as ONE observation: per-event mean signal-correct and mean favorite-correct,
  // then a paired test ACROSS events (n = distinct events, not markets). This is the honest n. ────────
  const sigCorrect = (m: (typeof resolved)[number]) => ((m.payout > 0.5 ? 1 : 0) === m.outcome ? 1 : 0);
  const favCorrect = (m: (typeof resolved)[number] & { entryYes: number }) => ((m.entryYes > 0.5 ? 1 : 0) === m.outcome ? 1 : 0);
  const byEvent = new Map<string, (typeof resolved)[number][]>();
  for (const m of resolved) { const k = m.eventSlug ?? m.cid; (byEvent.get(k) ?? byEvent.set(k, []).get(k)!).push(m); }
  const eventEdges: { k: string; n: number; sig: number; fav: number; edge: number }[] = [];
  for (const [k, set] of byEvent) {
    const withE = set.filter((m) => m.entryYes !== null) as ((typeof resolved)[number] & { entryYes: number })[];
    if (withE.length === 0) continue; // need a favorite baseline to form an edge
    const sig = mean(withE.map(sigCorrect));
    const fav = mean(withE.map(favCorrect));
    eventEdges.push({ k, n: set.length, sig, fav, edge: sig - fav });
  }
  const edges = eventEdges.map((e) => e.edge);
  const eMean = mean(edges);
  const eSd = Math.sqrt(mean(edges.map((d) => (d - eMean) ** 2)) * (edges.length / Math.max(1, edges.length - 1)));
  const eT = eMean / (eSd / Math.sqrt(edges.length));
  const eventsSigBeatsFav = eventEdges.filter((e) => e.edge > 0).length;
  const eventsFavBeatsSig = eventEdges.filter((e) => e.edge < 0).length;
  console.log(`\n═══ EVENT-CLUSTERED significance (each event = 1 independent observation) ═══`);
  console.log(`  ${byEvent.size} distinct events from ${resolved.length} markets  (avg ${(resolved.length / byEvent.size).toFixed(1)} date-variants/event)`);
  console.log(`  mean per-event edge (signal win% - favorite win%): ${(eMean * 100 >= 0 ? "+" : "")}${(eMean * 100).toFixed(1)}pt`);
  console.log(`  paired t across ${edges.length} events = ${eT.toFixed(2)}  (|t|>2 ~ significant at 95%)`);
  console.log(`  events where signal beat favorite: ${eventsSigBeatsFav}, favorite beat signal: ${eventsFavBeatsSig}, tied: ${edges.length - eventsSigBeatsFav - eventsFavBeatsSig}`);
  console.log(`  biggest events by market count:`);
  for (const e of [...eventEdges].sort((a, b) => b.n - a.n).slice(0, 8)) {
    console.log(`    ${String(e.n).padStart(2)} mkts  ${e.k.slice(0, 46).padEnd(46)}  signal ${(100 * e.sig).toFixed(0)}%  favorite ${(100 * e.fav).toFixed(0)}%`);
  }

  // Does ANY edge survive outside the Iran theme? Drop every event whose key looks Iran/Hormuz-related
  // and re-run the clustered test on what's left. If this collapses to noise, the entire result is the
  // one Iran macro call; if it holds, there's a theme-independent signal.
  const iranRe = /iran|hormuz|ceasefire|tehran|enrichment|uranium|airspace|blockade/i;
  const nonIran = eventEdges.filter((e) => !iranRe.test(e.k));
  if (nonIran.length >= 3) {
    const ne = nonIran.map((e) => e.edge);
    const nm = mean(ne);
    const nsd = Math.sqrt(mean(ne.map((d) => (d - nm) ** 2)) * (ne.length / Math.max(1, ne.length - 1)));
    console.log(`\n  NON-IRAN events only (${nonIran.length} events): mean edge ${(nm * 100 >= 0 ? "+" : "")}${(nm * 100).toFixed(1)}pt  t=${(nm / (nsd / Math.sqrt(ne.length))).toFixed(2)}  signal>fav ${nonIran.filter((e) => e.edge > 0).length}, fav>signal ${nonIran.filter((e) => e.edge < 0).length}`);
  }

  // FAMILY clustering: collapse date/number bucket-variants into one recurring series (tighter than
  // event_slug). This is the true count of distinct bets — the honest effective n.
  const byFam = new Map<string, (typeof resolved)[number][]>();
  for (const m of resolved) { const k = familyKey(m.question); (byFam.get(k) ?? byFam.set(k, []).get(k)!).push(m); }
  const famEdges: number[] = [];
  for (const [, set] of byFam) {
    const withE = set.filter((m) => m.entryYes !== null) as ((typeof resolved)[number] & { entryYes: number })[];
    if (withE.length === 0) continue;
    famEdges.push(mean(withE.map(sigCorrect)) - mean(withE.map(favCorrect)));
  }
  const fm = mean(famEdges);
  const fsd = Math.sqrt(mean(famEdges.map((d) => (d - fm) ** 2)) * (famEdges.length / Math.max(1, famEdges.length - 1)));
  const nonIranFam = [...byFam.entries()].filter(([k]) => !iranRe.test(k));
  const niEdges: number[] = [];
  for (const [, set] of nonIranFam) {
    const withE = set.filter((m) => m.entryYes !== null) as ((typeof resolved)[number] & { entryYes: number })[];
    if (withE.length > 0) niEdges.push(mean(withE.map(sigCorrect)) - mean(withE.map(favCorrect)));
  }
  console.log(`\n  ── FAMILY-clustered (bucket variants collapsed) ──`);
  console.log(`  ${byFam.size} distinct families from ${resolved.length} markets`);
  console.log(`  ALL families: mean edge ${(fm * 100 >= 0 ? "+" : "")}${(fm * 100).toFixed(1)}pt  t=${(fm / (fsd / Math.sqrt(famEdges.length))).toFixed(2)}  (n=${famEdges.length})`);
  if (niEdges.length >= 3) {
    const nim = mean(niEdges);
    const nisd = Math.sqrt(mean(niEdges.map((d) => (d - nim) ** 2)) * (niEdges.length / Math.max(1, niEdges.length - 1)));
    console.log(`  NON-IRAN families: mean edge ${(nim * 100 >= 0 ? "+" : "")}${(nim * 100).toFixed(1)}pt  t=${(nim / (nisd / Math.sqrt(niEdges.length))).toFixed(2)}  (n=${niEdges.length})`);
  }

  console.log(`\nabandonment markets now included: ${ugliest.length} (these have NO wallet holding to resolution — the old`);
  console.log(`wallet-vote method dropped every one of them). If their signal win rate ~ favorite baseline, that's where alpha dies.`);
  console.log(`\nCaveat still standing: smart-money entry (blended avg_price) is later-informed than the market entry price`);
  console.log(`(matched to their FIRST trade), so the signal's edge over the favorite is an UPPER bound. And survivorship remains.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
