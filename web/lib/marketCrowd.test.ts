import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildCrowdMarketDetail,
  buildCrowdTimeline,
  summarizeCrowdedMarkets,
  type CrowdClosedPosition,
  type CrowdLookups,
  type CrowdOpenPosition,
  type CrowdTradeFill
} from "./marketCrowd";

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
    ...p
  };
}

function fill(p: Partial<CrowdTradeFill>): CrowdTradeFill {
  return {
    address: "0xa",
    conditionId: "c1",
    market: "Will it rain?",
    outcomeIndex: 0,
    side: "BUY",
    price: 0.4,
    size: 100,
    usdcSize: 40,
    tradedAt: "2026-01-01T00:00:00.000Z",
    ...p
  };
}

const lookups: CrowdLookups = {
  rankByAddress: new Map([["0xa", 1], ["0xb", 5]]),
  handleByAddress: new Map([["0xa", "alpha"], ["0xb", null]]),
  skillByAddress: new Map([["0xa", 8.5], ["0xb", 6]])
};

test("summarizeCrowdedMarkets counts distinct wallets, YES/NO split, committed capital, and best rank", () => {
  const positions = [open({ address: "0xa", outcomeIndex: 0 }), open({ address: "0xb", outcomeIndex: 1, curPrice: 0.55 })];
  const closedRows = [closed({ address: "0xa", outcomeIndex: 0, closeTime: "2026-01-03T00:00:00.000Z" })];
  const [summary] = summarizeCrowdedMarkets(positions, closedRows, lookups);
  assert.ok(summary);
  assert.equal(summary.conditionId, "c1");
  assert.equal(summary.traderCount, 2);
  assert.equal(summary.yesTraders, 1);
  assert.equal(summary.noTraders, 1);
  assert.equal(summary.openCount, 2);
  assert.equal(summary.topRank, 1);
  // committed = YES (100*0.4 open + 100*0.3 closed) + NO (100*0.4 open) = 40 + 30 + 40 = 110
  assert.equal(summary.committedUsd, 110);
  // net = YES 70 − NO 40 = 30
  assert.equal(summary.netExposureUsd, 30);
  assert.equal(summary.lastTradedAt, "2026-01-03T00:00:00.000Z");
});

test("summarizeCrowdedMarkets ranks markets by trader count then committed capital, honoring the limit", () => {
  const positions = [
    open({ address: "0xa", conditionId: "c1" }),
    open({ address: "0xb", conditionId: "c1" }),
    open({ address: "0xa", conditionId: "c2" })
  ];
  const out = summarizeCrowdedMarkets(positions, [], lookups, 1);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.conditionId, "c1"); // 2 traders beats c2's 1
});

test("buildCrowdMarketDetail prefers the open cache, derives side, P/L, and fill dates", () => {
  const positions = [open({ address: "0xa", outcomeIndex: 0, avgPrice: 0.5, curPrice: 0.6, size: 100, currentValue: 60, cashPnl: 10 })];
  const fills = [
    fill({ address: "0xa", side: "BUY", tradedAt: "2026-01-01T00:00:00.000Z" }),
    fill({ address: "0xa", side: "BUY", tradedAt: "2026-01-05T00:00:00.000Z" })
  ];
  const detail = buildCrowdMarketDetail("c1", positions, [], fills, lookups, new Map());
  assert.ok(detail);
  assert.equal(detail.traderCount, 1);
  const [p] = detail.participants;
  assert.ok(p);
  assert.equal(p.side, "YES");
  assert.equal(p.state, "open");
  assert.equal(p.handle, "alpha");
  assert.equal(p.avgEntry, 0.5);
  // (0.6 - 0.5) / 0.5 = 0.2
  assert.equal(Number(p.pnlPct?.toFixed(4)), 0.2);
  assert.equal(p.firstTradedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(p.lastTradedAt, "2026-01-05T00:00:00.000Z");
  assert.equal(p.fills.length, 2);
  // fills are newest-first
  assert.equal(p.fills[0]?.tradedAt, "2026-01-05T00:00:00.000Z");
});

test("buildCrowdMarketDetail falls back to the closed cache for realized P/L", () => {
  const detail = buildCrowdMarketDetail("c1", [], [closed({ address: "0xb", outcomeIndex: 1, avgPrice: 0.3, size: 100, realizedPnl: 15 })], [], lookups, new Map());
  assert.ok(detail);
  const [p] = detail.participants;
  assert.ok(p);
  assert.equal(p.side, "NO");
  assert.equal(p.state, "closed");
  assert.equal(p.pnl, 15);
  // 15 / (0.3 * 100) = 0.5
  assert.equal(p.pnlPct, 0.5);
});

test("buildCrowdMarketDetail returns null when no wallet participates", () => {
  assert.equal(buildCrowdMarketDetail("c1", [], [], [], lookups, new Map()), null);
});

test("buildCrowdTimeline accumulates net shares/cost per day and clamps at zero", () => {
  const fills = [
    fill({ outcomeIndex: 0, side: "BUY", size: 100, usdcSize: 40, tradedAt: "2026-01-01T01:00:00.000Z" }),
    fill({ outcomeIndex: 0, side: "BUY", size: 50, usdcSize: 25, tradedAt: "2026-01-01T05:00:00.000Z" }),
    fill({ outcomeIndex: 1, side: "BUY", size: 80, usdcSize: 40, tradedAt: "2026-01-02T00:00:00.000Z" }),
    // a sell with no matching tracked buy would go negative — clamped to 0
    fill({ outcomeIndex: 0, side: "SELL", size: 500, usdcSize: 250, tradedAt: "2026-01-03T00:00:00.000Z" })
  ];
  const prices = new Map([["2026-01-02", 0.52]]);
  const points = buildCrowdTimeline(fills, prices);
  assert.equal(points.length, 3);
  // day 1: 150 YES shares, 65 cost
  assert.deepEqual([points[0]?.yesShares, points[0]?.yesCostUsd], [150, 65]);
  // day 2: NO side opens; price attaches; YES carries
  assert.equal(points[1]?.noShares, 80);
  assert.equal(points[1]?.price, 0.52);
  // day 3: big YES sell → clamped to 0, last known price carried forward
  assert.equal(points[2]?.yesShares, 0);
  assert.equal(points[2]?.price, 0.52);
});
