import { CONFIG } from "./config.js";
import type { Position, TradeActivity } from "./polymarket.js";

// One raw fill for a wallet-profile trade history. Unlike recentTrades.ts (which collapses fills for
// the landing feed), these stay individual: the web read layer groups them per market position and
// shows the raw fills as an expandable dropdown. camelCase intermediate; ingest maps to the
// snake_case wallet_trades row.
export interface ProfileFill {
  address: string;
  conditionId: string;
  market: string;
  outcomeIndex: number;
  side: "BUY" | "SELL" | "UNKNOWN";
  price: number;
  size: number;
  usdcSize: number;
  tradedAt: string;
  transactionHash: string | null;
}

// One current open holding for the wallet-profile positions list. Derived from the open
// (redeemable === false) subset of /positions — the same payload openUnrealizedPnl consumes, so this
// adds no API calls. Resolved-but-unredeemed positions are excluded: they're realized, not open.
export interface OpenPositionRecord {
  address: string;
  conditionId: string;
  asset: string;
  market: string;
  outcomeIndex: number;
  size: number;
  avgPrice: number;
  curPrice: number;
  initialValue: number;
  currentValue: number;
  cashPnl: number;
  endDate: string | null;
}

// endDate on a position is a calendar date string ("2026-05-10"); normalize to an ISO timestamp the
// TIMESTAMPTZ column accepts, or null when absent/unparseable (rather than letting a bad string reach
// Postgres).
function isoOrNull(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

// Most-recent `limit` raw fills from a wallet's already-fetched /activity, newest first. Polymarket
// /activity timestamps are unix seconds.
export function profileFillsFromActivity(
  activity: TradeActivity[],
  address: string,
  limit = CONFIG.PROFILE_TRADES_LIMIT
): ProfileFill[] {
  const normalized = address.toLowerCase();
  return [...activity]
    .sort((left, right) => right.timestamp - left.timestamp)
    .slice(0, limit)
    .map((trade) => ({
      address: normalized,
      conditionId: trade.conditionId,
      market: trade.market,
      outcomeIndex: trade.outcomeIndex,
      side: trade.side,
      price: trade.price,
      size: trade.size,
      usdcSize: trade.usdcSize,
      tradedAt: new Date(trade.timestamp * CONFIG.MS_PER_SECOND).toISOString(),
      transactionHash: trade.transactionHash
    }));
}

// The genuinely-open holdings (redeemable === false) from a wallet's /positions, shaped for storage.
export function openPositionRecords(positions: Position[], address: string): OpenPositionRecord[] {
  const normalized = address.toLowerCase();
  return positions
    .filter((position) => !position.redeemable)
    .map((position) => ({
      address: normalized,
      conditionId: position.conditionId,
      asset: position.asset,
      market: position.market,
      outcomeIndex: position.outcomeIndex,
      size: position.size,
      avgPrice: position.avgPrice,
      curPrice: position.curPrice,
      initialValue: position.initialValue,
      currentValue: position.currentValue,
      cashPnl: position.cashPnl,
      endDate: isoOrNull(position.endDate)
    }));
}
