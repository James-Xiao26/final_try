// Deadline-decay backtest — structural (wallet-free, survivorship-free) alpha hypothesis.
//
//   pnpm --filter edgeboard-scripts backtest:deadline
//
// HYPOTHESIS: "Will X happen BY <date>" markets systematically overprice YES late in their life.
// The true probability of an arrival event must decay as the window shrinks with no news, but
// holders anchor on the narrative, not the clock ("it could still happen"). If real, buying NO at
// T days before the deadline earns more than the market price implies — and specifically MORE than
// the same trade in non-deadline markets at the same price (the calibration control).
//
// Why this sample is different from every wallet backtest in this repo: it is ALL resolved binary
// markets from Gamma (winners and losers alike), not positions of board wallets — no survivorship
// by construction. The remaining biases are volume-filtering (tradeability) and price-history
// availability, both signal-neutral.
//
// SECONDARY SCAN (same data, free): date-ladder monotonicity. "X by May" can never be more likely
// than "X by June" of the same family; same-day price inversions are pure logic arbs. Counted and
// listed, not traded — execution needs both legs live.
//
// Method discipline (repo lessons baked in):
//   - family-clustered t-stats (date-variants of one theme count once) — the §4f/whale-exit lesson
//   - control group at same price band + horizon — the favorite-baseline lesson
//   - ex-top-family cut — the "it's all Iran" lesson
//   - time-split halves — the walk-forward lesson
//   - 1c slippage haircut on entries (Polymarket fees ~0; spread is the real cost)
//
// Caches Gamma + CLOB pulls to backtestDeadline.cache.json (gitignored) so reruns are instant.
import { config as loadEnv } from "dotenv";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { strict as assert } from "node:assert";
import { PolymarketClient } from "./polymarket.js";
import { dailyPointsFromHistory, type PricePoint } from "./priceHistory.js";
import { marketFamilyKey } from "./metrics.js";

loadEnv({ path: "../.env.local" });
loadEnv();

const GAMMA = "https://gamma-api.polymarket.com";
const CACHE_FILE = join(dirname(fileURLToPath(import.meta.url)), "backtestDeadline.cache.json");
const MS_DAY = 86_400_000;

// Experiment knobs.
const LOOKBACK_DAYS = 365; // resolved within the last year
const MIN_VOLUME = 10_000; // tradeable-liquidity floor
const HORIZONS = [30, 14, 7]; // days before deadline to place the trade
const BAND = { lo: 0.05, hi: 0.6 } as const; // YES band where the story-vs-clock mispricing should live
const SLIPPAGE = 0.01; // entry haircut per share
const MAX_DEADLINE = 1500; // price-history fetch caps (by volume)
const MAX_CONTROL = 1000;

interface Mkt {
  conditionId: string;
  question: string;
  endDate: string; // ISO
  yesWon: boolean;
  yesTokenId: string;
  volume: number;
  deadline: boolean;
  prices?: PricePoint[]; // daily YES closes, filled by the fetch phase
}

// ── Deadline detection ────────────────────────────────────────────────────────────────────────────
const MONTHS = "january|february|march|april|may|june|july|august|september|october|november|december";
// "by/before" must be followed directly by a month, year, or "end of" — NOT an amount ("increases
// rates by 25 bps" is not a deadline; that false-positive polluted v1 with Fed/BoJ meeting markets,
// which are mutually exclusive events, not cumulative arrivals, and faked monotonicity violations).
const DEADLINE_RE = new RegExp(`\\b(by|before)\\s+(the\\s+)?((${MONTHS})\\b|20\\d\\d\\b|end of\\b|eoy\\b)`, "i");
export function isDeadlineMarket(question: string): boolean {
  return DEADLINE_RE.test(question);
}

// Family key for the monotonicity scan: strip ONLY date-ish tokens (months, 1–2 digit day numbers,
// 4-digit years) so "BTC $100k by May" and "$150k by May" stay DISTINCT (marketFamilyKey strips all
// numbers, which would falsely pair non-nested ladders).
export function dateLadderKey(question: string): string {
  return question
    .toLowerCase()
    .replace(/(\d),(\d)/g, "$1$2") // "$5,000" → "$5000" so the strike survives day-number stripping
    .replace(new RegExp(`\\b(${MONTHS})\\b`, "g"), " ")
    .replace(/(?<![$.\d])\b\d{1,2}(st|nd|rd|th)?\b(?!\s*%)/g, " ") // day numbers only — "$85" and "5%" are strikes, not dates
    .replace(/\b20\d\d\b/g, " ")
    .replace(/[^a-z0-9$%]+/g, " ")
    .trim();
}

