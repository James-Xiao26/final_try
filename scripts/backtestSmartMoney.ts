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
//
// v12: EXPERIMENTAL, combines v7 + v8 into one weighting instead of testing them in isolation. Same
// population/filter as v8 (only positions held to a confirmed resolution count at all — early sells
// excluded entirely, not just down-weighted), but each surviving position's weight is v7's
// confidence-multiplied weight (skill*sqrt(cost)*max(1, sqrt(cost/theirOwnAvg))), not v8's plain
// skill*sqrt(cost). Tests whether v7's "this bet was unusually large for them" signal adds anything on
// top of v8's much larger "did they actually stick with it to the end" effect, or whether v8 alone
// already captures everything and stacking v7 on top just adds noise. Reported against locked v1, v7
// alone, and v8 alone, all on the same entries, so the combination's marginal effect over EACH
// individual change is visible, not just its effect over the unweighted baseline.
// RESULT: negative relative to v8 alone. n=217 same-entries comparison: locked v1 0.1178, v7 alone
// 0.1151, v8 alone 0.0737 (still the best of anything tested), v12 combined 0.0910 — worse than v8 by
// itself (~24% higher Brier). v8's held-to-resolution filter is carrying the entire effect; stacking
// v7's confidence multiplier on top of an already-resolution-filtered subset adds size-driven noise
// rather than signal. Not shipped (and v8 itself remains unshipped per the v9 finding that its effect
// is retrospective-only).
//
// v13: EXPERIMENTAL, the correction to v12 — v8 is retrospective-only (see the v9 header note: it
// requires knowing the position was never sold across the ENTIRE unknown future between the bet and
// resolution, information no live system has), so a v7+v8 combination inherits that same hindsight
// leak and its Brier score isn't trustworthy as a preview of anything shippable. v13 combines v7's
// confidence multiplier with v9's filter instead — v9 only requires a single already-defined-checkpoint
// snapshot fact (was the position open, not yet closed, at resolutionMs - OPEN_AS_OF_LEAD_DAYS), which
// a live system genuinely could observe by looking at currently-open positions on any given day. Same
// structure as v12: reported against locked v1, v7 alone, and v9 alone, all on the same entries.
// RESULT: negative, and decisively so. n=217 same-entries comparison: locked v1 0.1178, v7 alone
// 0.1151, v9 alone 0.1306 (already worse than v1 on its own, consistent with v9's original finding),
// v13 combined 0.1367 — worse than everything, including v9 alone. Confirms v12's headline number was
// an artifact of v8's hindsight leak: once the honest, live-plausible filter is substituted in, the
// entire "held/open-as-of x confidence" line of weighting is a dead end, not just an unproven one. Not
// shipped.
//
// v14: EXPERIMENTAL, a new weighting axis on top of locked v1 — "wavering conviction." v6-v13 only ever
// used the aggregate closed-position row (avg_price/size/realized_pnl), which can't tell a clean
// dollar-cost-average-in from a wallet that got cold feet partway through. This pulls each positioned
// wallet's raw /activity (chronological BUY/SELL fills, same source detectArbitrageConditions in
// botDetection.ts already reads) filtered to the specific (conditionId, outcomeIndex) and walks it:
//   - pure accumulation (buy, buy, buy, ... — never sells while still holding) -> multiplier 1.0. This
//     is the "don't reward averaging in" guard the user asked for explicitly — size alone never moves
//     the multiplier, only a sell-while-still-holding does.
//   - a SELL that leaves a non-dust remainder (still holding some after) -> WAVER_PENALTY once per
//     episode ("decrease their weight a bit").
//   - a subsequent BUY after having wavered -> RECOVERY_MULTIPLIER once, applied on top of the waver
//     penalty, not replacing it ("when they buy back, increase their weight a bit") — net effect after
//     one waver+one recovery is still slightly below 1.0 (partial, not full, trust restored).
// A full exit (remainder near zero) is NOT a waver — it's just closing the position normally.
// Implemented against locked v1 (skill*sqrt(cost) base) only, per the ask — not v6/v7/v10 variants.
// RESULT: negative. n=217 same-entries comparison: locked v1 0.1178, conviction-weighted 0.1310 —
// worse, plus lower win rate across every gap bucket. Plausible reason: a partial sell that still
// leaves a position open is often routine profit-taking or risk trimming by a wallet that still has
// real conviction on the remainder, not doubt — penalizing it removes signal rather than noise. Not
// shipped.
//
// v15: two related asks, reported together since one is a special case of the other's machinery.
//   (a) "copy every trade from every leaderboard wallet" baseline — the dollarPct field already
//       computed for every sample (dollar-weighted average entry, no skill at all) is now ALSO
//       persisted and point-in-time price-matched like every other variant, instead of only ever being
//       compared to the final outcome in the early unmatched section. This is the honest floor: what
//       you'd get by literally sizing a copy-trade proportional to how much each wallet actually bet,
//       with zero selectivity about who's good at forecasting.
//   (b) MIN_PARTICIPANTS_FLOOR (1) — walks the per-condition loop down to markets with even a single
//       positioned wallet, the most permissive population possible. Reported for locked v1 AND the
//       dollarPct baseline, at all three floors (5+/3+/1+) side by side, so "does skill-weighting help"
//       and "does requiring more agreement help" can both be read off independently at every population
//       size instead of just at the locked 5+ this file has used everywhere until now.
// RESULT: notable — the dollar-weighted "copy everyone" baseline beats locked v1's skill-weighting at
// EVERY population floor tested: 5+ n=217, v1=0.1178 vs dollar=0.1128; 3+ n=411, v1=0.1286 vs
// dollar=0.1236; 1+ n=1144, v1=0.1472 vs dollar=0.1449. The margin is modest (~0.003-0.005 Brier, not
// in v8's league) but consistent in direction across three different population sizes, not a one-off.
// Also reconfirms v10b independently at the extreme: loosening 5+ -> 1+ roughly doubles Brier for
// EITHER weighting (agreement among more traders is real signal, regardless of how you weight within a
// market). Skill-weighting may be adding noise relative to simply following dollar volume — worth a
// closer look before touching production, but not acted on yet.
// Follow-up diagnostic (not a numbered version, no code artifact): is v1 losing to dollarPct because a
// few noisy high-skill wallets dominate individual markets? Recomputed the 5+ population's weight
// concentration ad hoc — the opposite is true. Skill-weighting is CLOSEST to dollar-weighting (gap
// ~0) when one wallet dominates a market's weight, and WORST (gap ~0.02) when weight is spread across
// many wallets — i.e. skill-weighting underperforms exactly where it gets to do its job (differentiate
// several disagreeing wallets by quality), not because of whale distortion. One wallet
// (0x3c593aeb73ebdadbc9ce76d4264a6a2af4011766, skill 7.57) stood out with a 0.057 Brier gap across its
// 10 dominated markets — flagged for a future look, not investigated further here.
//
// v16: EXPERIMENTAL, isolated — same locked v1 formula (skill*sqrt(cost)), but with DUST_FLOOR_USD
// (10) removed entirely: every position counts, no matter how small, both toward who qualifies as a
// "participant" and toward the weighted average itself. sqrt(cost) already heavily dampens a tiny
// position's WEIGHT once included, so the main effect this tests is on the qualifying-market gate — a
// market with several genuine bettors plus a handful of sub-$10 dust positions previously either
// wasn't reached (if dust-only wallets pushed it to 5+ raw participants but <5 real ones) or had those
// dust wallets silently excluded from both the count and the average. Reports a genuinely separate
// population (participantCountNoDust >= MIN_PARTICIPANTS) side by side with locked v1's population,
// since the two aren't guaranteed identical. Scoping note: the outer per-condition walk floor
// (MIN_PARTICIPANTS_FLOOR) is still defined on the DUST-FLOORED participant count, so a market with
// zero non-dust positions at all is never visited in the first place — deliberate, since walking every
// market with even one cent of activity would balloon the live-price-fetch backlog far past v15's
// already-large 1+ tier for markets that are unlikely to carry real signal anyway.
// RESULT: negative. Locked v1 ($10 floor, n=226) Brier 0.1168 vs. no-dust-floor (n=223) Brier 0.1300 —
// worse. The $10 floor is filtering real noise, not discarding real signal; confirms it's doing useful
// work as configured. Not shipped (no change needed — this is the status quo staying correct).
//
// v17: EXPERIMENTAL, isolated — same locked v1 population (5+, $10 dust floor), but weight = skill*cost
// (linear) instead of skill*sqrt(cost). Tests whether the sqrt dampening is earning its place or just
// throwing away real conviction signal. Reported three-way against locked v1 (sqrt) and dollarPct (no
// skill, also linear in cost) on the exact same entries — brackets the whole size-scaling design space:
// no size scaling (equal-weight, v10a, already tested), sqrt (locked v1), and linear (v17) alongside
// dollar-only linear-with-no-skill (dollarPct).
// RESULT: negative, and forms a clean monotonic pattern with dollarPct and locked v1 on the same n=217
// entries: dollarPct (no skill) 0.1128 < locked v1 (sqrt) 0.1178 < v17 (linear) 0.1244. The MORE
// influence skill_score is given over the weighting, the WORSE the prediction gets — not just "dollar
// happens to edge out v1," but a graded effect across the whole size-scaling spectrum. The sqrt
// dampening is actively protective, not an arbitrary knob costing real signal; going further toward
// dollar-only keeps helping. Not shipped, but this materially sharpens the v15 finding — worth
// prioritizing over other open threads if this line of investigation continues.
//
// v18: EXPERIMENTAL, three isolated variants testing relative conviction (v7's confidenceMultiplier =
// max(1, sqrt(cost / theirOwnDustFlooredAvg)) — reused as-is, not redefined) as the PRIMARY signal
// instead of a multiplier stacked on skill-weighting. Motivation: dollarPct beating locked v1 (v15)
// raises the concern that dollar-weighting just favors whoever has more money to bet, not whoever's
// more convinced — v7 was supposed to test exactly that, but every prior use of it multiplied the
// confidenceMultiplier onto the skill*sqrt(cost) base, so its result was confounded by skill (since
// found to be net-harmful in v15-v17). These three drop skill from the base entirely:
//   (a) v18a: cost * confidenceMultiplier — dollar-linear base, scaled by relative conviction.
//   (b) v18b: sqrt(cost) * confidenceMultiplier — sqrt-dampened dollar base, scaled by relative
//       conviction (the direct skill-free analogue of locked v1's own size-scaling).
//   (c) v18c: confidenceMultiplier alone — equal 1-per-wallet base (no dollar or skill dependence at
//       all), scaled purely by how unusual this bet is for that specific wallet.
// All three use the SAME locked v1 population (5+, $10 dust floor) per the ask — no dust-floor removal
// here, that's v16's separate, already-answered question. Reported against locked v1 and dollarPct, all
// on the exact same entries.
// RESULT: negative for all three relative to dollarPct, n=217 same entries: dollarPct 0.1128 (still
// best), v18a (cost*conviction) 0.1143, locked v1 (skill*sqrt) 0.1178, v18b (sqrt*conviction) 0.1191,
// v18c (conviction alone) 0.1318 (worst). v18a is the closest anything has come to dollarPct all
// session (and beats locked v1), but even properly isolated from skill, relative conviction doesn't
// beat plain dollar size — and the pattern is monotonic again: the further a formula moves away from
// raw dollar size (toward pure conviction, v18c), the worse it gets. Raw bet size remains the strongest
// signal found in this dataset. Not shipped.
//
// v19: EXPERIMENTAL, isolated — weight = sqrt(cost) alone, no skill at all. Completes the 2x2
// size-scaling-x-skill grid that's been built piecemeal without ever explicitly assembling it: linear
// cost with no skill (dollarPct), linear cost with skill (v17), sqrt cost with skill (locked v1), and
// this — sqrt cost with no skill. Same locked v1 population (5+, $10 dust floor). Reported against all
// three other corners on the exact same entries.
// RESULT: dollarPct (linear, no skill) remains the overall best at 0.1128, n=217. But the grid reveals
// an asymmetry the earlier "monotonic" framing missed: sqrt dampening's effect FLIPS depending on
// whether skill is in the base. With skill, sqrt helps (locked v1 0.1178 beats v17's linear 0.1244) —
// it's counteracting skill's noise. Without skill, sqrt HURTS (dollarPct's linear 0.1128 beats v19's
// 0.1199) — it throws away real information from an already-clean signal. So sqrt isn't generically
// good or bad; it's specifically a counterweight to skill's unreliability, and only earns its keep when
// paired with something noisy to dampen. Not shipped.
import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PolymarketClient, type TradeActivity } from "./polymarket.js";
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

