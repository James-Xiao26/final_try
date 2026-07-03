import test from "node:test";
import assert from "node:assert/strict";
import { CONFIG } from "./config.js";
import { computeMetrics, computeSkillScore, excludeArbitrage, ineligibilityReason, isLongshotChurner, isScorableMarket, type WalletMetrics } from "./metrics.js";
import type { ClosedPosition } from "./polymarket.js";

const recentIso = (daysAgo: number): string =>
  new Date(Date.now() - daysAgo * CONFIG.SECONDS_PER_DAY * CONFIG.MS_PER_SECOND).toISOString();

function position(overrides: Partial<ClosedPosition> = {}): ClosedPosition {
  return {
    proxyWallet: "0xabc",
    asset: "asset",
    conditionId: "cond",
    market: "market",
    outcomeIndex: 0,
    size: 100,
    avgPrice: 1,
    realizedPnl: 0,
    closeTime: recentIso(1),
    outcome: null,
    outcomeLabel: null,
    eventSlug: null,
    ...overrides
  };
}

function metrics(overrides: Partial<WalletMetrics> = {}): WalletMetrics {
  return {
    horizonDays: 90,
    skillScore: null,
    pctReturn: 0.4,
    winRate: 0.65,
    totalPnlUsd: 1000,
    unrealizedPnlUsd: 0,
    totalVolumeUsd: 5000,
    avgEntryPrice: 0.5,
    nTrades: CONFIG.MIN_TRADES,
    pctEdge: 0,
    avgEdgePerShare: 0,
    nResolved: 0,
    ineligibleReason: null,
    equityCurve: [],
    ...overrides
  };
}

function approx(actual: number | null, expected: number, eps = 0.01): void {
  assert.ok(actual !== null, "expected a number, got null");
  assert.ok(Math.abs(actual - expected) <= eps, `expected ~${expected}, got ${actual}`);
}

// --- computeMetrics: raw per-horizon derivation -----------------------------

test("computeMetrics derives return and win rate from the realized path", () => {
  const positions = [
    position({ realizedPnl: 100, closeTime: recentIso(3) }),
    position({ realizedPnl: -50, closeTime: recentIso(2) }),
    position({ realizedPnl: 50, closeTime: recentIso(1) })
  ];
  const m = computeMetrics(positions, 30, CONFIG);
  assert.equal(m.totalPnlUsd, 100);
  assert.equal(m.totalVolumeUsd, 300);
  assert.equal(m.pctReturn, 0.3333);
  assert.equal(m.winRate, 0.6667);
  assert.equal(m.nTrades, 3);
});

test("computeMetrics computes a volume-weighted average entry price", () => {
  // 100 shares @ $0.10 + 300 shares @ $0.50: cost 10 + 150 = 160 over 400 shares => $0.40.
  // A simple mean of the two prices would be $0.30, so this confirms share-weighting.
  const positions = [
    position({ size: 100, avgPrice: 0.1, closeTime: recentIso(2) }),
    position({ size: 300, avgPrice: 0.5, closeTime: recentIso(1) })
  ];
  const m = computeMetrics(positions, 30, CONFIG);
  assert.equal(m.avgEntryPrice, 0.4);
});

test("computeMetrics folds resolved losses in, lowering win rate and return", () => {
  // Three winners alone => 100% win rate, positive return (the old winner-biased view).
  const winnersOnly = [
    position({ realizedPnl: 100, size: 100, avgPrice: 0.5, closeTime: recentIso(3) }),
    position({ realizedPnl: 80, size: 100, avgPrice: 0.5, closeTime: recentIso(2) }),
    position({ realizedPnl: 120, size: 100, avgPrice: 0.5, closeTime: recentIso(1) })
  ];
  const biased = computeMetrics(winnersOnly, 30, CONFIG);
  assert.equal(biased.winRate, 1);

  // Add two resolved losers (as resolvedToClosed would produce: realizedPnl < 0). Win rate and
  // return must drop once the abandoned losses are counted.
  const withLosses = [
    ...winnersOnly,
    position({ realizedPnl: -200, size: 400, avgPrice: 0.5, closeTime: recentIso(2) }),
    position({ realizedPnl: -150, size: 300, avgPrice: 0.5, closeTime: recentIso(1) })
  ];
  const corrected = computeMetrics(withLosses, 30, CONFIG);
  assert.equal(corrected.winRate, 0.6); // 3 wins of 5
  assert.ok(corrected.pctReturn < biased.pctReturn);
});

