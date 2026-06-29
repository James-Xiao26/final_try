import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizeCrowdedMarkets, type CrowdClosedPosition, type CrowdOpenPosition } from "./marketCrowd.js";

function open(p: Partial<CrowdOpenPosition>): CrowdOpenPosition {
  return {
    address: "0xa",
    conditionId: "c1",
    market: "Will it rain?",
    outcomeIndex: 0,
    size: 100,
    avgPrice: 0.4,
    curPrice: 0.5,
    ...p
  };
}

function closed(p: Partial<CrowdClosedPosition>): CrowdClosedPosition {
  return {
    address: "0xa",
    conditionId: "c1",
    market: "Will it rain?",
    outcomeIndex: 1,
    avgPrice: 0.3,
    size: 100,
    closeTime: "2026-02-01T00:00:00.000Z",
    ...p
  };
}

const ranks = new Map<string, number>([["0xa", 1], ["0xb", 5]]);

test("summarizeCrowdedMarkets counts distinct wallets, YES/NO split, committed capital, and best rank", () => {
  const positions = [open({ address: "0xa", outcomeIndex: 0 }), open({ address: "0xb", outcomeIndex: 1, curPrice: 0.55 })];
  const closedRows = [closed({ address: "0xa", outcomeIndex: 0, closeTime: "2026-01-03T00:00:00.000Z" })];
  const [summary] = summarizeCrowdedMarkets(positions, closedRows, ranks);
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
    open({ address: "0xa", conditionId: "c2", size: 1000 })
  ];
  // c1 has 2 traders, c2 has 1 → c1 ranks first by trader count.
  const ranked = summarizeCrowdedMarkets(positions, [], ranks);
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0]?.conditionId, "c1");
  assert.equal(ranked[1]?.conditionId, "c2");
  // limit truncates.
  assert.equal(summarizeCrowdedMarkets(positions, [], ranks, 1).length, 1);
});

test("summarizeCrowdedMarkets derives the YES price from outcome 0 directly and outcome 1 as its complement", () => {
  const yesSummary = summarizeCrowdedMarkets([open({ outcomeIndex: 0, curPrice: 0.62 })], [], ranks);
  assert.equal(yesSummary[0]?.curPrice, 0.62);
  const noSummary = summarizeCrowdedMarkets([open({ outcomeIndex: 1, curPrice: 0.62 })], [], ranks);
  assert.ok(noSummary[0]);
  assert.ok(Math.abs((noSummary[0].curPrice ?? 0) - 0.38) < 1e-9);
});

test("summarizeCrowdedMarkets skips rows with no conditionId and returns no rank when no participant is ranked", () => {
  const summaries = summarizeCrowdedMarkets(
    [open({ address: "0xz", conditionId: null }), open({ address: "0xz", conditionId: "c9" })],
    [],
    ranks
  );
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0]?.conditionId, "c9");
  assert.equal(summaries[0]?.topRank, null); // 0xz is not in the rank map
  assert.equal(summaries[0]?.lastTradedAt, null); // no closed positions → no close time
});

test("summarizeCrowdedMarkets handles an empty input set", () => {
  assert.deepEqual(summarizeCrowdedMarkets([], [], ranks), []);
});

test("summarizeCrowdedMarkets drops a market no wallet currently holds (all positions closed)", () => {
  // A resolved/fully-exited market: only closed positions, no open holdings → excluded.
  const resolved = summarizeCrowdedMarkets([], [closed({ conditionId: "resolved" }), closed({ address: "0xb", conditionId: "resolved" })], ranks);
  assert.equal(resolved.length, 0);
  // A market with even one current holder is kept.
  const active = summarizeCrowdedMarkets([open({ conditionId: "live" })], [closed({ conditionId: "live" })], ranks);
  assert.equal(active.length, 1);
  assert.equal(active[0]?.openCount, 1);
});
