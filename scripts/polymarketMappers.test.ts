import test from "node:test";
import assert from "node:assert/strict";
import {
  mapActivity,
  mapClosedPosition,
  mapLeaderboard,
  mapPosition,
  openUnrealizedPnl,
  type Position
} from "./polymarket.js";

// These mappers are the defensive layer over Polymarket's inconsistent API field names: each field
// is read from a fallback list of keys, with safe defaults. The tests pin both the canonical shape
// and the fallback behavior, so a future key rename is caught here rather than silently zeroing data.

// --- mapClosedPosition ------------------------------------------------------

test("mapClosedPosition maps canonical fields and lowercases the wallet", () => {
  const out = mapClosedPosition({
    proxyWallet: "0xABCdef",
    asset: "asset-1",
    conditionId: "cond-1",
    market: "Will it rain?",
    outcomeIndex: 1,
    size: 100,
    avgPrice: 0.42,
    realizedPnl: 12.5,
    closeTime: 1_700_000_000,
    curPrice: 1
  });
  assert.equal(out.proxyWallet, "0xabcdef");
  assert.equal(out.asset, "asset-1");
  assert.equal(out.conditionId, "cond-1");
  assert.equal(out.market, "Will it rain?");
  assert.equal(out.outcomeIndex, 1);
  assert.equal(out.size, 100);
  assert.equal(out.avgPrice, 0.42);
  assert.equal(out.realizedPnl, 12.5);
  assert.equal(out.closeTime, new Date(1_700_000_000_000).toISOString());
  assert.equal(out.outcome, 1);
});

test("mapClosedPosition reads alternate API key names", () => {
  const out = mapClosedPosition({
    user: "0xWALLET",
    tokenId: "tok",
    marketId: "mkt",
    title: "Some market",
    totalBought: 250,
    averagePrice: 0.3,
    pnl: -5,
    timestamp: 1_700_000_000
  });
  assert.equal(out.proxyWallet, "0xwallet");
  assert.equal(out.asset, "tok");
  assert.equal(out.conditionId, "mkt");
  assert.equal(out.market, "Some market");
  assert.equal(out.size, 250);
  assert.equal(out.avgPrice, 0.3);
  assert.equal(out.realizedPnl, -5);
});

test("mapClosedPosition snaps near-settled prices to a 0/1 outcome, else null", () => {
  // RESOLUTION_EPSILON is 0.001: within epsilon of 1 -> 1, within epsilon of 0 -> 0, mid -> null.
  assert.equal(mapClosedPosition({ curPrice: 0.9995 }).outcome, 1);
  assert.equal(mapClosedPosition({ curPrice: 0.999 }).outcome, 1);
  assert.equal(mapClosedPosition({ curPrice: 0.0005 }).outcome, 0);
  assert.equal(mapClosedPosition({ curPrice: 0.5 }).outcome, null);
  // A near-certain-but-unresolved price (0.99) is NOT mistaken for a resolution.
  assert.equal(mapClosedPosition({ curPrice: 0.99 }).outcome, null);
});

test("mapClosedPosition outcome is null when no price field is present", () => {
  // Absent (not 0) so callers can tell 'field missing' from 'settled to $0'.
  assert.equal(mapClosedPosition({ size: 10 }).outcome, null);
});

test("mapClosedPosition reads outcome from payout/resolvedPrice fallbacks", () => {
  assert.equal(mapClosedPosition({ payout: 1 }).outcome, 1);
  assert.equal(mapClosedPosition({ resolvedPrice: 0 }).outcome, 0);
});

test("mapClosedPosition defaults missing fields and falls back to the epoch on a bad timestamp", () => {
  const out = mapClosedPosition({});
  assert.equal(out.proxyWallet, "");
  assert.equal(out.market, "");
  assert.equal(out.size, 0);
  assert.equal(out.avgPrice, 0);
  assert.equal(out.realizedPnl, 0);
  assert.equal(out.outcomeIndex, 0);
  assert.equal(out.closeTime, new Date(0).toISOString());
});

// --- mapPosition ------------------------------------------------------------

