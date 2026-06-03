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

const NOW_SEC = 1_700_000_000;
const CUTOFF_MS = NOW_SEC * 1000 - 24 * 60 * 60 * 1000;

test("recentTradesFromActivity keeps only fills at/after the cutoff", () => {
  const rows = recentTradesFromActivity(
    [
      activity({ timestamp: NOW_SEC, market: "fresh" }),
      activity({ timestamp: NOW_SEC - 23 * 60 * 60, market: "within" }),
      activity({ timestamp: NOW_SEC - 25 * 60 * 60, market: "stale" })
    ],
    "0xABC",
    CUTOFF_MS
  );
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.market), ["fresh", "within"]);
});

test("recentTradesFromActivity lowercases the address and maps money/price/time", () => {
  const [row] = recentTradesFromActivity(
    [activity({ timestamp: NOW_SEC, usdcSize: 250, price: 0.42 })],
    "0xDEAD",
    0
  );
  assert.ok(row);
  assert.equal(row.address, "0xdead");
  assert.equal(row.usdcSize, 250);
  assert.equal(row.price, 0.42);
  assert.equal(row.tradedAt, new Date(NOW_SEC * 1000).toISOString());
});

test("recentTradesFromActivity returns empty for empty input", () => {
  assert.deepEqual(recentTradesFromActivity([], "0xabc", 0), []);
});