test("computeMetrics excludes positions older than the horizon", () => {
  const positions = [
    position({ realizedPnl: 10, closeTime: recentIso(5) }),
    position({ realizedPnl: 20, closeTime: recentIso(10) }),
    position({ realizedPnl: 30, closeTime: recentIso(400) })
  ];
  const m = computeMetrics(positions, 30, CONFIG);
  assert.equal(m.nTrades, 2);
  assert.equal(m.totalPnlUsd, 30);
});

test("isScorableMarket rejects recurring 'Up or Down' windowed markets, keeps everything else", () => {
  assert.equal(isScorableMarket("Bitcoin Up or Down - May 31, 1:55PM-2:00PM ET"), false);
  assert.equal(isScorableMarket("Ethereum Up or Down - June 3, 9:00AM-9:15AM ET"), false);
  // A once-daily variant has no time range, so it isn't the recurring-window template.
  assert.equal(isScorableMarket("S&P 500 (SPX) Up or Down on March 2?"), true);
  assert.equal(isScorableMarket("Will Bitcoin reach $150,000 by 2026?"), true);
});

test("computeMetrics excludes recurring 'Up or Down' windowed positions from every metric", () => {
  const positions = [
    position({ realizedPnl: 500, market: "Bitcoin Up or Down - May 31, 1:55PM-2:00PM ET", outcome: 1, avgPrice: 0.4, size: 1000 }),
    position({ realizedPnl: 10, market: "Will Bitcoin reach $150,000 by 2026?", outcome: 1, avgPrice: 0.5, size: 20 })
  ];
  const m = computeMetrics(positions, 90, CONFIG);
  // Only the non-windowed position counts, as if the windowed one were never in the array.
  assert.equal(m.nTrades, 1);
  assert.equal(m.totalPnlUsd, 10);
  assert.equal(m.nResolved, 1);
});

test("excludeArbitrage strips only positions in a flagged conditionId, leaves everything else", () => {
  const positions = [
    position({ conditionId: "arb-market", realizedPnl: 100 }),
    position({ conditionId: "clean-market", realizedPnl: 50 })
  ];
  const filtered = excludeArbitrage(positions, new Set(["arb-market"]));
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0]?.conditionId, "clean-market");
});

test("excludeArbitrage is a no-op with an empty exclusion set", () => {
  const positions = [position({ conditionId: "c1" }), position({ conditionId: "c2" })];
  assert.deepEqual(excludeArbitrage(positions, new Set()), positions);
});

test("computeMetrics handles an empty position set without dividing by zero", () => {
  const m = computeMetrics([], 30, CONFIG);
  assert.equal(m.nTrades, 0);
  assert.equal(m.pctReturn, 0);
  assert.equal(m.winRate, 0);
  assert.equal(m.totalVolumeUsd, 0);
  assert.equal(m.skillScore, null);
  assert.equal(m.equityCurve.length, 0); // no closed positions and no open exposure => empty curve
});

// --- computeMetrics: Total P/L (realized + current unrealized) --------------

test("computeMetrics folds current unrealized PnL into totalPnlUsd and the curve endpoint", () => {
  const positions = [
    position({ realizedPnl: 100, closeTime: recentIso(3) }),
    position({ realizedPnl: 50, closeTime: recentIso(1) })
  ];
  const m = computeMetrics(positions, 30, CONFIG, 75);
  assert.equal(m.unrealizedPnlUsd, 75);
  assert.equal(m.totalPnlUsd, 225); // realized 150 + unrealized 75
  // Final curve point is marked to market: realized cumulative 150 + unrealized 75.
  assert.equal(m.equityCurve[m.equityCurve.length - 1]?.cumulativePnl, 225);
});

test("computeMetrics lets a negative unrealized (open loser) drag the total below realized", () => {
  const positions = [position({ realizedPnl: 100, closeTime: recentIso(1) })];
  const m = computeMetrics(positions, 30, CONFIG, -160);
  assert.equal(m.unrealizedPnlUsd, -160);
  assert.equal(m.totalPnlUsd, -60); // realized 100 + unrealized -160
  assert.equal(m.equityCurve[m.equityCurve.length - 1]?.cumulativePnl, -60);
});

