import assert from "node:assert/strict";
import { test } from "node:test";
import type { CrowdLookups } from "./marketCrowd";
import { groupResolvedByEvent, summarizeResolvedMarkets } from "./resolvedMarkets";
import type { ResolvedMarket } from "./types";

// Helper to build a minimal closed-position input.
interface InputProps {
  address?: string;
  conditionId?: string | null;
  market?: string | null;
  eventSlug?: string | null;
  outcomeIndex?: number | null;
  avgPrice?: number;
  size?: number;
  realizedPnl?: number | null;
  closeTime?: string | null;
  firstTradedAt?: string | null;
}

function input(p: InputProps = {}) {
  return {
    address: "0xa",
    conditionId: "c1",
    market: "Will it rain?",
    eventSlug: null,
    outcomeIndex: 0,
    avgPrice: 0.4,
    size: 100,
    realizedPnl: 60, // exitValue = 0.4 + 60/100 = 1.0 → won
    closeTime: "2026-06-10T00:00:00.000Z",
    firstTradedAt: null,
    ...p
  };
}

const lookups: CrowdLookups = {
  rankByAddress: new Map([["0xa", 1], ["0xb", 5], ["0xc", 12]]),
  handleByAddress: new Map([["0xa", "alpha"], ["0xb", null], ["0xc", "charlie"]]),
  skillByAddress: new Map([["0xa", 8.5], ["0xb", 6.0], ["0xc", 7.2]])
};

test("exitValue recovery: won ≈ 1 (held to YES resolution)", () => {
  // avgPrice=0.4, realizedPnl=60, size=100 → exitValue = 0.4 + 60/100 = 1.0
  const rows = [input({ address: "0xa", outcomeIndex: 0, avgPrice: 0.4, size: 100, realizedPnl: 60 })];
  const result = summarizeResolvedMarkets(rows, lookups);
  assert.equal(result.length, 1);
  const [m] = result;
  assert.ok(m);
  assert.equal(m.winningOutcomeIndex, 0);
  assert.equal(m.winningSide, "YES");
  assert.equal(m.winners, 1);
  assert.equal(m.losers, 0);
  const [p] = m.participants;
  assert.ok(p);
  assert.equal(p.won, true);
  assert.equal(p.side, "YES");
});

test("exitValue recovery: lost ≈ 0 (held to NO resolution — YES holder lost)", () => {
  // avgPrice=0.6, realizedPnl=-60, size=100 → exitValue = 0.6 + (-60)/100 = 0.0
  const rows = [input({ address: "0xa", outcomeIndex: 0, avgPrice: 0.6, size: 100, realizedPnl: -60 })];
  const result = summarizeResolvedMarkets(rows, lookups);
  assert.equal(result.length, 1);
  const [m] = result;
  assert.ok(m);
  // The YES holder lost, so the winning outcome voted is 1 - 0 = 1 (NO won)
  assert.equal(m.winningOutcomeIndex, 1);
  assert.equal(m.winningSide, "NO");
  const [p] = m.participants;
  assert.ok(p);
  assert.equal(p.won, false);
});

test("exitValue recovery: sold early (mid-range exitValue) — market NOT confirmed", () => {
  // avgPrice=0.4, realizedPnl=10, size=100 → exitValue = 0.4 + 10/100 = 0.5 (mid-range)
  const rows = [input({ address: "0xa", outcomeIndex: 0, avgPrice: 0.4, size: 100, realizedPnl: 10 })];
  const result = summarizeResolvedMarkets(rows, lookups);
  // No votes → market dropped
  assert.equal(result.length, 0);
});

test("dropping an all-sold-early (unconfirmed) market", () => {
  // Both participants sold early — no confirmed resolution votes
  const rows = [
    input({ address: "0xa", outcomeIndex: 0, avgPrice: 0.5, size: 100, realizedPnl: 5 }),  // exitValue=0.55
    input({ address: "0xb", outcomeIndex: 1, avgPrice: 0.5, size: 100, realizedPnl: -5 })  // exitValue=0.45
  ];
  const result = summarizeResolvedMarkets(rows, lookups);
  assert.equal(result.length, 0);
});

