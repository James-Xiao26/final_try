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

test("summarizeCrowdedMarkets drops a market no wallet currently holds (all positions closed)", () => {
  const resolved = summarizeCrowdedMarkets([], [closed({ conditionId: "resolved" }), closed({ address: "0xb", conditionId: "resolved" })], lookups);
  assert.equal(resolved.length, 0);
  const active = summarizeCrowdedMarkets([open({ conditionId: "live" })], [closed({ conditionId: "live" })], lookups);
  assert.equal(active.length, 1);
  assert.equal(active[0]?.openCount, 1);
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

test("buildCrowdMarketDetail falls back to position-cache dates when there are no fills for the market", () => {
  // Open holder with no fills in the tracked window: dates come from the open cache (first/last).
  const positions = [open({ address: "0xa", firstTradedAt: "2026-01-01", lastTradedAt: "2026-03-10" })];
  // Closed holder with no fills: first from the cache, last falls back to closeTime.
  const closedRows = [closed({ address: "0xb", outcomeIndex: 1, firstTradedAt: "2025-12-15", closeTime: "2026-02-01T00:00:00.000Z" })];
  const detail = buildCrowdMarketDetail("c1", positions, closedRows, [], lookups, new Map());
  assert.ok(detail);
  const a = detail.participants.find((p) => p.address === "0xa");
  const b = detail.participants.find((p) => p.address === "0xb");
  assert.ok(a);
  assert.equal(a.firstTradedAt, "2026-01-01");
  assert.equal(a.lastTradedAt, "2026-03-10");
  assert.ok(b);
  assert.equal(b.firstTradedAt, "2025-12-15");
  assert.equal(b.lastTradedAt, "2026-02-01T00:00:00.000Z"); // closeTime
});

test("buildCrowdMarketDetail prefers fill timestamps over position-cache dates when fills exist", () => {
  const positions = [open({ address: "0xa", firstTradedAt: "2020-01-01", lastTradedAt: "2020-01-01" })];
  const fills = [fill({ address: "0xa", tradedAt: "2026-01-09T00:00:00.000Z" })];
  const detail = buildCrowdMarketDetail("c1", positions, [], fills, lookups, new Map());
  assert.ok(detail);
  const [p] = detail.participants;
  assert.ok(p);
  // The actual fill timestamp wins over the (stale) cache fallback.
  assert.equal(p.firstTradedAt, "2026-01-09T00:00:00.000Z");
  assert.equal(p.lastTradedAt, "2026-01-09T00:00:00.000Z");
});

test("buildCrowdMarketDetail marks a fill-only OPEN holder to the current YES price for value/P-L", () => {
  // No position-cache row: weflyhigh appears only via fills (a net-long YES buy). With a YES price of
  // 0.55 the remaining holding is marked, so value/P-L are filled rather than blank.
  const fills = [fill({ address: "0xb", outcomeIndex: 0, side: "BUY", size: 100, usdcSize: 50, tradedAt: "2026-01-02T00:00:00.000Z" })];
  const detail = buildCrowdMarketDetail("c1", [], [], fills, lookups, new Map([["2026-01-02", 0.55]]));
  const p = detail?.participants.find((x) => x.address === "0xb");
  assert.ok(p);
  assert.equal(p.state, "open");
  assert.equal(p.side, "YES");
  assert.equal(Number(p.value?.toFixed(4)), 55); // 100 shares · 0.55
  assert.equal(Number(p.pnl?.toFixed(4)), 5); // 55 marked − 50 paid
  assert.equal(Number(p.pnlPct?.toFixed(4)), 0.1);
});

test("buildCrowdMarketDetail marks a fill-only NO holder with the complement price", () => {
  const fills = [fill({ address: "0xb", outcomeIndex: 1, side: "BUY", size: 100, usdcSize: 40, tradedAt: "2026-01-02T00:00:00.000Z" })];
  const detail = buildCrowdMarketDetail("c1", [], [], fills, lookups, new Map([["2026-01-02", 0.7]]));
  const p = detail?.participants.find((x) => x.address === "0xb");
  assert.ok(p);
  assert.equal(p.side, "NO");
  assert.equal(Number(p.value?.toFixed(4)), 30); // 100 · (1 − 0.7)
  assert.equal(Number(p.pnl?.toFixed(4)), -10); // 30 marked − 40 paid
});

test("buildCrowdMarketDetail leaves P/L blank for a sells-only (buys-out-of-window) participant", () => {
  // Only sell fills are in the tracked window — the cost basis predates it, so reporting proceeds as
  // profit would massively overstate. P/L and avg entry stay null instead of fabricated.
  const fills = [
    fill({ address: "0xb", outcomeIndex: 0, side: "SELL", size: 60, usdcSize: 33, tradedAt: "2026-01-03T00:00:00.000Z" }),
    fill({ address: "0xb", outcomeIndex: 0, side: "SELL", size: 40, usdcSize: 22, tradedAt: "2026-01-04T00:00:00.000Z" })
  ];
  const detail = buildCrowdMarketDetail("c1", [], [], fills, lookups, new Map([["2026-01-04", 0.55]]));
  const p = detail?.participants.find((x) => x.address === "0xb");
  assert.ok(p);
  assert.equal(p.state, "closed");
  assert.equal(p.pnl, null);
  assert.equal(p.avgEntry, null);
  assert.equal(p.value, null);
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