test("mapPosition maps fields and treats redeemable as strictly boolean true", () => {
  const out = mapPosition({
    proxyWallet: "0xAA",
    asset: "a",
    conditionId: "c",
    market: "m",
    outcomeIndex: 0,
    size: 10,
    avgPrice: 0.5,
    initialValue: 5,
    currentValue: 8,
    cashPnl: 3,
    realizedPnl: 0,
    curPrice: 0.8,
    endDate: "2026-05-10",
    redeemable: true
  });
  assert.equal(out.proxyWallet, "0xaa");
  assert.equal(out.initialValue, 5);
  assert.equal(out.currentValue, 8);
  assert.equal(out.cashPnl, 3);
  assert.equal(out.endDate, "2026-05-10");
  assert.equal(out.redeemable, true);
});

test("mapPosition: redeemable is false for any non-true value, endDate '' becomes null", () => {
  // record.redeemable === true is a strict check: the string "true" must NOT count as redeemable.
  assert.equal(mapPosition({ redeemable: "true" }).redeemable, false);
  assert.equal(mapPosition({}).redeemable, false);
  assert.equal(mapPosition({}).endDate, null);
});

// --- mapActivity ------------------------------------------------------------

test("mapActivity maps fields, lowercases wallet, and reads the side", () => {
  const out = mapActivity({
    proxyWallet: "0xBob",
    timestamp: 1_700_000_000,
    conditionId: "c",
    size: 100,
    usdcSize: 40,
    price: 0.4,
    side: "buy",
    asset: "a",
    outcomeIndex: 1,
    market: "m",
    transactionHash: "0xhash"
  });
  assert.equal(out.proxyWallet, "0xbob");
  assert.equal(out.side, "BUY");
  assert.equal(out.usdcSize, 40);
  assert.equal(out.transactionHash, "0xhash");
});

test("mapActivity derives usdcSize from size*price when absent", () => {
  const out = mapActivity({ size: 100, price: 0.25 });
  assert.equal(out.usdcSize, 25);
});

test("mapActivity normalizes side via action/type and falls back to UNKNOWN", () => {
  assert.equal(mapActivity({ action: "SELL" }).side, "SELL");
  assert.equal(mapActivity({ type: "buy" }).side, "BUY");
  assert.equal(mapActivity({ side: "redeem" }).side, "UNKNOWN");
  assert.equal(mapActivity({}).side, "UNKNOWN");
});

test("mapActivity maps an empty transaction hash to null and reads txHash fallback", () => {
  assert.equal(mapActivity({ transactionHash: "" }).transactionHash, null);
  assert.equal(mapActivity({ txHash: "0xdead" }).transactionHash, "0xdead");
});

// --- mapLeaderboard ---------------------------------------------------------

test("mapLeaderboard maps fields, lowercases wallet, and reads fallback keys", () => {
  const out = mapLeaderboard({ rank: "1", user: "0xFF", name: "alice", volume: 1000, profit: 500 });
  assert.equal(out.rank, "1");
  assert.equal(out.proxyWallet, "0xff");
  assert.equal(out.userName, "alice");
  assert.equal(out.vol, 1000);
  assert.equal(out.pnl, 500);
});

test("mapLeaderboard yields a null userName when absent", () => {
  assert.equal(mapLeaderboard({ proxyWallet: "0x1" }).userName, null);
});

// --- openUnrealizedPnl ------------------------------------------------------

function position(overrides: Partial<Position> = {}): Position {
  return {
    proxyWallet: "0xabc",
    asset: "a",
    conditionId: "c",
    market: "m",
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

test("openUnrealizedPnl sums currentValue - initialValue over genuinely-open positions", () => {
  const pnl = openUnrealizedPnl([
    position({ initialValue: 40, currentValue: 60 }), // +20
    position({ initialValue: 100, currentValue: 70 }) // -30
  ]);
  assert.equal(pnl, -10);
});

test("openUnrealizedPnl excludes resolved-but-unredeemed (redeemable) positions", () => {
  // Redeemable positions' realized win/loss enters the metric set via resolvedToClosed; counting
  // their mark here would double-count, so they're skipped.
  const pnl = openUnrealizedPnl([
    position({ initialValue: 40, currentValue: 60, redeemable: false }), // +20 counted
    position({ initialValue: 10, currentValue: 1000, redeemable: true }) // excluded
  ]);
  assert.equal(pnl, 20);
});

test("openUnrealizedPnl returns 0 for an empty set", () => {
  assert.equal(openUnrealizedPnl([]), 0);
});