test("winner majority vote with mixed participants", () => {
  // 0xa: YES holder, exitValue≈1 → votes 0 (YES won)
  // 0xb: NO holder, exitValue≈0 → votes 1 - 1 = 0 (NO holder lost → YES won)
  // 0xc: YES holder, exitValue≈0 → votes 1 - 0 = 1 (YES holder lost → NO won)
  const rows = [
    input({ address: "0xa", outcomeIndex: 0, avgPrice: 0.4, size: 100, realizedPnl: 60 }),  // ev=1.0 → vote 0
    input({ address: "0xb", outcomeIndex: 1, avgPrice: 0.6, size: 100, realizedPnl: -60 }), // ev=0.0 → vote 0
    input({ address: "0xc", outcomeIndex: 0, avgPrice: 0.6, size: 100, realizedPnl: -60 })  // ev=0.0 → vote 1
  ];
  const result = summarizeResolvedMarkets(rows, lookups);
  assert.equal(result.length, 1);
  const [m] = result;
  assert.ok(m);
  // 2 votes for 0 (YES), 1 vote for 1 (NO)
  assert.equal(m.winningOutcomeIndex, 0);
  assert.equal(m.winningSide, "YES");
});

test("per-participant won flag matches winningOutcomeIndex", () => {
  // YES won: 0xa (YES) = won, 0xb (NO) = lost
  const rows = [
    input({ address: "0xa", outcomeIndex: 0, avgPrice: 0.4, size: 100, realizedPnl: 60, closeTime: "2026-06-10T00:00:00.000Z" }),
    input({ address: "0xb", outcomeIndex: 1, avgPrice: 0.6, size: 100, realizedPnl: -60, closeTime: "2026-06-10T01:00:00.000Z" })
  ];
  const result = summarizeResolvedMarkets(rows, lookups);
  assert.equal(result.length, 1);
  const [m] = result;
  assert.ok(m);
  assert.equal(m.winningOutcomeIndex, 0);
  const a = m.participants.find((p) => p.address === "0xa");
  const b = m.participants.find((p) => p.address === "0xb");
  assert.ok(a);
  assert.ok(b);
  assert.equal(a.won, true);
  assert.equal(b.won, false);
});

test("recency sort: two markets, newest resolvedAt comes first", () => {
  const rows = [
    // c1 resolved earlier
    input({ conditionId: "c1", market: "Market A", closeTime: "2026-06-08T00:00:00.000Z", avgPrice: 0.4, size: 100, realizedPnl: 60 }),
    // c2 resolved later
    input({ conditionId: "c2", market: "Market B", closeTime: "2026-06-10T00:00:00.000Z", avgPrice: 0.4, size: 100, realizedPnl: 60 })
  ];
  const result = summarizeResolvedMarkets(rows, lookups);
  assert.equal(result.length, 2);
  assert.equal(result[0]?.conditionId, "c2");
  assert.equal(result[1]?.conditionId, "c1");
});

test("aggregate winners / losers / total realized P/L", () => {
  const rows = [
    // 0xa YES winner: +$60
    input({ address: "0xa", outcomeIndex: 0, avgPrice: 0.4, size: 100, realizedPnl: 60 }),
    // 0xb NO loser (YES won): -$60
    input({ address: "0xb", outcomeIndex: 1, avgPrice: 0.6, size: 100, realizedPnl: -60 })
  ];
  const result = summarizeResolvedMarkets(rows, lookups);
  assert.equal(result.length, 1);
  const [m] = result;
  assert.ok(m);
  assert.equal(m.winners, 1);
  assert.equal(m.losers, 1);
  assert.equal(m.totalRealizedPnl, 0); // 60 + (-60) = 0
  assert.equal(m.traderCount, 2);
});

test("empty input → empty output", () => {
  assert.deepEqual(summarizeResolvedMarkets([], lookups), []);
});

test("null conditionId rows are skipped", () => {
  const rows = [input({ conditionId: null, avgPrice: 0.4, size: 100, realizedPnl: 60 })];
  assert.deepEqual(summarizeResolvedMarkets(rows, lookups), []);
});

