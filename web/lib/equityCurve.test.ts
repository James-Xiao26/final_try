import assert from "node:assert/strict";
import { test } from "node:test";
import { windowedCurve } from "./equityCurve";
import type { EquityPoint } from "./types";

const MS_PER_DAY = 86_400_000;

test("windowedCurve prepends a $0 baseline at the window start when the first close is inside the window", () => {
  const points: EquityPoint[] = [
    { ts: "2026-05-20", cumulativePnl: 1200 },
    { ts: "2026-06-09", cumulativePnl: 1800 }
  ];
  const { points: out, startMs, endMs } = windowedCurve(points, 30);

  assert.equal(endMs, Date.parse("2026-06-09"));
  assert.equal(startMs, Date.parse("2026-06-09") - 30 * MS_PER_DAY);

  // Baseline prepended at the window start, at $0.
  assert.equal(out.length, 3);
  const [baseline] = out;
  assert.ok(baseline);
  assert.equal(baseline.cumulativePnl, 0);
  assert.equal(baseline.ts, new Date(startMs).toISOString().slice(0, 10));
  // Original points preserved after the baseline.
  assert.deepEqual(out.slice(1), points);
});

test("windowedCurve uses the horizon length for the window (90-day)", () => {
  const points: EquityPoint[] = [
    { ts: "2026-04-15", cumulativePnl: -300 },
    { ts: "2026-06-09", cumulativePnl: 500 }
  ];
  const { startMs, endMs } = windowedCurve(points, 90);
  assert.equal(endMs, Date.parse("2026-06-09"));
  assert.equal(startMs, Date.parse("2026-06-09") - 90 * MS_PER_DAY);
});

test("windowedCurve does not prepend when the first point is at/before the window start", () => {
  const endTs = "2026-06-09";
  const startMs = Date.parse(endTs) - 30 * MS_PER_DAY;
  const onBoundary = new Date(startMs).toISOString().slice(0, 10);
  const points: EquityPoint[] = [
    { ts: onBoundary, cumulativePnl: 400 },
    { ts: endTs, cumulativePnl: 900 }
  ];
  const { points: out } = windowedCurve(points, 30);
  assert.equal(out.length, 2);
  assert.deepEqual(out, points);
});

test("windowedCurve endMs equals the last point's parsed ts", () => {
  const points: EquityPoint[] = [
    { ts: "2026-06-01", cumulativePnl: 10 },
    { ts: "2026-06-05", cumulativePnl: 20 },
    { ts: "2026-06-09", cumulativePnl: 30 }
  ];
  const { endMs } = windowedCurve(points, 30);
  assert.equal(endMs, Date.parse("2026-06-09"));
});
