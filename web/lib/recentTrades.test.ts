import assert from "node:assert/strict";
import { test } from "node:test";
import { groupRecentTrades, positionKey, type ClosedBasis, type OpenBasis, type TradeBasis } from "./recentTrades";
import type { RecentTrade } from "./types";

function trade(partial: Partial<RecentTrade>): RecentTrade {
  return {
    address: "0xabc",
    handle: "tide",
    skillScore: 7,
    rank: 3,
    conditionId: "c1",
    market: "Will it rain?",
    outcomeIndex: 0,
    side: "BUY",
    price: 0.5,
    size: 100,
    usdcSize: 50,
    tradedAt: "2026-01-01T00:00:00.000Z",
    ...partial
  };
}

const noOpen = new Map<string, OpenBasis>();
const noClosed = new Map<string, ClosedBasis>();
const noTrade = new Map<string, TradeBasis>();

// ── Open cache path ───────────────────────────────────────────────────────────

test("open position uses wallet_positions cache for basis, mark, value and unrealized %", () => {
  const open = new Map<string, OpenBasis>([
    [positionKey("0xabc", "c1", 0), { avgEntry: 0.48, curPrice: 0.6, currentValue: 600, cashPnl: 120, size: 1000 }]
  ]);
  const [p] = groupRecentTrades([trade({ side: "BUY", price: 0.6, size: 200 })], open, noClosed, noTrade);
  assert.ok(p);
  assert.equal(p.state, "open");
  assert.equal(p.basisSource, "cache");
  assert.equal(p.avgEntry, 0.48);
  assert.equal(p.mark, 0.6);
  assert.equal(p.positionValue, 600);
  assert.equal(p.remainingSize, 1000);
  // (0.6 - 0.48) / 0.48 = 0.25
  assert.equal(p.unrealizedPct, 0.25);
  assert.equal(p.realizedPct, null);
});

test("open cache + avg_price=0 falls back to in-window buy for avgEntry", () => {
  const open = new Map<string, OpenBasis>([
    [positionKey("0xabc", "c1", 0), { avgEntry: 0, curPrice: 0.6, currentValue: 600, cashPnl: 120, size: 1000 }]
  ]);
  const [p] = groupRecentTrades([trade({ side: "BUY", price: 0.5, size: 200 })], open, noClosed, noTrade);
  assert.ok(p);
  assert.equal(p.state, "open");
  assert.equal(p.avgEntry, 0.5); // falls back to in-window buy
  assert.equal(p.basisSource, "fills");
});

// ── likelyClosed detection ────────────────────────────────────────────────────

test("likelyClosed: in-window sells >= open.size shows as closed with realized %", () => {
  const open = new Map<string, OpenBasis>([
    [positionKey("0xabc", "c1", 0), { avgEntry: 0.4, curPrice: 0.7, currentValue: 700, cashPnl: 300, size: 1000 }]
  ]);
  const [p] = groupRecentTrades(
    [trade({ side: "SELL", price: 0.7, size: 1000, tradedAt: "2026-01-02T00:00:00.000Z" })],
    open,
    noClosed,
    noTrade
  );
  assert.ok(p);
  assert.equal(p.state, "closed");
  assert.equal(p.basisSource, "cache");
  assert.equal(p.avgEntry, 0.4);
  // (0.7 - 0.4) / 0.4 = 0.75
  assert.ok(p.realizedPct !== null && Math.abs(p.realizedPct - 0.75) < 1e-9);
  assert.equal(p.remainingSize, 0);
  assert.equal(p.realizedPnl, null); // Polymarket's realized PnL not available until next ingest
});

test("likelyClosed: partial sell (< open.size) stays open", () => {
  const open = new Map<string, OpenBasis>([
    [positionKey("0xabc", "c1", 0), { avgEntry: 0.4, curPrice: 0.6, currentValue: 600, cashPnl: 200, size: 1000 }]
  ]);
  const [p] = groupRecentTrades(
    [trade({ side: "SELL", price: 0.6, size: 400, tradedAt: "2026-01-02T00:00:00.000Z" })],
    open,
    noClosed,
    noTrade
  );
  assert.ok(p);
  assert.equal(p.state, "open");
  assert.equal(p.avgEntry, 0.4);
});

