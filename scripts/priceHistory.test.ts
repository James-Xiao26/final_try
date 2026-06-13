import assert from "node:assert/strict";
import { test } from "node:test";
import { dailyPointsFromHistory, planPriceFetches, type CacheState, type RawHistory } from "./priceHistory.js";

const MS_PER_DAY = 86_400_000;
// Fixed "now" for deterministic windowing: 2026-06-10T00:00:00Z.
const NOW_MS = Date.UTC(2026, 5, 10);
const day = (y: number, m: number, d: number): number => Math.floor(Date.UTC(y, m, d) / 1000); // unix seconds

test("dailyPointsFromHistory keeps the last point per UTC day, sorted ascending", () => {
  const history: RawHistory[] = [
    { t: day(2026, 5, 8), p: 0.4 },
    { t: day(2026, 5, 8) + 3600, p: 0.45 }, // same day, later → wins
    { t: day(2026, 5, 9), p: 0.5 }
  ];
  const out = dailyPointsFromHistory(history, 90, NOW_MS);
  assert.deepEqual(out, [
    { ts: "2026-06-08", price: 0.45 },
    { ts: "2026-06-09", price: 0.5 }
  ]);
});

test("dailyPointsFromHistory drops points older than the horizon window", () => {
  const history: RawHistory[] = [
    { t: Math.floor((NOW_MS - 120 * MS_PER_DAY) / 1000), p: 0.1 }, // 120d ago, outside 90d
    { t: Math.floor((NOW_MS - 10 * MS_PER_DAY) / 1000), p: 0.7 } // inside
  ];
  const out = dailyPointsFromHistory(history, 90, NOW_MS);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.price, 0.7);
});

test("dailyPointsFromHistory handles empty / malformed input", () => {
  assert.deepEqual(dailyPointsFromHistory([], 90, NOW_MS), []);
  assert.deepEqual(dailyPointsFromHistory([{ t: NaN, p: 0.5 }], 90, NOW_MS), []);
  assert.deepEqual(dailyPointsFromHistory([{ t: day(2026, 5, 9), p: NaN }], 90, NOW_MS), []);
});

test("planPriceFetches fetches never-seen assets and skips resolved+cached ones", () => {
  const state = new Map<string, CacheState>([
    ["resolved", { maxTs: "2026-05-01", resolved: true }],
    ["staleOpen", { maxTs: "2026-06-08", resolved: false }] // unresolved, tail behind today
  ]);
  const { fetch, deferred } = planPriceFetches(["new", "resolved", "staleOpen"], state, "2026-06-10", 100);
  assert.deepEqual(fetch.sort(), ["new", "staleOpen"]);
  assert.equal(deferred, 0);
});

test("planPriceFetches skips an unresolved asset already fresh through today", () => {
  const state = new Map<string, CacheState>([["fresh", { maxTs: "2026-06-10", resolved: false }]]);
  const { fetch } = planPriceFetches(["fresh"], state, "2026-06-10", 100);
  assert.deepEqual(fetch, []);
});

test("planPriceFetches caps the batch and reports the deferred remainder", () => {
  const { fetch, deferred } = planPriceFetches(["a", "b", "c", "d"], new Map(), "2026-06-10", 2);
  assert.equal(fetch.length, 2);
  assert.equal(deferred, 2);
});

test("planPriceFetches dedupes repeated assets in the needed list", () => {
  const { fetch } = planPriceFetches(["a", "a", "a"], new Map(), "2026-06-10", 100);
  assert.deepEqual(fetch, ["a"]);
});