test("computeMetrics clamps a future close date into today (no future-dated curve point)", () => {
  const today = new Date().toISOString().slice(0, 10);
  // A sold position whose closeTime is reported as the market's future end date.
  const future = new Date(Date.now() + 30 * CONFIG.SECONDS_PER_DAY * CONFIG.MS_PER_SECOND).toISOString();
  const positions = [
    position({ realizedPnl: 100, closeTime: recentIso(2) }),
    position({ realizedPnl: 40, closeTime: future })
  ];
  const m = computeMetrics(positions, 90, CONFIG, 0);
  // No curve point lands beyond today, and the right edge holds the full realized total.
  assert.ok(m.equityCurve.every((p) => p.ts <= today), "no future-dated curve point");
  assert.equal(m.equityCurve[m.equityCurve.length - 1]?.ts, today);
  assert.equal(m.equityCurve[m.equityCurve.length - 1]?.cumulativePnl, 140);
});

test("computeMetrics with only open exposure emits a single today point", () => {
  const m = computeMetrics([], 30, CONFIG, 40);
  assert.equal(m.nTrades, 0);
  assert.equal(m.totalPnlUsd, 40);
  assert.equal(m.equityCurve.length, 1);
  assert.equal(m.equityCurve[0]?.cumulativePnl, 40);
});

test("unrealized PnL does not affect realized scoring inputs or the skill score", () => {
  const positions = [
    position({ realizedPnl: 100, size: 100, avgPrice: 0.5, closeTime: recentIso(3) }),
    position({ realizedPnl: -40, size: 100, avgPrice: 0.5, closeTime: recentIso(2) }),
    position({ realizedPnl: 60, size: 100, avgPrice: 0.5, closeTime: recentIso(1) })
  ];
  const realizedOnly = computeMetrics(positions, 30, CONFIG, 0);
  const withUnrealized = computeMetrics(positions, 30, CONFIG, 500);
  // Scoring stays strictly realized: only totalPnlUsd / unrealizedPnlUsd / the curve endpoint move.
  assert.equal(withUnrealized.pctReturn, realizedOnly.pctReturn);
  assert.equal(withUnrealized.winRate, realizedOnly.winRate);
  assert.equal(withUnrealized.skillScore, realizedOnly.skillScore);
});

// --- computeSkillScore: eligibility gate ------------------------------------

test("computeSkillScore is null below the trade minimum", () => {
  assert.equal(computeSkillScore(metrics({ nTrades: CONFIG.MIN_TRADES - 1 }), CONFIG), null);
});

test("computeSkillScore is null below the volume minimum", () => {
  assert.equal(computeSkillScore(metrics({ totalVolumeUsd: CONFIG.MIN_VOLUME_USD - 1 }), CONFIG), null);
});

test("computeSkillScore is null for sub-cent longshot traders (low avg entry price)", () => {
  assert.equal(computeSkillScore(metrics({ avgEntryPrice: 0.005 }), CONFIG), null);
  // At/above the floor, the wallet stays eligible (gate is strict less-than).
  assert.ok(computeSkillScore(metrics({ avgEntryPrice: CONFIG.MIN_AVG_ENTRY_PRICE }), CONFIG) !== null);
});

// --- ineligibilityReason: same gates as computeSkillScore, broken out into a reason code ---------

test("ineligibilityReason returns null for an eligible wallet", () => {
  assert.equal(ineligibilityReason(metrics(), CONFIG), null);
});

test("ineligibilityReason flags insufficient_trades before the other gates", () => {
  assert.equal(ineligibilityReason(metrics({ nTrades: CONFIG.MIN_TRADES - 1 }), CONFIG), "insufficient_trades");
});

test("ineligibilityReason flags insufficient_volume", () => {
  assert.equal(ineligibilityReason(metrics({ totalVolumeUsd: CONFIG.MIN_VOLUME_USD - 1 }), CONFIG), "insufficient_volume");
});

test("ineligibilityReason flags longshot_entry", () => {
  assert.equal(ineligibilityReason(metrics({ avgEntryPrice: 0.005 }), CONFIG), "longshot_entry");
});

// --- isLongshotChurner: wallet-level exclusion, needs BOTH high churn AND tiny bets --------------

test("isLongshotChurner flags high churn with tiny average bets", () => {
  // ~2000 resolved positions averaging ~$160/bet (the rocky42025 profile).
  const churner = metrics({ nResolved: 1914, nTrades: 1959, totalVolumeUsd: 318_000 });
  assert.equal(isLongshotChurner(churner, CONFIG), true);
});

test("isLongshotChurner spares a legit high-volume trader (big average bets)", () => {
  // High churn but real size per bet — a whale, not a longshot farmer.
  const whale = metrics({ nResolved: 856, nTrades: 857, totalVolumeUsd: 4_799_000 });
  assert.equal(isLongshotChurner(whale, CONFIG), false);
});

