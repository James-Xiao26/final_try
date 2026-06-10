import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMarkToMarketCurve, type CurvePosition } from "./equityCurve.js";

const WINDOW_START = "2026-06-06";
const TODAY = "2026-06-10"; // 5 days: 06,07,08,09,10

function pnls(points: { cumulativePnl: number }[]): number[] {
  return points.map((p) => p.cumulativePnl);
}

test("buildMarkToMarketCurve marks an open position daily as its price moves", () => {
  const positions: CurvePosition[] = [{ asset: "A", size: 100, avgCost: 0.4, realizedPnl: null, closeTs: null }];
  const curve = buildMarkToMarketCurve({
    positions,
    pricesByAsset: new Map([["A", [{ ts: "2026-06-07", price: 0.4 }, { ts: "2026-06-09", price: 0.5 }]]]),
    entryByAsset: new Map([["A", "2026-06-07"]]),
    windowStartUtc: WINDOW_START,
    todayUtc: TODAY
  });
  // Not held on the 6th (entry 7th); flat at cost through the 8th; +$10 once price hits 0.50 on the 9th.
  assert.deepEqual(pnls(curve), [0, 0, 0, 10, 10]);
});

test("buildMarkToMarketCurve shows a closed-in-window position's swing then its realized step", () => {
  // Bought 100 @ 0.30, peaks at 0.55 (unrealized +25), sold for realized +20 (i.e. ~0.50) midday on the 9th.
  const positions: CurvePosition[] = [
    { asset: "B", size: 100, avgCost: 0.3, realizedPnl: 20, closeTs: "2026-06-09T12:00:00.000Z" }
  ];
  const curve = buildMarkToMarketCurve({
    positions,
    pricesByAsset: new Map([["B", [{ ts: "2026-06-06", price: 0.3 }, { ts: "2026-06-08", price: 0.55 }]]]),
    entryByAsset: new Map([["B", "2026-06-06"]]),
    windowStartUtc: WINDOW_START,
    todayUtc: TODAY
  });
  // 6th/7th flat at cost; +25 unrealized on the 8th, still open (held) at 00:00 on the 9th;
  // on the 10th it's closed → unrealized drops out, realized +20 folds in.
  assert.deepEqual(pnls(curve), [0, 0, 25, 25, 20]);
});

test("buildMarkToMarketCurve falls back to zero unrealized when a token has no cached price", () => {
  const positions: CurvePosition[] = [{ asset: "C", size: 50, avgCost: 0.2, realizedPnl: null, closeTs: null }];
  const curve = buildMarkToMarketCurve({
    positions,
    pricesByAsset: new Map(),
    entryByAsset: new Map([["C", "2026-06-06"]]),
    windowStartUtc: WINDOW_START,
    todayUtc: TODAY
  });
  assert.deepEqual(pnls(curve), [0, 0, 0, 0, 0]);
});

test("buildMarkToMarketCurve endpoint equals realized-in-window + current unrealized", () => {
  const positions: CurvePosition[] = [
    { asset: "A", size: 100, avgCost: 0.4, realizedPnl: null, closeTs: null }, // open, +10 at today
    { asset: "B", size: 100, avgCost: 0.3, realizedPnl: 20, closeTs: "2026-06-08T00:00:00.000Z" } // realized +20
  ];
  const curve = buildMarkToMarketCurve({
    positions,
    pricesByAsset: new Map([["A", [{ ts: "2026-06-06", price: 0.4 }, { ts: "2026-06-10", price: 0.5 }]]]),
    entryByAsset: new Map([["A", "2026-06-06"], ["B", "2026-06-06"]]),
    windowStartUtc: WINDOW_START,
    todayUtc: TODAY
  });
  assert.equal(curve[curve.length - 1]?.cumulativePnl, 30); // 20 realized + 10 unrealized
});

test("buildMarkToMarketCurve clamps an entry that predates the window to the window start", () => {
  const positions: CurvePosition[] = [{ asset: "A", size: 100, avgCost: 0.4, realizedPnl: null, closeTs: null }];
  const curve = buildMarkToMarketCurve({
    positions,
    pricesByAsset: new Map([["A", [{ ts: "2026-06-06", price: 0.5 }]]]),
    entryByAsset: new Map([["A", "2026-01-01"]]), // long before the window
    windowStartUtc: WINDOW_START,
    todayUtc: TODAY
  });
  // Held from the very first window day at price 0.50 → +$10 throughout.
  assert.deepEqual(pnls(curve), [10, 10, 10, 10, 10]);
});
