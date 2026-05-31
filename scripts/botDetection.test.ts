import test from "node:test";
import assert from "node:assert/strict";
import { CONFIG } from "./config.js";
import { botSignal, isSuspectedBot } from "./botDetection.js";
import type { TradeActivity } from "./polymarket.js";

const DAY = CONFIG.SECONDS_PER_DAY;

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
  assert.equal(isSuspectedBot([], CONFIG), false);
});

test("isSuspectedBot flags excessive trades per day within a sub-day burst", () => {
  // 51 trades over ~50s collapse to the 1-day rate floor -> 51/day, over the 50/day limit.
  const activity = build(CONFIG.BOT.MAX_TRADES_PER_DAY + 1, () => ({ conditionId: "same" }));
  assert.equal(isSuspectedBot(activity, CONFIG), true);
});

test("isSuspectedBot does not flag trades per day exactly at the limit", () => {
  // Exactly 50 trades inside the 1-day rate floor -> 50/day, not over the limit. Same market +
  // all buys so the simultaneous-markets check stays at 1.
  const activity = build(CONFIG.BOT.MAX_TRADES_PER_DAY, () => ({ conditionId: "same" }));
  assert.equal(isSuspectedBot(activity, CONFIG), false);
});

test("isSuspectedBot uses the observed span, not a fixed horizon (truncated history)", () => {
  // The most-recent ACTIVITY_LIMIT trades spanning only 1 day = ~500/day. A fixed 90-day horizon
  // would have read this as ~5.6/day and missed it; the observed-span denominator catches it.
  const count = CONFIG.ACTIVITY_LIMIT;
  const activity = build(count, (index) => ({
    conditionId: "same",
    timestamp: 1_700_000_000 + Math.round((index * DAY) / (count - 1))
  }));
  assert.equal(isSuspectedBot(activity, CONFIG), true);
});

test("isSuspectedBot does not flag a high trade count spread across many days", () => {
  // 60 trades, one per day -> ~1/day, well under the limit. Same market + all buys.
  const activity = build(60, (index) => ({ conditionId: "same", timestamp: 1_700_000_000 + index * DAY }));
  assert.equal(isSuspectedBot(activity, CONFIG), false);
});

test("isSuspectedBot flags dust-sized average trades", () => {
  const activity = build(10, () => ({ usdcSize: CONFIG.BOT.MIN_AVG_TRADE_SIZE_USD / 2 }));
  assert.equal(isSuspectedBot(activity, CONFIG), true);
});

test("isSuspectedBot flags too many simultaneous open markets", () => {
  const activity = build(CONFIG.BOT.MAX_SIMULTANEOUS_MARKETS + 1, (index) => ({
    conditionId: `cond-${index}`,
    side: "BUY"
  }));
  assert.equal(isSuspectedBot(activity, CONFIG), true);
});

test("isSuspectedBot does not flag markets opened and fully closed sequentially", () => {
  // Each market is bought then fully sold, so only one is ever open at a time. Spaced a day apart
  // so the trade rate stays well under the limit and we isolate the simultaneous-markets check.
  const activity: TradeActivity[] = [];
  for (let index = 0; index < CONFIG.BOT.MAX_SIMULTANEOUS_MARKETS + 10; index += 1) {
    activity.push(trade({ conditionId: `cond-${index}`, side: "BUY", size: 100, timestamp: 1_700_000_000 + index * 2 * DAY }));
    activity.push(trade({ conditionId: `cond-${index}`, side: "SELL", size: 100, timestamp: 1_700_000_000 + index * 2 * DAY + 1 }));
  }
  assert.equal(isSuspectedBot(activity, CONFIG), false);
});

test("isSuspectedBot keeps partially-sold positions open", () => {
  // Each market is bought (100) then only half sold (50). A presence-based check would treat the
  // sell as a full close and never see them simultaneously open; net-size tracking keeps all
  // MAX_SIMULTANEOUS_MARKETS + 1 of them open, tripping the limit. Spaced out so the rate is low.
  const markets = CONFIG.BOT.MAX_SIMULTANEOUS_MARKETS + 1;
  const activity: TradeActivity[] = [];
  for (let index = 0; index < markets; index += 1) {
    activity.push(trade({ conditionId: `cond-${index}`, side: "BUY", size: 100, timestamp: 1_700_000_000 + index * 2 * DAY }));
    activity.push(trade({ conditionId: `cond-${index}`, side: "SELL", size: 50, timestamp: 1_700_000_000 + index * 2 * DAY + 1 }));
  }
  assert.equal(isSuspectedBot(activity, CONFIG), true);
});

test("isSuspectedBot closes a position sold off across multiple partial sells", () => {
  // Buy 100, then sell 60 + 40 = fully closed, for many markets in sequence. Never more than one
  // open at a time, so the simultaneous-markets check stays low. Spaced out to keep the rate low.
  const activity: TradeActivity[] = [];
  for (let index = 0; index < CONFIG.BOT.MAX_SIMULTANEOUS_MARKETS + 10; index += 1) {
    const base = 1_700_000_000 + index * 3 * DAY;
    activity.push(trade({ conditionId: `cond-${index}`, side: "BUY", size: 100, timestamp: base }));
    activity.push(trade({ conditionId: `cond-${index}`, side: "SELL", size: 60, timestamp: base + 1 }));
    activity.push(trade({ conditionId: `cond-${index}`, side: "SELL", size: 40, timestamp: base + 2 }));
  }
  assert.equal(isSuspectedBot(activity, CONFIG), false);
});

test("isSuspectedBot is false for a normal trader", () => {
  const activity = build(10, (index) => ({ conditionId: `cond-${index % 3}`, usdcSize: 250 }));
  assert.equal(isSuspectedBot(activity, CONFIG), false);
});

test("botSignal reports which heuristic flagged the wallet", () => {
  assert.equal(botSignal([], CONFIG), null);

  const fast = build(CONFIG.BOT.MAX_TRADES_PER_DAY + 1, () => ({ conditionId: "same" }));
  assert.equal(botSignal(fast, CONFIG), "trade_rate");

  const dust = build(10, () => ({ usdcSize: CONFIG.BOT.MIN_AVG_TRADE_SIZE_USD / 2 }));
  assert.equal(botSignal(dust, CONFIG), "dust_trades");

  const wide = build(CONFIG.BOT.MAX_SIMULTANEOUS_MARKETS + 1, (index) => ({ conditionId: `cond-${index}` }));
  assert.equal(botSignal(wide, CONFIG), "simultaneous_markets");
});
