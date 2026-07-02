import test from "node:test";
import assert from "node:assert/strict";
import { CONFIG } from "./config.js";
import { shouldSkipWallet, type WalletRecheckState, type WalletRecheckStatsRow } from "./walletRecheck.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-07-01T00:00:00.000Z");

function isoDaysAgo(days: number): string {
  return new Date(NOW - days * DAY_MS).toISOString();
}

function statsRow(overrides: Partial<WalletRecheckStatsRow> = {}): WalletRecheckStatsRow {
  return {
    horizonDays: 90,
    skillScore: null,
    ineligibleReason: "insufficient_trades",
    computedAt: isoDaysAgo(1),
    ...overrides
  };
}

function state(overrides: Partial<WalletRecheckState> = {}): WalletRecheckState {
  return {
    isBotSuspected: false,
    updatedAt: isoDaysAgo(1),
    earliestTradeAt: null,
    statsRows: [statsRow()],
    ...overrides
  };
}

test("shouldSkipWallet never skips a wallet with no prior state", () => {
  assert.equal(shouldSkipWallet(null, CONFIG), false);
});

test("shouldSkipWallet skips a bot-suspected wallet inside its cooldown", () => {
  const s = state({ isBotSuspected: true, updatedAt: isoDaysAgo(CONFIG.WALLET_RECHECK.BOT_DAYS - 1) });
  assert.equal(shouldSkipWallet(s, CONFIG, NOW), true);
});

test("shouldSkipWallet reprocesses a bot-suspected wallet past its cooldown", () => {
  const s = state({ isBotSuspected: true, updatedAt: isoDaysAgo(CONFIG.WALLET_RECHECK.BOT_DAYS + 1) });
  assert.equal(shouldSkipWallet(s, CONFIG, NOW), false);
});

test("shouldSkipWallet never skips a wallet eligible on at least one horizon", () => {
  const s = state({ statsRows: [statsRow({ horizonDays: 30, skillScore: null }), statsRow({ horizonDays: 90, skillScore: 6.5 })] });
  assert.equal(shouldSkipWallet(s, CONFIG, NOW), false);
});

test("shouldSkipWallet skips insufficient_trades/insufficient_volume inside THIN_SAMPLE_DAYS", () => {
  const s = state({ statsRows: [statsRow({ ineligibleReason: "insufficient_trades", computedAt: isoDaysAgo(CONFIG.WALLET_RECHECK.THIN_SAMPLE_DAYS - 1) })] });
  assert.equal(shouldSkipWallet(s, CONFIG, NOW), true);
});

test("shouldSkipWallet reprocesses insufficient_trades past THIN_SAMPLE_DAYS", () => {
  const s = state({ statsRows: [statsRow({ ineligibleReason: "insufficient_trades", computedAt: isoDaysAgo(CONFIG.WALLET_RECHECK.THIN_SAMPLE_DAYS + 1) })] });
  assert.equal(shouldSkipWallet(s, CONFIG, NOW), false);
});

test("shouldSkipWallet skips longshot_entry inside LONGSHOT_DAYS, reprocesses past it", () => {
  const inside = state({ statsRows: [statsRow({ ineligibleReason: "longshot_entry", computedAt: isoDaysAgo(CONFIG.WALLET_RECHECK.LONGSHOT_DAYS - 1) })] });
  const past = state({ statsRows: [statsRow({ ineligibleReason: "longshot_entry", computedAt: isoDaysAgo(CONFIG.WALLET_RECHECK.LONGSHOT_DAYS + 1) })] });
  assert.equal(shouldSkipWallet(inside, CONFIG, NOW), true);
  assert.equal(shouldSkipWallet(past, CONFIG, NOW), false);
});

test("shouldSkipWallet computes the too_new cooldown exactly from earliestTradeAt, not a fixed window", () => {
  const stillTooNew = state({
    earliestTradeAt: isoDaysAgo(CONFIG.MIN_ACCOUNT_AGE_DAYS - 1),
    statsRows: [statsRow({ ineligibleReason: "too_new" })]
  });
  const nowEligible = state({
    earliestTradeAt: isoDaysAgo(CONFIG.MIN_ACCOUNT_AGE_DAYS + 1),
    statsRows: [statsRow({ ineligibleReason: "too_new" })]
  });
  assert.equal(shouldSkipWallet(stillTooNew, CONFIG, NOW), true);
  assert.equal(shouldSkipWallet(nowEligible, CONFIG, NOW), false);
});

test("shouldSkipWallet fails open (reprocesses) for too_new with no known earliestTradeAt", () => {
  const s = state({ earliestTradeAt: null, statsRows: [statsRow({ ineligibleReason: "too_new" })] });
  assert.equal(shouldSkipWallet(s, CONFIG, NOW), false);
});

test("shouldSkipWallet branches on the widest horizon's reason, not the narrowest", () => {
  // 30d looks thin (short cooldown), but 90d is what actually failed and says longshot (longer
  // cooldown) — the wider horizon wins, so this stays skipped past THIN_SAMPLE_DAYS.
  const s = state({
    statsRows: [
      statsRow({ horizonDays: 30, ineligibleReason: "insufficient_trades", computedAt: isoDaysAgo(CONFIG.WALLET_RECHECK.THIN_SAMPLE_DAYS + 1) }),
      statsRow({ horizonDays: 90, ineligibleReason: "longshot_entry", computedAt: isoDaysAgo(CONFIG.WALLET_RECHECK.THIN_SAMPLE_DAYS + 1) })
    ]
  });
  assert.equal(shouldSkipWallet(s, CONFIG, NOW), true);
});

test("shouldSkipWallet never skips when there are no stats rows at all", () => {
  const s = state({ statsRows: [] });
  assert.equal(shouldSkipWallet(s, CONFIG, NOW), false);
});