// Deadline parsed from the TITLE — Gamma's endDate is unreliable for ladder ordering (edited on early
// resolution), which made consistent pairs look inverted. "by June 30" / "by June 30, 2026" /
// "before July" / "by end of June" / "by 2027". Year omitted → first year that puts the deadline
// at/after `anchorMs` (market creation) — a deadline can't predate the market's existence, and the
// endDate year is exactly what resolution-editing corrupts. The right anchor is the LAST traded
// day: trading never continues past the deadline (early resolution only stops it sooner), whereas
// anchoring on creation mis-years a market created before the same-named date of the prior year.
export function titleDeadlineMs(question: string, anchorMs: number): number | null {
  const q = question.toLowerCase();
  const bare = q.match(/\b(?:by|before)\s+(?:the\s+)?(20\d\d)\b/);
  const m = q.match(new RegExp(`\\b(?:by|before)\\s+(?:the\\s+)?(end of\\s+)?(${MONTHS})\\s*(\\d{1,2})?(?:st|nd|rd|th)?,?\\s*(20\\d\\d)?`));
  if (!m) return bare ? Date.UTC(Number(bare[1]), 0, 1) : null; // "by 2027" = before Jan 1 2027
  const monthIdx = MONTHS.split("|").indexOf(m[2]!);
  const build = (y: number): number => Date.UTC(y, monthIdx, m[3] ? Number(m[3]) : m[1] ? new Date(Date.UTC(y, monthIdx + 1, 0)).getUTCDate() : 1); // "end of June"=30th, bare "before July"=1st
  if (m[4]) return build(Number(m[4]));
  const y = new Date(anchorMs).getUTCFullYear();
  return build(y) >= anchorMs ? build(y) : build(y + 1);
}

// Year anchor for a title with no explicit year: the deadline can't predate the market's creation,
// and can't be more than ~45d (generous UMA-settlement lag) before its last print. max() of the two
// survives both failure modes seen live: dust prints weeks past deadline (Dec-2025 leg read as Dec
// 2026) and markets created before the same-named date of the prior year (June-30 leg read a year early).
export function yearAnchorMs(firstDayMs: number, lastDayMs: number): number {
  return Math.max(firstDayMs, lastDayMs - 45 * MS_DAY);
}

// Survival-shaped questions ("US does NOT strike by X", "X remains Y through...") invert the ladder
// direction — surviving to a LATER date is HARDER. Excluded rather than direction-flipped.
export function isSurvivalShaped(question: string): boolean {
  return /\b(not|no |without|avoid|remains?|stays?)\b/i.test(question);
}

// $1 staked on NO at YES price p (plus slippage): cost/share = 1-p+slip. NO wins → 1/cost − 1; else −1.
export function noPnlPerDollar(yesPrice: number, yesWon: boolean, slip = SLIPPAGE): number {
  const cost = Math.min(0.99, 1 - yesPrice + slip);
  return yesWon ? -1 : 1 / cost - 1;
}

// Last daily close at or before the target day (never peek later), within `tolDays` staleness.
export function priceAt(prices: PricePoint[], targetMs: number, tolDays = 5): number | null {
  const targetTs = new Date(targetMs).toISOString().slice(0, 10);
  const floorTs = new Date(targetMs - tolDays * MS_DAY).toISOString().slice(0, 10);
  let best: PricePoint | null = null;
  for (const p of prices) {
    if (p.ts <= targetTs && p.ts >= floorTs) best = p; // sorted ascending → last match wins
    if (p.ts > targetTs) break;
  }
  return best ? best.price : null;
}

// ── Stats (same conventions as backtestCopylist) ──────────────────────────────────────────────────
function stats(xs: number[]): { n: number; mean: number; t: number; winRate: number } {
  if (xs.length === 0) return { n: 0, mean: 0, t: 0, winRate: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, xs.length - 1));
  return { n: xs.length, mean, t: sd > 0 ? mean / (sd / Math.sqrt(xs.length)) : 0, winRate: xs.filter((x) => x > 0).length / xs.length };
}
function clusterMean(rows: { key: string; v: number }[]): number[] {
  const m = new Map<string, { s: number; n: number }>();
  for (const r of rows) { const e = m.get(r.key) ?? { s: 0, n: 0 }; e.s += r.v; e.n += 1; m.set(r.key, e); }
  return [...m.values()].map((e) => e.s / e.n);
}
const fmt = (s: ReturnType<typeof stats>) => `n=${String(s.n).padStart(4)}  mean $/$1 ${s.mean >= 0 ? "+" : ""}${s.mean.toFixed(3)}  win ${(s.winRate * 100).toFixed(1)}%  t=${s.t.toFixed(2)}`;