// EXPERIMENTAL (v14) — not part of the locked v1 formula, see the header note. A partial sell that
// still leaves a non-dust remainder counts as "wavered" (decrease weight a bit); a later buy after
// wavering counts as "recovered" (increase weight a bit, but not all the way back — net effect after
// one waver+one recovery is 0.85*1.15 = 0.9775, still slightly below neutral, not a reward for having
// wavered at all). Round, simple starting values — tune against the backtest, not by feel, same
// discipline as SPECIALTY_BOOST.
const WAVER_PENALTY = 0.85;
const RECOVERY_MULTIPLIER = 1.15;
// A sell leaving less than this fraction of the position's peak size behind counts as a full exit
// (not a waver) — guards against floating-point/rounding dust registering as "still holding."
const FULL_EXIT_EPSILON_FRACTION = 0.02;

// EXPERIMENTAL (v15b) — not part of the locked v1 formula, see the header note. Most permissive
// population floor tested — a market with even a single positioned leaderboard wallet qualifies.
const MIN_PARTICIPANTS_FLOOR = 1;

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
  smartPctHeldConfidence?: number; // EXPERIMENTAL (v12) — not locked, may be absent on older entries
  smartPctOpenAsOfConfidence?: number; // EXPERIMENTAL (v13) — not locked, may be absent on older entries
  smartPctConviction?: number; // EXPERIMENTAL (v14) — not locked, may be absent on older entries
  dollarPct?: number; // EXPERIMENTAL (v15a) — not locked, may be absent on older entries
  smartPctNoDust?: number; // EXPERIMENTAL (v16) — not locked, may be absent on older entries
  participantCountNoDust?: number; // EXPERIMENTAL (v16) — not locked, may be absent on older entries
  smartPctLinear?: number; // EXPERIMENTAL (v17) — not locked, may be absent on older entries
  smartPctCostConviction?: number; // EXPERIMENTAL (v18a) — not locked, may be absent on older entries
  smartPctSqrtConviction?: number; // EXPERIMENTAL (v18b) — not locked, may be absent on older entries
  smartPctConvictionOnly?: number; // EXPERIMENTAL (v18c) — not locked, may be absent on older entries
  smartPctSqrtDollar?: number; // EXPERIMENTAL (v19) — not locked, may be absent on older entries
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

