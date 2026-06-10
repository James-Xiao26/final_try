import assert from "node:assert/strict";
import { test } from "node:test";
import { earliestEntryDates, openPositionRecords, profileFillsFromActivity } from "./walletDetail.js";
import type { Position, TradeActivity } from "./polymarket.js";

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

function position(partial: Partial<Position>): Position {
  return {
    proxyWallet: "0xabc",
    asset: "a1",
    conditionId: "c1",
    market: "Will it rain?",
    outcomeIndex: 0,
    size: 100,
    avgPrice: 0.4,
    initialValue: 40,
    currentValue: 55,
    cashPnl: 15,
    realizedPnl: 0,
    curPrice: 0.55,
    endDate: null,
    redeemable: false,
    ...partial
  };
}

const NOW_SEC = 1_700_000_000;

test("profileFillsFromActivity returns most-recent fills first", () => {
  const fills = profileFillsFromActivity(
    [
      activity({ timestamp: NOW_SEC - 100, market: "older" }),
      activity({ timestamp: NOW_SEC, market: "newest" }),
      activity({ timestamp: NOW_SEC - 50, market: "middle" })
    ],
    "0xabc"
  );
  assert.deepEqual(fills.map((fill) => fill.market), ["newest", "middle", "older"]);
});

test("profileFillsFromActivity caps at the limit (after sorting newest-first)", () => {
  const fills = profileFillsFromActivity(
    [
      activity({ timestamp: NOW_SEC - 100, market: "older" }),
      activity({ timestamp: NOW_SEC, market: "newest" }),
      activity({ timestamp: NOW_SEC - 50, market: "middle" })
    ],
    "0xabc",
    2
  );
  // Keeps the two newest, dropping "older".
  assert.deepEqual(fills.map((fill) => fill.market), ["newest", "middle"]);
});

test("profileFillsFromActivity lowercases the address and maps fields and time", () => {
  const [fill] = profileFillsFromActivity(
    [activity({ timestamp: NOW_SEC, side: "SELL", price: 0.6, size: 20, usdcSize: 12, transactionHash: "0xhash" })],
    "0xABCDEF"
  );
  assert.ok(fill);
  assert.equal(fill.address, "0xabcdef");
  assert.equal(fill.side, "SELL");
  assert.equal(fill.price, 0.6);
  assert.equal(fill.size, 20);
  assert.equal(fill.usdcSize, 12);
  assert.equal(fill.transactionHash, "0xhash");
  // Polymarket /activity timestamps are unix seconds -> ISO.
  assert.equal(fill.tradedAt, new Date(NOW_SEC * 1000).toISOString());
});

test("profileFillsFromActivity returns empty for empty input", () => {
  assert.deepEqual(profileFillsFromActivity([], "0xabc"), []);
});

test("openPositionRecords keeps only genuinely-open (non-redeemable) positions", () => {
  const records = openPositionRecords(
    [
      position({ asset: "open1", redeemable: false }),
      position({ asset: "resolved1", redeemable: true }),
      position({ asset: "open2", redeemable: false })
    ],
    "0xabc"
  );
  assert.deepEqual(records.map((record) => record.asset), ["open1", "open2"]);
});

test("openPositionRecords lowercases the address and maps fields", () => {
  const [record] = openPositionRecords(
    [position({ asset: "a9", size: 250, avgPrice: 0.3, curPrice: 0.45, initialValue: 75, currentValue: 112.5, cashPnl: 37.5 })],
    "0xABC"
  );
  assert.ok(record);
  assert.equal(record.address, "0xabc");
  assert.equal(record.asset, "a9");
  assert.equal(record.size, 250);
  assert.equal(record.avgPrice, 0.3);
  assert.equal(record.curPrice, 0.45);
  assert.equal(record.currentValue, 112.5);
  assert.equal(record.cashPnl, 37.5);
});

test("openPositionRecords normalizes endDate to ISO or null", () => {
  const [withDate, withBad] = openPositionRecords(
    [
      position({ asset: "d1", endDate: "2026-05-10", redeemable: false }),
      position({ asset: "d2", endDate: "not-a-date", redeemable: false })
    ],
    "0xabc"
  );
  assert.ok(withDate);
  assert.equal(withDate.endDate, new Date(Date.parse("2026-05-10")).toISOString());
  assert.ok(withBad);
  assert.equal(withBad.endDate, null);
});

test("earliestEntryDates keeps the oldest fill date per asset (UTC)", () => {
  const day = (iso: string): number => Math.floor(Date.parse(iso) / 1000);
  const dates = earliestEntryDates([
    activity({ asset: "A", timestamp: day("2026-06-09T10:00:00Z") }),
    activity({ asset: "A", timestamp: day("2026-06-07T03:00:00Z") }), // older → wins for A
    activity({ asset: "B", timestamp: day("2026-05-20T00:00:00Z") })
  ]);
  assert.equal(dates.get("A"), "2026-06-07");
  assert.equal(dates.get("B"), "2026-05-20");
});

test("earliestEntryDates skips fills with no asset and handles empty input", () => {
  assert.equal(earliestEntryDates([activity({ asset: "" })]).size, 0);
  assert.equal(earliestEntryDates([]).size, 0);
});
