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

// Equal skill for 0xa-0xe so tests that aren't specifically about weighting behave like a plain
// average (skill*sqrt(cost) weighting collapses to cost-only ranking when skill is constant).
const lookups: CrowdLookups = {
  rankByAddress: new Map([["0xa", 1], ["0xb", 2], ["0xc", 3], ["0xd", 4], ["0xe", 5]]),
  handleByAddress: new Map(),
  skillByAddress: new Map([["0xa", 5], ["0xb", 5], ["0xc", 5], ["0xd", 5], ["0xe", 5]])
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

test("smart-money implied price (via scoreTrendingMarket's near-entry term) normalizes NO entries to YES-equivalent", () => {
  // YES @ 0.60 and NO @ 0.60, equal size/skill -> YES-equivalent entries 0.60 and 0.40, blended = 0.50.
  const rows = [
    open({ address: "0xa", outcomeIndex: 0, size: 100, avgPrice: 0.6 }),
    open({ address: "0xb", outcomeIndex: 1, size: 100, avgPrice: 0.6 })
  ];
  const atEntry = scoreTrendingMarket(market({ currentPrice: 0.5 }), rows, lookups);
  const farFromEntry = scoreTrendingMarket(market({ currentPrice: 0.95 }), rows, lookups);
  assert.ok(atEntry > farFromEntry);
  // Current price exactly at the blended implied price -> full near-entry credit (score == 1).
  assert.equal(atEntry, 1);
});

test("near-entry score decays to 0 by a 5c gap", () => {
  const rows = fiveWallets({ outcomeIndex: 0, avgPrice: 0.5 });
  const zeroGap = scoreTrendingMarket(market({ currentPrice: 0.5 }), rows, lookups);
  const bigGap = scoreTrendingMarket(market({ currentPrice: 0.9 }), rows, lookups);
  assert.equal(zeroGap, 1);
  assert.equal(bigGap, 0);
});

test("resolve-soon score is high for an imminent endDate, ~0 for a far one, 0 for none", () => {
  const now = Date.parse("2026-01-01T00:00:00.000Z");
  const rows: CrowdOpenPosition[] = []; // isolate the resolve-soon term
  const soon = scoreTrendingMarket(market({ endDate: "2026-01-01T01:00:00.000Z", currentPrice: null }), rows, lookups, now);
  const far = scoreTrendingMarket(market({ endDate: "2026-02-01T00:00:00.000Z", currentPrice: null }), rows, lookups, now);
  const none = scoreTrendingMarket(market({ endDate: null, currentPrice: null }), rows, lookups, now);
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
    lookups,
    now
  );
  const noGameStart = scoreTrendingMarket(
    market({ category: "Sports", endDate: null, currentPrice: null, gameStartTime: null }),
    rows,
    lookups,
    now
  );
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
    lookups,
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

test("consensus is dust-floored, with topRank among positioned wallets only", () => {
  const positions = [
    ...fiveWallets({ outcomeIndex: 0, size: 100, avgPrice: 0.5 }), // ranks 1-5, equal skill/size -> smartMoneyPct 0.5
    open({ address: "0xf", outcomeIndex: 1, size: 5, avgPrice: 0.1 }) // dust, NO side, unranked, excluded
  ];
  const [row] = buildTrendingMarkets([market({ currentPrice: 0.5 })], positions, lookups, 12);
  assert.ok(row?.consensus);
  assert.equal(row.consensus.smartMoneyPct, 0.5); // all-YES @ 0.5, dust NO excluded entirely
  assert.equal(row.consensus.label, "SPLIT"); // exactly 0.5
  assert.equal(row.consensus.positionedCount, 5);
  assert.equal(row.consensus.topRank, 1);
  assert.equal(row.consensus.gapPts, 0); // implied price == live price
});

test("a position at exactly the dust floor counts (>= not >)", () => {
  const positions = ["0xa", "0xb", "0xc", "0xd", "0xe"].map((address) =>
    open({ address, outcomeIndex: 0, size: 20, avgPrice: 0.5 }) // $10.00 exactly
  );
  assert.equal(positions[0]!.size * positions[0]!.avgPrice, TRENDING_DUST_FLOOR_USD);
  const [row] = buildTrendingMarkets([market({})], positions, lookups, 12);
  assert.equal(row?.consensus?.positionedCount, 5);
});

test("skill*sqrt(cost) weighting: a highly-skilled small position outweighs a big unskilled one, but doesn't erase it", () => {
  const skewedLookups: CrowdLookups = {
    rankByAddress: new Map([["0xsharp", 1], ["0xwhale", 2]]),
    handleByAddress: new Map(),
    skillByAddress: new Map([["0xsharp", 9], ["0xwhale", 1]])
  };
  // Sharp trader: skill 9, $100 position on YES @ 0.90 -> weight = 9 * 10 = 90.
  // Unskilled whale: skill 1, $10,000 position on NO @ 0.90 (i.e. YES-equivalent 0.10) -> weight = 1 * 100 = 100.
  const positions = [
    open({ address: "0xsharp", outcomeIndex: 0, size: 111.11, avgPrice: 0.9 }), // ~$100
    open({ address: "0xwhale", outcomeIndex: 1, size: 11111.11, avgPrice: 0.9 }) // ~$10,000
  ];
  const [row] = buildTrendingMarkets([market({ currentPrice: 0.5 })], positions, skewedLookups, 12);
  assert.ok(row?.consensus);
  // Pure $-weighting would put this near 0.10 (whale dominates 100:1 in raw dollars). sqrt dampening
  // plus the skill multiplier pulls it back toward the middle instead of letting the whale run away with it.
  assert.ok(row.consensus.smartMoneyPct > 0.3, `expected dampened pct > 0.3, got ${row.consensus.smartMoneyPct}`);
  assert.ok(row.consensus.smartMoneyPct < 0.7, `expected dampened pct < 0.7, got ${row.consensus.smartMoneyPct}`);
});

test("gapPts is null when the market has no live price, and signed vs. currentPrice otherwise", () => {
  const positions = fiveWallets({ outcomeIndex: 0, avgPrice: 0.7 }); // smartMoneyPct == 0.7
  const noPriceRow = buildTrendingMarkets([market({ currentPrice: null })], positions, lookups, 12)[0];
  assert.equal(noPriceRow?.consensus?.gapPts, null);

  const bullishGap = buildTrendingMarkets([market({ currentPrice: 0.5 })], positions, lookups, 12)[0];
  assert.ok(bullishGap?.consensus);
  assert.ok(Math.abs(bullishGap.consensus.gapPts! - 0.2) < 1e-9); // smart money more bullish than the market
});