// EXPERIMENTAL (v14) — raw chronological fills per wallet, fetched live (not cached anywhere in
// Supabase at this granularity/retention — wallet_trades is a rolling ~200-fill window scoped to
// current leaderboard wallets only, too lossy for a wallet's full lifetime history in one market).
// One /activity call per distinct address, same "general" rate lane as ingest's own bot-detection pass.
async function fetchActivityByAddress(addresses: string[], client: PolymarketClient): Promise<Map<string, TradeActivity[]>> {
  const activityByAddress = new Map<string, TradeActivity[]>();
  let done = 0;
  for (const address of addresses) {
    done += 1;
    if (done % 25 === 0) console.log(`  ...${done}/${addresses.length}`);
    const activity = await client.getActivity(address);
    activityByAddress.set(address, activity);
  }
  return activityByAddress;
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

// EXPERIMENTAL (v14): walk one wallet's raw chronological fills for a single (conditionId,
// outcomeIndex) position and derive the conviction multiplier — see the header note for the state
// machine (pure accumulation = neutral, a partial sell that leaves a remainder = wavered, a buy after
// wavering = partial recovery). Fills outside this exact position are already filtered out by the
// caller; this function assumes `fills` is already scoped to one (wallet, conditionId, outcomeIndex).
function convictionMultiplier(fills: TradeActivity[]): number {
  const sorted = [...fills].sort((a, b) => a.timestamp - b.timestamp);
  let runningSize = 0;
  let peakSize = 0;
  let hasWavered = false;
  let multiplier = 1;
  for (const fill of sorted) {
    if (fill.side === "BUY") {
      if (hasWavered) {
        multiplier *= RECOVERY_MULTIPLIER;
        hasWavered = false; // consume — a second buy in a row shouldn't stack another bump
      }
      runningSize += fill.size;
      peakSize = Math.max(peakSize, runningSize);
    } else if (fill.side === "SELL") {
      runningSize -= fill.size;
      const isFullExit = peakSize === 0 || runningSize <= peakSize * FULL_EXIT_EPSILON_FRACTION;
      if (!isFullExit && !hasWavered) {
        multiplier *= WAVER_PENALTY;
        hasWavered = true;
      }
    }
  }
  return multiplier;
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

  // EXPERIMENTAL (v14): one /activity fetch per distinct address touching any closed position, so the
  // per-condition loop below can reconstruct each wallet's raw fill sequence for the conviction
  // multiplier. Instantiated here (rather than down where the price-history live-fetch fallback used to
  // create its own client) so both steps share one instance.
  const client = new PolymarketClient();
  const distinctAddresses = [...new Set(allClosed.map((r) => r.address))];
  console.log(`Fetching raw activity for ${distinctAddresses.length} distinct wallets (v14 conviction weighting)...`);
  const activityByAddress = await fetchActivityByAddress(distinctAddresses, client);
  console.log(`${activityByAddress.size} wallets' activity fetched\n`);

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
    smartPctHeldConfidence: number; // EXPERIMENTAL (v12) — v8's held-to-resolution filter + v7's confidence multiplier, combined
    smartPctOpenAsOfConfidence: number; // EXPERIMENTAL (v13) — v9's open-as-of filter + v7's confidence multiplier, combined
    smartPctConviction: number; // EXPERIMENTAL (v14) — v1 base weight x wavering-conviction multiplier
    smartPctNoDust: number; // EXPERIMENTAL (v16) — locked v1 formula with DUST_FLOOR_USD removed entirely
    participantCountNoDust: number; // EXPERIMENTAL (v16) — distinct wallets with ANY nonzero position, no dust floor
    smartPctLinear: number; // EXPERIMENTAL (v17) — skill*cost (no sqrt dampening), same population as locked v1
    smartPctCostConviction: number; // EXPERIMENTAL (v18a) — cost * confidenceMultiplier, no skill
    smartPctSqrtConviction: number; // EXPERIMENTAL (v18b) — sqrt(cost) * confidenceMultiplier, no skill
    smartPctConvictionOnly: number; // EXPERIMENTAL (v18c) — confidenceMultiplier alone, no dollar/skill base
    smartPctSqrtDollar: number; // EXPERIMENTAL (v19) — sqrt(cost) alone, no skill
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
    // walks all the way down to MIN_PARTICIPANTS_FLOOR (v15b, 1) so every population tier (5+/3+/1+)
    // gets discovered and matched in one pass; every downstream "locked v1" report still filters back
    // up to whichever floor it's reporting on.
    const positioned = rows.filter((r) => cost(r) >= DUST_FLOOR_USD);
    const distinctWallets = new Set(positioned.map((r) => r.address));
    if (distinctWallets.size < MIN_PARTICIPANTS_FLOOR) continue;

    // EXPERIMENTAL (v16): every position with a nonzero cost, no $10 floor at all — the loop below
    // iterates this instead of `positioned` and re-applies the dust floor per-row for every OTHER
    // (locked + experimental) formula, so v16 is the only one that sees the dust-floor-excluded rows.
    const allPositioned = rows.filter((r) => cost(r) > 0);
    const allDistinctWallets = new Set(allPositioned.map((r) => r.address));

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
    let heldConfidenceWeight = 0;
    let heldConfidenceWeighted = 0;
    let openAsOfWeight = 0;
    let openAsOfWeighted = 0;
    let openAsOfConfidenceWeight = 0;
    let openAsOfConfidenceWeighted = 0;
    let equalWeight = 0;
    let equalWeighted = 0;
    let convictionWeight = 0;
    let convictionWeighted = 0;
    let noDustWeight = 0;
    let noDustWeighted = 0;
    let linearWeight = 0;
    let linearWeighted = 0;
    let sqrtDollarWeight = 0;
    let sqrtDollarWeighted = 0;
    let costConvictionWeight = 0;
    let costConvictionWeighted = 0;
    let sqrtConvictionWeight = 0;
    let sqrtConvictionWeighted = 0;
    let convictionOnlyWeight = 0;
    let convictionOnlyWeighted = 0;
    let dateWeight = 0;
    let dateWeighted = 0; // sum(weight * entry epoch ms) -> weighted-average entry date
    for (const row of allPositioned) {
      const c = cost(row);
      const yesEq = yesEquivalentEntry(row);
      const skill = Math.max(0, skillByAddress.get(row.address) ?? 0);
      const w = skill * Math.sqrt(c);

      // EXPERIMENTAL (v16): unconditional — sees every nonzero position, dust or not.
      noDustWeight += w;
      noDustWeighted += w * yesEq;

      if (c < DUST_FLOOR_USD) continue; // dust floor gate for every formula below (identical to the old `positioned`-only loop)

      smartWeight += w;
      smartWeighted += w * yesEq;
      dollarWeight += c;
      dollarWeighted += c * yesEq;
      // EXPERIMENTAL (v17): linear in cost, no sqrt dampening — same dust-floored population as locked v1.
      const wLinear = skill * c;
      linearWeight += wLinear;
      linearWeighted += wLinear * yesEq;
      // EXPERIMENTAL (v19): sqrt(cost) alone, no skill — completes the 2x2 grid with dollarPct/v17/v1.
      const wSqrtDollar = Math.sqrt(c);
      sqrtDollarWeight += wSqrtDollar;
      sqrtDollarWeighted += wSqrtDollar * yesEq;
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
      // EXPERIMENTAL (v18): relative conviction as the PRIMARY signal, skill dropped from the base
      // entirely — reuses the same confidenceMultiplier just computed above for v7.
      const wCostConviction = c * confidenceMultiplier; // v18a — dollar-linear base
      costConvictionWeight += wCostConviction;
      costConvictionWeighted += wCostConviction * yesEq;
      const wSqrtConviction = Math.sqrt(c) * confidenceMultiplier; // v18b — sqrt-dampened dollar base
      sqrtConvictionWeight += wSqrtConviction;
      sqrtConvictionWeighted += wSqrtConviction * yesEq;
      convictionOnlyWeight += confidenceMultiplier; // v18c — equal base, conviction-scaled only
      convictionOnlyWeighted += confidenceMultiplier * yesEq;
      // EXPERIMENTAL (v8): only positions actually held to a confirmed resolution count — a wallet
      // who bought in and later sold out doesn't get their (possibly-abandoned) entry counted.
      if (isHeldToResolution(row)) {
        heldWeight += w;
        heldWeighted += w * yesEq;
        // EXPERIMENTAL (v12): v8's held-to-resolution filter + v7's confidence multiplier, combined —
        // only a position that survived to resolution counts, weighted by how unusual its size was
        // for that wallet, not just by skill*sqrt(cost).
        heldConfidenceWeight += wConfidence;
        heldConfidenceWeighted += wConfidence * yesEq;
      }
      // EXPERIMENTAL (v9): only positions genuinely still open at the reference lead time count.
      if (Number.isFinite(openAsOfReferenceMs) && isOpenAsOf(row, openAsOfReferenceMs)) {
        openAsOfWeight += w;
        openAsOfWeighted += w * yesEq;
        // EXPERIMENTAL (v13): v9's live-plausible open-as-of filter + v7's confidence multiplier,
        // combined — the honest counterpart to v12 (v8 is retrospective-only, see header note).
        openAsOfConfidenceWeight += wConfidence;
        openAsOfConfidenceWeighted += wConfidence * yesEq;
      }
      // EXPERIMENTAL (v10a): no skill lookup — every wallet is worth 1, bumped to
      // EQUAL_WEIGHT_BOOST only when this bet is bigger than that wallet's own dust-floored average.
      const wEqual = theirAvg && theirAvg > 0 && c > theirAvg ? EQUAL_WEIGHT_BOOST : 1;
      equalWeight += wEqual;
      equalWeighted += wEqual * yesEq;
      // EXPERIMENTAL (v14): v1's base weight x wavering-conviction multiplier, derived from this
      // wallet's raw fills for this exact (conditionId, outcomeIndex) — see convictionMultiplier().
      const positionFills = (activityByAddress.get(row.address) ?? []).filter(
        (a) => a.conditionId === conditionId && a.outcomeIndex === row.outcome_index
      );
      const wConviction = w * convictionMultiplier(positionFills);
      convictionWeight += wConviction;
      convictionWeighted += wConviction * yesEq;
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
      smartPctHeldConfidence: heldConfidenceWeight > 0 ? heldConfidenceWeighted / heldConfidenceWeight : smartWeighted / smartWeight,
      smartPctOpenAsOfConfidence: openAsOfConfidenceWeight > 0 ? openAsOfConfidenceWeighted / openAsOfConfidenceWeight : smartWeighted / smartWeight,
      smartPctConviction: convictionWeight > 0 ? convictionWeighted / convictionWeight : smartWeighted / smartWeight,
      smartPctNoDust: noDustWeight > 0 ? noDustWeighted / noDustWeight : smartWeighted / smartWeight,
      participantCountNoDust: allDistinctWallets.size,
      smartPctLinear: linearWeight > 0 ? linearWeighted / linearWeight : smartWeighted / smartWeight,
      smartPctCostConviction: costConvictionWeight > 0 ? costConvictionWeighted / costConvictionWeight : smartWeighted / smartWeight,
      smartPctSqrtConviction: sqrtConvictionWeight > 0 ? sqrtConvictionWeighted / sqrtConvictionWeight : smartWeighted / smartWeight,
      smartPctConvictionOnly: convictionOnlyWeight > 0 ? convictionOnlyWeighted / convictionOnlyWeight : smartWeighted / smartWeight,
      smartPctSqrtDollar: sqrtDollarWeight > 0 ? sqrtDollarWeighted / sqrtDollarWeight : smartWeighted / smartWeight,
      actual,
      daysEarly,
      refEntryMs
    });
  }

  console.log(
    `${samples.length} resolved markets clear the ${MIN_PARTICIPANTS_FLOOR}-participant / $10 floor (${samples.filter((s) => s.participantCount >= MIN_PARTICIPANTS_LOOSE).length} clear ${MIN_PARTICIPANTS_LOOSE}+, ${samples.filter((s) => s.participantCount >= MIN_PARTICIPANTS).length} clear the locked ${MIN_PARTICIPANTS}+ floor)\n`
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
  const before = history.size;
  const now = new Date().toISOString();
  // Fold a matched/live-fetched sample into the persisted history — resolved markets already recorded
  // stay as-is (their outcome and matched price are fixed historical facts, LOCKED and never touched),
  // new ones from this run get added. This is what makes the sample actually grow across runs instead
  // of shifting with wallet_closed_positions' rolling window.
  function recordMatch(s: MatchedSample): void {
    if (history.has(s.conditionId)) return;
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
      isUnanimous: s.isUnanimous,
      smartPctHeldConfidence: s.smartPctHeldConfidence,
      smartPctOpenAsOfConfidence: s.smartPctOpenAsOfConfidence,
      smartPctConviction: s.smartPctConviction,
      dollarPct: s.dollarPct,
      smartPctNoDust: s.smartPctNoDust,
      participantCountNoDust: s.participantCountNoDust,
      smartPctLinear: s.smartPctLinear,
      smartPctCostConviction: s.smartPctCostConviction,
      smartPctSqrtConviction: s.smartPctSqrtConviction,
      smartPctConvictionOnly: s.smartPctConvictionOnly,
      smartPctSqrtDollar: s.smartPctSqrtDollar
    });
  }
  for (const s of matched) recordMatch(s);

  const toFetch = samples.filter((s) => s.refEntryMs !== null && !matchedIds.has(s.conditionId) && !history.has(s.conditionId));
  let liveFetchedCount = 0;
  if (toFetch.length > 0) {
    console.log(`Fetching real price history from Gamma+CLOB for ${toFetch.length} markets the cache missed...`);
    let done = 0;
    for (const s of toFetch) {
      done += 1;
      if (done % 25 === 0) console.log(`  ...${done}/${toFetch.length}`);
      // Checkpoint periodically — this loop can run long on a wide population (v15b's 1+ floor pulls
      // in thousands of markets needing a live fetch each), so bank progress instead of losing it all
      // if the run gets killed/times out partway through; a resumed run's toFetch filter already skips
      // anything already in history.
      if (done % 50 === 0) saveHistory(history);
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
      recordMatch({ ...s, livePriceAtEntry, gap: s.smartPct - livePriceAtEntry });
      liveFetchedCount += 1;
    }
    console.log(`${liveFetchedCount} additional markets matched via live fetch`);
  }
  saveHistory(history);
  console.log(`${history.size - before} new markets added to ${HISTORY_FILE} (${history.size} total recorded)`);

  // EXPERIMENTAL (v6-v19) backfill: existing entries never got these fields (they didn't exist
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
    if (entry.smartPctHeldConfidence === undefined) {
      entry.smartPctHeldConfidence = sample.smartPctHeldConfidence;
      changed = true;
    }
    if (entry.smartPctOpenAsOfConfidence === undefined) {
      entry.smartPctOpenAsOfConfidence = sample.smartPctOpenAsOfConfidence;
      changed = true;
    }
    if (entry.smartPctConviction === undefined) {
      entry.smartPctConviction = sample.smartPctConviction;
      changed = true;
    }
    if (entry.dollarPct === undefined) {
      entry.dollarPct = sample.dollarPct;
      changed = true;
    }
    if (entry.smartPctNoDust === undefined) {
      entry.smartPctNoDust = sample.smartPctNoDust;
      changed = true;
    }
    if (entry.participantCountNoDust === undefined) {
      entry.participantCountNoDust = sample.participantCountNoDust;
      changed = true;
    }
    if (entry.smartPctLinear === undefined) {
      entry.smartPctLinear = sample.smartPctLinear;
      changed = true;
    }
    if (entry.smartPctCostConviction === undefined) {
      entry.smartPctCostConviction = sample.smartPctCostConviction;
      changed = true;
    }
    if (entry.smartPctSqrtConviction === undefined) {
      entry.smartPctSqrtConviction = sample.smartPctSqrtConviction;
      changed = true;
    }
    if (entry.smartPctConvictionOnly === undefined) {
      entry.smartPctConvictionOnly = sample.smartPctConvictionOnly;
      changed = true;
    }
    if (entry.smartPctSqrtDollar === undefined) {
      entry.smartPctSqrtDollar = sample.smartPctSqrtDollar;
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
  // EXPERIMENTAL (v15b): the most permissive 1+ population — a strict superset of currentVersionAllLoose.
  const currentVersionAllFloor = all.filter(
    (s) => s.methodologyVersion === METHODOLOGY_VERSION && (s.participantCount ?? MIN_PARTICIPANTS) >= MIN_PARTICIPANTS_FLOOR
  );
  // EXPERIMENTAL (v16): population gated on the NO-DUST participant count instead of the dust-floored
  // one — not necessarily identical to currentVersionAll, since a market can clear one gate without
  // clearing the other. Older entries (participantCountNoDust undefined) fall back to participantCount
  // (a reasonable floor since the no-dust count can only be >= the dust-floored one).
  const currentVersionAllNoDust = all.filter(
    (s) =>
      s.methodologyVersion === METHODOLOGY_VERSION &&
      (s.participantCountNoDust ?? s.participantCount ?? MIN_PARTICIPANTS) >= MIN_PARTICIPANTS
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

  // ── EXPERIMENTAL (v12): v7 + v8 combined — held-to-resolution filter, confidence-multiplied weight
  // — compared against locked v1, v7 alone, and v8 alone, all on the SAME entries so the combination's
  // marginal effect over each individual change is visible, not just over the unweighted baseline. ──
  const withHeldConfidence = currentVersionAll.filter(
    (s) => s.smartPctHeldConfidence !== undefined && s.smartPctConfidence !== undefined && s.smartPctHeld !== undefined
  );
  console.log(`\nEXPERIMENTAL: v7+v8 combined (held-to-resolution filter, confidence-multiplied weight), n=${withHeldConfidence.length}:`);
  if (withHeldConfidence.length === 0) {
    console.log("  No entries have smartPctHeldConfidence yet.");
  } else {
    const v1BrierSub = mean(withHeldConfidence.map((s) => brier(s.smartPct, s.actual)));
    const v7BrierSub = mean(withHeldConfidence.map((s) => brier(s.smartPctConfidence!, s.actual)));
    const v8BrierSub = mean(withHeldConfidence.map((s) => brier(s.smartPctHeld!, s.actual)));
    const combinedBrier = mean(withHeldConfidence.map((s) => brier(s.smartPctHeldConfidence!, s.actual)));
    console.log(`  locked v1 Brier (same ${withHeldConfidence.length} entries): ${v1BrierSub.toFixed(4)}`);
    console.log(`  v7 alone (confidence-weighted):        ${v7BrierSub.toFixed(4)}`);
    console.log(`  v8 alone (held-to-resolution):          ${v8BrierSub.toFixed(4)}`);
    console.log(`  v12 combined (v7+v8):                   ${combinedBrier.toFixed(4)}`);
    console.log(
      combinedBrier < v8BrierSub
        ? "  -> combining v7 on top of v8 improves further on v8 alone."
        : "  -> combining v7 on top of v8 does NOT improve on v8 alone — v8's held-to-resolution filter is carrying all of the effect."
    );

    console.log("\n  Simulated return per $1 staked using the combined tilt (min gap):");
    for (const minGap of GAP_THRESHOLDS) {
      const trades = withHeldConfidence
        .map((s) => ({ ...s, gapCombined: s.smartPctHeldConfidence! - s.livePriceAtEntry }))
        .filter((s) => Math.abs(s.gapCombined) >= minGap);
      if (trades.length === 0) {
        console.log(`    >=${(minGap * 100).toFixed(0)}pt gap: n=0`);
        continue;
      }
      const profits = trades.map((s) => (s.gapCombined >= 0 ? s.actual - s.livePriceAtEntry : s.livePriceAtEntry - s.actual));
      const avgProfit = mean(profits);
      const winRate = mean(profits.map((p) => (p > 0 ? 1 : 0)));
      console.log(
        `    >=${(minGap * 100).toFixed(0)}pt gap: n=${trades.length}, avg profit/$1=${avgProfit >= 0 ? "+" : ""}${avgProfit.toFixed(3)}, win rate=${(winRate * 100).toFixed(1)}%`
      );
    }
  }

  // ── EXPERIMENTAL (v13): v7 + v9 combined — the live-plausible counterpart to v12, since v9 (unlike
  // v8) only relies on a snapshot fact a real system could observe (open-as-of a fixed pre-resolution
  // checkpoint), not full-future hindsight. Compared against locked v1, v7 alone, and v9 alone. ──
  const withOpenAsOfConfidence = currentVersionAll.filter(
    (s) => s.smartPctOpenAsOfConfidence !== undefined && s.smartPctConfidence !== undefined && s.smartPctOpenAsOf !== undefined
  );
  console.log(`\nEXPERIMENTAL: v7+v9 combined (live-plausible open-as-of filter, confidence-multiplied weight), n=${withOpenAsOfConfidence.length}:`);
  if (withOpenAsOfConfidence.length === 0) {
    console.log("  No entries have smartPctOpenAsOfConfidence yet.");
  } else {
    const v1BrierSub = mean(withOpenAsOfConfidence.map((s) => brier(s.smartPct, s.actual)));
    const v7BrierSub = mean(withOpenAsOfConfidence.map((s) => brier(s.smartPctConfidence!, s.actual)));
    const v9BrierSub = mean(withOpenAsOfConfidence.map((s) => brier(s.smartPctOpenAsOf!, s.actual)));
    const combinedBrier = mean(withOpenAsOfConfidence.map((s) => brier(s.smartPctOpenAsOfConfidence!, s.actual)));
    console.log(`  locked v1 Brier (same ${withOpenAsOfConfidence.length} entries): ${v1BrierSub.toFixed(4)}`);
    console.log(`  v7 alone (confidence-weighted):        ${v7BrierSub.toFixed(4)}`);
    console.log(`  v9 alone (open-as-of, live-plausible):  ${v9BrierSub.toFixed(4)}`);
    console.log(`  v13 combined (v7+v9):                   ${combinedBrier.toFixed(4)}`);
    console.log(
      combinedBrier < Math.min(v1BrierSub, v7BrierSub, v9BrierSub)
        ? "  -> v13 beats locked v1, v7 alone, AND v9 alone — this is the one worth taking seriously."
        : combinedBrier < v1BrierSub
          ? "  -> v13 beats locked v1 but not every individual component — mixed result."
          : "  -> v13 does NOT beat locked v1 — not worth shipping."
    );

    console.log("\n  Simulated return per $1 staked using the combined tilt (min gap):");
    for (const minGap of GAP_THRESHOLDS) {
      const trades = withOpenAsOfConfidence
        .map((s) => ({ ...s, gapCombined: s.smartPctOpenAsOfConfidence! - s.livePriceAtEntry }))
        .filter((s) => Math.abs(s.gapCombined) >= minGap);
      if (trades.length === 0) {
        console.log(`    >=${(minGap * 100).toFixed(0)}pt gap: n=0`);
        continue;
      }
      const profits = trades.map((s) => (s.gapCombined >= 0 ? s.actual - s.livePriceAtEntry : s.livePriceAtEntry - s.actual));
      const avgProfit = mean(profits);
      const winRate = mean(profits.map((p) => (p > 0 ? 1 : 0)));
      console.log(
        `    >=${(minGap * 100).toFixed(0)}pt gap: n=${trades.length}, avg profit/$1=${avgProfit >= 0 ? "+" : ""}${avgProfit.toFixed(3)}, win rate=${(winRate * 100).toFixed(1)}%`
      );
    }
  }

  // ── EXPERIMENTAL (v14): wavering-conviction weighting — v1's base weight x convictionMultiplier —
  // compared against locked v1 on the same entries. ──
  const withConviction = currentVersionAll.filter((s) => s.smartPctConviction !== undefined);
  console.log(`\nEXPERIMENTAL: wavering-conviction weighted (partial-sell-then-hold penalized, buy-back-after partially restored), n=${withConviction.length}:`);
  if (withConviction.length === 0) {
    console.log("  No entries have smartPctConviction yet.");
  } else {
    const v1BrierSub = mean(withConviction.map((s) => brier(s.smartPct, s.actual)));
    const convictionBrier = mean(withConviction.map((s) => brier(s.smartPctConviction!, s.actual)));
    console.log(`  locked v1 Brier (same ${withConviction.length} entries): ${v1BrierSub.toFixed(4)}`);
    console.log(`  conviction-weighted Brier:                   ${convictionBrier.toFixed(4)}`);
    console.log(
      convictionBrier < v1BrierSub
        ? "  -> conviction weighting improves on locked v1 on this sample."
        : "  -> conviction weighting does NOT improve on locked v1 on this sample — not worth shipping as-is."
    );

    console.log("\n  Simulated return per $1 staked using the conviction-weighted tilt (min gap):");
    for (const minGap of GAP_THRESHOLDS) {
      const trades = withConviction
        .map((s) => ({ ...s, gapConviction: s.smartPctConviction! - s.livePriceAtEntry }))
        .filter((s) => Math.abs(s.gapConviction) >= minGap);
      if (trades.length === 0) {
        console.log(`    >=${(minGap * 100).toFixed(0)}pt gap: n=0`);
        continue;
      }
      const profits = trades.map((s) => (s.gapConviction >= 0 ? s.actual - s.livePriceAtEntry : s.livePriceAtEntry - s.actual));
      const avgProfit = mean(profits);
      const winRate = mean(profits.map((p) => (p > 0 ? 1 : 0)));
      console.log(
        `    >=${(minGap * 100).toFixed(0)}pt gap: n=${trades.length}, avg profit/$1=${avgProfit >= 0 ? "+" : ""}${avgProfit.toFixed(3)}, win rate=${(winRate * 100).toFixed(1)}%`
      );
    }
  }

  // ── EXPERIMENTAL (v15): "copy every trade" dollar-weighted baseline (v15a) + the most permissive
  // 1+ population floor (v15b), reported together as a 3-tier table (locked v1 vs. dollarPct, at
  // 5+/3+/1+) so both "does skill-weighting help" and "does requiring agreement help" are visible at
  // every population size, not just the locked 5+. ──
  console.log("\nEXPERIMENTAL: locked v1 vs. dollar-weighted 'copy every trade' baseline, by population floor:");
  const populationTiers: [string, HistoryEntry[]][] = [
    [`${MIN_PARTICIPANTS}+ (locked)`, currentVersionAll],
    [`${MIN_PARTICIPANTS_LOOSE}+`, currentVersionAllLoose],
    [`${MIN_PARTICIPANTS_FLOOR}+ (most permissive)`, currentVersionAllFloor]
  ];
  for (const [label, pool] of populationTiers) {
    const withDollar = pool.filter((s) => s.dollarPct !== undefined);
    if (withDollar.length === 0) {
      console.log(`  ${label}: n=0`);
      continue;
    }
    const v1BrierTier = mean(withDollar.map((s) => brier(s.smartPct, s.actual)));
    const dollarBrierTier = mean(withDollar.map((s) => brier(s.dollarPct!, s.actual)));
    console.log(
      `  ${label}: n=${withDollar.length}, locked v1=${v1BrierTier.toFixed(4)}, copy-every-trade (dollar-weighted)=${dollarBrierTier.toFixed(4)}` +
        (dollarBrierTier < v1BrierTier ? "  <- copy-everyone beats skill-weighting here" : "")
    );
  }

  const floorWithDollar = currentVersionAllFloor.filter((s) => s.dollarPct !== undefined);
  if (floorWithDollar.length > 0) {
    console.log(`\n  Simulated return per $1 staked, copy-every-trade baseline, ${MIN_PARTICIPANTS_FLOOR}+ population (min gap):`);
    for (const minGap of GAP_THRESHOLDS) {
      const trades = floorWithDollar
        .map((s) => ({ ...s, gapDollar: s.dollarPct! - s.livePriceAtEntry }))
        .filter((s) => Math.abs(s.gapDollar) >= minGap);
      if (trades.length === 0) {
        console.log(`    >=${(minGap * 100).toFixed(0)}pt gap: n=0`);
        continue;
      }
      const profits = trades.map((s) => (s.gapDollar >= 0 ? s.actual - s.livePriceAtEntry : s.livePriceAtEntry - s.actual));
      const avgProfit = mean(profits);
      const winRate = mean(profits.map((p) => (p > 0 ? 1 : 0)));
      console.log(
        `    >=${(minGap * 100).toFixed(0)}pt gap: n=${trades.length}, avg profit/$1=${avgProfit >= 0 ? "+" : ""}${avgProfit.toFixed(3)}, win rate=${(winRate * 100).toFixed(1)}%`
      );
    }
  }

  // ── EXPERIMENTAL (v16): DUST_FLOOR_USD removed entirely. currentVersionAllNoDust (the no-dust-
  // gated population) is a strict superset of currentVersionAll — every market clearing the $10-floor
  // gate automatically clears the no-dust gate too, since the no-dust participant count can only be
  // >= the dust-floored one. But not every entry has smartPctNoDust backfilled (a market that aged out
  // of wallet_closed_positions' rolling window since it was first recorded can't be recomputed), so
  // `withNoDust` below is smaller than the full no-dust-qualifying set — comparing it against the
  // GLOBAL locked-v1 Brier (computed over a different, not-necessarily-overlapping set of entries)
  // would be an apples-to-oranges mismatch. v1BrierSub recomputes locked v1's Brier restricted to the
  // exact same withNoDust entries, matching every other section's "same entries" discipline. ──
  console.log(`\nEXPERIMENTAL: dust floor removed entirely, n=${currentVersionAllNoDust.length} qualify (vs. locked v1's n=${currentVersionAll.length}, dust floor $${DUST_FLOOR_USD}):`);
  const withNoDust = currentVersionAllNoDust.filter((s) => s.smartPctNoDust !== undefined);
  if (withNoDust.length === 0) {
    console.log("  No entries have smartPctNoDust yet.");
  } else {
    const v1BrierSub = mean(withNoDust.map((s) => brier(s.smartPct, s.actual)));
    const noDustBrier = mean(withNoDust.map((s) => brier(s.smartPctNoDust!, s.actual)));
    console.log(`  locked v1 Brier (same ${withNoDust.length} entries): ${v1BrierSub.toFixed(4)}`);
    console.log(`  no-dust-floor Brier:                    ${noDustBrier.toFixed(4)}`);
    console.log(
      noDustBrier < v1BrierSub
        ? "  -> removing the dust floor improves on locked v1."
        : "  -> removing the dust floor does NOT improve on locked v1 — the $10 floor is filtering real noise, not real signal."
    );

    console.log("\n  Simulated return per $1 staked using the no-dust-floor tilt (min gap):");
    for (const minGap of GAP_THRESHOLDS) {
      const trades = withNoDust
        .map((s) => ({ ...s, gapNoDust: s.smartPctNoDust! - s.livePriceAtEntry }))
        .filter((s) => Math.abs(s.gapNoDust) >= minGap);
      if (trades.length === 0) {
        console.log(`    >=${(minGap * 100).toFixed(0)}pt gap: n=0`);
        continue;
      }
      const profits = trades.map((s) => (s.gapNoDust >= 0 ? s.actual - s.livePriceAtEntry : s.livePriceAtEntry - s.actual));
      const avgProfit = mean(profits);
      const winRate = mean(profits.map((p) => (p > 0 ? 1 : 0)));
      console.log(
        `    >=${(minGap * 100).toFixed(0)}pt gap: n=${trades.length}, avg profit/$1=${avgProfit >= 0 ? "+" : ""}${avgProfit.toFixed(3)}, win rate=${(winRate * 100).toFixed(1)}%`
      );
    }
  }

  // ── EXPERIMENTAL (v17): linear-in-cost (skill*cost, no sqrt) — three-way against locked v1 (sqrt)
  // and dollarPct (linear, no skill), all on the exact same entries. Brackets the size-scaling design
  // space: equal-weight (v10a, no size scaling), sqrt (locked v1), linear (v17), dollar-only linear-
  // with-no-skill (dollarPct). ──
  const withLinear = currentVersionAll.filter((s) => s.smartPctLinear !== undefined && s.dollarPct !== undefined);
  console.log(`\nEXPERIMENTAL: linear-in-cost weighted (skill*cost, no sqrt dampening), n=${withLinear.length}:`);
  if (withLinear.length === 0) {
    console.log("  No entries have smartPctLinear yet.");
  } else {
    const sqrtBrier = mean(withLinear.map((s) => brier(s.smartPct, s.actual)));
    const linearBrier = mean(withLinear.map((s) => brier(s.smartPctLinear!, s.actual)));
    const dollarBrierSub = mean(withLinear.map((s) => brier(s.dollarPct!, s.actual)));
    console.log(`  locked v1 (sqrt(cost)):     ${sqrtBrier.toFixed(4)}`);
    console.log(`  v17 (linear cost, w/skill): ${linearBrier.toFixed(4)}`);
    console.log(`  dollarPct (linear, no skill): ${dollarBrierSub.toFixed(4)}`);
    console.log(
      linearBrier < sqrtBrier
        ? "  -> dropping the sqrt dampening improves on locked v1 — sqrt may be throwing away real conviction signal."
        : "  -> dropping the sqrt dampening does NOT improve on locked v1 — the dampening is earning its place."
    );

    console.log("\n  Simulated return per $1 staked using the linear-cost tilt (min gap):");
    for (const minGap of GAP_THRESHOLDS) {
      const trades = withLinear
        .map((s) => ({ ...s, gapLinear: s.smartPctLinear! - s.livePriceAtEntry }))
        .filter((s) => Math.abs(s.gapLinear) >= minGap);
      if (trades.length === 0) {
        console.log(`    >=${(minGap * 100).toFixed(0)}pt gap: n=0`);
        continue;
      }
      const profits = trades.map((s) => (s.gapLinear >= 0 ? s.actual - s.livePriceAtEntry : s.livePriceAtEntry - s.actual));
      const avgProfit = mean(profits);
      const winRate = mean(profits.map((p) => (p > 0 ? 1 : 0)));
      console.log(
        `    >=${(minGap * 100).toFixed(0)}pt gap: n=${trades.length}, avg profit/$1=${avgProfit >= 0 ? "+" : ""}${avgProfit.toFixed(3)}, win rate=${(winRate * 100).toFixed(1)}%`
      );
    }
  }

  // ── EXPERIMENTAL (v18): relative conviction as the PRIMARY signal (skill dropped from the base
  // entirely), three variants — all on the SAME locked v1 (5+, $10 dust floor) entries, reported
  // against BOTH locked v1 and dollarPct so "beats the money-only baseline" and "beats skill-weighting"
  // are both visible. ──
  type ConvictionKey = "smartPctCostConviction" | "smartPctSqrtConviction" | "smartPctConvictionOnly";
  function reportConvictionVariant(label: string, key: ConvictionKey): void {
    const withVariant = currentVersionAll.filter((s) => s[key] !== undefined && s.dollarPct !== undefined);
    console.log(`\nEXPERIMENTAL: ${label}, n=${withVariant.length}:`);
    if (withVariant.length === 0) {
      console.log(`  No entries have ${key} yet.`);
      return;
    }
    const v1BrierSub = mean(withVariant.map((s) => brier(s.smartPct, s.actual)));
    const dollarBrierSub = mean(withVariant.map((s) => brier(s.dollarPct!, s.actual)));
    const variantBrier = mean(withVariant.map((s) => brier(s[key]!, s.actual)));
    console.log(`  locked v1 (skill*sqrt(cost)): ${v1BrierSub.toFixed(4)}`);
    console.log(`  dollarPct (no skill, linear): ${dollarBrierSub.toFixed(4)}`);
    console.log(`  this variant:                 ${variantBrier.toFixed(4)}`);
    console.log(
      variantBrier < Math.min(v1BrierSub, dollarBrierSub)
        ? "  -> beats BOTH locked v1 and dollarPct — worth taking seriously."
        : variantBrier < dollarBrierSub
          ? "  -> beats dollarPct but not locked v1 — mixed result."
          : variantBrier < v1BrierSub
            ? "  -> beats locked v1 but not dollarPct — mixed result."
            : "  -> does NOT beat either baseline — not worth shipping."
    );
    console.log(`\n  Simulated return per $1 staked using this tilt (min gap):`);
    for (const minGap of GAP_THRESHOLDS) {
      const trades = withVariant
        .map((s) => ({ ...s, gap: s[key]! - s.livePriceAtEntry }))
        .filter((s) => Math.abs(s.gap) >= minGap);
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
  reportConvictionVariant("v18a: cost * confidenceMultiplier (dollar-linear, conviction-scaled)", "smartPctCostConviction");
  reportConvictionVariant("v18b: sqrt(cost) * confidenceMultiplier (sqrt-dampened, conviction-scaled)", "smartPctSqrtConviction");
  reportConvictionVariant("v18c: confidenceMultiplier alone (equal base, conviction-scaled only)", "smartPctConvictionOnly");

  // ── EXPERIMENTAL (v19): completes the 2x2 size-scaling x skill grid. ──
  const withGrid = currentVersionAll.filter(
    (s) => s.smartPctSqrtDollar !== undefined && s.dollarPct !== undefined && s.smartPctLinear !== undefined
  );
  console.log(`\nEXPERIMENTAL: the full size-scaling x skill grid, n=${withGrid.length}:`);
  if (withGrid.length === 0) {
    console.log("  No entries have smartPctSqrtDollar yet.");
  } else {
    const dollarBrierGrid = mean(withGrid.map((s) => brier(s.dollarPct!, s.actual)));
    const sqrtDollarBrier = mean(withGrid.map((s) => brier(s.smartPctSqrtDollar!, s.actual)));
    const linearBrierGrid = mean(withGrid.map((s) => brier(s.smartPctLinear!, s.actual)));
    const v1BrierGrid = mean(withGrid.map((s) => brier(s.smartPct, s.actual)));
    console.log("                    no skill        with skill");
    console.log(`  linear cost:      ${dollarBrierGrid.toFixed(4)} (dollarPct)  ${linearBrierGrid.toFixed(4)} (v17)`);
    console.log(`  sqrt(cost):       ${sqrtDollarBrier.toFixed(4)} (v19)       ${v1BrierGrid.toFixed(4)} (locked v1)`);
    const best = Math.min(dollarBrierGrid, sqrtDollarBrier, linearBrierGrid, v1BrierGrid);
    const bestLabel =
      best === dollarBrierGrid ? "dollarPct (linear, no skill)" : best === sqrtDollarBrier ? "v19 (sqrt, no skill)" : best === linearBrierGrid ? "v17 (linear, with skill)" : "locked v1 (sqrt, with skill)";
    console.log(`  -> best of the four: ${bestLabel} at ${best.toFixed(4)}`);

    console.log("\n  Simulated return per $1 staked using the v19 (sqrt, no skill) tilt (min gap):");
    for (const minGap of GAP_THRESHOLDS) {
      const trades = withGrid
        .map((s) => ({ ...s, gapSqrtDollar: s.smartPctSqrtDollar! - s.livePriceAtEntry }))
        .filter((s) => Math.abs(s.gapSqrtDollar) >= minGap);
      if (trades.length === 0) {
        console.log(`    >=${(minGap * 100).toFixed(0)}pt gap: n=0`);
        continue;
      }
      const profits = trades.map((s) => (s.gapSqrtDollar >= 0 ? s.actual - s.livePriceAtEntry : s.livePriceAtEntry - s.actual));
      const avgProfit = mean(profits);
      const winRate = mean(profits.map((p) => (p > 0 ? 1 : 0)));
      console.log(
        `    >=${(minGap * 100).toFixed(0)}pt gap: n=${trades.length}, avg profit/$1=${avgProfit >= 0 ? "+" : ""}${avgProfit.toFixed(3)}, win rate=${(winRate * 100).toFixed(1)}%`
      );
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