test("likelyClosed: in-window add + sell-out blends basis", () => {
  // Wallet held 500 shares (avg 0.4 per cache). Added 500 more at 0.6 in-window. Sold all 1000 at 0.7.
  // Blended avg = (0.4*500 + 0.6*500) / 1000 = 0.5
  const open = new Map<string, OpenBasis>([
    [positionKey("0xabc", "c1", 0), { avgEntry: 0.4, curPrice: 0.65, currentValue: 325, cashPnl: 100, size: 500 }]
  ]);
  const fills = [
    trade({ side: "SELL", price: 0.7,  size: 1000, tradedAt: "2026-01-03T00:00:00.000Z" }),
    trade({ side: "BUY",  price: 0.6,  size: 500,  tradedAt: "2026-01-02T00:00:00.000Z" })
  ];
  const [p] = groupRecentTrades(fills, open, noClosed, noTrade);
  assert.ok(p);
  assert.equal(p.state, "closed");
  assert.equal(p.avgEntry, 0.5);
  // (0.7 - 0.5) / 0.5 = 0.4
  assert.ok(p.realizedPct !== null && Math.abs(p.realizedPct - 0.4) < 1e-9);
});

test("likelyClosed: open.size=null does not trigger (no detection without size)", () => {
  const open = new Map<string, OpenBasis>([
    [positionKey("0xabc", "c1", 0), { avgEntry: 0.4, curPrice: 0.7, currentValue: null, cashPnl: null, size: null }]
  ]);
  const [p] = groupRecentTrades(
    [trade({ side: "SELL", price: 0.7, size: 1000, tradedAt: "2026-01-02T00:00:00.000Z" })],
    open,
    noClosed,
    noTrade
  );
  assert.ok(p);
  // Without open.size we cannot detect likelyClosed; falls through to the normal open branch.
  assert.equal(p.state, "open");
});

// ── Closed cache path ─────────────────────────────────────────────────────────

test("closed cache: shows realized % from realizedPnl / (avgEntry * size)", () => {
  const closed = new Map<string, ClosedBasis>([
    [positionKey("0xabc", "c1", 0), { avgEntry: 0.5, realizedPnl: 125, size: 1000 }]
  ]);
  const [p] = groupRecentTrades(
    [
      trade({ side: "SELL", price: 0.62, size: 600, tradedAt: "2026-01-02T00:00:00.000Z" }),
      trade({ side: "SELL", price: 0.6,  size: 400, tradedAt: "2026-01-01T00:00:00.000Z" })
    ],
    noOpen,
    closed,
    noTrade
  );
  assert.ok(p);
  assert.equal(p.state, "closed");
  assert.equal(p.basisSource, "cache");
  assert.equal(p.avgEntry, 0.5);
  assert.equal(p.remainingSize, 0);
  // 125 / (0.5 * 1000) = 0.25
  assert.equal(p.realizedPct, 0.25);
  assert.equal(p.lastPrice, 0.62);
  assert.equal(p.soldSize, 1000);
});

test("closed cache: avg_price=0 (API omission) falls back to TradeBasis", () => {
  // avg_price was stored as 0 because readNumber defaulted when the API field was absent.
  const closed = new Map<string, ClosedBasis>([
    [positionKey("0xabc", "c1", 0), { avgEntry: 0, realizedPnl: 50, size: 500 }]
  ]);
  const tradeBasis = new Map<string, TradeBasis>([
    [positionKey("0xabc", "c1", 0), { preWindowWeighted: 0.4 * 500, preWindowSize: 500 }]
  ]);
  const [p] = groupRecentTrades(
    [trade({ side: "SELL", price: 0.6, size: 500, tradedAt: "2026-01-02T00:00:00.000Z" })],
    noOpen,
    closed,
    tradeBasis
  );
  assert.ok(p);
  assert.equal(p.state, "closed");
  assert.equal(p.basisSource, "trades");
  assert.equal(p.avgEntry, 0.4); // from TradeBasis
  // realizedPnl=50, avgEntry=0.4, size=500: 50 / (0.4 * 500) = 0.25
  assert.ok(p.realizedPct !== null && Math.abs(p.realizedPct - 0.25) < 1e-9);
});

