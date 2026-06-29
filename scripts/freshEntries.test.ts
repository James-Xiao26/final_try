import assert from "node:assert/strict";
import { test } from "node:test";
import { newEntriesFromActivity, summarizeFreshEntries, type NewEntry } from "./freshEntries.js";
import type { TradeActivity } from "./polymarket.js";

const HOUR_MS = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 5, 19, 12, 0, 0);
const CUTOFF = NOW - 24 * HOUR_MS; // 24h window

// timestamp in unix SECONDS, `hoursAgo` before NOW.
function fill(partial: Partial<TradeActivity> & { side: TradeActivity["side"]; hoursAgo: number }): TradeActivity {
  return {
    proxyWallet: "0xWALLET",
    timestamp: Math.floor((NOW - partial.hoursAgo * HOUR_MS) / 1000),
    conditionId: partial.conditionId ?? "0xMARKET",
    size: partial.size ?? 100,
    usdcSize: partial.usdcSize ?? 50,
    price: partial.price ?? 0.5,
    side: partial.side,
    asset: partial.asset ?? "tok",
    outcomeIndex: partial.outcomeIndex ?? 0,
    market: partial.market ?? "Will it rain?",
    outcomeLabel: null,
    eventSlug: null,
    transactionHash: null
  };
}

test("newEntriesFromActivity flags a market whose earliest fill is an in-window BUY", () => {
  const entries = newEntriesFromActivity(
    [fill({ side: "BUY", hoursAgo: 2, usdcSize: 80 }), fill({ side: "BUY", hoursAgo: 5, usdcSize: 20 })],
    "0xABC",
    CUTOFF
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.address, "0xabc"); // lowercased
  assert.equal(entries[0]?.outcomeIndex, 0);
  assert.equal(entries[0]?.buyUsd, 100); // both in-window buys summed
  assert.equal(entries[0]?.tradedAt, new Date(NOW - 2 * HOUR_MS).toISOString()); // latest buy
});

test("newEntriesFromActivity excludes a market the wallet already held (earliest fill predates window)", () => {
  // An older buy (out of window) means they were already in the market — adding more is not a fresh entry.
  const entries = newEntriesFromActivity(
    [fill({ side: "BUY", hoursAgo: 2 }), fill({ side: "BUY", hoursAgo: 40 })],
    "0xABC",
    CUTOFF
  );
  assert.deepEqual(entries, []);
});

test("newEntriesFromActivity excludes a market whose earliest fill is a SELL", () => {
  const entries = newEntriesFromActivity(
    [fill({ side: "SELL", hoursAgo: 10 }), fill({ side: "BUY", hoursAgo: 3 })],
    "0xABC",
    CUTOFF
  );
  assert.deepEqual(entries, []);
});

test("newEntriesFromActivity carries the entry side from the earliest buy (NO = outcome 1)", () => {
  const entries = newEntriesFromActivity([fill({ side: "BUY", hoursAgo: 1, outcomeIndex: 1 })], "0xABC", CUTOFF);
  assert.equal(entries[0]?.outcomeIndex, 1);
});

function entry(partial: Partial<NewEntry> & { address: string }): NewEntry {
  return {
    address: partial.address,
    conditionId: partial.conditionId ?? "0xM1",
    market: partial.market ?? "Market 1",
    outcomeIndex: partial.outcomeIndex ?? 0,
    buyUsd: partial.buyUsd ?? 100,
    tradedAt: partial.tradedAt ?? new Date(NOW).toISOString()
  };
}

test("summarizeFreshEntries aggregates distinct entrants, YES/NO split, skill, capital, and best rank", () => {
  const skills = new Map([["0xa", 7], ["0xb", 9]]);
  const ranks = new Map([["0xa", 12], ["0xb", 3]]);
  const [s] = summarizeFreshEntries(
    [
      entry({ address: "0xa", outcomeIndex: 0, buyUsd: 100 }),
      entry({ address: "0xb", outcomeIndex: 1, buyUsd: 250 }),
      entry({ address: "0xa", outcomeIndex: 0, buyUsd: 1 }) // duplicate wallet — counts once for headcount/skill
    ],
    skills,
    ranks
  );
  assert.equal(s?.entrantCount, 2);
  assert.equal(s?.yesEntrants, 1);
  assert.equal(s?.noEntrants, 1);
  assert.equal(s?.committedUsd, 351); // all buyUsd summed
  assert.equal(s?.skillWeight, 16); // 7 + 9, duplicate not re-counted
  assert.equal(s?.topSkill, 9);
  assert.equal(s?.topRank, 3); // lowest rank number
});

test("summarizeFreshEntries ranks by entrant count then skill weight, honoring the limit", () => {
  const skills = new Map([["0xa", 5], ["0xb", 9], ["0xc", 5]]);
  const ranked = summarizeFreshEntries(
    [
      entry({ address: "0xa", conditionId: "0xLOW" }),
      entry({ address: "0xb", conditionId: "0xHIGH" }),
      entry({ address: "0xc", conditionId: "0xHIGH" })
    ],
    skills,
    new Map()
  );
  assert.equal(ranked[0]?.conditionId, "0xHIGH"); // 2 entrants beats 1
  assert.equal(ranked.length, 2);
  assert.equal(summarizeFreshEntries([entry({ address: "0xa" })], skills, new Map(), 0).length === 0, true);
});

test("summarizeFreshEntries handles an empty input set", () => {
  assert.deepEqual(summarizeFreshEntries([], new Map(), new Map()), []);
});