// ── Data pull (cached) ────────────────────────────────────────────────────────────────────────────
async function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

async function fetchGammaMarkets(): Promise<Mkt[]> {
  // Gamma caps a page at 100 rows regardless of limit, and endDate-ordered paging drowns in 5-minute
  // Up/Down spam. So: 12 monthly windows, each ordered volume DESC — liquid real markets first, and
  // we can stop a window early the moment volume drops under the floor.
  const out: Mkt[] = [];
  const nowMs = Date.now();
  for (let month = 0; month < Math.ceil(LOOKBACK_DAYS / 30); month++) {
    const maxEnd = new Date(Math.min(nowMs - 2 * MS_DAY, nowMs - month * 30 * MS_DAY)).toISOString();
    const minEnd = new Date(nowMs - (month + 1) * 30 * MS_DAY).toISOString();
    let kept = 0;
    windowLoop: for (let offset = 0; offset < 5_000 && kept < 1_200; ) {
      const url = `${GAMMA}/markets?closed=true&limit=100&offset=${offset}&order=volumeNum&ascending=false&end_date_min=${encodeURIComponent(minEnd)}&end_date_max=${encodeURIComponent(maxEnd)}`;
      const res = await fetch(url);
      if (res.status === 422) break; // Gamma caps pagination depth (~2000) — top-by-volume slice is enough
      if (!res.ok) throw new Error(`Gamma ${res.status} at offset ${offset}`);
      const page = (await res.json()) as Record<string, unknown>[];
      if (!Array.isArray(page) || page.length === 0) break;
      for (const m of page) {
        try {
          const volume = Number(m.volumeNum ?? m.volume ?? 0);
          if (volume < MIN_VOLUME) break windowLoop; // volume-desc ordering → nothing below is big enough
          const outcomes = JSON.parse(String(m.outcomes ?? "[]")) as string[];
          if (outcomes.length !== 2 || outcomes[0] !== "Yes") continue; // binary Yes/No only
          const prices = JSON.parse(String(m.outcomePrices ?? "[]")) as string[];
          const yes = Number(prices[0]);
          if (yes !== 0 && yes !== 1) continue; // skip voided/50-50 resolutions
          const tokens = JSON.parse(String(m.clobTokenIds ?? "[]")) as string[];
          const endDate = String(m.endDate ?? "");
          const conditionId = String(m.conditionId ?? "");
          const question = String(m.question ?? "");
          if (!tokens[0] || !endDate || !conditionId || !question) continue;
          if (!Number.isFinite(Date.parse(endDate))) continue;
          out.push({ conditionId, question, endDate, yesWon: yes === 1, yesTokenId: tokens[0], volume, deadline: isDeadlineMarket(question) });
          kept += 1;
        } catch { /* malformed row — skip */ }
      }
      offset += page.length;
      await sleep(60);
    }
    console.log(`  month -${month + 1} (${minEnd.slice(0, 10)}..${maxEnd.slice(0, 10)}): ${kept} binary ≥$${MIN_VOLUME / 1000}k`);
  }
  // Dedup (pagination drift) then cap fetch load by volume within each class.
  const seen = new Map<string, Mkt>();
  for (const m of out) if (!seen.has(m.conditionId)) seen.set(m.conditionId, m);
  const all = [...seen.values()];
  const deadline = all.filter((m) => m.deadline).sort((a, b) => b.volume - a.volume).slice(0, MAX_DEADLINE);
  const control = all.filter((m) => !m.deadline).sort((a, b) => b.volume - a.volume).slice(0, MAX_CONTROL);
  console.log(`Gamma: ${all.length} resolved binary markets ≥$${MIN_VOLUME / 1000}k; kept ${deadline.length} deadline + ${control.length} control.`);
  return [...deadline, ...control];
}

