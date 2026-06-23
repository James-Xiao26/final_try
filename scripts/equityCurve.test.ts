import assert from "node:assert/strict";
import { test } from "node:test";
import { simulateCopyCurve, type CopyTrade } from "./equityCurve.js";

const WINDOW_START = "2026-06-06";
const TODAY = "2026-06-10";

function values(points: { cumulativePnl: number }[]): number[] {
  return points.map((p) => p.cumulativePnl);
}

test("starts at $100 and stays flat with no trades or open positions", () => {
  const curve = simulateCopyCurve({ closed: [], open: [], windowStartUtc: WINDOW_START, todayUtc: TODAY });
  // Baseline at window start + a today point, both at the starting stake.
  assert.deepEqual(values(curve), [100, 100]);
});

test("a winning resolved trade grows the balance; sizing is 1% of running balance", () => {
  // 1% of $100 = $1; at 0.50/share → round(1/0.5)=2 shares, cost $1, wins $2 → +$1 profit.
  const closed: CopyTrade[] = [
    { avgPrice: 0.5, size: 100, outcome: 1, realizedPnl: 999, closeTime: "2026-06-08T00:00:00.000Z" }
  ];
  const curve = simulateCopyCurve({ closed, open: [], windowStartUtc: WINDOW_START, todayUtc: TODAY });
  assert.deepEqual(values(curve), [100, 101, 101]); // start, step on the 8th, flat to today
});

test("a losing resolved trade only risks the staked cost", () => {
  // 1% of $100 = $1; 0.50/share → 2 shares, cost $1, outcome 0 → lose $1.
  const closed: CopyTrade[] = [
    { avgPrice: 0.5, size: 100, outcome: 0, realizedPnl: -999, closeTime: "2026-06-08T00:00:00.000Z" }
  ];
  const curve = simulateCopyCurve({ closed, open: [], windowStartUtc: WINDOW_START, todayUtc: TODAY });
  assert.deepEqual(values(curve), [100, 99, 99]);
});

test("unknown outcome falls back to the trader's realized result, scaled to our shares", () => {
  // outcome null. Trader made +$50 on 100 shares → +$0.50/share realized. We buy 2 shares → +$1.
  const closed: CopyTrade[] = [
    { avgPrice: 0.5, size: 100, outcome: null, realizedPnl: 50, closeTime: "2026-06-08T00:00:00.000Z" }
  ];
  const curve = simulateCopyCurve({ closed, open: [], windowStartUtc: WINDOW_START, todayUtc: TODAY });
  assert.deepEqual(values(curve), [100, 101, 101]);
});

test("balance compounds across trades, sizing off the running balance", () => {
  // Cheap shares so the grown balance buys strictly more on the second trade (compounding visible).
  // T1: 1% of $100 = $1 → round(1/0.1)=10 shares @0.10, win → +$9 → $109.
  // T2: 1% of $109 = $1.09 → round(1.09/0.1)=11 shares @0.10, cost $1.10, win → +$9.90 → $118.90.
  const closed: CopyTrade[] = [
    { avgPrice: 0.1, size: 100, outcome: 1, realizedPnl: 0, closeTime: "2026-06-07T00:00:00.000Z" },
    { avgPrice: 0.1, size: 100, outcome: 1, realizedPnl: 0, closeTime: "2026-06-08T00:00:00.000Z" }
  ];
  const curve = simulateCopyCurve({ closed, open: [], windowStartUtc: WINDOW_START, todayUtc: TODAY });
  assert.deepEqual(values(curve), [100, 109, 118.9, 118.9]);
});

test("open position adds a today mark-to-market at its current price", () => {
  // No closed trades; one open position bought at 0.40, now 0.50. 1% of $100 = $1 → round(1/0.4)=3 shares,
  // unrealized = 3 × (0.50 − 0.40) = +$0.30.
  const curve = simulateCopyCurve({
    closed: [],
    open: [{ avgPrice: 0.4, curPrice: 0.5 }],
    windowStartUtc: WINDOW_START,
    todayUtc: TODAY
  });
  assert.deepEqual(values(curve), [100, 100.3]);
});

test("trades outside the window are ignored", () => {
  const closed: CopyTrade[] = [
    { avgPrice: 0.5, size: 100, outcome: 1, realizedPnl: 0, closeTime: "2026-05-01T00:00:00.000Z" } // before window
  ];
  const curve = simulateCopyCurve({ closed, open: [], windowStartUtc: WINDOW_START, todayUtc: TODAY });
  assert.deepEqual(values(curve), [100, 100]);
});

test("balance is clamped at zero on absurd loss data", () => {
  const closed: CopyTrade[] = [
    { avgPrice: 0.5, size: 1, outcome: null, realizedPnl: -1e9, closeTime: "2026-06-08T00:00:00.000Z" }
  ];
  const curve = simulateCopyCurve({ closed, open: [], windowStartUtc: WINDOW_START, todayUtc: TODAY });
  assert.ok(curve.every((p) => p.cumulativePnl >= 0));
});

test("balance stays under the NUMERIC(14,2) ceiling on explosive longshot compounding", () => {
  // Sub-penny winners: each $stake buys ~200x in shares and pays ~200x — compounds past $1T without a cap.
  const closed: CopyTrade[] = Array.from({ length: 30 }, (_, i) => ({
    avgPrice: 0.005,
    size: 1000,
    outcome: 1,
    realizedPnl: 0,
    closeTime: `2026-06-${String(7 + (i % 3)).padStart(2, "0")}T0${i % 9}:00:00.000Z`
  }));
  const curve = simulateCopyCurve({ closed, open: [], windowStartUtc: WINDOW_START, todayUtc: TODAY });
  // Must fit numeric(14,2): |value| < 10^12. The cap (1e11) keeps it safely under.
  assert.ok(curve.every((p) => p.cumulativePnl < 1e12), "every point fits the column");
  assert.equal(curve[curve.length - 1]?.cumulativePnl, 1e11, "pegs at the ceiling, not beyond");
});