test("closed cache: avg_price=0 + no TradeBasis falls back to in-window buy", () => {
  const closed = new Map<string, ClosedBasis>([
    [positionKey("0xabc", "c1", 0), { avgEntry: 0, realizedPnl: null, size: 500 }]
  ]);
  const fills = [
    trade({ side: "SELL", price: 0.7,  size: 500, tradedAt: "2026-01-02T00:00:00.000Z" }),
    trade({ side: "BUY",  price: 0.45, size: 500, tradedAt: "2026-01-01T00:00:00.000Z" })
  ];
  const [p] = groupRecentTrades(fills, noOpen, closed, noTrade);
  assert.ok(p);
  assert.equal(p.avgEntry, 0.45); // from in-window fills
  assert.equal(p.basisSource, "fills");
  assert.ok(p.realizedPct !== null && Math.abs(p.realizedPct - (0.7 - 0.45) / 0.45) < 1e-9);
});

// ── No-cache: fills only ──────────────────────────────────────────────────────

test("no-cache: pure sell (out-of-window buys) with TradeBasis computes realized %", () => {
  // Wallet bought 500 shares at avg 0.4 (pre-window, in wallet_trades). Sold 500 at 0.65 in-window.
  const tradeBasis = new Map<string, TradeBasis>([
    [positionKey("0xabc", "c1", 0), { preWindowWeighted: 0.4 * 500, preWindowSize: 500 }]
  ]);
  const [p] = groupRecentTrades(
    [trade({ side: "SELL", price: 0.65, size: 500, tradedAt: "2026-01-02T00:00:00.000Z" })],
    noOpen,
    noClosed,
    tradeBasis
  );
  assert.ok(p);
  assert.equal(p.state, "closed");
  assert.equal(p.basisSource, "trades");
  assert.equal(p.avgEntry, 0.4);
  // (0.65 - 0.4) / 0.4 = 0.625
  assert.ok(p.realizedPct !== null && Math.abs(p.realizedPct - 0.625) < 1e-9);
});

test("no-cache: pure sell with no TradeBasis still has null avg entry (genuinely unknown)", () => {
  const [p] = groupRecentTrades(
    [trade({ side: "SELL", price: 0.6, size: 800 })],
    noOpen,
    noClosed,
    noTrade
  );
  assert.ok(p);
  assert.equal(p.state, "closed");
  assert.equal(p.basisSource, "none");
  assert.equal(p.avgEntry, null);
  assert.equal(p.realizedPct, null);
});

test("no-cache: round-trip in-window uses fills for P/L", () => {
  const [p] = groupRecentTrades(
    [
      // size 300: buyWeighted = 0.4 * 300 = 120 ≥ MIN_BUY_USD
      trade({ side: "SELL", price: 0.5, size: 300, tradedAt: "2026-01-02T00:00:00.000Z" }),
      trade({ side: "BUY",  price: 0.4, size: 300, tradedAt: "2026-01-01T00:00:00.000Z" })
    ],
    noOpen,
    noClosed,
    noTrade
  );
  assert.ok(p);
  assert.equal(p.state, "closed");
  assert.equal(p.basisSource, "fills");
  // (0.5 - 0.4) / 0.4 = 0.25
  assert.ok(p.realizedPct !== null && Math.abs(p.realizedPct - 0.25) < 1e-9);
});

