import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildPriceSeries,
  concentration,
  detectWhaleTrades,
  pnlDistribution,
  smartMoneyLean,
  summarizeWhaleMoves,
  type PricePoint,
  type WhaleFillInput
} from "./marketAnalytics";
import type { CrowdParticipant } from "./types";

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

test("buildPriceSeries collapses to one point per day and derives headline stats", () => {
  const rows: PricePoint[] = [
    { ts: "2026-06-01T01:00:00Z", price: 0.4 },
    { ts: "2026-06-01T20:00:00Z", price: 0.45 }, // same day → last wins
    { ts: "2026-06-02", price: 0.5 },
    { ts: "2026-06-03", price: 0.48 }
  ];
  const s = buildPriceSeries(rows);
  assert.equal(s.points.length, 3);
  assert.equal(s.points[0]?.price, 0.45);
  assert.equal(s.first, 0.45);
  assert.equal(s.latest, 0.48);
  assert.ok(Math.abs((s.changeAbs ?? 0) - 0.03) < 1e-9);
  assert.ok(Math.abs((s.change24h ?? 0) - -0.02) < 1e-9);
  assert.equal(s.min, 0.45);
  assert.equal(s.max, 0.5);
  assert.ok((s.volatility ?? 0) > 0);
});

test("buildPriceSeries handles empty input without dividing by zero", () => {
  const s = buildPriceSeries([]);
  assert.equal(s.points.length, 0);
  assert.equal(s.latest, null);
  assert.equal(s.volatility, null);
  assert.deepEqual(s.regimeShifts, []);
});

test("buildPriceSeries flags a regime shift on an outsized daily move", () => {
  // A long calm stretch then a jump should exceed regimeK·stdev.
  const rows: PricePoint[] = [];
  for (let i = 0; i < 10; i += 1) rows.push({ ts: `2026-06-${String(i + 1).padStart(2, "0")}`, price: 0.5 + (i % 2) * 0.005 });
  rows.push({ ts: "2026-06-20", price: 0.85 }); // big jump
  const s = buildPriceSeries(rows, 2);
  assert.ok(s.regimeShifts.length >= 1);
  assert.equal(s.regimeShifts.at(-1)?.ts, "2026-06-20");
  assert.ok((s.regimeShifts.at(-1)?.delta ?? 0) > 0.2);
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
