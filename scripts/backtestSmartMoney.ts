// Does the skill-weighted "smart money" implied price (web/lib/trendingMarkets.ts's
// smartMoneyImpliedPrice, same skill*sqrt(cost) weighting, ported here since scripts/ and web/ don't
// share code) actually predict resolved-market outcomes better than a naive baseline? Read-only,
// no writes, no schema changes — just a report to stdout.
//
// Run from the repo root:  pnpm --filter edgeboard-scripts exec tsx backtestSmartMoney.ts
//
// v1 (aggregate Brier score + conviction buckets) found high-conviction predictions 98% accurate —
// but that's confounded: a position entered the day before resolution on an already-obvious outcome
// isn't insight, it's just riding a market that already converged. v2 added a lead-time breakdown to
// separate "saw it early" from "piled on late" (it held up — accuracy didn't erode with more lead
// time). Neither v1 nor v2 answers the actual bankroll question though, since both compare smart
// money's price only to the FINAL outcome, never to what the market was showing at the same moment.
//
// v3 does that: pulls market_price_history (daily, keyed by outcome TOKEN not YES/NO side — closed
// positions don't retain which token they held, so there's no direct join) and disambiguates which
// token is YES using the market's *already-known* actual outcome as ground truth — whichever token's
// price ended near 1 represents the outcome that happened; cross-referencing that against the
// independently-derived winner (from the closed-positions voting, not from price data) tells us
// which token is index 0 (YES) without needing any external token-id mapping. Then: look up the
// price nearest smart money's weighted entry date, compare, and simulate "buy the side smart money
// diverges from the market on, at the market's price" across all qualifying markets.
//
// v4: persists every matched result to backtestSmartMoneyHistory.json (committed) instead of only
// ever looking at whatever's live in wallet_closed_positions right now. That table is wiped and
// rebuilt on every full ingest, scoped to the *current* leaderboard, and Polymarket's
// /closed-positions fetch only covers roughly the trailing 90 days per wallet — it's a rolling
// window, not a growing archive, so a market that resolved months ago quietly disappears once its
// positioned wallets roll off the board. Snapshotting each run's computed results (fixed historical
// facts once computed — a resolved market's outcome and matched price never change) is what actually
// makes the sample grow across repeated runs instead of just shifting.
//
// v5: the v3 cache-only match only covered 17 of 298 qualifying markets — market_price_history only
// has data for tokens a leaderboard wallet held or that were in the top-liquidity listed set, not a
// full archive. For markets the cache missed, fetch the real thing directly: Gamma resolves
// condition_id -> the actual YES token id (no more inferring it from settled prices), then CLOB
// prices-history gets its real daily series. This fills in genuine missing data — same match
// tolerance, same everything else — not a relaxation of the locked methodology, so no version bump.
//
// v6: EXPERIMENTAL, not part of the locked v1 formula. Computes a second, separate "specialty-
// weighted" smart-money price alongside the locked one — same skill*sqrt(cost) base, but doubled
// when the wallet's own proven specialty (wallets.specialty, from scripts/specialty.ts) matches the
// market's category (via the same classifyMarket() keyword classifier specialty itself is computed
// with, applied to the market's question — not markets.category, which is Gamma's raw tag and much
// noisier than the classifier). Reported side by side with locked-v1 on the exact same markets for a
// direct comparison. The locked smartPct/livePriceAtEntry/actual/gap fields are never touched by
// this — if the experimental version doesn't measurably beat v1, nothing about the live feature
// needs to change. RESULT: no measurable improvement (Brier 0.1177 -> 0.1175, noise-level) — kept
// for the record, not shipped.
//
// v7: EXPERIMENTAL, isolated from v6 (one change at a time, so any effect is attributable). Tests
// "conviction relative to the wallet's own norm" — a wallet that usually stakes $50 suddenly staking
// $500 is a stronger signal than the same $500 from someone who always bets that big, since it's an
// outlier *for them specifically*, not just a big number in isolation. confidenceMultiplier =
// max(1, sqrt(thisBetCost / theirAvgDustFlooredCost)) — floored at 1 so a below-average bet is never
// penalized, only above-average conviction is rewarded, and sqrt-dampened for the same reason the
// base formula dampens raw cost (one outlier bet shouldn't run away with the number). Their average
// is computed from their own dust-floored closed positions across the whole dataset, not just this
// market.
//
// v8: EXPERIMENTAL, isolated from v6/v7. The locked v1 formula weights every non-dust position the
// same regardless of whether the wallet held it to resolution or sold out early — it only uses
// held-vs-sold to figure out what actually happened (the outcome vote), never to decide who should
// count toward the signal. That means a wallet who bought in, then changed their mind and exited,
// still has their original (abandoned) belief counted at full weight. v8 restricts the weighted
// average to positions the wallet actually held to a confirmed resolution (same >=97%/<=3% exitValue
// test the outcome vote already uses) — the closed-position analogue of what the live panel already
// does implicitly, since wallet_positions only ever contains currently-open positions. The 5-
// participant qualifying gate is left untouched (same 225-market population as v1/v6/v7, for a fair
// comparison) — only which positions feed the weighted average changes. RESULT: the largest effect of
// any experiment (Brier 0.1055 -> 0.0705, n=201; win rate up 12-21pts across every gap bucket).
//
// v9: EXPERIMENTAL, isolated from v6/v7/v8. Traced through web/lib/trendingMarkets.ts +
// web/lib/supabase.ts's getTrendingMarkets() and confirmed wallet_positions is wiped and rebuilt every
// feed cycle from PolymarketClient.getCurrentPositions() — a direct call to Polymarket's live
// /positions endpoint, which returns current balances only (a fully-exited position simply isn't
// returned; a partial sell reduces the reported size directly). So the live feature ALREADY
// structurally excludes abandoned positions — v8's idea isn't something trendingMarkets.ts needs to be
// taught, it's an emergent property of reading current-holdings data. But v8's filter ("held all the
// way to *confirmed resolution*") requires retrospective knowledge a live system can never have —
// whether a wallet will sell at some point between now and resolution. It's a best-case upper bound,
// not a simulation of what a continuously-updating panel could show a visitor on any given day before
// resolution. v9 answers the real question: strip out that retrospective advantage — was the position
// genuinely still open as of a live-plausible reference point (resolutionMs - 7 days, using close_time
// vs. that reference rather than the final outcome) — and see whether the effect survives, and how
// large it really is. That's the number worth trusting before deciding whether any production code
// needs to change at all.
//
// v10: EXPERIMENTAL, isolated from v6/v7/v8/v9. Two independent changes, reported separately so
// neither masks the other:
//   (a) equal weighting — every positioned wallet counts the same (weight 1), no skill lookup at all,
//       with a flat 2x bump when THIS bet is unusually large for that specific wallet (cost exceeds
//       their own dust-floored average, same "vs their own norm" definition v7 already established,
//       just applied as a binary bump to an equal base instead of scaling the skill-weighted base).
//       Tests whether skill-weighting is earning its complexity versus "just listen to the room,
//       weighted toward whoever's betting bigger than they usually do." Reported head-to-head against
//       locked v1 on the SAME 5-participant population first — single-variable comparison, same
//       discipline as v6-v9.
//   (b) loosening the qualifying-market gate from the locked MIN_PARTICIPANTS (5) to
//       MIN_PARTICIPANTS_LOOSE (3) — a different population than v1/v6-v9's every-market-locked-at-5
//       comparisons, so it's reported as its own separate section (locked-v1 vs equal-weight, BOTH
//       recomputed on the 3+ population) rather than blended into the persisted 5+ history numbers.
//       The main per-condition loop now walks every market with >=3 participants (a strict superset of
//       the old >=5 walk) so 3-4-participant markets get discovered and their point-in-time price
//       matched/persisted too — MIN_PARTICIPANTS itself (5) is untouched and still gates the primary
//       locked-v1 report, so v1/v6-v9's numbers are unaffected by this widening.
// RESULT: both changes are negative, independently and combined. (a) equal-weight Brier 0.1331 vs.
// locked v1's 0.1129 on the identical 5+ population, n=217 (worse on every gap-size win-rate bucket
// too: ~47-53% vs. v1's ~51-63%) — skill-weighting is earning its complexity, not just adding noise.
// (b) loosening to 3+ participants makes locked v1 itself worse too (Brier 0.1129 -> 0.1250, n=234 ->
// 428) — a 3-4-participant market is a noisier signal, not just a bigger sample; equal-weighting on
// that widened population is worse still (0.1343). Not shipped.
//
// v11: EXPERIMENTAL, isolated from v6-v10 (population filter, not a weighting change). Restricts to
// unanimous markets — every non-dust position in the market (across every positioned wallet) is on the
// SAME outcome_index, i.e. no leaderboard money at all took the other side. A market with even one
// dissenting position (including a wallet's own hedge/arb leg — wallet_closed_positions keeps both legs
// unfiltered, see the v8 note) fails unanimity. Reported for both the locked 5+ and loosened 3+
// populations (v10b), using both the locked-v1 and equal-weighted (v10a) formulas on the unanimous-only
// subset — since with everyone agreeing, weighting mostly collapses to "how big was the total bet,"
// this mainly tests whether *filtering out disagreement entirely* beats weighting through it.
// RESULT: negative at both floors. Locked v1 Brier 0.1129 (n=234) -> 0.1456 unanimous-only (n=12) at
// 5+; 0.1247 (n=429) -> 0.1678 unanimous-only (n=57) at 3+. The n=12 slice is too small to trust on its
// own (win-rate swings 33%-100% across gap buckets, classic small-n noise), but the larger n=57 slice
// points the same direction, so this doesn't look like it flips with more data. Plausible reason:
// unanimity discards markets where 4 skilled wallets agreed and 1 mediocre one didn't — exactly what
// skill-weighting already handles correctly without throwing the data away. Not shipped.
import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PolymarketClient } from "./polymarket.js";
import { dailyPointsFromHistory } from "./priceHistory.js";
import { classifyMarket } from "./specialty.js";

