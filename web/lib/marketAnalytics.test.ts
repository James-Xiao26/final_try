import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildPriceSeries,
  concentration,
  detectWhaleTrades,
  marketResolution,
  parseEventCandidates,
  pnlDistribution,
  smartMoneyLean,
  summarizeWhaleMoves,
  type MarketMeta,
  type PricePoint,
  type WhaleFillInput
} from "./marketAnalytics";
import type { CrowdParticipant } from "./types";

function marketMeta(p: Partial<MarketMeta>): MarketMeta {
  return {
    question: "Will it rain?",
    slug: null,
    category: null,
    image: null,
    endDate: null,
    liquidityUsd: 0,
    volumeUsd: 0,
    volume24hrUsd: 0,
    volume1wkUsd: 0,
    spread: null,
    lastTradePrice: null,
    topOutcome: null,
    oneDayPriceChange: null,
    outcomes: ["Yes", "No"],
    outcomePrices: null,
    active: false,
    closed: true,
    ...p
  };
}

function participant(p: Partial<CrowdParticipant>): CrowdParticipant {
  return {
    address: "0xa",
    handle: null,
    rank: null,
    skillScore: null,
    outcomeIndex: 0,
    side: "YES",
    state: "open",
    size: 100,
    avgEntry: 0.4,
    curPrice: 0.5,
    value: 50,
    pnl: 10,
    pnlPct: 0.25,
    firstTradedAt: null,
    lastTradedAt: null,
    fills: [],
    ...p
  };
}

function fill(p: Partial<WhaleFillInput>): WhaleFillInput {
  return {
    address: "0xa",
    handle: null,
    rank: null,
    skillScore: null,
    outcomeIndex: 0,
    side: "BUY",
    price: 0.4,
    size: 100,
    usdcSize: 40,
    tradedAt: "2026-06-01T00:00:00.000Z",
    ...p
  };
}

// ── buildPriceSeries ──────────────────────────────────────────────────────────

test("buildPriceSeries keeps intraday points and derives day-over-day stats", () => {
  const rows: PricePoint[] = [
    { ts: "2026-06-01T01:00:00Z", price: 0.4 },
    { ts: "2026-06-01T20:00:00Z", price: 0.45 }, // same day — kept as a distinct intraday point
    { ts: "2026-06-02", price: 0.5 },
    { ts: "2026-06-03", price: 0.48 }
  ];
  const s = buildPriceSeries(rows);
  // Intraday points are NOT collapsed — every move is on the line.
  assert.equal(s.points.length, 4);
  assert.equal(s.first, 0.4); // earliest intraday
  assert.equal(s.latest, 0.48); // most recent intraday
  // min/max span all intraday points.
  assert.equal(s.min, 0.4);
  assert.equal(s.max, 0.5);
  // Stats are day-over-day: daily closes 0.45 (Jun 1 last), 0.5, 0.48 → last delta −0.02.
  assert.ok(Math.abs((s.change24h ?? 0) - -0.02) < 1e-9);
  assert.ok((s.volatility ?? 0) > 0);
});

test("buildPriceSeries sorts unordered points ascending by ts", () => {
  const s = buildPriceSeries([
    { ts: "2026-06-03", price: 0.48 },
    { ts: "2026-06-01T01:00:00Z", price: 0.4 },
    { ts: "2026-06-02", price: 0.5 }
  ]);
  assert.deepEqual(s.points.map((p) => p.price), [0.4, 0.5, 0.48]);
});

test("buildPriceSeries handles empty input without dividing by zero", () => {
  const s = buildPriceSeries([]);
  assert.equal(s.points.length, 0);
  assert.equal(s.latest, null);
  assert.equal(s.volatility, null);
});

// ── detectWhaleTrades ─────────────────────────────────────────────────────────

test("detectWhaleTrades keeps fills above the threshold and tallies direction", () => {
  const fills = [
    fill({ usdcSize: 5000, side: "BUY", outcomeIndex: 0 }),
    fill({ usdcSize: 200, side: "BUY", outcomeIndex: 0 }), // below minUsd, not in topN if topN small
    fill({ usdcSize: 3000, side: "SELL", outcomeIndex: 1 })
  ];
  const a = detectWhaleTrades(fills, { minUsd: 1000, topN: 0 });
  assert.equal(a.trades.length, 2);
  assert.equal(a.trades[0]?.usdc, 5000); // largest first
  assert.equal(a.buyUsd, 5200);
  assert.equal(a.sellUsd, 3000);
  assert.equal(a.netUsd, 2200);
  assert.equal(a.yesBuyUsd, 5200);
  assert.equal(a.biggest?.usdc, 5000);
});

