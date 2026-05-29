import test from "node:test";
import assert from "node:assert/strict";
import { CONFIG } from "./config.js";
import { isSuspectedBot } from "./botDetection.js";
import type { TradeActivity } from "./polymarket.js";

function trade(overrides: Partial<TradeActivity> = {}): TradeActivity {
  return {
    proxyWallet: "0xabc",
    timestamp: 1_700_000_000,
    conditionId: "cond",
    size: 100,
    usdcSize: 100,
    price: 1,
    side: "BUY",
    asset: "asset",
    outcomeIndex: 0,
    market: "market",
    transactionHash: null,
    ...overrides
  };
}

function build(count: number, overrides: (index: number) => Partial<TradeActivity>): TradeActivity[] {
  return Array.from({ length: count }, (_value, index) =>
    trade({ timestamp: 1_700_000_000 + index, ...overrides(index) })
  );
}

test("isSuspectedBot is false for empty activity", () => {
  assert.equal(isSuspectedBot([], 90, CONFIG), false);
});

test("isSuspectedBot flags excessive trades per day", () => {
  const activity = build(CONFIG.BOT.MAX_TRADES_PER_DAY + 1, () => ({}));
  assert.equal(isSuspectedBot(activity, 1, CONFIG), true);
});

test("isSuspectedBot does not flag trades per day exactly at the limit", () => {
  // Same market + all buys so the simultaneous-markets check stays at 1.
  const activity = build(CONFIG.BOT.MAX_TRADES_PER_DAY, () => ({ conditionId: "same" }));
  assert.equal(isSuspectedBot(activity, 1, CONFIG), false);
});

test("isSuspectedBot flags dust-sized average trades", () => {
  const activity = build(10, () => ({ usdcSize: CONFIG.BOT.MIN_AVG_TRADE_SIZE_USD / 2 }));
  assert.equal(isSuspectedBot(activity, 90, CONFIG), true);
});

test("isSuspectedBot flags too many simultaneous open markets", () => {
  const activity = build(CONFIG.BOT.MAX_SIMULTANEOUS_MARKETS + 1, (index) => ({
    conditionId: `cond-${index}`,
    side: "BUY"
  }));
  assert.equal(isSuspectedBot(activity, 365, CONFIG), true);
});

test("isSuspectedBot does not flag markets opened and closed sequentially", () => {
  // Each market is bought then immediately sold, so only one is ever open at a time.
  const activity: TradeActivity[] = [];
  for (let index = 0; index < CONFIG.BOT.MAX_SIMULTANEOUS_MARKETS + 10; index += 1) {
    activity.push(trade({ conditionId: `cond-${index}`, side: "BUY", timestamp: 1_700_000_000 + index * 2 }));
    activity.push(trade({ conditionId: `cond-${index}`, side: "SELL", timestamp: 1_700_000_000 + index * 2 + 1 }));
  }
  assert.equal(isSuspectedBot(activity, 365, CONFIG), false);
});

test("isSuspectedBot is false for a normal trader", () => {
  const activity = build(10, (index) => ({ conditionId: `cond-${index % 3}`, usdcSize: 250 }));
  assert.equal(isSuspectedBot(activity, 90, CONFIG), false);
});