loadEnv({ path: "../.env.local" });
loadEnv();

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

const supabase = createClient(requiredEnv("NEXT_PUBLIC_SUPABASE_URL"), requiredEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"));

// ── Locked methodology ───────────────────────────────────────────────────────────────────────────
// Frozen 2026-07-01, after v3 first ran successfully (17 matched markets). DO NOT edit these values
// in place as more data comes in — that's exactly the overfitting risk this is guarding against
// (quietly tuning thresholds until the backtest you're running says what you want it to say). If the
// methodology genuinely needs to change, bump METHODOLOGY_VERSION and treat results under the new
// version as a fresh, separate track record — never silently blend them with what came before.
const METHODOLOGY_VERSION = "v1-2026-07-01";
const DUST_FLOOR_USD = 10; // same as web/lib/trendingMarkets.ts — evaluate the population the live feature actually shows
const MIN_PARTICIPANTS = 5; // same as web/lib/trendingMarkets.ts
const RESOLVE_EPSILON = 0.03; // same as web/lib/resolvedMarkets.ts
const PRICE_MATCH_TOLERANCE_DAYS = 10; // max distance from smart money's entry date to an available price point
const GAP_THRESHOLDS = [0, 0.05, 0.1, 0.2]; // profit-simulation buckets, probability points
const LEAD_TIME_THRESHOLDS_DAYS = [0, 3, 7, 14, 30]; // conviction-vs-lead-time buckets

// EXPERIMENTAL (v6) — not part of the locked v1 formula, see the header note. A round, simple
// starting multiplier; if this line of work continues, tune it against the backtest, not by feel.
const SPECIALTY_BOOST = 2;

// EXPERIMENTAL (v9) — not part of the locked v1 formula, see the header note. How far before
// resolution to check "was this position genuinely still open" — a live-plausible lead time, not the
// retrospective-only "held all the way to the very end" v8 uses.
const OPEN_AS_OF_LEAD_DAYS = 7;

// EXPERIMENTAL (v10a) — not part of the locked v1 formula, see the header note. Flat bump applied to
// an equal (1-per-wallet) base when a bet is unusually large FOR THAT WALLET specifically.
const EQUAL_WEIGHT_BOOST = 2;

// EXPERIMENTAL (v10b) — not part of the locked v1 formula, see the header note. Loosened qualifying-
// market gate; MIN_PARTICIPANTS (5) stays the locked value used for the primary report.
const MIN_PARTICIPANTS_LOOSE = 3;

// Persisted, ever-growing record of matched results — see the v4 note at the top of the file for why
// this exists (wallet_closed_positions is a rolling window, not an archive).
const HISTORY_FILE = join(dirname(fileURLToPath(import.meta.url)), "backtestSmartMoneyHistory.json");

interface HistoryEntry {
  conditionId: string;
  smartPct: number;
  livePriceAtEntry: number;
  actual: number;
  gap: number;
  daysEarly: number | null;
  recordedAt: string; // when this run first captured it
  methodologyVersion: string;
  smartPctSpecialty?: number; // EXPERIMENTAL (v6) — not locked, may be absent on older entries
  smartPctConfidence?: number; // EXPERIMENTAL (v7) — not locked, may be absent on older entries
  smartPctHeld?: number; // EXPERIMENTAL (v8) — not locked, may be absent on older entries
  smartPctOpenAsOf?: number; // EXPERIMENTAL (v9) — not locked, may be absent on older entries
  smartPctEqual?: number; // EXPERIMENTAL (v10a) — not locked, may be absent on older entries
  participantCount?: number; // EXPERIMENTAL (v10b) — not locked, may be absent on older entries
  isUnanimous?: boolean; // EXPERIMENTAL (v11) — not locked, may be absent on older entries
}

function loadHistory(): Map<string, HistoryEntry> {
  if (!existsSync(HISTORY_FILE)) return new Map();
  const entries = JSON.parse(readFileSync(HISTORY_FILE, "utf8")) as HistoryEntry[];
  return new Map(entries.map((e) => [e.conditionId, e]));
}

function saveHistory(history: Map<string, HistoryEntry>): void {
  const entries = [...history.values()].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
  writeFileSync(HISTORY_FILE, JSON.stringify(entries, null, 2) + "\n");
}

interface ClosedRow {
  address: string;
  condition_id: string | null;
  outcome_index: number | null;
  avg_price: number | null;
  realized_pnl: number | null;
  size: number | null;
  first_traded_at: string | null;
  close_time: string | null;
  market: string | null; // EXPERIMENTAL (v6) — market question, for classifyMarket()
}

async function fetchAllClosedPositions(): Promise<ClosedRow[]> {
  const rows: ClosedRow[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("wallet_closed_positions")
      .select("address, condition_id, outcome_index, avg_price, realized_pnl, size, first_traded_at, close_time, market")
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

// EXPERIMENTAL (v6) — wallets.specialty, the category scripts/specialty.ts's walletSpecialty already
// determined each wallet has a proven edge in (or null if none).
async function fetchSpecialtyByAddress(): Promise<Map<string, string>> {
  const { data, error } = await supabase.from("wallets").select("address, specialty");
  if (error) throw error;
  const specialty = new Map<string, string>();
  for (const row of (data ?? []) as { address: string; specialty: string | null }[]) {
    if (row.specialty) specialty.set(row.address, row.specialty);
  }
  return specialty;
}

// exitValue ~1 -> held to a winning resolution, ~0 -> held to a loss. Mid-range -> sold early
// (not a resolution confirmation), same logic as web/lib/resolvedMarkets.ts.
function exitValue(row: ClosedRow): number | null {
  if (row.size === null || row.size <= 0 || row.realized_pnl === null || row.avg_price === null) return null;
  return row.avg_price + row.realized_pnl / row.size;
}

// EXPERIMENTAL (v8): did this specific position get held all the way to a confirmed resolution,
// rather than sold early? Same >=97%/<=3% test the outcome vote already uses.
function isHeldToResolution(row: ClosedRow): boolean {
  const ev = exitValue(row);
  return ev !== null && (ev >= 1 - RESOLVE_EPSILON || ev <= RESOLVE_EPSILON);
}

// EXPERIMENTAL (v9): was this position genuinely still open as of `referenceMs` — already entered,
// not yet closed — rather than "did it ultimately survive to the very end" (v8). No point-in-time
// size reconstruction (the data doesn't support it, same approximation level as v8): close_time is
// used as the "still held" proxy.
function isOpenAsOf(row: ClosedRow, referenceMs: number): boolean {
  const entryMs = row.first_traded_at ? Date.parse(row.first_traded_at) : NaN;
  const closeMs = row.close_time ? Date.parse(row.close_time) : NaN;
  return Number.isFinite(entryMs) && Number.isFinite(closeMs) && entryMs <= referenceMs && closeMs > referenceMs;
}

function cost(row: ClosedRow): number {
  return (row.size ?? 0) * (row.avg_price ?? 0);
}

function yesEquivalentEntry(row: ClosedRow): number {
  return row.outcome_index === 1 ? 1 - (row.avg_price ?? 0) : row.avg_price ?? 0;
}

interface PriceRow {
  asset: string;
  condition_id: string | null;
  ts: string; // UTC calendar day
  price: number;
}

// market_price_history has no index on condition_id (only (asset, ts)), so a .in("condition_id", ...)
// filter forces a full-table scan per chunk and hits Supabase's statement timeout on a table this size
// (342k+ rows). Sequential unfiltered paging (PK-ordered, cheap) + client-side filtering avoids that —
// one full read instead of many expensive filtered ones.
async function fetchPriceHistory(conditionIds: string[]): Promise<PriceRow[]> {
  const wanted = new Set(conditionIds);
  const rows: PriceRow[] = [];
  const PAGE = 1000;
  let pages = 0;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("market_price_history")
      .select("asset, condition_id, ts, price")
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const batch = (data ?? []) as PriceRow[];
    for (const row of batch) {
      if (row.condition_id && wanted.has(row.condition_id)) rows.push(row);
    }
    pages += 1;
    if (pages % 50 === 0) console.log(`  ...scanned ${pages * PAGE} price rows`);
    if (batch.length < PAGE) break;
  }
  return rows;
}

// market_price_history is keyed by outcome TOKEN, not YES/NO side, and there's no token<->outcome_index
// mapping available for closed positions. Disambiguate using the market's already-known actual outcome
// (from the closed-positions vote, a separate source): whichever token's price ended near 1 represents
// whatever *actually happened* — cross-referencing that against `actual` tells us if that token is
// outcome_index 0 (YES) or 1 (NO), non-circularly. Tokens whose final price never settled near 0 or 1
// (thin/stale caching) are dropped rather than guessed at.
function buildYesPriceSeries(priceRows: PriceRow[], actual: number): Map<string, number> | null {
  const byAsset = new Map<string, PriceRow[]>();
  for (const row of priceRows) {
    const group = byAsset.get(row.asset);
    if (group) group.push(row);
    else byAsset.set(row.asset, [row]);
  }

  // day -> [sum of yes-equivalent prices, count] across however many usable tokens exist that day
  const sums = new Map<string, [number, number]>();
  for (const assetRows of byAsset.values()) {
    const sorted = [...assetRows].sort((a, b) => a.ts.localeCompare(b.ts));
    const finalPrice = sorted[sorted.length - 1]?.price;
    if (finalPrice === undefined) continue;
    const tokenWon = finalPrice >= 0.97;
    const tokenLost = finalPrice <= 0.03;
    if (!tokenWon && !tokenLost) continue; // never settled — can't tell which side this token was
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

// Nearest available day within `toleranceDays` — daily cache rows aren't guaranteed for every single
// day (gaps happen), so exact-day lookups would drop too many otherwise-usable markets.
function nearestPrice(series: Map<string, number>, targetMs: number, toleranceDays = PRICE_MATCH_TOLERANCE_DAYS): number | null {
  let best: { price: number; diffDays: number } | null = null;
  for (const [day, price] of series) {
    const diffDays = Math.abs(Date.parse(day) - targetMs) / 86_400_000;
    if (diffDays <= toleranceDays && (best === null || diffDays < best.diffDays)) {
      best = { price, diffDays };
    }
  }
  return best?.price ?? null;
}

async function main(): Promise<void> {
  console.log("Fetching closed positions + leaderboard skill scores...");
  const [allClosed, skillByAddress, specialtyByAddress] = await Promise.all([
    fetchAllClosedPositions(),
    fetchSkillByAddress(),
    fetchSpecialtyByAddress()
  ]);
  console.log(`${allClosed.length} closed-position rows, ${skillByAddress.size} leaderboard wallets, ${specialtyByAddress.size} with a specialty\n`);

  // EXPERIMENTAL (v7): each wallet's own average dust-floored bet size, across their whole recorded
  // history — the baseline "this bet is bigger than usual FOR THEM" is measured against. Dust-floored
  // so a pile of $2 noise trades doesn't drag the average down and make every real bet look outsized.
  const costSumByAddress = new Map<string, number>();
  const costCountByAddress = new Map<string, number>();
  for (const row of allClosed) {
    const c = cost(row);
    if (c < DUST_FLOOR_USD) continue;
    costSumByAddress.set(row.address, (costSumByAddress.get(row.address) ?? 0) + c);
    costCountByAddress.set(row.address, (costCountByAddress.get(row.address) ?? 0) + 1);
  }
  const avgCostByAddress = new Map<string, number>();
  for (const [address, sum] of costSumByAddress) {
    avgCostByAddress.set(address, sum / costCountByAddress.get(address)!);
  }

  const byCondition = new Map<string, ClosedRow[]>();
  for (const row of allClosed) {
    if (!row.condition_id) continue;
    const group = byCondition.get(row.condition_id);
    if (group) group.push(row);
    else byCondition.set(row.condition_id, [row]);
  }

  interface Sample {
    conditionId: string;
    smartPct: number;
    dollarPct: number;
    smartPctSpecialty: number; // EXPERIMENTAL (v6) — equals smartPct when no positioned wallet has a specialty match
    smartPctConfidence: number; // EXPERIMENTAL (v7) — equals smartPct when no bet exceeds its wallet's own average
    smartPctHeld: number; // EXPERIMENTAL (v8) — only positions held to confirmed resolution, excludes early sells
    smartPctOpenAsOf: number; // EXPERIMENTAL (v9) — only positions still open OPEN_AS_OF_LEAD_DAYS before resolution
    smartPctEqual: number; // EXPERIMENTAL (v10a) — equal weight per wallet, 2x bump on an unusually-large-for-them bet
    participantCount: number; // EXPERIMENTAL (v10b) — distinct positioned wallets; markets can be as few as MIN_PARTICIPANTS_LOOSE now
    isUnanimous: boolean; // EXPERIMENTAL (v11) — every non-dust position in the market is on the same outcome_index
    actual: number; // 1 = YES won, 0 = NO won
    daysEarly: number | null; // resolution date minus smart money's weighted entry date
    refEntryMs: number | null; // smart money's weighted entry date, as epoch ms (for the price-history lookup)
  }
  const samples: Sample[] = [];

  for (const [conditionId, rows] of byCondition.entries()) {
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

    // Locked-v1 population is 5+ distinct wallets, each with a non-dust position — but the loop now
    // walks down to MIN_PARTICIPANTS_LOOSE (v10b) so 3-4-participant markets get discovered and
    // matched too; every downstream "locked v1" report still filters back up to MIN_PARTICIPANTS.
    const positioned = rows.filter((r) => cost(r) >= DUST_FLOOR_USD);
    const distinctWallets = new Set(positioned.map((r) => r.address));
    if (distinctWallets.size < MIN_PARTICIPANTS_LOOSE) continue;

    // EXPERIMENTAL (v11): every non-dust position (across every wallet) on the same outcome_index —
    // no leaderboard money at all took the other side.
    const isUnanimous = new Set(positioned.map((r) => r.outcome_index)).size === 1;

    // EXPERIMENTAL (v6): classify the market once via the same keyword classifier wallets.specialty
    // was itself computed with (not markets.category, which is Gamma's raw tag and much noisier).
    const marketTitle = rows.find((r) => r.market)?.market ?? null;
    const marketCategory = marketTitle ? classifyMarket(marketTitle) : null;

    // EXPERIMENTAL (v9): reference point for "was this position still open" — a live-plausible lead
    // time before resolution, not the retrospective-only "held to the very end" v8 uses.
    const openAsOfReferenceMs = Number.isFinite(resolutionMs) ? resolutionMs - OPEN_AS_OF_LEAD_DAYS * 86_400_000 : NaN;

    let smartWeight = 0;
    let smartWeighted = 0;
    let dollarWeight = 0;
    let dollarWeighted = 0;
    let specialtyWeight = 0;
    let specialtyWeighted = 0;
    let confidenceWeight = 0;
    let confidenceWeighted = 0;
    let heldWeight = 0;
    let heldWeighted = 0;
    let openAsOfWeight = 0;
    let openAsOfWeighted = 0;
    let equalWeight = 0;
    let equalWeighted = 0;
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
      const isSpecialtyMatch = marketCategory !== null && specialtyByAddress.get(row.address) === marketCategory;
      const wSpecialty = isSpecialtyMatch ? w * SPECIALTY_BOOST : w;
      specialtyWeight += wSpecialty;
      specialtyWeighted += wSpecialty * yesEq;
      // EXPERIMENTAL (v7): floored at 1 (below-average bets aren't penalized), sqrt-dampened (one
      // outlier bet shouldn't run away with it) — see the header note.
      const theirAvg = avgCostByAddress.get(row.address);
      const confidenceMultiplier = theirAvg && theirAvg > 0 ? Math.max(1, Math.sqrt(c / theirAvg)) : 1;
      const wConfidence = w * confidenceMultiplier;
      confidenceWeight += wConfidence;
      confidenceWeighted += wConfidence * yesEq;
      // EXPERIMENTAL (v8): only positions actually held to a confirmed resolution count — a wallet
      // who bought in and later sold out doesn't get their (possibly-abandoned) entry counted.
      if (isHeldToResolution(row)) {
        heldWeight += w;
        heldWeighted += w * yesEq;
      }
      // EXPERIMENTAL (v9): only positions genuinely still open at the reference lead time count.
      if (Number.isFinite(openAsOfReferenceMs) && isOpenAsOf(row, openAsOfReferenceMs)) {
        openAsOfWeight += w;
        openAsOfWeighted += w * yesEq;
      }
      // EXPERIMENTAL (v10a): no skill lookup — every wallet is worth 1, bumped to
      // EQUAL_WEIGHT_BOOST only when this bet is bigger than that wallet's own dust-floored average.
      const wEqual = theirAvg && theirAvg > 0 && c > theirAvg ? EQUAL_WEIGHT_BOOST : 1;
      equalWeight += wEqual;
      equalWeighted += wEqual * yesEq;
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
    let refEntryMs: number | null = null;
    if (dateWeight > 0 && Number.isFinite(resolutionMs)) {
      refEntryMs = dateWeighted / dateWeight;
      daysEarly = (resolutionMs - refEntryMs) / 86_400_000;
    }

    samples.push({
      conditionId,
      smartPct: smartWeighted / smartWeight,
      dollarPct: dollarWeighted / dollarWeight,
      smartPctSpecialty: specialtyWeight > 0 ? specialtyWeighted / specialtyWeight : smartWeighted / smartWeight,
      smartPctConfidence: confidenceWeight > 0 ? confidenceWeighted / confidenceWeight : smartWeighted / smartWeight,
      smartPctHeld: heldWeight > 0 ? heldWeighted / heldWeight : smartWeighted / smartWeight,
      smartPctOpenAsOf: openAsOfWeight > 0 ? openAsOfWeighted / openAsOfWeight : smartWeighted / smartWeight,
      smartPctEqual: equalWeight > 0 ? equalWeighted / equalWeight : smartWeighted / smartWeight,
      participantCount: distinctWallets.size,
      isUnanimous,
      actual,
      daysEarly,
      refEntryMs
    });
  }

  console.log(
    `${samples.length} resolved markets clear the ${MIN_PARTICIPANTS_LOOSE}-participant / $10 floor (${samples.filter((s) => s.participantCount >= MIN_PARTICIPANTS).length} of those also clear the locked ${MIN_PARTICIPANTS}-participant floor)\n`
  );
  if (samples.length === 0) {
    console.log("Nothing to score.");
    return;
  }

  const brier = (pred: number, actual: number): number => (pred - actual) ** 2;
  const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
  const accuracy = (preds: number[], actuals: number[]): number =>
    mean(preds.map((p, i) => (p > 0.5 === actuals[i]! > 0.5 ? 1 : 0)));

  // Locked-v1 population only (>=5 participants) for every report below up through the gap-simulation
  // section, so these numbers stay directly comparable to v1/v6-v9's historical results — the loosened
  // 3+ population (v10b) gets its own separate section further down instead of blending in here.
  const samplesLocked = samples.filter((s) => s.participantCount >= MIN_PARTICIPANTS);

  const smartBrier = mean(samplesLocked.map((s) => brier(s.smartPct, s.actual)));
  const dollarBrier = mean(samplesLocked.map((s) => brier(s.dollarPct, s.actual)));
  const naiveBrier = mean(samplesLocked.map((s) => brier(0.5, s.actual)));

  console.log("Mean Brier score (lower is better; 0.25 = coin flip, 0 = perfect):");
  console.log(`  smart money (skill*sqrt(cost) weighted): ${smartBrier.toFixed(4)}`);
  console.log(`  dollar-weighted only (no skill):          ${dollarBrier.toFixed(4)}`);
  console.log(`  naive 50/50 baseline:                     ${naiveBrier.toFixed(4)}`);
  console.log();
  console.log("Directional accuracy (predicted majority side matched the actual winner):");
  console.log(`  smart money:  ${(accuracy(samplesLocked.map((s) => s.smartPct), samplesLocked.map((s) => s.actual)) * 100).toFixed(1)}%`);
  console.log(`  dollar-only:  ${(accuracy(samplesLocked.map((s) => s.dollarPct), samplesLocked.map((s) => s.actual)) * 100).toFixed(1)}%`);

  // Bucket by conviction (distance from 50/50) as a proxy for "how big a signal is this" — the
  // question that actually matters: does a stronger signal predict better, or is it noise?
  console.log("\nBy conviction (|smart money % - 50%|):");
  const buckets: [string, (s: Sample) => boolean][] = [
    ["  low  (<10pt)", (s) => Math.abs(s.smartPct - 0.5) < 0.1],
    ["  med  (10-25pt)", (s) => Math.abs(s.smartPct - 0.5) >= 0.1 && Math.abs(s.smartPct - 0.5) < 0.25],
    ["  high (>=25pt)", (s) => Math.abs(s.smartPct - 0.5) >= 0.25]
  ];
  for (const [label, filter] of buckets) {
    const bucket = samplesLocked.filter(filter);
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
  const highConviction = samplesLocked.filter((s) => Math.abs(s.smartPct - 0.5) >= 0.25 && s.daysEarly !== null);
  for (const minDays of LEAD_TIME_THRESHOLDS_DAYS) {
    const bucket = highConviction.filter((s) => s.daysEarly! >= minDays);
    if (bucket.length === 0) {
      console.log(`  >=${minDays}d early: n=0`);
      continue;
    }
    const b = mean(bucket.map((s) => brier(s.smartPct, s.actual)));
    const a = accuracy(bucket.map((s) => s.smartPct), bucket.map((s) => s.actual));
    console.log(`  >=${minDays}d early: n=${bucket.length}, brier=${b.toFixed(4)}, accuracy=${(a * 100).toFixed(1)}%`);
  }

  // ── v3: the actual bankroll question — compare smart money's price to the LIVE market price at
  // the same point in time, not to the final outcome. ──────────────────────────────────────────
  console.log("\nFetching market_price_history for the point-in-time comparison...");
  const conditionIds = [...new Set(samples.map((s) => s.conditionId))];
  const priceRows = await fetchPriceHistory(conditionIds);
  console.log(`${priceRows.length} price rows across ${conditionIds.length} markets`);

  const priceRowsByCondition = new Map<string, PriceRow[]>();
  for (const row of priceRows) {
    if (!row.condition_id) continue;
    const group = priceRowsByCondition.get(row.condition_id);
    if (group) group.push(row);
    else priceRowsByCondition.set(row.condition_id, [row]);
  }

  interface MatchedSample extends Sample {
    livePriceAtEntry: number;
    gap: number; // smartPct - livePriceAtEntry
  }
  const matched: MatchedSample[] = [];
  for (const s of samples) {
    if (s.refEntryMs === null) continue;
    const rows = priceRowsByCondition.get(s.conditionId);
    if (!rows) continue;
    const series = buildYesPriceSeries(rows, s.actual);
    if (!series) continue;
    const livePriceAtEntry = nearestPrice(series, s.refEntryMs);
    if (livePriceAtEntry === null) continue;
    matched.push({ ...s, livePriceAtEntry, gap: s.smartPct - livePriceAtEntry });
  }
  console.log(`${matched.length} markets matched from the market_price_history cache this run`);

  // Load history now (not later) so the live-fetch pass below can skip anything already captured in
  // a previous run — otherwise every run would re-hit Gamma+CLOB for the same never-going-to-match
  // markets forever.
  const history = loadHistory();
  const matchedIds = new Set(matched.map((s) => s.conditionId));
  const client = new PolymarketClient();
  const liveFetched: MatchedSample[] = [];
  const toFetch = samples.filter((s) => s.refEntryMs !== null && !matchedIds.has(s.conditionId) && !history.has(s.conditionId));
  if (toFetch.length > 0) {
    console.log(`Fetching real price history from Gamma+CLOB for ${toFetch.length} markets the cache missed...`);
    let done = 0;
    for (const s of toFetch) {
      done += 1;
      if (done % 25 === 0) console.log(`  ...${done}/${toFetch.length}`);
      const yesTokenId = await client.getYesTokenId(s.conditionId);
      if (!yesTokenId) continue;
      const raw = await client.getPriceHistory(yesTokenId);
      if (raw.length === 0) continue;
      // clobTokenIds[0] is the YES token directly (Gamma tells us, not inferred from settled
      // prices), so no orientation step needed — dailyPointsFromHistory's price is already YES-equivalent.
      const points = dailyPointsFromHistory(raw, 3650, Date.now());
      if (points.length === 0) continue;
      const series = new Map(points.map((p) => [p.ts, p.price]));
      const livePriceAtEntry = nearestPrice(series, s.refEntryMs!);
      if (livePriceAtEntry === null) continue;
      liveFetched.push({ ...s, livePriceAtEntry, gap: s.smartPct - livePriceAtEntry });
    }
    console.log(`${liveFetched.length} additional markets matched via live fetch`);
  }

  // Fold into the persisted history — resolved markets already recorded stay as-is (their outcome and
  // matched price are fixed historical facts, LOCKED and never touched), new ones from this run get
  // added. This is what makes the sample actually grow across runs instead of shifting with
  // wallet_closed_positions' rolling window.
  const before = history.size;
  const now = new Date().toISOString();
  for (const s of [...matched, ...liveFetched]) {
    if (history.has(s.conditionId)) continue;
    history.set(s.conditionId, {
      conditionId: s.conditionId,
      smartPct: s.smartPct,
      livePriceAtEntry: s.livePriceAtEntry,
      actual: s.actual,
      gap: s.gap,
      daysEarly: s.daysEarly,
      recordedAt: now,
      methodologyVersion: METHODOLOGY_VERSION,
      smartPctSpecialty: s.smartPctSpecialty,
      smartPctConfidence: s.smartPctConfidence,
      smartPctHeld: s.smartPctHeld,
      smartPctOpenAsOf: s.smartPctOpenAsOf,
      smartPctEqual: s.smartPctEqual,
      participantCount: s.participantCount,
      isUnanimous: s.isUnanimous
    });
  }
  saveHistory(history);
  console.log(`${history.size - before} new markets added to ${HISTORY_FILE} (${history.size} total recorded)`);

  // EXPERIMENTAL (v6/v7/v8/v9/v10) backfill: existing entries never got these fields (they didn't exist
  // yet). None touch any locked field, so it's safe to add retroactively for any entry whose
  // underlying market is still represented in this run's samples (older ones may have aged out of
  // wallet_closed_positions' rolling window and just won't get backfilled — that's fine, they're
  // simply excluded from the experimental comparisons below until/unless re-derivable).
  const samplesByCondition = new Map(samples.map((s) => [s.conditionId, s]));
  let backfilled = 0;
  for (const entry of history.values()) {
    const sample = samplesByCondition.get(entry.conditionId);
    if (!sample) continue;
    let changed = false;
    if (entry.smartPctSpecialty === undefined) {
      entry.smartPctSpecialty = sample.smartPctSpecialty;
      changed = true;
    }
    if (entry.smartPctConfidence === undefined) {
      entry.smartPctConfidence = sample.smartPctConfidence;
      changed = true;
    }
    if (entry.smartPctHeld === undefined) {
      entry.smartPctHeld = sample.smartPctHeld;
      changed = true;
    }
    if (entry.smartPctOpenAsOf === undefined) {
      entry.smartPctOpenAsOf = sample.smartPctOpenAsOf;
      changed = true;
    }
    if (entry.smartPctEqual === undefined) {
      entry.smartPctEqual = sample.smartPctEqual;
      changed = true;
    }
    if (entry.participantCount === undefined) {
      entry.participantCount = sample.participantCount;
      changed = true;
    }
    if (entry.isUnanimous === undefined) {
      entry.isUnanimous = sample.isUnanimous;
      changed = true;
    }
    if (changed) backfilled += 1;
  }
  if (backfilled > 0) {
    saveHistory(history);
    console.log(`${backfilled} existing entries backfilled with experimental fields`);
  }
  console.log();

  const all = [...history.values()];
  if (all.length === 0) {
    console.log("Nothing recorded yet to score for the point-in-time comparison.");
    return;
  }

  // Guard against silently blending results computed under a different locked methodology — if the
  // formula/thresholds above are ever changed, old entries stay in the file (they're still valid
  // history) but must not be averaged in with the new version as if nothing changed.
  const otherVersions = new Set(all.filter((s) => s.methodologyVersion !== METHODOLOGY_VERSION).map((s) => s.methodologyVersion));
  if (otherVersions.size > 0) {
    console.log(
      `\n⚠ ${all.length - all.filter((s) => s.methodologyVersion === METHODOLOGY_VERSION).length} recorded entries use a different methodology version (${[...otherVersions].join(", ")}) than the current one (${METHODOLOGY_VERSION}). Scoring below is CURRENT-VERSION ONLY — mixing would make the numbers meaningless.`
    );
  }
  // Locked-v1 (>=5 participant) subset only, for every report through the v9 section below — the same
  // population v1/v6-v9 have always been scored on. Entries without a recorded participantCount (older
  // than v10b) default to exactly MIN_PARTICIPANTS, since the OLD code that captured them only ever
  // walked the 5+ population in the first place.
  const currentVersionAll = all.filter(
    (s) => s.methodologyVersion === METHODOLOGY_VERSION && (s.participantCount ?? MIN_PARTICIPANTS) >= MIN_PARTICIPANTS
  );
  if (currentVersionAll.length === 0) {
    console.log("No entries recorded under the current methodology version.");
    return;
  }
  // EXPERIMENTAL (v10b): the loosened 3+ population — a strict superset of currentVersionAll, used
  // only by the v10b section at the very end.
  const currentVersionAllLoose = all.filter(
    (s) => s.methodologyVersion === METHODOLOGY_VERSION && (s.participantCount ?? MIN_PARTICIPANTS) >= MIN_PARTICIPANTS_LOOSE
  );

  const smartBrierM = mean(currentVersionAll.map((s) => brier(s.smartPct, s.actual)));
  const liveBrierM = mean(currentVersionAll.map((s) => brier(s.livePriceAtEntry, s.actual)));
  console.log(`Mean Brier score, current-version recorded (smart money vs. the live price at the SAME time), n=${currentVersionAll.length}:`);
  console.log(`  smart money:         ${smartBrierM.toFixed(4)}`);
  console.log(`  live price at entry: ${liveBrierM.toFixed(4)}`);
  console.log(smartBrierM < liveBrierM ? "  -> smart money forecast BETTER than the contemporaneous market." : "  -> the contemporaneous market forecast at least as well as smart money.");

  // The real test: simulate buying the side smart money diverges from the market on, AT the market's
  // price at that time, only when the gap clears a threshold — across increasing thresholds, since
  // the original question was specifically about the BIGGEST divergences.
  console.log("\nSimulated return per $1 staked, buying smart money's tilt at the live price (min gap):");
  for (const minGap of GAP_THRESHOLDS) {
    const trades = currentVersionAll.filter((s) => Math.abs(s.gap) >= minGap);
    if (trades.length === 0) {
      console.log(`  >=${(minGap * 100).toFixed(0)}pt gap: n=0`);
      continue;
    }
    const profits = trades.map((s) => {
      if (s.gap >= 0) return s.actual - s.livePriceAtEntry; // bought YES at livePriceAtEntry
      return s.livePriceAtEntry - s.actual; // bought NO at (1 - livePriceAtEntry), payout (1-actual)
    });
    const avgProfit = mean(profits);
    const winRate = mean(profits.map((p) => (p > 0 ? 1 : 0)));
    console.log(
      `  >=${(minGap * 100).toFixed(0)}pt gap: n=${trades.length}, avg profit/$1=${avgProfit >= 0 ? "+" : ""}${avgProfit.toFixed(3)}, win rate=${(winRate * 100).toFixed(1)}%`
    );
  }

  // ── EXPERIMENTAL (v6): specialty-weighted, compared head-to-head against locked v1 on the exact
  // same entries (not the full history — a fair comparison needs identical samples on both sides). ──
  const withSpecialty = currentVersionAll.filter((s) => s.smartPctSpecialty !== undefined);
  console.log(`\nEXPERIMENTAL: specialty-weighted (${SPECIALTY_BOOST}x boost when market matches wallet's proven category), n=${withSpecialty.length}:`);
  if (withSpecialty.length === 0) {
    console.log("  No entries have smartPctSpecialty yet.");
  } else {
    const v1BrierSub = mean(withSpecialty.map((s) => brier(s.smartPct, s.actual)));
    const specialtyBrier = mean(withSpecialty.map((s) => brier(s.smartPctSpecialty!, s.actual)));
    console.log(`  locked v1 Brier (same ${withSpecialty.length} entries): ${v1BrierSub.toFixed(4)}`);
    console.log(`  specialty-weighted Brier:                    ${specialtyBrier.toFixed(4)}`);
    console.log(
      specialtyBrier < v1BrierSub
        ? "  -> specialty weighting improves on locked v1 on this sample."
        : "  -> specialty weighting does NOT improve on locked v1 on this sample — not worth shipping as-is."
    );

    console.log("\n  Simulated return per $1 staked using the specialty-weighted tilt (min gap):");
    for (const minGap of GAP_THRESHOLDS) {
      const trades = withSpecialty
        .map((s) => ({ ...s, gapSpecialty: s.smartPctSpecialty! - s.livePriceAtEntry }))
        .filter((s) => Math.abs(s.gapSpecialty) >= minGap);
      if (trades.length === 0) {
        console.log(`    >=${(minGap * 100).toFixed(0)}pt gap: n=0`);
        continue;
      }
      const profits = trades.map((s) => (s.gapSpecialty >= 0 ? s.actual - s.livePriceAtEntry : s.livePriceAtEntry - s.actual));
      const avgProfit = mean(profits);
      const winRate = mean(profits.map((p) => (p > 0 ? 1 : 0)));
      console.log(
        `    >=${(minGap * 100).toFixed(0)}pt gap: n=${trades.length}, avg profit/$1=${avgProfit >= 0 ? "+" : ""}${avgProfit.toFixed(3)}, win rate=${(winRate * 100).toFixed(1)}%`
      );
    }
  }

  // ── EXPERIMENTAL (v7): bet-size-relative-to-the-wallet's-own-average weighted, compared head-to-
  // head against locked v1 on the exact same entries — isolated from v6, one change at a time. ──
  const withConfidence = currentVersionAll.filter((s) => s.smartPctConfidence !== undefined);
  console.log(`\nEXPERIMENTAL: bet-size-vs-own-average weighted (sqrt-dampened, floored at 1x), n=${withConfidence.length}:`);
  if (withConfidence.length === 0) {
    console.log("  No entries have smartPctConfidence yet.");
  } else {
    const v1BrierSub = mean(withConfidence.map((s) => brier(s.smartPct, s.actual)));
    const confidenceBrier = mean(withConfidence.map((s) => brier(s.smartPctConfidence!, s.actual)));
    console.log(`  locked v1 Brier (same ${withConfidence.length} entries): ${v1BrierSub.toFixed(4)}`);
    console.log(`  confidence-weighted Brier:                    ${confidenceBrier.toFixed(4)}`);
    console.log(
      confidenceBrier < v1BrierSub
        ? "  -> confidence weighting improves on locked v1 on this sample."
        : "  -> confidence weighting does NOT improve on locked v1 on this sample — not worth shipping as-is."
    );

    console.log("\n  Simulated return per $1 staked using the confidence-weighted tilt (min gap):");
    for (const minGap of GAP_THRESHOLDS) {
      const trades = withConfidence
        .map((s) => ({ ...s, gapConfidence: s.smartPctConfidence! - s.livePriceAtEntry }))
        .filter((s) => Math.abs(s.gapConfidence) >= minGap);
      if (trades.length === 0) {
        console.log(`    >=${(minGap * 100).toFixed(0)}pt gap: n=0`);
        continue;
      }
      const profits = trades.map((s) => (s.gapConfidence >= 0 ? s.actual - s.livePriceAtEntry : s.livePriceAtEntry - s.actual));
      const avgProfit = mean(profits);
      const winRate = mean(profits.map((p) => (p > 0 ? 1 : 0)));
      console.log(
        `    >=${(minGap * 100).toFixed(0)}pt gap: n=${trades.length}, avg profit/$1=${avgProfit >= 0 ? "+" : ""}${avgProfit.toFixed(3)}, win rate=${(winRate * 100).toFixed(1)}%`
      );
    }
  }

  // ── EXPERIMENTAL (v8): held-to-resolution-only weighted (excludes early sells from the weighted
  // average, not just from the outcome vote), compared head-to-head against locked v1. ──
  const withHeld = currentVersionAll.filter((s) => s.smartPctHeld !== undefined);
  console.log(`\nEXPERIMENTAL: held-to-resolution-only weighted (early sells excluded from the average), n=${withHeld.length}:`);
  if (withHeld.length === 0) {
    console.log("  No entries have smartPctHeld yet.");
  } else {
    const v1BrierSub = mean(withHeld.map((s) => brier(s.smartPct, s.actual)));
    const heldBrier = mean(withHeld.map((s) => brier(s.smartPctHeld!, s.actual)));
    console.log(`  locked v1 Brier (same ${withHeld.length} entries): ${v1BrierSub.toFixed(4)}`);
    console.log(`  held-only Brier:                            ${heldBrier.toFixed(4)}`);
    console.log(
      heldBrier < v1BrierSub
        ? "  -> excluding early sells improves on locked v1 on this sample."
        : "  -> excluding early sells does NOT improve on locked v1 on this sample — not worth shipping as-is."
    );

    console.log("\n  Simulated return per $1 staked using the held-only tilt (min gap):");
    for (const minGap of GAP_THRESHOLDS) {
      const trades = withHeld
        .map((s) => ({ ...s, gapHeld: s.smartPctHeld! - s.livePriceAtEntry }))
        .filter((s) => Math.abs(s.gapHeld) >= minGap);
      if (trades.length === 0) {
        console.log(`    >=${(minGap * 100).toFixed(0)}pt gap: n=0`);
        continue;
      }
      const profits = trades.map((s) => (s.gapHeld >= 0 ? s.actual - s.livePriceAtEntry : s.livePriceAtEntry - s.actual));
      const avgProfit = mean(profits);
      const winRate = mean(profits.map((p) => (p > 0 ? 1 : 0)));
      console.log(
        `    >=${(minGap * 100).toFixed(0)}pt gap: n=${trades.length}, avg profit/$1=${avgProfit >= 0 ? "+" : ""}${avgProfit.toFixed(3)}, win rate=${(winRate * 100).toFixed(1)}%`
      );
    }
  }

  // ── EXPERIMENTAL (v9): open-as-of-N-days-before-resolution weighted — the live-plausible version
  // of v8's idea (v8 requires retrospective knowledge a live system can't have). Compared head-to-
  // head against locked v1 on the exact same entries. ──
  const withOpenAsOf = currentVersionAll.filter((s) => s.smartPctOpenAsOf !== undefined);
  console.log(`\nEXPERIMENTAL: open-as-of-${OPEN_AS_OF_LEAD_DAYS}-days-before-resolution weighted, n=${withOpenAsOf.length}:`);
  if (withOpenAsOf.length === 0) {
    console.log("  No entries have smartPctOpenAsOf yet.");
  } else {
    const v1BrierSub = mean(withOpenAsOf.map((s) => brier(s.smartPct, s.actual)));
    const openAsOfBrier = mean(withOpenAsOf.map((s) => brier(s.smartPctOpenAsOf!, s.actual)));
    console.log(`  locked v1 Brier (same ${withOpenAsOf.length} entries): ${v1BrierSub.toFixed(4)}`);
    console.log(`  open-as-of Brier:                           ${openAsOfBrier.toFixed(4)}`);
    console.log(
      openAsOfBrier < v1BrierSub
        ? "  -> the live-plausible version still improves on locked v1 on this sample."
        : "  -> the live-plausible version does NOT improve on locked v1 on this sample — v8's effect may not survive in real time."
    );

    console.log("\n  Simulated return per $1 staked using the open-as-of tilt (min gap):");
    for (const minGap of GAP_THRESHOLDS) {
      const trades = withOpenAsOf
        .map((s) => ({ ...s, gapOpenAsOf: s.smartPctOpenAsOf! - s.livePriceAtEntry }))
        .filter((s) => Math.abs(s.gapOpenAsOf) >= minGap);
      if (trades.length === 0) {
        console.log(`    >=${(minGap * 100).toFixed(0)}pt gap: n=0`);
        continue;
      }
      const profits = trades.map((s) => (s.gapOpenAsOf >= 0 ? s.actual - s.livePriceAtEntry : s.livePriceAtEntry - s.actual));
      const avgProfit = mean(profits);
      const winRate = mean(profits.map((p) => (p > 0 ? 1 : 0)));
      console.log(
        `    >=${(minGap * 100).toFixed(0)}pt gap: n=${trades.length}, avg profit/$1=${avgProfit >= 0 ? "+" : ""}${avgProfit.toFixed(3)}, win rate=${(winRate * 100).toFixed(1)}%`
      );
    }
  }

  // ── EXPERIMENTAL (v10a): equal-weight-per-wallet (no skill lookup), 2x bump when a bet is unusually
  // large for that specific wallet — compared head-to-head against locked v1 on the SAME 5-participant
  // population (same discipline as v6-v9: one variable at a time). ──
  const withEqual = currentVersionAll.filter((s) => s.smartPctEqual !== undefined);
  console.log(`\nEXPERIMENTAL: equal-weighted (no skill; ${EQUAL_WEIGHT_BOOST}x bump on an unusually-large-for-them bet), n=${withEqual.length}:`);
  if (withEqual.length === 0) {
    console.log("  No entries have smartPctEqual yet.");
  } else {
    const v1BrierSub = mean(withEqual.map((s) => brier(s.smartPct, s.actual)));
    const equalBrier = mean(withEqual.map((s) => brier(s.smartPctEqual!, s.actual)));
    console.log(`  locked v1 Brier (same ${withEqual.length} entries): ${v1BrierSub.toFixed(4)}`);
    console.log(`  equal-weighted Brier:                       ${equalBrier.toFixed(4)}`);
    console.log(
      equalBrier < v1BrierSub
        ? "  -> equal weighting improves on locked v1 on this sample — skill-weighting may not be earning its complexity."
        : "  -> equal weighting does NOT improve on locked v1 on this sample — not worth shipping as-is."
    );

    console.log("\n  Simulated return per $1 staked using the equal-weighted tilt (min gap):");
    for (const minGap of GAP_THRESHOLDS) {
      const trades = withEqual
        .map((s) => ({ ...s, gapEqual: s.smartPctEqual! - s.livePriceAtEntry }))
        .filter((s) => Math.abs(s.gapEqual) >= minGap);
      if (trades.length === 0) {
        console.log(`    >=${(minGap * 100).toFixed(0)}pt gap: n=0`);
        continue;
      }
      const profits = trades.map((s) => (s.gapEqual >= 0 ? s.actual - s.livePriceAtEntry : s.livePriceAtEntry - s.actual));
      const avgProfit = mean(profits);
      const winRate = mean(profits.map((p) => (p > 0 ? 1 : 0)));
      console.log(
        `    >=${(minGap * 100).toFixed(0)}pt gap: n=${trades.length}, avg profit/$1=${avgProfit >= 0 ? "+" : ""}${avgProfit.toFixed(3)}, win rate=${(winRate * 100).toFixed(1)}%`
      );
    }
  }

  // ── EXPERIMENTAL (v10b): loosened qualifying gate (3+ participants instead of the locked 5+) — a
  // different population than every section above, so it's not blended in there. Four-way comparison
  // on the SAME loosened population: locked-v1 formula vs. v10a's equal-weight formula, both recomputed
  // on the wider set, so "does loosening help" and "does equal-weighting help" can each be read off
  // independently instead of conflated into one number. ──
  console.log(`\nEXPERIMENTAL: loosened to ${MIN_PARTICIPANTS_LOOSE}+ participants (vs. locked ${MIN_PARTICIPANTS}+), n=${currentVersionAllLoose.length}:`);
  if (currentVersionAllLoose.length === 0) {
    console.log("  No entries recorded under the loosened floor yet.");
  } else {
    const v1BrierLoose = mean(currentVersionAllLoose.map((s) => brier(s.smartPct, s.actual)));
    console.log(`  locked v1 formula, on the ${MIN_PARTICIPANTS}+ population (n=${currentVersionAll.length}): ${smartBrierM.toFixed(4)}`);
    console.log(`  locked v1 formula, on the ${MIN_PARTICIPANTS_LOOSE}+ population (n=${currentVersionAllLoose.length}):  ${v1BrierLoose.toFixed(4)}`);
    const withEqualLoose = currentVersionAllLoose.filter((s) => s.smartPctEqual !== undefined);
    if (withEqualLoose.length > 0) {
      const equalBrierLoose = mean(withEqualLoose.map((s) => brier(s.smartPctEqual!, s.actual)));
      console.log(`  equal-weighted formula, on the ${MIN_PARTICIPANTS_LOOSE}+ population (n=${withEqualLoose.length}): ${equalBrierLoose.toFixed(4)}`);
      console.log(
        equalBrierLoose < v1BrierLoose
          ? "  -> on the loosened population, equal weighting beats locked v1."
          : "  -> on the loosened population, equal weighting does NOT beat locked v1."
      );

      console.log(`\n  Simulated return per $1 staked, equal-weighted tilt on the ${MIN_PARTICIPANTS_LOOSE}+ population (min gap):`);
      for (const minGap of GAP_THRESHOLDS) {
        const trades = withEqualLoose
          .map((s) => ({ ...s, gapEqualLoose: s.smartPctEqual! - s.livePriceAtEntry }))
          .filter((s) => Math.abs(s.gapEqualLoose) >= minGap);
        if (trades.length === 0) {
          console.log(`    >=${(minGap * 100).toFixed(0)}pt gap: n=0`);
          continue;
        }
        const profits = trades.map((s) => (s.gapEqualLoose >= 0 ? s.actual - s.livePriceAtEntry : s.livePriceAtEntry - s.actual));
        const avgProfit = mean(profits);
        const winRate = mean(profits.map((p) => (p > 0 ? 1 : 0)));
        console.log(
          `    >=${(minGap * 100).toFixed(0)}pt gap: n=${trades.length}, avg profit/$1=${avgProfit >= 0 ? "+" : ""}${avgProfit.toFixed(3)}, win rate=${(winRate * 100).toFixed(1)}%`
        );
      }
    }
  }

  // ── EXPERIMENTAL (v11): unanimous markets only — no leaderboard money at all took the other side —
  // reported for both the locked 5+ and loosened 3+ populations, each compared against that same
  // population's non-filtered baseline computed above (smartBrierM for 5+, v1BrierLoose for 3+). ──
  function reportUnanimous(label: string, pool: HistoryEntry[], baselineBrier: number, baselineN: number): void {
    const unanimous = pool.filter((s) => s.isUnanimous === true);
    console.log(`\nEXPERIMENTAL: unanimous-only, ${label} population, n=${unanimous.length} (vs. n=${baselineN} unfiltered):`);
    if (unanimous.length === 0) {
      console.log("  No unanimous entries recorded yet.");
      return;
    }
    const v1BrierUnanimous = mean(unanimous.map((s) => brier(s.smartPct, s.actual)));
    const v1AccUnanimous = accuracy(unanimous.map((s) => s.smartPct), unanimous.map((s) => s.actual));
    console.log(`  locked v1 formula, unfiltered:  ${baselineBrier.toFixed(4)}`);
    console.log(`  locked v1 formula, unanimous-only: ${v1BrierUnanimous.toFixed(4)}, accuracy=${(v1AccUnanimous * 100).toFixed(1)}%`);
    console.log(
      v1BrierUnanimous < baselineBrier
        ? "  -> restricting to unanimous markets improves on the unfiltered population."
        : "  -> restricting to unanimous markets does NOT improve on the unfiltered population."
    );
    const withEqualUnanimous = unanimous.filter((s) => s.smartPctEqual !== undefined);
    if (withEqualUnanimous.length > 0) {
      const equalBrierUnanimous = mean(withEqualUnanimous.map((s) => brier(s.smartPctEqual!, s.actual)));
      console.log(`  equal-weighted formula, unanimous-only (n=${withEqualUnanimous.length}): ${equalBrierUnanimous.toFixed(4)}`);
    }
    console.log(`\n  Simulated return per $1 staked, unanimous-only, ${label} population (min gap):`);
    for (const minGap of GAP_THRESHOLDS) {
      const trades = unanimous.filter((s) => Math.abs(s.gap) >= minGap);
      if (trades.length === 0) {
        console.log(`    >=${(minGap * 100).toFixed(0)}pt gap: n=0`);
        continue;
      }
      const profits = trades.map((s) => (s.gap >= 0 ? s.actual - s.livePriceAtEntry : s.livePriceAtEntry - s.actual));
      const avgProfit = mean(profits);
      const winRate = mean(profits.map((p) => (p > 0 ? 1 : 0)));
      console.log(
        `    >=${(minGap * 100).toFixed(0)}pt gap: n=${trades.length}, avg profit/$1=${avgProfit >= 0 ? "+" : ""}${avgProfit.toFixed(3)}, win rate=${(winRate * 100).toFixed(1)}%`
      );
    }
  }
  reportUnanimous(`locked ${MIN_PARTICIPANTS}+`, currentVersionAll, smartBrierM, currentVersionAll.length);
  reportUnanimous(`loosened ${MIN_PARTICIPANTS_LOOSE}+`, currentVersionAllLoose, mean(currentVersionAllLoose.map((s) => brier(s.smartPct, s.actual))), currentVersionAllLoose.length);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
