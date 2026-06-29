import test from "node:test";
import assert from "node:assert/strict";
import { resolvedToClosed, chipBoardCode, type Position } from "./polymarket.js";

test("chipBoardCode maps PnL and Volume boards to chip codes, null for unknown sorts", () => {
  assert.equal(chipBoardCode("ALL", "PNL"), "pnl-all");
  assert.equal(chipBoardCode("MONTH", "PNL"), "pnl-month");
  assert.equal(chipBoardCode("WEEK", "vol"), "vol-week"); // orderBy case-insensitive
  assert.equal(chipBoardCode("ALL", "VOL"), "vol-all");
  assert.equal(chipBoardCode("ALL", "XYZ"), null);
});

function position(overrides: Partial<Position> = {}): Position {
  return {
    proxyWallet: "0xabc",
    asset: "asset",
    conditionId: "cond",
    market: "market",
    outcomeIndex: 0,
    size: 1000,
    avgPrice: 0.4,
    initialValue: 400,
    currentValue: 0,
    cashPnl: -400,
    realizedPnl: 0,
    curPrice: 0,
    endDate: "2026-05-10",
    redeemable: true,
    outcomeLabel: null,
    eventSlug: null,
    ...overrides
  };
}

test("resolvedToClosed drops genuinely-open (non-redeemable) positions", () => {
  const out = resolvedToClosed([position({ redeemable: false })]);
  assert.equal(out.length, 0);
});

test("resolvedToClosed maps a resolved loser to a negative-PnL closed position", () => {
  // curPrice 0, never redeemed: cashPnl = currentValue - initialValue = -400 (the full stake lost).
  const [out] = resolvedToClosed([position({ curPrice: 0, cashPnl: -400 })]);
  assert.ok(out);
  assert.equal(out.realizedPnl, -400);
  assert.equal(out.outcome, 0); // settled at $0 -> outcome 0
  // closeTime comes from endDate (a calendar date), not the epoch fallback.
  assert.equal(out.closeTime, new Date("2026-05-10").toISOString());
});

test("resolvedToClosed maps a resolved winner (unredeemed) to a positive-PnL closed position", () => {
  // curPrice 1: cashPnl = size - initialValue = 1000 - 400 = 600.
  const [out] = resolvedToClosed([position({ curPrice: 1, currentValue: 1000, cashPnl: 600 })]);
  assert.ok(out);
  assert.equal(out.realizedPnl, 600);
  assert.equal(out.outcome, 1); // settled at $1 -> outcome 1
});
