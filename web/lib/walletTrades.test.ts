import assert from "node:assert/strict";
import { test } from "node:test";
import { groupWalletTrades, type WalletTradeRowInput } from "./walletTrades";

function row(partial: Partial<WalletTradeRowInput>): WalletTradeRowInput {
  return {
    condition_id: "c1",
    market: "Will it rain?",
    outcome_index: 0,
    side: "BUY",
    price: 0.5,
    size: 10,
    usdc_size: 5,
    traded_at: "2026-01-01T00:00:00.000Z",
    transaction_hash: null,
    ...partial
  };
}

test("groupWalletTrades collapses fills on one position with volume-weighted avg entry/exit", () => {
  const groups = groupWalletTrades([
    row({ side: "BUY", price: 0.4, size: 100, traded_at: "2026-01-01T00:00:00.000Z" }),
    row({ side: "BUY", price: 0.6, size: 300, traded_at: "2026-01-02T00:00:00.000Z" }),
    row({ side: "SELL", price: 0.8, size: 200, traded_at: "2026-01-03T00:00:00.000Z" })
  ]);
  assert.equal(groups.length, 1);
  const [group] = groups;
  assert.ok(group);
  // Avg entry = (100*0.4 + 300*0.6) / 400 = 0.55
  assert.equal(group.avgEntryPrice, 0.55);
  // Avg exit = 200*0.8 / 200 = 0.8
  assert.equal(group.avgExitPrice, 0.8);
  assert.equal(group.totalBoughtSize, 400);
  assert.equal(group.totalSoldSize, 200);
  // All three raw fills kept for the dropdown.
  assert.equal(group.fills.length, 3);
});

test("groupWalletTrades reports null avg exit for a still-held position (no sells)", () => {
  const [group] = groupWalletTrades([
    row({ side: "BUY", price: 0.5, size: 50 }),
    row({ side: "BUY", price: 0.5, size: 50 })
  ]);
  assert.ok(group);
  assert.equal(group.avgExitPrice, null);
  assert.equal(group.totalSoldSize, 0);
  assert.equal(group.avgEntryPrice, 0.5);
});

test("groupWalletTrades keeps the two outcome tokens of a market as separate groups", () => {
  const groups = groupWalletTrades([
    row({ condition_id: "m1", outcome_index: 0, side: "BUY" }),
    row({ condition_id: "m1", outcome_index: 1, side: "BUY" })
  ]);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((group) => group.outcomeIndex).sort(), [0, 1]);
});

test("groupWalletTrades orders groups by most-recent fill first", () => {
  const groups = groupWalletTrades([
    row({ condition_id: "older", market: "older", traded_at: "2026-01-01T00:00:00.000Z" }),
    row({ condition_id: "newer", market: "newer", traded_at: "2026-02-01T00:00:00.000Z" })
  ]);
  assert.deepEqual(groups.map((group) => group.market), ["newer", "older"]);
});

test("groupWalletTrades returns empty for empty input", () => {
  assert.deepEqual(groupWalletTrades([]), []);
});
