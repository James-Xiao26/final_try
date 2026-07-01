import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildTrendingMarkets,
  qualifyingConditionIds,
  scoreTrendingMarket,
  TRENDING_DUST_FLOOR_USD
} from "./trendingMarkets";
import type { CrowdLookups, CrowdOpenPosition } from "./marketCrowd";
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
    gameStartTime: null,
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

const lookups: CrowdLookups = {
  rankByAddress: new Map([["0xa", 1], ["0xb", 2], ["0xc", 3], ["0xd", 4], ["0xe", 5]]),
  handleByAddress: new Map(),
  skillByAddress: new Map()
};

// Five distinct wallets, each with a non-dust position on c1.
function fiveWallets(overrides: Partial<CrowdOpenPosition> = {}): CrowdOpenPosition[] {
  return ["0xa", "0xb", "0xc", "0xd", "0xe"].map((address) =>
    open({ address, outcomeIndex: 0, size: 100, avgPrice: 0.5, ...overrides })
  );
}

test("qualifyingConditionIds: 4 distinct wallets does not qualify, 5 does", () => {
  const four = ["0xa", "0xb", "0xc", "0xd"].map((address) => open({ address }));
  assert.equal(qualifyingConditionIds(four).size, 0);

  const five = fiveWallets();
  assert.deepEqual([...qualifyingConditionIds(five)], ["c1"]);
});

test("qualifyingConditionIds: dust positions don't count toward the participant floor", () => {
  const positions = [
    ...fiveWallets(),
    open({ address: "0xf", size: 5, avgPrice: 0.1 }) // $0.50, dust
  ];
  // Still exactly 5 qualifying wallets on c1 (the dust wallet doesn't push it to 6, but doesn't hurt either).
  assert.deepEqual([...qualifyingConditionIds(positions)], ["c1"]);

  // A market with only dust positions from 5 wallets doesn't qualify at all.
  const allDust = ["0xa", "0xb", "0xc", "0xd", "0xe"].map((address) =>
    open({ address, conditionId: "c2", size: 5, avgPrice: 0.1 })
  );
  assert.equal(qualifyingConditionIds(allDust).size, 0);
});

test("weightedAvgEntry (via scoreTrendingMarket's near-entry term) normalizes NO entries to YES-equivalent", () => {
  // YES @ 0.60 ($60) and NO @ 0.60 ($60) -> YES-equivalent entries 0.60 and 0.40, blended = 0.50.
  const rows = [
    open({ address: "0xa", outcomeIndex: 0, size: 100, avgPrice: 0.6 }),
    open({ address: "0xb", outcomeIndex: 1, size: 100, avgPrice: 0.6 })
  ];
  const atEntry = scoreTrendingMarket(market({ currentPrice: 0.5 }), rows);
  const farFromEntry = scoreTrendingMarket(market({ currentPrice: 0.95 }), rows);
  assert.ok(atEntry > farFromEntry);
  // Current price exactly at the blended entry -> full near-entry credit (score == 1, no other terms set).
  assert.equal(atEntry, 1);
});

test("near-entry score decays to 0 by a 5c gap", () => {
  const rows = fiveWallets({ outcomeIndex: 0, avgPrice: 0.5 });
  const zeroGap = scoreTrendingMarket(market({ currentPrice: 0.5 }), rows);
  const bigGap = scoreTrendingMarket(market({ currentPrice: 0.9 }), rows);
  assert.equal(zeroGap, 1);
  assert.equal(bigGap, 0);
});

test("resolve-soon score is high for an imminent endDate, ~0 for a far one, 0 for none", () => {
  const now = Date.parse("2026-01-01T00:00:00.000Z");
  const rows: CrowdOpenPosition[] = []; // isolate the resolve-soon term
  const soon = scoreTrendingMarket(market({ endDate: "2026-01-01T01:00:00.000Z", currentPrice: null }), rows, now);
  const far = scoreTrendingMarket(market({ endDate: "2026-02-01T00:00:00.000Z", currentPrice: null }), rows, now);
  const none = scoreTrendingMarket(market({ endDate: null, currentPrice: null }), rows, now);
  assert.ok(soon > 0.9);
  assert.ok(far < 0.1);
  assert.equal(none, 0);
});