test("isLongshotChurner spares a low-churn small-stakes trader", () => {
  // Tiny bets but few positions — below the churn floor, so not the pattern.
  const cautious = metrics({ nResolved: 145, nTrades: 159, totalVolumeUsd: 25_000 });
  assert.equal(isLongshotChurner(cautious, CONFIG), false);
});

// --- computeSkillScore: Bayesian-shrunk edge (0, then 4–10) -----------------
// Constants below assume EDGE_SHRINKAGE_K = 50, EDGE_FOR_TEN = 0.13, SCORE_FLOOR = 4,
// SCORE_MAX = 10. Any positive shrunk edge floors at 4: score = 4 + 6*shrunk/0.13.

test("computeSkillScore maps a positive shrunk edge into the 4–10 band", () => {
  // avgEdgePerShare 0.05 over 60 resolved: shrunk = 0.05*60/(60+50) = 0.027273;
  // score = 4 + 6 * 0.027273 / 0.13 ≈ 5.26.
  const score = computeSkillScore(metrics({ avgEdgePerShare: 0.05, nResolved: 60 }), CONFIG);
  approx(score, 5.26);
});

test("computeSkillScore shrinks a thin resolved sample toward the floor", () => {
  // Same edge, fewer resolved bets => lower score (toward SCORE_FLOOR, not 0). n=20:
  // shrunk = 0.05*20/(20+50) = 0.014286; score = 4 + 6 * 0.014286 / 0.13 ≈ 4.66.
  const thin = computeSkillScore(metrics({ avgEdgePerShare: 0.05, nResolved: 20 }), CONFIG);
  const full = computeSkillScore(metrics({ avgEdgePerShare: 0.05, nResolved: 60 }), CONFIG);
  approx(thin, 4.66);
  assert.ok(thin !== null && full !== null && thin < full);
});

test("computeSkillScore floors any positive shrunk edge at SCORE_FLOOR", () => {
  // A hair of positive edge jumps to SCORE_FLOOR (hard discontinuity at edge = 0).
  // shrunk = 0.0001*20/(20+50) ≈ 0.0000286; score = 4 + 6 * 0.0000286 / 0.13 ≈ 4.00.
  approx(computeSkillScore(metrics({ avgEdgePerShare: 0.0001, nResolved: 20 }), CONFIG), CONFIG.SCORE_FLOOR);
});

test("computeSkillScore floors negative edge to 0", () => {
  assert.equal(computeSkillScore(metrics({ avgEdgePerShare: -0.03, nResolved: 50 }), CONFIG), 0);
});

test("computeSkillScore clamps at SCORE_MAX", () => {
  // avgEdgePerShare 0.2 over 200: shrunk = 0.2*200/(200+50) = 0.16; raw score >10 -> clamped to 10.
  assert.equal(computeSkillScore(metrics({ avgEdgePerShare: 0.2, nResolved: 200 }), CONFIG), CONFIG.SCORE_MAX);
});

test("computeSkillScore is 0 with no resolved positions", () => {
  assert.equal(computeSkillScore(metrics({ avgEdgePerShare: 0, nResolved: 0 }), CONFIG), 0);
});

// --- forecasting edge -------------------------------------------------------

test("computeMetrics derives per-position mean edge (avgEdgePerShare) from outcomes", () => {
  // Per-share edges: (1-0.5)=+0.5, (1-0.4)=+0.6, (0-0.6)=-0.6. Per-position mean = 0.5/3 = 0.1667.
  // Sizes differ, so this is distinct from the share-weighted pctEdge below. The still-trading
  // position (outcome null) is excluded, not counted as a miss.
  const positions = [
    position({ size: 100, avgPrice: 0.5, outcome: 1 }),
    position({ size: 900, avgPrice: 0.4, outcome: 1 }),
    position({ size: 100, avgPrice: 0.6, outcome: 0 }),
    position({ size: 1000, avgPrice: 0.9, outcome: null })
  ];
  const m = computeMetrics(positions, 30, CONFIG);
  assert.equal(m.nResolved, 3);
  assert.equal(m.avgEdgePerShare, 0.1667); // per-position mean: 0.5 / 3
  // pctEdge is share-weighted: edge $ = 50 + 540 - 60 = 530 over capital 50 + 360 + 60 = 470.
  assert.equal(m.pctEdge, 1.1277); // 530 / 470
});

test("computeMetrics reports zero edge when no position has resolved", () => {
  const m = computeMetrics([position({ outcome: null }), position({ outcome: null })], 30, CONFIG);
  assert.equal(m.nResolved, 0);
  assert.equal(m.pctEdge, 0);
  assert.equal(m.avgEdgePerShare, 0);
});