test("non-leaderboard addresses are excluded from participants", () => {
  const lookupsSmall: CrowdLookups = {
    rankByAddress: new Map([["0xa", 1]]),
    handleByAddress: new Map([["0xa", "alpha"]]),
    skillByAddress: new Map([["0xa", 8.5]])
  };
  // 0xb is NOT on the leaderboard
  const rows = [
    input({ address: "0xa", outcomeIndex: 0, avgPrice: 0.4, size: 100, realizedPnl: 60 }),
    input({ address: "0xb", outcomeIndex: 0, avgPrice: 0.4, size: 100, realizedPnl: 60 })
  ];
  const result = summarizeResolvedMarkets(rows, lookupsSmall);
  assert.equal(result.length, 1);
  const [m] = result;
  assert.ok(m);
  assert.equal(m.traderCount, 1);
  assert.equal(m.participants.length, 1);
  assert.equal(m.participants[0]?.address, "0xa");
});

test("limit parameter slices the result", () => {
  // Three separate markets
  const rows = [
    input({ conditionId: "c1", closeTime: "2026-06-08T00:00:00.000Z", avgPrice: 0.4, size: 100, realizedPnl: 60 }),
    input({ conditionId: "c2", closeTime: "2026-06-09T00:00:00.000Z", avgPrice: 0.4, size: 100, realizedPnl: 60 }),
    input({ conditionId: "c3", closeTime: "2026-06-10T00:00:00.000Z", avgPrice: 0.4, size: 100, realizedPnl: 60 })
  ];
  const result = summarizeResolvedMarkets(rows, lookups, 2);
  assert.equal(result.length, 2);
  // Newest two
  assert.equal(result[0]?.conditionId, "c3");
  assert.equal(result[1]?.conditionId, "c2");
});

// ── groupResolvedByEvent ────────────────────────────────────────────────────────

function market(p: Partial<ResolvedMarket>): ResolvedMarket {
  return {
    conditionId: "c1",
    market: "A market",
    eventSlug: null,
    winningOutcomeIndex: 0,
    winningSide: "YES",
    resolvedAt: "2026-06-10T00:00:00.000Z",
    traderCount: 1,
    winners: 1,
    losers: 0,
    totalRealizedPnl: 10,
    participants: [{ address: "0xa", handle: null, rank: 1, skillScore: null, outcomeIndex: 0, side: "YES", won: true, avgEntry: 0.4, size: 100, realizedPnl: 10, realizedPct: 0.25, closeTime: null, firstTradedAt: null }],
    ...p
  };
}

test("groupResolvedByEvent condenses same-event markets and keeps standalones flat", () => {
  const rows: ResolvedMarket[] = [
    market({ conditionId: "m1", eventSlug: "bra-nor", market: "Brazil vs. Norway: Total goals over 2.5", resolvedAt: "2026-06-10T02:00:00.000Z", winners: 1, losers: 0, totalRealizedPnl: 30, participants: [{ address: "0xa", handle: null, rank: 1, skillScore: null, outcomeIndex: 0, side: "YES", won: true, avgEntry: 0.4, size: 100, realizedPnl: 30, realizedPct: 0.5, closeTime: null, firstTradedAt: null }] }),
    market({ conditionId: "m2", eventSlug: "bra-nor", market: "Brazil vs. Norway: Brazil to win", resolvedAt: "2026-06-10T03:00:00.000Z", winners: 0, losers: 1, totalRealizedPnl: -20, participants: [{ address: "0xb", handle: null, rank: 5, skillScore: null, outcomeIndex: 1, side: "NO", won: false, avgEntry: 0.6, size: 50, realizedPnl: -20, realizedPct: -0.4, closeTime: null, firstTradedAt: null }] }),
    market({ conditionId: "solo", eventSlug: "fed-decision", market: "Fed hike in July?", resolvedAt: "2026-06-11T00:00:00.000Z" })
  ];
  const groups = groupResolvedByEvent(rows);
  assert.equal(groups.length, 2);
  // Standalone (newest) first.
  assert.equal(groups[0]?.markets.length, 1);
  assert.equal(groups[0]?.key, "solo");
  // The Brazil/Norway group is condensed.
  const g = groups[1]!;
  assert.equal(g.markets.length, 2);
  assert.equal(g.title, "Brazil vs. Norway:".replace(/[\s:]+$/, "")); // common prefix, trailing sep stripped
  assert.equal(g.traderCount, 2);      // distinct wallets across the two markets
  assert.equal(g.winners, 1);
  assert.equal(g.losers, 1);
  assert.equal(g.totalRealizedPnl, 10);
  assert.equal(g.resolvedAt, "2026-06-10T03:00:00.000Z"); // latest of the two
});