test("detectWhaleTrades sets yesPrice to the YES-equivalent (NO fills inverted)", () => {
  const a = detectWhaleTrades(
    [
      fill({ outcomeIndex: 0, price: 0.62, usdcSize: 2000 }), // YES → yesPrice 0.62
      fill({ outcomeIndex: 1, price: 0.47, usdcSize: 2000 }), // NO 47¢ → YES 53¢
      fill({ outcomeIndex: 1, price: null, usdcSize: 2000 }) // no price → null
    ],
    { topN: 3 }
  );
  const yes = a.trades.find((t) => t.outcome === "YES");
  const no = a.trades.find((t) => t.outcome === "NO" && t.price === 0.47);
  const noNull = a.trades.find((t) => t.price === null);
  assert.equal(yes?.yesPrice, 0.62);
  assert.equal(Number(no?.yesPrice?.toFixed(4)), 0.53);
  assert.equal(noNull?.yesPrice, null);
});

test("detectWhaleTrades always surfaces the topN largest even below threshold", () => {
  const fills = [fill({ usdcSize: 50 }), fill({ usdcSize: 80 }), fill({ usdcSize: 30 })];
  const a = detectWhaleTrades(fills, { minUsd: 100000, topN: 2 });
  assert.equal(a.trades.length, 2);
  assert.equal(a.trades[0]?.usdc, 80);
});

test("detectWhaleTrades derives usdc from price·size when usdcSize is missing", () => {
  const a = detectWhaleTrades([fill({ usdcSize: null, price: 0.5, size: 1000 })], { topN: 1 });
  assert.equal(a.trades[0]?.usdc, 500);
});

