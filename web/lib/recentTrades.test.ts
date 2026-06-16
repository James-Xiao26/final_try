import assert from "node:assert/strict";
import { test } from "node:test";
import { groupRecentTrades, positionKey, type ClosedBasis, type OpenBasis } from "./recentTrades";
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

test("open position uses the wallet_positions cache for basis, mark, value and unrealized %", () => {
  const open = new Map<string, OpenBasis>([
    [positionKey("0xabc", "c1", 0), { avgEntry: 0.48, curPrice: 0.6, currentValue: 600, cashPnl: 120, size: 1000 }]
  ]);
  const [p] = groupRecentTrades([trade({ side: "BUY", price: 0.6, size: 200 })], open, noClosed);
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

test("fully-closed position with cache shows realized % from realizedPnl / (avgEntry * size)", () => {
  const closed = new Map<string, ClosedBasis>([
    [positionKey("0xabc", "c1", 0), { avgEntry: 0.5, realizedPnl: 125, size: 1000 }]
  ]);
  const [p] = groupRecentTrades(
    [
      trade({ side: "SELL", price: 0.62, size: 600, tradedAt: "2026-01-02T00:00:00.000Z" }),
      trade({ side: "SELL", price: 0.6, size: 400, tradedAt: "2026-01-01T00:00:00.000Z" })
    ],
    noOpen,
    closed
  );
  assert.ok(p);
  assert.equal(p.state, "closed");
  assert.equal(p.basisSource, "cache");
  assert.equal(p.avgEntry, 0.5);
  assert.equal(p.remainingSize, 0);
  // 125 / (0.5 * 1000) = 0.25
  assert.equal(p.realizedPct, 0.25);
  // headline is the most recent (newest-first) fill
  assert.equal(p.lastPrice, 0.62);
  assert.equal(p.soldSize, 1000);
});

test("sold-out position with no cache and out-of-window buys reports P/L n/a (basis unknown)", () => {
  const [p] = groupRecentTrades(
    [trade({ side: "SELL", price: 0.6, size: 800 })], // only sells in window, never saw the buys
    noOpen,
    noClosed
  );
  assert.ok(p);
  assert.equal(p.state, "closed");
  assert.equal(p.basisSource, "none");
  assert.equal(p.avgEntry, null);
  assert.equal(p.realizedPct, null);
});

test("round-trip fully inside the window reconstructs realized % from fills alone", () => {
  const [p] = groupRecentTrades(
    [
      // size 300: buyWeighted = 0.4 * 300 = 120 ≥ MIN_BUY_USD
      trade({ side: "SELL", price: 0.5, size: 300, tradedAt: "2026-01-02T00:00:00.000Z" }),
      trade({ side: "BUY", price: 0.4, size: 300, tradedAt: "2026-01-01T00:00:00.000Z" })
    ],
    noOpen,
    noClosed
  );
  assert.ok(p);
  assert.equal(p.state, "closed");
  assert.equal(p.basisSource, "fills");
  // (0.5 - 0.4) / 0.4 = 0.25
  assert.ok(p.realizedPct !== null && Math.abs(p.realizedPct - 0.25) < 1e-9);
});

test("open position built from in-window adds (no cache) uses the volume-weighted buy basis", () => {
  const [p] = groupRecentTrades(
    [
      trade({ side: "BUY", price: 0.6, size: 100, tradedAt: "2026-01-02T00:00:00.000Z" }),
      trade({ side: "BUY", price: 0.4, size: 300, tradedAt: "2026-01-01T00:00:00.000Z" })
    ],
    noOpen,
    noClosed
  );
  assert.ok(p);
  assert.equal(p.state, "open");
  assert.equal(p.basisSource, "fills");
  // (100*0.6 + 300*0.4) / 400 = 0.45
  assert.equal(p.avgEntry, 0.45);
  // mark = most recent fill price (2026-01-02 trade at 0.6); unrealizedPct = (0.6-0.45)/0.45
  assert.equal(p.mark, 0.6);
  assert.ok(p.unrealizedPct !== null && Math.abs(p.unrealizedPct - (0.6 - 0.45) / 0.45) < 1e-9);
  assert.equal(p.remainingSize, 400);
});

test("groups by conditionId + outcomeIndex, keeps all fills, orders newest-first", () => {
  const positions = groupRecentTrades(
    [
      // size 300: buyWeighted = 0.5 * 300 = 150 ≥ MIN_BUY_USD
      trade({ conditionId: "newer", market: "newer", tradedAt: "2026-02-01T00:00:00.000Z", size: 300 }),
      trade({ conditionId: "older", market: "older", tradedAt: "2026-01-01T00:00:00.000Z", size: 300 }),
      trade({ conditionId: "older", market: "older", tradedAt: "2026-01-01T06:00:00.000Z", size: 300 })
    ],
    noOpen,
    noClosed
  );
  assert.equal(positions.length, 2);
  assert.deepEqual(positions.map((p) => p.market), ["newer", "older"]);
  assert.equal(positions[1]?.fills.length, 2);
});

test("returns empty for empty input", () => {
  assert.deepEqual(groupRecentTrades([], noOpen, noClosed), []);
});