test("groupResolvedByEvent leaves a lone market under a slug ungrouped", () => {
  const groups = groupResolvedByEvent([market({ conditionId: "only", eventSlug: "some-event" })]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.markets.length, 1);
  assert.equal(groups[0]?.key, "only");
});

// title extraction: matchup wins even when some markets don't name the teams
test("group title uses the shared matchup, not the abbreviated slug", () => {
  const slug = "fifwc-par-fra-2026-07-04-more-markets";
  const groups = groupResolvedByEvent([
    market({ conditionId: "a", eventSlug: slug, market: "Paraguay vs. France: O/U 2.5" }),
    market({ conditionId: "b", eventSlug: slug, market: "Spread: France (-2.5)" }),
    market({ conditionId: "c", eventSlug: slug, market: "Paraguay vs. France: Team to Advance" })
  ]);
  assert.equal(groups[0]?.title, "Paraguay vs. France");
});

test("group title extracts the matchup from 'Will … draw' questions (not just 'Will')", () => {
  const slug = "fifwc-bra-nor-2026-07-05";
  const groups = groupResolvedByEvent([
    market({ conditionId: "a", eventSlug: slug, market: "Will Brazil vs. Norway end in a draw?" }),
    market({ conditionId: "b", eventSlug: slug, market: "Will Brazil win on 2026-07-05?" }),
    market({ conditionId: "c", eventSlug: slug, market: "Will Norway win on 2026-07-05?" })
  ]);
  assert.equal(groups[0]?.title, "Brazil vs. Norway");
});

test("group title falls back to a cleaned slug when there's no matchup", () => {
  const slug = "world-cup-winner";
  const groups = groupResolvedByEvent([
    market({ conditionId: "a", eventSlug: slug, market: "Will Brazil win the 2026 FIFA World Cup?" }),
    market({ conditionId: "b", eventSlug: slug, market: "Will Spain win the 2026 FIFA World Cup?" })
  ]);
  assert.equal(groups[0]?.title, "World Cup Winner");
});

test("group title keeps accented team names", () => {
  const slug = "fifwc-civ-nor-2026-06-30-more-markets";
  const groups = groupResolvedByEvent([
    market({ conditionId: "a", eventSlug: slug, market: "Côte d'Ivoire vs. Norway: O/U 2.5" }),
    market({ conditionId: "b", eventSlug: slug, market: "Côte d'Ivoire vs. Norway: Both Teams to Score" })
  ]);
  assert.equal(groups[0]?.title, "Côte d'Ivoire vs. Norway");
});

test("group title cross-references the matchup from a sibling slug", () => {
  // The exact-score group's own questions never name the teams, but the -more-markets sibling does.
  const groups = groupResolvedByEvent([
    market({ conditionId: "a", eventSlug: "fifwc-par-fra-2026-07-04-more-markets", market: "Paraguay vs. France: O/U 2.5" }),
    market({ conditionId: "b", eventSlug: "fifwc-par-fra-2026-07-04-more-markets", market: "Spread: France (-2.5)" }),
    market({ conditionId: "c", eventSlug: "fifwc-par-fra-2026-07-04-exact-score", market: "Exact Score: 2-1" }),
    market({ conditionId: "d", eventSlug: "fifwc-par-fra-2026-07-04-exact-score", market: "Exact Score: 1-0" })
  ]);
  const exact = groups.find((g) => g.key === "fifwc-par-fra-2026-07-04-exact-score");
  assert.equal(exact?.title, "Paraguay vs. France");
});

test("humanizeSlug drops 3-digit id tokens and dangling prepositions", () => {
  const groups = groupResolvedByEvent([
    market({ conditionId: "a", eventSlug: "fed-rate-hike-by", market: "Will the Fed hike by June?" }),
    market({ conditionId: "b", eventSlug: "fed-rate-hike-by", market: "Will the Fed hold in June?" })
  ]);
  assert.equal(groups[0]?.title, "Fed Rate Hike"); // trailing "By" trimmed
});