test("no-cache: TradeBasis blends with in-window buys for complete avg", () => {
  // Wallet bought 200 pre-window at 0.3 (in wallet_trades). Bought 300 in-window at 0.5. Sold all 500 at 0.65.
  // Full avg = (200*0.3 + 300*0.5) / 500 = (60 + 150) / 500 = 0.42
  const tradeBasis = new Map<string, TradeBasis>([
    [positionKey("0xabc", "c1", 0), { preWindowWeighted: 0.3 * 200, preWindowSize: 200 }]
  ]);
  const fills = [
    trade({ side: "SELL", price: 0.65, size: 500, tradedAt: "2026-01-03T00:00:00.000Z" }),
    trade({ side: "BUY",  price: 0.5,  size: 300, tradedAt: "2026-01-02T00:00:00.000Z" })
  ];
  const [p] = groupRecentTrades(fills, noOpen, noClosed, tradeBasis);
  assert.ok(p);
  assert.equal(p.state, "closed");
  assert.equal(p.basisSource, "trades");
  assert.ok(p.avgEntry !== null && Math.abs(p.avgEntry - 0.42) < 1e-9);
  // (0.65 - 0.42) / 0.42 ≈ 0.5476
  assert.ok(p.realizedPct !== null && Math.abs(p.realizedPct - (0.65 - 0.42) / 0.42) < 1e-9);
});

test("no-cache: partial in-window entry (sellSize > buySize) shows avgBuy from TradeBasis", () => {
  // Bought 300 pre-window + 300 in-window at 0.4, then sold all 600. Only the in-window BUY is in
  // the feed, so sellSize > buySize. avgEntry shows the blended avg; realized % computed.
  const tradeBasis = new Map<string, TradeBasis>([
    [positionKey("0xabc", "c1", 0), { preWindowWeighted: 0.4 * 300, preWindowSize: 300 }]
  ]);
  const fills = [
    trade({ side: "SELL", price: 0.65, size: 600, tradedAt: "2026-01-02T00:00:00.000Z" }),
    trade({ side: "BUY",  price: 0.4,  size: 300, tradedAt: "2026-01-01T00:00:00.000Z" })
  ];
  const [p] = groupRecentTrades(fills, noOpen, noClosed, tradeBasis);
  assert.ok(p);
  assert.equal(p.state, "closed");
  assert.equal(p.basisSource, "trades");
  assert.equal(p.avgEntry, 0.4); // (300*0.4 + 300*0.4) / 600 = 0.4
  assert.ok(p.realizedPct !== null && Math.abs(p.realizedPct - (0.65 - 0.4) / 0.4) < 1e-9);
});

test("no-cache: open position built from in-window adds uses volume-weighted buy basis", () => {
  const [p] = groupRecentTrades(
    [
      trade({ side: "BUY", price: 0.6, size: 100, tradedAt: "2026-01-02T00:00:00.000Z" }),
      trade({ side: "BUY", price: 0.4, size: 300, tradedAt: "2026-01-01T00:00:00.000Z" })
    ],
    noOpen,
    noClosed,
    noTrade
  );
  assert.ok(p);
  assert.equal(p.state, "open");
  assert.equal(p.basisSource, "fills");
  // (100*0.6 + 300*0.4) / 400 = 0.45
  assert.equal(p.avgEntry, 0.45);
  assert.equal(p.mark, 0.6);
  assert.ok(p.unrealizedPct !== null && Math.abs(p.unrealizedPct - (0.6 - 0.45) / 0.45) < 1e-9);
  assert.equal(p.remainingSize, 400);
});

// ── Grouping and filtering ────────────────────────────────────────────────────

test("groups by conditionId + outcomeIndex, keeps all fills, orders newest-first", () => {
  const positions = groupRecentTrades(
    [
      // size 300: buyWeighted = 0.5 * 300 = 150 ≥ MIN_BUY_USD
      trade({ conditionId: "newer", market: "newer", tradedAt: "2026-02-01T00:00:00.000Z", size: 300 }),
      trade({ conditionId: "older", market: "older", tradedAt: "2026-01-01T00:00:00.000Z", size: 300 }),
      trade({ conditionId: "older", market: "older", tradedAt: "2026-01-01T06:00:00.000Z", size: 300 })
    ],
    noOpen,
    noClosed,
    noTrade
  );
  assert.equal(positions.length, 2);
  assert.deepEqual(positions.map((p) => p.market), ["newer", "older"]);
  assert.equal(positions[1]?.fills.length, 2);
});

test("returns empty for empty input", () => {
  assert.deepEqual(groupRecentTrades([], noOpen, noClosed, noTrade), []);
});