test("summarizeWhaleMoves describes net flow and the largest move", () => {
  const a = detectWhaleTrades(
    [
      fill({ usdcSize: 12000, side: "BUY", outcomeIndex: 0, rank: 4, tradedAt: "2026-06-03T00:00:00Z", price: 0.38 }),
      fill({ usdcSize: 2000, side: "SELL", outcomeIndex: 0 })
    ],
    { topN: 2 }
  );
  const s = summarizeWhaleMoves(a);
  assert.match(s, /net buying/);
  assert.match(s, /leaning YES/);
  assert.match(s, /rank-#4 wallet bought \$12\.0K YES at 38¢ on Jun 3/);
});

test("summarizeWhaleMoves degrades when there are no trades", () => {
  assert.match(summarizeWhaleMoves(detectWhaleTrades([])), /No tracked whale trades/);
});

// ── concentration ─────────────────────────────────────────────────────────────

test("concentration ranks holders and measures lopsidedness", () => {
  const ps = [
    participant({ address: "0x1", size: 1000, avgEntry: 0.5 }), // 500
    participant({ address: "0x2", size: 200, avgEntry: 0.5 }),  // 100
    participant({ address: "0x3", size: 800, avgEntry: 0.5 })   // 400
  ];
  const c = concentration(ps);
  assert.equal(c.count, 3);
  assert.equal(c.total, 1000);
  assert.equal(c.holders[0]?.committed, 500);
  assert.ok(Math.abs(c.top1Share - 0.5) < 1e-9);
  assert.ok(Math.abs(c.top5Share - 1) < 1e-9);
  // HHI = 0.5² + 0.4² + 0.1² = 0.42
  assert.ok(Math.abs(c.hhi - 0.42) < 1e-9);
});

test("concentration excludes zero-cost participants", () => {
  const c = concentration([participant({ size: 0, avgEntry: null, value: null })]);
  assert.equal(c.count, 0);
  assert.equal(c.total, 0);
});

// ── pnlDistribution ───────────────────────────────────────────────────────────

test("pnlDistribution buckets P/L and computes win rate", () => {
  const ps = [
    participant({ pnl: 6000 }),  // ≥ $5K
    participant({ pnl: 500 }),   // $100..1K
    participant({ pnl: 0 }),     // flat
    participant({ pnl: -2000 }), // -5K..-1K
    participant({ pnl: null })   // unknown → ignored
  ];
  const d = pnlDistribution(ps);
  assert.equal(d.sampled, 4);
  assert.equal(d.winners, 2);
  assert.equal(d.losers, 1);
  assert.equal(d.flat, 1);
  assert.ok(Math.abs((d.winRate ?? 0) - 2 / 3) < 1e-9);
  assert.equal(d.totalPnl, 4500);
  assert.equal(d.best, 6000);
  assert.equal(d.worst, -2000);
  assert.equal(d.buckets.find((b) => b.label === "≥ $5K")?.count, 1);
  assert.equal(d.buckets.find((b) => b.label === "≈ flat")?.count, 1);
});

test("pnlDistribution returns null win rate with no decided participants", () => {
  const d = pnlDistribution([participant({ pnl: 0 }), participant({ pnl: null })]);
  assert.equal(d.winRate, null);
  assert.equal(d.flat, 1);
});

// ── smartMoneyLean ────────────────────────────────────────────────────────────

test("smartMoneyLean weights sides by skill score", () => {
  const ps = [
    participant({ outcomeIndex: 0, skillScore: 9, size: 1000, avgEntry: 0.5 }), // YES, weight 10
    participant({ outcomeIndex: 1, skillScore: 1, size: 1000, avgEntry: 0.5 })  // NO, weight 2
  ];
  const l = smartMoneyLean(ps);
  assert.equal(l.label, "YES");
  assert.equal(l.yesWeight, 10);
  assert.equal(l.noWeight, 2);
  assert.ok(Math.abs((l.yesPct ?? 0) - 10 / 12) < 1e-9);
  assert.equal(l.yesCapital, 500);
  assert.equal(l.noCapital, 500);
});

test("smartMoneyLean reports SPLIT when weights tie", () => {
  const l = smartMoneyLean([
    participant({ outcomeIndex: 0, skillScore: 5 }),
    participant({ outcomeIndex: 1, skillScore: 5 })
  ]);
  assert.equal(l.label, "SPLIT");
});

test("marketResolution decodes the winning leg from a closed market's prices", () => {
  const yesWon = marketResolution(marketMeta({ closed: true, outcomePrices: [1, 0] }));
  assert.deepEqual(yesWon, { winnerIndex: 0, winnerLabel: "Yes", winnerSide: "YES" });
  const noWon = marketResolution(marketMeta({ closed: true, outcomePrices: [0, 1] }));
  assert.deepEqual(noWon, { winnerIndex: 1, winnerLabel: "No", winnerSide: "NO" });
});

test("marketResolution uses the outcome labels when present", () => {
  const r = marketResolution(marketMeta({ closed: true, outcomes: ["Hurricanes", "Golden Knights"], outcomePrices: [1, 0] }));
  assert.equal(r?.winnerLabel, "Hurricanes");
  assert.equal(r?.winnerSide, "YES");
});

test("marketResolution falls back to the settled YES price when outcomePrices is absent", () => {
  // Listed resolved markets carry no outcome_prices, but the series shows the binary settling at ~1/0.
  const yesWon = marketResolution(marketMeta({ closed: true, outcomePrices: null }), 1);
  assert.equal(yesWon?.winnerSide, "YES");
  const noWon = marketResolution(marketMeta({ closed: true, outcomePrices: null }), 0.01);
  assert.equal(noWon?.winnerSide, "NO");
  // A still-contested price (didn't settle to an extreme) → no verdict.
  assert.equal(marketResolution(marketMeta({ closed: true, outcomePrices: null }), 0.6), null);
});

test("marketResolution returns null for open, ambiguous, or unpriced markets", () => {
  assert.equal(marketResolution(marketMeta({ closed: false, outcomePrices: [1, 0] })), null);
  assert.equal(marketResolution(marketMeta({ closed: true, outcomePrices: null })), null);
  assert.equal(marketResolution(marketMeta({ closed: true, outcomePrices: [0.5, 0.5] })), null);
  assert.equal(marketResolution(null), null);
});

test("parseEventCandidates ranks grouped-event candidates favored-first", () => {
  const cands = parseEventCandidates([
    { groupItemTitle: "Spain", conditionId: "0xspain", clobTokenIds: '["spainYes","spainNo"]', outcomePrices: '["0.16","0.84"]' },
    { groupItemTitle: "France", conditionId: "0xfrance", clobTokenIds: '["frYes","frNo"]', outcomePrices: '["0.20","0.80"]' },
    { groupItemTitle: "Portugal", conditionId: "0xpt", clobTokenIds: '["ptYes","ptNo"]', lastTradePrice: 0.11 }, // price via lastTradePrice
    { groupItemTitle: "", conditionId: "0xbad", clobTokenIds: '["x","y"]', outcomePrices: '["0.5"]' }, // no label → skipped
    { groupItemTitle: "NoToken", conditionId: "0xz", clobTokenIds: "[]", outcomePrices: '["0.9"]' } // no YES token → skipped
  ]);
  assert.deepEqual(cands.map((c) => c.label), ["France", "Spain", "Portugal"]);
  assert.equal(cands[0]?.yesTokenId, "frYes");
  assert.equal(cands[2]?.price, 0.11);
});

test("parseEventCandidates returns [] for a non-grouped (binary) event", () => {
  assert.deepEqual(parseEventCandidates([{ conditionId: "0x1", clobTokenIds: '["a","b"]', outcomePrices: '["0.5","0.5"]' }]), []);
  assert.deepEqual(parseEventCandidates([]), []);
});
