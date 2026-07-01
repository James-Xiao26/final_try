import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTrendingMarkets, TRENDING_DUST_FLOOR_USD } from "./trendingMarkets";
import type { CrowdClosedPosition, CrowdLookups, CrowdOpenPosition } from "./marketCrowd";
import type { MarketRow } from "./types";

function market(p: Partial<MarketRow>): MarketRow {
  return {
    id: "m1",
    conditionId: "c1",
    question: "Will it rain?",
    slug: "will-it-rain",
    category: "Weather",
    liquidityUsd: 1000,
    volumeUsd: 5000,
    volume24hrUsd: 2000,
    volume1wkUsd: 8000,
    currentPrice: 0.5,
    topOutcome: "Yes",
    oneDayPriceChange: null,
    endDate: null,
    image: null,
    ...p
  };
}

function open(p: Partial<CrowdOpenPosition>): CrowdOpenPosition {
  return {
    address: "0xa",
    conditionId: "c1",
    asset: "t1",
    market: "Will it rain?",
    outcomeIndex: 0,
    size: 100,
    avgPrice: 0.4,
    curPrice: 0.5,
    currentValue: 50,
    cashPnl: 10,
    firstTradedAt: null,
    lastTradedAt: null,
    ...p
  };
}

function closed(p: Partial<CrowdClosedPosition>): CrowdClosedPosition {
  return {
    address: "0xa",
    conditionId: "c1",
    outcomeIndex: 1,
    market: "Will it rain?",
    avgPrice: 0.3,
    realizedPnl: 15,
    size: 100,
    closeTime: "2026-02-01T00:00:00.000Z",
    firstTradedAt: null,
    ...p
  };
}

const lookups: CrowdLookups = {
  rankByAddress: new Map([["0xa", 3], ["0xb", 1]]),
  handleByAddress: new Map([["0xa", "alpha"], ["0xb", "beta"]]),
  skillByAddress: new Map([["0xa", 9], ["0xb", 1]])
};

test("a market with zero tracked participants still appears, with lean null", () => {
  const [row] = buildTrendingMarkets([market({})], [], [], [], lookups);
  assert.ok(row);
  assert.equal(row.conditionId, "c1");
  assert.equal(row.lean, null);
});

test("a sub-$10 position is excluded from the lean tally", () => {
  // 20 shares @ 0.10 = $2, well under the floor.
  const positions = [open({ address: "0xa", outcomeIndex: 0, size: 20, avgPrice: 0.1 })];
  const [row] = buildTrendingMarkets([market({})], positions, [], [], lookups);
  assert.equal(row?.lean, null);
});

test("a closed position is excluded even when well above the dust floor", () => {
  const closedRows = [closed({ address: "0xa", outcomeIndex: 0, size: 1000, avgPrice: 0.5 })]; // $500
  const [row] = buildTrendingMarkets([market({})], [], closedRows, [], lookups);
  assert.equal(row?.lean, null);
});

test("dollar-weighted lean disagrees with skill-weighted: equal capital, mismatched skill -> SPLIT", () => {
  const positions = [
    open({ address: "0xa", outcomeIndex: 0, size: 1000, avgPrice: 0.5 }), // YES, skill 9, $500
    open({ address: "0xb", outcomeIndex: 1, size: 1000, avgPrice: 0.5 })  // NO, skill 1, $500
  ];
  const [row] = buildTrendingMarkets([market({})], positions, [], [], lookups);
  assert.ok(row?.lean);
  assert.equal(row.lean.yesCapital, 500);
  assert.equal(row.lean.noCapital, 500);
  assert.equal(row.lean.label, "SPLIT");
});

test("a position at exactly the dust floor is included (>= not >)", () => {
  // 20 shares @ 0.50 = $10.00 exactly.
  const positions = [open({ address: "0xa", outcomeIndex: 0, size: 20, avgPrice: 0.5 })];
  const [row] = buildTrendingMarkets([market({})], positions, [], [], lookups);
  assert.ok(row?.lean);
  assert.equal(row.lean.yesCapital, TRENDING_DUST_FLOOR_USD);
  assert.equal(row.lean.positionedCount, 1);
});

test("output order matches input market order, not re-sorted by lean or trader count", () => {
  const markets = [
    market({ id: "m1", conditionId: "c1", question: "First" }),
    market({ id: "m2", conditionId: "c2", question: "Second" }),
    market({ id: "m3", conditionId: "c3", question: "Third" })
  ];
  // Give c3 the biggest leaderboard lean, c1 none — order should still be First, Second, Third.
  const positions = [open({ address: "0xa", conditionId: "c3", outcomeIndex: 0, size: 10000, avgPrice: 0.9 })];
  const rows = buildTrendingMarkets(markets, positions, [], [], lookups);
  assert.deepEqual(rows.map((r) => r.market), ["First", "Second", "Third"]);
});

test("topRank picks the best (lowest) rank among positioned wallets, ignoring dusted-out ones", () => {
  const positions = [
    open({ address: "0xa", outcomeIndex: 0, size: 1000, avgPrice: 0.5 }), // rank 3, $500
    open({ address: "0xb", outcomeIndex: 0, size: 5, avgPrice: 0.1 })     // rank 1, $0.50 (dusted out)
  ];
  const [row] = buildTrendingMarkets([market({})], positions, [], [], lookups);
  assert.ok(row?.lean);
  assert.equal(row.lean.positionedCount, 1);
  assert.equal(row.lean.topRank, 3);
});
