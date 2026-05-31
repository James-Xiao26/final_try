import test from "node:test";
import assert from "node:assert/strict";
import { CONFIG } from "./config.js";
import { computeMetrics, computeSkillScore, type WalletMetrics } from "./metrics.js";
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
    outlierFlag: false,
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

test("computeSkillScore is null when a single win dominates PnL", () => {
  assert.equal(computeSkillScore(metrics({ outlierFlag: true }), CONFIG), null);
});

// --- computeSkillScore: sample-size confidence (sqrt ramp + floor) ----------

test("computeSkillScore applies the sqrt confidence ramp and floor at the trade minimum", () => {
  // nTrades == MIN_TRADES: confidence = sqrt(1/3) ~= 0.5774.
  // multiplier = 0.6 + 0.4 * 0.5774 ~= 0.8309.
  // edge term is 0 here (nResolved 0). rawScore = 0.4*0.4 + 0.65*0.2 + 0.5774*0.05 ~= 0.31887
  //   -> *0.8309*1000 ~= 264.96.
  const score = computeSkillScore(
    metrics({ nTrades: CONFIG.MIN_TRADES, pctReturn: 0.4, winRate: 0.65 }),
    CONFIG
  );
  approx(score, 264.96);
});

test("computeSkillScore saturates confidence at MIN_TRADES * 3", () => {
  const at60 = computeSkillScore(metrics({ nTrades: CONFIG.MIN_TRADES * 3 }), CONFIG);
  const at200 = computeSkillScore(metrics({ nTrades: 200 }), CONFIG);
  // confidence == 1, multiplier == 1, edge term 0: rawScore = 0.4*0.4 + 0.65*0.2 + 1*0.05 = 0.34.
  approx(at60, 340);
  assert.equal(at60, at200);
});

test("computeSkillScore no longer guts a thin-but-eligible sample (floor holds)", () => {
  const thin = computeSkillScore(metrics({ nTrades: CONFIG.MIN_TRADES }), CONFIG);
  const full = computeSkillScore(metrics({ nTrades: CONFIG.MIN_TRADES * 3 }), CONFIG);
  assert.ok(thin !== null && full !== null);
  // Old linear ramp retained only ~26% at the minimum; the 0.6 floor keeps it well above that.
  assert.ok(thin / full >= 0.6);
});

// --- forecasting edge -------------------------------------------------------

test("computeMetrics derives forecasting edge from resolved-position outcomes", () => {
  // Edge $ = size * (outcome - entryPrice), summed over resolved positions:
  //   100@0.5 win  -> +50,  100@0.4 win -> +60,  100@0.6 loss -> -60  => +50 over $150 capital.
  // The still-trading position (outcome null) is excluded, not counted as a miss.
  const positions = [
    position({ size: 100, avgPrice: 0.5, outcome: 1 }),
    position({ size: 100, avgPrice: 0.4, outcome: 1 }),
    position({ size: 100, avgPrice: 0.6, outcome: 0 }),
    position({ size: 1000, avgPrice: 0.9, outcome: null })
  ];
  const m = computeMetrics(positions, 30, CONFIG);
  assert.equal(m.nResolved, 3);
  assert.equal(m.pctEdge, 0.3333); // 50 / 150
  assert.equal(m.avgEdgePerShare, 0.1667); // 50 / 300 shares
});

test("computeMetrics reports zero edge when no position has resolved", () => {
  const m = computeMetrics([position({ outcome: null }), position({ outcome: null })], 30, CONFIG);
  assert.equal(m.nResolved, 0);
  assert.equal(m.pctEdge, 0);
  assert.equal(m.avgEdgePerShare, 0);
});

test("computeSkillScore rewards forecasting edge once the resolved sample is large enough", () => {
  // nResolved 0 -> edge term is exactly 0 (baseline 340). At MIN_RESOLVED*3 the edge confidence
  // saturates to 1, adding pctEdge 0.5 * 1 * weight 0.2 * 1000 = +100.
  const base = computeSkillScore(
    metrics({ nTrades: CONFIG.MIN_TRADES * 3, pctEdge: 0.5, nResolved: 0 }),
    CONFIG
  );
  const withEdge = computeSkillScore(
    metrics({ nTrades: CONFIG.MIN_TRADES * 3, pctEdge: 0.5, nResolved: CONFIG.MIN_RESOLVED * 3 }),
    CONFIG
  );
  approx(base, 340);
  approx(withEdge, 440);
});

test("computeSkillScore discounts edge for a thin resolved sample", () => {
  // nResolved == MIN_RESOLVED: edgeConfidence = sqrt(1/3) ~= 0.5774.
  // edge contribution = 0.5 * 0.5774 * 0.2 ~= 0.05774; rawScore = 0.34 + 0.05774 -> ~397.74.
  const thin = computeSkillScore(
    metrics({ nTrades: CONFIG.MIN_TRADES * 3, pctEdge: 0.5, nResolved: CONFIG.MIN_RESOLVED }),
    CONFIG
  );
  approx(thin, 397.74);
});
