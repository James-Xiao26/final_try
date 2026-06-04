import assert from "node:assert/strict";
import { test } from "node:test";
import { recentTradesFromActivity } from "./recentTrades.js";
import type { TradeActivity } from "./polymarket.js";

function activity(partial: Partial<TradeActivity>): TradeActivity {
  return {
    proxyWallet: "0xabc",
    timestamp: 0,
    conditionId: "c1",
    size: 10,
    usdcSize: 5,
    price: 0.5,
    side: "BUY",
    asset: "a1",
    outcomeIndex: 0,
    market: "Will it rain?",
    transactionHash: null,
    ...partial
  };
}

function approx(actual: number | null, expected: number, tolerance = 1e-9): void {
  assert.ok(actual !== null && Math.abs(actual - expected) <= tolerance, `expected ~${expected}, got ${actual}`);
}

const NOW_SEC = 1_700_000_000;
const CUTOFF_MS = NOW_SEC * 1000 - 24 * 60 * 60 * 1000;

test("recentTradesFromActivity keeps only fills at/after the cutoff", () => {
  // Distinct conditionIds so each stays its own row (same-market fills would otherwise group).
  const rows = recentTradesFromActivity(
    [
      activity({ timestamp: NOW_SEC, conditionId: "fresh", market: "fresh" }),
      activity({ timestamp: NOW_SEC - 23 * 60 * 60, conditionId: "within", market: "within" }),
      activity({ timestamp: NOW_SEC - 25 * 60 * 60, conditionId: "stale", market: "stale" })
    ],
    "0xABC",
    CUTOFF_MS
  );
  assert.equal(rows.length, 2);
  // Sorted by most-recent fill first.
  assert.deepEqual(rows.map((row) => row.market), ["fresh", "within"]);
});

test("recentTradesFromActivity groups repeated fills on a market into one averaged row", () => {
  const rows = recentTradesFromActivity(
    [
      activity({ timestamp: NOW_SEC - 100, conditionId: "m1", outcomeIndex: 0, side: "BUY", size: 100, price: 0.4, usdcSize: 40 }),
      activity({ timestamp: NOW_SEC, conditionId: "m1", outcomeIndex: 0, side: "BUY", size: 300, price: 0.6, usdcSize: 180 })
    ],
    "0xabc",
    0
  );
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.ok(row);
  // Volume-weighted average cost: (100*0.40 + 300*0.60) / 400 = 0.55.
  approx(row.price, 0.55);
  assert.equal(row.size, 400); // summed shares
  assert.equal(row.usdcSize, 220); // summed dollars
  assert.equal(row.tradedAt, new Date(NOW_SEC * 1000).toISOString()); // latest fill time
});

test("recentTradesFromActivity keeps buys, sells, and outcome tokens as separate rows", () => {
  const rows = recentTradesFromActivity(
    [
      activity({ timestamp: NOW_SEC, conditionId: "m1", outcomeIndex: 0, side: "BUY" }),
      activity({ timestamp: NOW_SEC, conditionId: "m1", outcomeIndex: 0, side: "SELL" }),
      activity({ timestamp: NOW_SEC, conditionId: "m1", outcomeIndex: 1, side: "BUY" })
    ],
    "0xabc",
    0
  );
  assert.equal(rows.length, 3);
});

test("recentTradesFromActivity lowercases the address and maps money/price/time", () => {
  const [row] = recentTradesFromActivity(
    [activity({ timestamp: NOW_SEC, size: 10, usdcSize: 250, price: 0.42 })],
    "0xDEAD",
    0
  );
  assert.ok(row);
  assert.equal(row.address, "0xdead");
  assert.equal(row.usdcSize, 250);
  approx(row.price, 0.42);
  assert.equal(row.tradedAt, new Date(NOW_SEC * 1000).toISOString());
});

test("recentTradesFromActivity returns empty for empty input", () => {
  assert.deepEqual(recentTradesFromActivity([], "0xabc", 0), []);
});
