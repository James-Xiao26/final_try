import type { CONFIG } from "./config.js";
import type { IneligibilityReason } from "./metrics.js";

// Main-discovery-loop recheck cooldown: skip re-fetching /activity + /closed-positions + /positions
// for a wallet whose last full run flagged it bot/ineligible, tiered by *why* it was flagged, since
// each reason resolves on a very different timescale (see WALLET_RECHECK in config.ts). Scope: the
// main ~5k-wallet discovery loop only — the candidate pipeline keeps its own flat
// CANDIDATE_RESCORE_DAYS cooldown untouched.

export interface WalletRecheckStatsRow {
  horizonDays: number;
  skillScore: number | null;
  ineligibleReason: IneligibilityReason | null;
  computedAt: string;
}

export interface WalletRecheckState {
  isBotSuspected: boolean;
  updatedAt: string; // wallets.updated_at
  earliestTradeAt: string | null; // wallets.earliest_trade_at
  statsRows: WalletRecheckStatsRow[]; // one per horizon
}

// Unparsable/missing timestamps return Infinity ("assume it's been forever"), so every cooldown
// comparison below (`daysSince(...) < threshold`) fails open — a bad timestamp always means
// "reprocess," never "skip forever."
function daysSince(iso: string, now: number): number {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? (now - ms) / (24 * 60 * 60 * 1000) : Infinity;
}

export function shouldSkipWallet(state: WalletRecheckState | null, config: typeof CONFIG, now = Date.now()): boolean {
  // Never seen before — nothing to skip on.
  if (state === null) {
    return false;
  }

  if (state.isBotSuspected) {
    return daysSince(state.updatedAt, now) < config.WALLET_RECHECK.BOT_DAYS;
  }

  // Eligible on at least one horizon (or no recorded stats at all) — always keep it fresh.
  if (state.statsRows.length === 0 || state.statsRows.some((row) => row.skillScore !== null)) {
    return false;
  }

  // Branch on the widest horizon's reason: failing a larger window's trade/volume-count gate
  // necessarily fails a smaller window's too (a smaller horizon's positions are a subset of a
  // larger one's), so this can't under-count and miss a wallet that's actually still eligible.
  const widest = state.statsRows.reduce((a, b) => (b.horizonDays > a.horizonDays ? b : a));

  switch (widest.ineligibleReason) {
    case "too_new":
      // Not a fixed window — resolves on a known calendar date, so compute it exactly rather than
      // guessing a cooldown length. No known earliest-trade timestamp → fail open, reprocess.
      return state.earliestTradeAt !== null && daysSince(state.earliestTradeAt, now) < config.MIN_ACCOUNT_AGE_DAYS;
    case "insufficient_trades":
    case "insufficient_volume":
      return daysSince(widest.computedAt, now) < config.WALLET_RECHECK.THIN_SAMPLE_DAYS;
    case "longshot_entry":
      return daysSince(widest.computedAt, now) < config.WALLET_RECHECK.LONGSHOT_DAYS;
    case "longshot_churn":
      return daysSince(widest.computedAt, now) < config.WALLET_RECHECK.CHURN_DAYS;
    case null:
    default:
      return false;
  }
}