interface Cache { markets: Mkt[] }
function loadCache(): Cache | null { return existsSync(CACHE_FILE) ? (JSON.parse(readFileSync(CACHE_FILE, "utf8")) as Cache) : null; }
function saveCache(c: Cache): void { writeFileSync(CACHE_FILE, JSON.stringify(c) + "\n"); }

async function main(): Promise<void> {
  selfCheck();
  let cache = loadCache();
  if (!cache) {
    console.log("No cache — pulling resolved markets from Gamma…");
    cache = { markets: await fetchGammaMarkets() };
    saveCache(cache);
  }
  const client = new PolymarketClient();
  const todo = cache.markets.filter((m) => !m.prices);
  if (todo.length > 0) console.log(`Fetching CLOB daily history for ${todo.length} markets (cached: ${cache.markets.length - todo.length})…`);
  let done = 0;
  for (const m of todo) {
    const raw = await client.getPriceHistory(m.yesTokenId).catch(() => []);
    m.prices = dailyPointsFromHistory(raw, 3650, Date.now());
    done += 1;
    if (done % 200 === 0) { saveCache(cache); console.log(`  ${done}/${todo.length}`); }
  }
  saveCache(cache);

  for (const m of cache.markets) m.deadline = isDeadlineMarket(m.question); // recompute — detector may have changed since cache
  const usable = cache.markets.filter((m) => (m.prices?.length ?? 0) >= 3);
  const dl = usable.filter((m) => m.deadline);
  const ctl = usable.filter((m) => !m.deadline);
  console.log(`\nUsable (≥3 price days): ${dl.length} deadline, ${ctl.length} control.`);
  console.log(`Sample deadline titles: ${dl.slice(0, 5).map((m) => `"${m.question.slice(0, 60)}"`).join(", ")}\n`);

  // ── Main experiment: buy NO at T days out, YES price in band ──────────────────────────────────
  interface Obs { key: string; endMs: number; pnl: number; p: number; yesWon: boolean; q: string }
  const observe = (ms: Mkt[], T: number): Obs[] => {
    const obs: Obs[] = [];
    for (const m of ms) {
      const endMs = Date.parse(m.endDate);
      const p = priceAt(m.prices!, endMs - T * MS_DAY);
      if (p === null || p < BAND.lo || p > BAND.hi) continue;
      obs.push({ key: marketFamilyKey(m.question), endMs, pnl: noPnlPerDollar(p, m.yesWon), p, yesWon: m.yesWon, q: m.question });
    }
    return obs;
  };

  for (const T of HORIZONS) {
    const dObs = observe(dl, T);
    const cObs = observe(ctl, T);
    const dCl = clusterMean(dObs.map((o) => ({ key: o.key, v: o.pnl })));
    const cCl = clusterMean(cObs.map((o) => ({ key: o.key, v: o.pnl })));
    console.log(`── BUY NO at T=${T}d out, YES∈[${BAND.lo},${BAND.hi}], ${SLIPPAGE * 100}c slippage ──`);
    console.log(`  deadline (family-clustered)  ${fmt(stats(dCl))}`);
    console.log(`  control  (family-clustered)  ${fmt(stats(cCl))}`);
    // Stress: drop the biggest family (the "it's all Iran" check), split halves by endDate.
    const famCount = new Map<string, number>();
    for (const o of dObs) famCount.set(o.key, (famCount.get(o.key) ?? 0) + 1);
    const topFam = [...famCount.entries()].sort((a, b) => b[1] - a[1])[0];
    if (topFam) {
      const exTop = clusterMean(dObs.filter((o) => o.key !== topFam[0]).map((o) => ({ key: o.key, v: o.pnl })));
      console.log(`  deadline ex-top-family       ${fmt(stats(exTop))}   (dropped "${topFam[0].slice(0, 40)}" ×${topFam[1]})`);
    }
    const endTimes = dObs.map((o) => o.endMs).sort((a, b) => a - b);
    const midEnd = endTimes[Math.floor(endTimes.length / 2)] ?? 0;
    const h1 = clusterMean(dObs.filter((o) => o.endMs < midEnd).map((o) => ({ key: o.key, v: o.pnl })));
    const h2 = clusterMean(dObs.filter((o) => o.endMs >= midEnd).map((o) => ({ key: o.key, v: o.pnl })));
    console.log(`  deadline older half          ${fmt(stats(h1))}`);
    console.log(`  deadline newer half          ${fmt(stats(h2))}\n`);
  }

  // Calibration table at T=14: market said p, how often did YES actually happen?
  console.log("── CALIBRATION at T=14d (market price → actual YES rate; overpricing = actual < price) ──");
  console.log("  band        deadline: actual (n)     control: actual (n)");
  const dObs14 = observe(dl, 14);
  const cObs14 = observe(ctl, 14);
  for (let lo = 0.05; lo < 0.6; lo += 0.11) {
    const hi = lo + 0.11;
    const db = dObs14.filter((o) => o.p >= lo && o.p < hi);
    const cb = cObs14.filter((o) => o.p >= lo && o.p < hi);
    const rate = (xs: Obs[]) => (xs.length ? (xs.filter((o) => o.yesWon).length / xs.length) : NaN);
    console.log(`  ${lo.toFixed(2)}-${hi.toFixed(2)}   ${(rate(db) * 100).toFixed(1).padStart(5)}% (${String(db.length).padStart(4)})        ${(rate(cb) * 100).toFixed(1).padStart(5)}% (${String(cb.length).padStart(4)})   vs mid ~${(((lo + hi) / 2) * 100).toFixed(0)}%`);
  }

  // ── Secondary: date-ladder monotonicity violations ────────────────────────────────────────────
  console.log("\n── DATE-LADDER MONOTONICITY (same family, earlier deadline priced ABOVE later = logic arb) ──");
  const ladders = new Map<string, Mkt[]>();
  for (const m of dl) (ladders.get(dateLadderKey(m.question)) ?? ladders.set(dateLadderKey(m.question), []).get(dateLadderKey(m.question))!).push(m);
  let pairDays = 0, violDays = 0, liveViolDays = 0;
  const live: { gap: number; line: string }[] = [];
  let ladderCount = 0;
  for (const fam of ladders.values()) {
    // Order by the deadline in the TITLE; drop unparseable or survival-shaped members.
    const dated = fam
      .filter((m) => !isSurvivalShaped(m.question))
      .map((m) => ({ m, dl: titleDeadlineMs(m.question, yearAnchorMs(Date.parse(`${m.prices![0]!.ts}T00:00:00Z`), Date.parse(`${m.prices![m.prices!.length - 1]!.ts}T00:00:00Z`))) }))
      .filter((x): x is { m: Mkt; dl: number } => x.dl !== null)
      .sort((x, y) => x.dl - y.dl);
    if (dated.length < 2) continue;
    ladderCount += 1;
    for (let i = 0; i < dated.length - 1; i++) {
      for (let j = i + 1; j < dated.length; j++) {
        const a = dated[i]!.m, b = dated[j]!.m;
        if (dated[j]!.dl - dated[i]!.dl < 2 * MS_DAY) continue; // same deadline, not nested
        // Compare only days strictly BEFORE the earlier TITLE deadline — past it the earlier leg is
        // an expired token at dust, and any live later leg fakes a giant "violation".
        const aDeadlineDay = new Date(dated[i]!.dl).toISOString().slice(0, 10);
        const bByTs = new Map(b.prices!.map((p) => [p.ts, p.price]));
        for (const pa of a.prices!) {
          const pb = bByTs.get(pa.ts);
          if (pb === undefined || pa.ts >= aDeadlineDay) continue;
          pairDays += 1;
          const gap = pa.price - pb;
          if (gap > 0.04) {
            violDays += 1;
            // "Live" = the later leg isn't a dust placeholder (a dead 1-2c quote is not executable
            // liquidity, and a huge "gap" against it is an artifact, not an arb).
            if (pb >= 0.05) {
              liveViolDays += 1;
              live.push({ gap, line: `${pa.ts}  gap ${(gap * 100).toFixed(0)}c  "${a.question.slice(0, 75)}" ${(pa.price * 100).toFixed(0)}c  vs  "${b.question.slice(0, 75)}" ${(pb * 100).toFixed(0)}c` });
            }
          }
        }
      }
    }
  }
  live.sort((x, y) => y.gap - x.gap);
  console.log(`  ${pairDays} overlapping market-pair-days across ${ladderCount} ladders (title-date ordered, survival-shaped excluded); ${violDays} violation-days >4c (${pairDays ? ((violDays / pairDays) * 100).toFixed(2) : 0}%), of which ${liveViolDays} with a LIVE later leg ≥5c (${pairDays ? ((liveViolDays / pairDays) * 100).toFixed(2) : 0}%).`);
  for (const e of live.slice(0, 6)) console.log(`    ${e.line}`);
  console.log("\n(Survivorship-free sample: ALL resolved binary markets, not wallet positions. Gross of");
  console.log(" price-impact beyond the 1c haircut; daily closes, so intraday entries may differ.)");
}

