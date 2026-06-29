import assert from "node:assert/strict";
import { test } from "node:test";
import { groupWalletTrades, applyClosedBasis, type WalletTradeRowInput, type ClosedBasisInput } from "./walletTrades";

function row(partial: Partial<WalletTradeRowInput>): WalletTradeRowInput {
  return {
    condition_id: "c1",
    market: "Will it rain?",
    outcome_index: 0,
    outcome_label: null,
    event_slug: null,
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

function closed(partial: Partial<ClosedBasisInput>): ClosedBasisInput {
  return {
    conditionId: "c1",
    outcomeIndex: 0,
    market: "Will it rain?",
    outcomeLabel: null,
    eventSlug: null,
    avgPrice: 0.4,
    size: 500,
    realizedPnl: 0,
    closeTime: "2026-01-05T00:00:00.000Z",
    ...partial
  };
}

test("applyClosedBasis backfills blank entry / 0 bought from the closed row and attaches P/L", () => {
  // A position whose buys fell outside the fill window: only a SELL fill is present.
  const [group] = applyClosedBasis(
    groupWalletTrades([row({ side: "SELL", price: 0.9, size: 200 })]),
    [closed({ avgPrice: 0.4, size: 500, realizedPnl: 250 })]
  );
  assert.ok(group);
  assert.equal(group.avgEntryPrice, 0.4); // was null (no buys), filled from the closed row
  assert.equal(group.totalBoughtSize, 500); // was 0 (no buys), filled from the closed row
  assert.equal(group.realizedPnl, 250);
  // % = realizedPnl / (avgPrice·size) = 250 / (0.4·500=200) = 1.25
  assert.equal(group.realizedPnlPct, 1.25);
});

test("applyClosedBasis keeps fill-derived entry/bought when present, still attaches P/L", () => {
  const [group] = applyClosedBasis(
    groupWalletTrades([row({ side: "BUY", price: 0.6, size: 100 }), row({ side: "SELL", price: 0.9, size: 100 })]),
    [closed({ avgPrice: 0.4, size: 500, realizedPnl: -30 })]
  );
  assert.ok(group);
  assert.equal(group.avgEntryPrice, 0.6); // real buy fill in window wins over the closed-row basis
  assert.equal(group.totalBoughtSize, 100);
  assert.equal(group.realizedPnl, -30);
  // % still uses the closed row's basis (0.4·500=200), not the window buys: -30/200 = -0.15
  assert.equal(group.realizedPnlPct, -0.15);
});

test("applyClosedBasis leaves groups with no matching closed row untouched (P/L null)", () => {
  const [group] = applyClosedBasis(groupWalletTrades([row({ side: "BUY", price: 0.5, size: 50 })]), []);
  assert.ok(group);
  assert.equal(group.realizedPnl, null);
});

test("applyClosedBasis appends synthetic rows for closed positions absent from the fill window", () => {
  // Fill window saturated by one market (c1); the wallet also closed c2 + c3 earlier (no fills here).
  const groups = applyClosedBasis(groupWalletTrades([row({ condition_id: "c1", side: "BUY", size: 10 })]), [
    closed({ conditionId: "c2", market: "Old A", outcomeLabel: "Under", eventSlug: "cs2-foo-2026-01-10", avgPrice: 0.5, size: 100, realizedPnl: 50, closeTime: "2026-01-10T00:00:00.000Z" }),
    closed({ conditionId: "c3", market: "Old B", avgPrice: 0.2, size: 100, realizedPnl: -20, closeTime: "2026-01-08T00:00:00.000Z" })
  ]);
  assert.equal(groups.length, 3); // the live c1 group + two synthetic closed rows
  const synth = groups.find((g) => g.conditionId === "c2");
  assert.ok(synth);
  assert.equal(synth.market, "Old A");
  assert.equal(synth.outcomeLabel, "Under"); // real side label carried onto the synthetic row
  assert.equal(synth.eventSlug, "cs2-foo-2026-01-10");
  assert.equal(synth.totalBoughtSize, 100);
  assert.equal(synth.totalSoldSize, 100);
  assert.equal(synth.realizedPnl, 50);
  // exit = entry + pnl/size = 0.5 + 50/100 = 1.0 (won, settled at $1)
  assert.equal(synth.avgExitPrice, 1);
  assert.equal(synth.fills.length, 0);
  // Sorted newest-first by date: c1 (today, from the row default 2026-01-01) vs c2 (Jan 10) vs c3 (Jan 8).
  assert.deepEqual(groups.map((g) => g.conditionId), ["c2", "c3", "c1"]);
});
