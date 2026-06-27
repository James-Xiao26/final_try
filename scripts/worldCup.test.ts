import test from "node:test";
import assert from "node:assert/strict";
import { CONFIG } from "./config.js";
import { isWorldCupMarket, worldCupStats } from "./worldCup.js";
import type { ClosedPosition, Position } from "./polymarket.js";

function closed(overrides: Partial<ClosedPosition> = {}): ClosedPosition {
  return {
    proxyWallet: "0xabc",
    asset: "asset",
    conditionId: "cond",
    market: "Will Argentina win the 2026 World Cup?",
    outcomeIndex: 0,
    size: 100,
    avgPrice: 0.5,
    realizedPnl: 10,
    closeTime: new Date().toISOString(),
    outcome: 1,
    ...overrides
  };
}

function openPos(overrides: Partial<Position> = {}): Position {
  return {
    proxyWallet: "0xabc",
    asset: "asset",
    conditionId: "cond",
    market: "Will Brazil win the World Cup?",
    outcomeIndex: 0,
    size: 100,
    avgPrice: 0.4,
    initialValue: 40,
    currentValue: 60,
    cashPnl: 20,
    realizedPnl: 0,
    curPrice: 0.6,
    endDate: null,
    redeemable: false,
    ...overrides
  };
}

test("isWorldCupMarket matches World Cup / FIFA titles, not other sports", () => {
  assert.equal(isWorldCupMarket("Will Argentina win the 2026 World Cup?"), true);
  assert.equal(isWorldCupMarket("FIFA Club World Cup winner"), true);
  assert.equal(isWorldCupMarket("Lakers vs Celtics Game 7"), false);
  assert.equal(isWorldCupMarket("Super Bowl LX winner"), false);
});

test("worldCupStats returns null below the bet floor", () => {
  const positions = Array.from({ length: CONFIG.WORLD_CUP_MIN_BETS - 1 }, () => closed());
  assert.equal(worldCupStats(positions, [], CONFIG), null);
});

test("worldCupStats ignores non-WC and unresolved positions", () => {
  const positions = [
    closed({ market: "NBA Finals winner", outcome: 1 }), // not WC
    closed({ market: "World Cup top scorer", outcome: null }) // unresolved
  ];
  assert.equal(worldCupStats(positions, [], CONFIG), null); // nothing counts → below floor
});

test("worldCupStats scores positive WC edge and summarizes open conviction", () => {
  // 4 winning WC bets bought at 0.5, resolved to 1 → +0.5 edge/share each.
  const positions = Array.from({ length: 4 }, () => closed({ avgPrice: 0.5, outcome: 1, realizedPnl: 5 }));
  const open = [
    openPos({ market: "Will France win the World Cup?", outcomeIndex: 1, currentValue: 30 }),
    openPos({ market: "Will Spain win the World Cup?", outcomeIndex: 0, currentValue: 90 }), // largest
    openPos({ market: "NBA champion", currentValue: 200 }), // not WC, ignored
    openPos({ market: "World Cup winner", redeemable: true, currentValue: 500 }) // settled, ignored
  ];
  const stats = worldCupStats(positions, open, CONFIG);
  assert.ok(stats);
  assert.equal(stats.nBets, 4);
  assert.equal(stats.winRate, 1);
  assert.equal(stats.avgEdgePerShare, 0.5);
  assert.equal(stats.pnlUsd, 20);
  // shrunkEdge = (4 * 0.5) / (4 + K); score floors at SCORE_FLOOR for any positive edge.
  assert.ok(stats.score >= CONFIG.SCORE_FLOOR && stats.score <= CONFIG.SCORE_MAX);
  assert.equal(stats.openBets, 2);
  assert.equal(stats.topMarket, "Will Spain win the World Cup?");
  assert.equal(stats.topSide, "YES");
});

test("worldCupStats floors negative-edge wallets at 0", () => {
  const positions = Array.from({ length: 5 }, () => closed({ avgPrice: 0.8, outcome: 0, realizedPnl: -5 }));
  const stats = worldCupStats(positions, [], CONFIG);
  assert.ok(stats);
  assert.equal(stats.score, 0);
  assert.equal(stats.topMarket, null);
});
