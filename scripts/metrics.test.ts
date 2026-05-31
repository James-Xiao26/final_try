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
    ...overrides
  };
}

function metrics(overrides: Partial<WalletMetrics> = {}): WalletMetrics {
  return {
    horizonDays: 90,
    skillScore: null,
    pctReturn: 0.4,
    winRate: 0.65,
    maxDrawdown: 0.1,
    totalPnlUsd: 1000,
    unrealizedPnlUsd: 0,
    totalVolumeUsd: 5000,
    avgEntryPrice: 0.5,
    nTrades: CONFIG.MIN_TRADES,
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

test("computeMetrics derives return, win rate, and drawdown from the realized path", () => {
  // Cumulative path +100 -> +50 -> +100: peak 100, trough 50 => max drawdown 0.5.
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
  assert.equal(m.maxDrawdown, 0.5);
  assert.equal(m.nTrades, 3);
});

test("computeMetrics clamps drawdown to 1 when the PnL path dips far below a small early peak", () => {
  // Cumulative path +10 -> -990: raw ratio (10 - -990)/10 = 100, must be capped at 1.0 so it
  // stays within max_drawdown's NUMERIC(6,4) column and doesn't blow up the skill-score penalty.
  const positions = [
    position({ realizedPnl: 10, closeTime: recentIso(2) }),
    position({ realizedPnl: -1000, closeTime: recentIso(1) })
  ];
  const m = computeMetrics(positions, 30, CONFIG);
  assert.equal(m.maxDrawdown, 1);
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
  assert.equal(withUnrealized.maxDrawdown, realizedOnly.maxDrawdown);
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
  // rawScore = 0.4*0.5 + 0.65*0.25 + 0.5774*0.1 ~= 0.42024 -> *0.8309*1000 ~= 349.19.
  const score = computeSkillScore(
    metrics({ nTrades: CONFIG.MIN_TRADES, pctReturn: 0.4, winRate: 0.65, maxDrawdown: 0.1 }),
    CONFIG
  );
  approx(score, 349.19);
});

test("computeSkillScore saturates confidence at MIN_TRADES * 3", () => {
  const at60 = computeSkillScore(metrics({ nTrades: CONFIG.MIN_TRADES * 3, maxDrawdown: 0.1 }), CONFIG);
  const at200 = computeSkillScore(metrics({ nTrades: 200, maxDrawdown: 0.1 }), CONFIG);
  // confidence == 1, multiplier == 1: rawScore = 0.4*0.5 + 0.65*0.25 + 1*0.1 = 0.4625.
  approx(at60, 462.5);
  assert.equal(at60, at200);
});

test("computeSkillScore no longer guts a thin-but-eligible sample (floor holds)", () => {
  const thin = computeSkillScore(metrics({ nTrades: CONFIG.MIN_TRADES, maxDrawdown: 0.1 }), CONFIG);
  const full = computeSkillScore(metrics({ nTrades: CONFIG.MIN_TRADES * 3, maxDrawdown: 0.1 }), CONFIG);
  assert.ok(thin !== null && full !== null);
  // Old linear ramp retained only ~26% at the minimum; the 0.6 floor keeps it well above that.
  assert.ok(thin / full >= 0.6);
});

test("computeSkillScore penalizes drawdown beyond the threshold", () => {
  // maxDrawdown 0.6 -> penalty (0.6 - 0.2)/0.8 = 0.5; nTrades 60 -> multiplier 1.
  // rawScore = 0.2 + 0.1625 + 0.1 - 0.5*0.15 = 0.3875 -> 387.5.
  const score = computeSkillScore(metrics({ nTrades: CONFIG.MIN_TRADES * 3, maxDrawdown: 0.6 }), CONFIG);
  approx(score, 387.5);
});