test("start-soon score only applies to sports/esports markets with a gameStartTime, doesn't penalize its absence", () => {
  const now = Date.parse("2026-01-01T00:00:00.000Z");
  const rows: CrowdOpenPosition[] = [];
  const startsSoon = scoreTrendingMarket(
    market({ category: "Sports", endDate: null, currentPrice: null, gameStartTime: "2026-01-01T06:00:00.000Z" }),
    rows,
    now
  );
  const noGameStart = scoreTrendingMarket(market({ category: "Sports", endDate: null, currentPrice: null, gameStartTime: null }), rows, now);
  assert.ok(startsSoon > 0.5);
  assert.equal(noGameStart, 0);
});

test("start-soon score is gated to sports/esports categories -- a leaked gameStartTime on another category doesn't count", () => {
  // Real production data: Gamma sets gameStartTime on some recurring non-sports markets too
  // (e.g. weekly tweet-count trackers tagged Culture) — it isn't exclusively a scheduled-game field.
  const now = Date.parse("2026-01-01T00:00:00.000Z");
  const rows: CrowdOpenPosition[] = [];
  const leaked = scoreTrendingMarket(
    market({ category: "Culture", endDate: null, currentPrice: null, gameStartTime: "2026-01-01T06:00:00.000Z" }),
    rows,
    now
  );
  assert.equal(leaked, 0);
});

test("buildTrendingMarkets ranks by composite score, not volume", () => {
  const now = Date.parse("2026-01-01T00:00:00.000Z");
  const highVolumeButDecided = market({
    id: "big",
    conditionId: "big",
    question: "Big but decided",
    volume24hrUsd: 1_000_000,
    currentPrice: 0.99,
    endDate: "2026-06-01T00:00:00.000Z" // far off
  });
  const smallButActionable = market({
    id: "small",
    conditionId: "small",
    question: "Small but hot",
    volume24hrUsd: 100,
    currentPrice: 0.5,
    endDate: "2026-01-01T06:00:00.000Z" // resolves in hours
  });
  const positions = [
    ...fiveWallets({ conditionId: "big", outcomeIndex: 0, avgPrice: 0.99 }),
    ...fiveWallets({ conditionId: "small", outcomeIndex: 0, avgPrice: 0.5 })
  ];
  const rows = buildTrendingMarkets([highVolumeButDecided, smallButActionable], positions, lookups, 12, now);
  assert.deepEqual(rows.map((r) => r.market), ["Small but hot", "Big but decided"]);
});

test("buildTrendingMarkets respects the limit after sorting", () => {
  const markets = [market({ id: "a", conditionId: "a" }), market({ id: "b", conditionId: "b" }), market({ id: "c", conditionId: "c" })];
  const positions = [
    ...fiveWallets({ conditionId: "a" }),
    ...fiveWallets({ conditionId: "b" }),
    ...fiveWallets({ conditionId: "c" })
  ];
  const rows = buildTrendingMarkets(markets, positions, lookups, 2);
  assert.equal(rows.length, 2);
});

test("lean is dollar-weighted and dust-floored, with topRank among positioned wallets only", () => {
  const positions = [
    ...fiveWallets({ outcomeIndex: 0, size: 100, avgPrice: 0.5 }), // $50 each, ranks 1-5
    open({ address: "0xf", outcomeIndex: 1, size: 5, avgPrice: 0.1 }) // dust, NO side, unranked
  ];
  const [row] = buildTrendingMarkets([market({})], positions, lookups, 12);
  assert.ok(row?.lean);
  assert.equal(row.lean.yesCapital, 250);
  assert.equal(row.lean.noCapital, 0); // dust NO position excluded
  assert.equal(row.lean.label, "YES");
  assert.equal(row.lean.positionedCount, 5);
  assert.equal(row.lean.topRank, 1);
});

test("a position at exactly the dust floor counts (>= not >)", () => {
  const positions = ["0xa", "0xb", "0xc", "0xd", "0xe"].map((address) =>
    open({ address, outcomeIndex: 0, size: 20, avgPrice: 0.5 }) // $10.00 exactly
  );
  assert.equal(positions[0]!.size * positions[0]!.avgPrice, TRENDING_DUST_FLOOR_USD);
  const [row] = buildTrendingMarkets([market({})], positions, lookups, 12);
  assert.equal(row?.lean?.positionedCount, 5);
});