function selfCheck(): void {
  assert.ok(isDeadlineMarket("Will Iran sign a peace deal by June 30?"));
  assert.ok(isDeadlineMarket("Bitcoin above $150k before 2027?"));
  assert.ok(isDeadlineMarket("Trump out by end of 2026?"));
  assert.ok(!isDeadlineMarket("Lakers vs Celtics: Lakers win?"));
  assert.ok(!isDeadlineMarket("Fed December meeting: cut?"));
  assert.ok(!isDeadlineMarket("Fed decreases interest rates by 50+ bps after January 2026 meeting?")); // amount, not deadline
  assert.ok(!isDeadlineMarket("Will X win by 10 points in November?")); // amount, not deadline
  assert.equal(dateLadderKey("Iran deal by June 30?"), dateLadderKey("Iran deal by May 15?"));
  assert.notEqual(dateLadderKey("Gold hit $5,000 by end of January?"), dateLadderKey("Gold hit $7,000 by end of June?"));
  assert.notEqual(dateLadderKey("Crude hit (LOW) $85 by end of March?"), dateLadderKey("Crude hit (LOW) $60 by end of June?")); // 2-digit strikes stay distinct
  assert.notEqual(dateLadderKey("BTC $100k by June?"), dateLadderKey("BTC $150k by June?"));
  const anchor = Date.UTC(2026, 1, 1); // market created Feb 1, 2026
  assert.equal(titleDeadlineMs("Trump visits China by June 30?", anchor), Date.UTC(2026, 5, 30));
  assert.equal(titleDeadlineMs("Deal by April 22, 2026?", Date.UTC(2027, 0, 1)), Date.UTC(2026, 3, 22)); // explicit year beats anchor
  assert.equal(titleDeadlineMs("Shutdown ends by January 31?", Date.UTC(2025, 10, 1)), Date.UTC(2026, 0, 31)); // created Nov 2025 → NEXT Jan
  assert.equal(titleDeadlineMs("Gold $5000 by end of January?", Date.UTC(2026, 0, 5)), Date.UTC(2026, 0, 31));
  assert.equal(titleDeadlineMs("Will Zelenskyy wear a suit before July?", anchor), Date.UTC(2026, 6, 1));
  assert.equal(titleDeadlineMs("BTC $150k by 2027?", anchor), Date.UTC(2027, 0, 1));
  assert.equal(titleDeadlineMs("Lakers win the title?", anchor), null);
  assert.equal(titleDeadlineMs("Text released by June 16?", yearAnchorMs(Date.UTC(2026, 4, 1), Date.UTC(2026, 5, 20))), Date.UTC(2026, 5, 16)); // 4d UMA lag — same year
  assert.equal(titleDeadlineMs("Airdrop by December 31?", yearAnchorMs(Date.UTC(2025, 9, 1), Date.UTC(2026, 0, 15))), Date.UTC(2025, 11, 31)); // dust prints into January — still 2025
  assert.equal(titleDeadlineMs("Airdrop by June 30?", yearAnchorMs(Date.UTC(2025, 7, 1), Date.UTC(2026, 5, 30))), Date.UTC(2026, 5, 30)); // created Aug 2025 for NEXT June
  assert.ok(isSurvivalShaped("Will the US not strike Iran by February 28?"));
  assert.ok(!isSurvivalShaped("US forces enter Iran by April 30?"));
  assert.ok(Math.abs(noPnlPerDollar(0.4, false, 0.01) - (1 / 0.61 - 1)) < 1e-9);
  assert.equal(noPnlPerDollar(0.4, true, 0.01), -1);
  const pts: PricePoint[] = [{ ts: "2026-01-01", price: 0.5 }, { ts: "2026-01-03", price: 0.4 }];
  assert.equal(priceAt(pts, Date.parse("2026-01-04")), 0.4); // last at-or-before
  assert.equal(priceAt(pts, Date.parse("2025-12-20")), null); // nothing in window
  const s = stats(clusterMean([{ key: "a", v: 1 }, { key: "a", v: -1 }, { key: "b", v: 2 }]));
  assert.equal(s.n, 2); // two families
}

main().catch((e) => { console.error(e); process.exit(1); });
