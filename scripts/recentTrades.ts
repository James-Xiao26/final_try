import { CONFIG } from "./config.js";
import type { TradeActivity } from "./polymarket.js";

// One grouped position in the activity feed: a wallet's fills on a single market position
// (conditionId + outcome + side), collapsed to a volume-weighted average cost. camelCase
// intermediate; ingest maps it to the snake_case recent_trades row on the way to Supabase.
export interface RecentTrade {
  address: string;
  conditionId: string;
  market: string;
  outcomeIndex: number;
  side: "BUY" | "SELL" | "UNKNOWN";
  price: number;
  size: number;
  usdcSize: number;
  tradedAt: string;
}

interface TradeGroup {
  conditionId: string;
  market: string;
  outcomeIndex: number;
  side: "BUY" | "SELL" | "UNKNOWN";
  weightedPriceSum: number; // Σ size·price, for the volume-weighted average cost
  totalSize: number; // Σ shares
  totalUsdc: number; // Σ dollars placed
  latestMs: number; // most recent fill in the group
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

// Map a wallet's already-fetched /activity rows to feed records, keeping only fills at/after cutoffMs
// and COLLAPSING repeated fills on the same market position (conditionId + outcomeIndex + side) into a
// single row: a volume-weighted average cost (Σ size·price / Σ size), summed shares and dollars, and
// the latest fill time. Buys and sells, and the two outcome tokens, stay separate so the averaged
// cost stays meaningful. `activity` is already in hand in processWallet, so this adds no Polymarket
// API calls. Polymarket /activity timestamps are unix seconds.
export function recentTradesFromActivity(
  activity: TradeActivity[],
  address: string,
  cutoffMs: number
): RecentTrade[] {
  const normalized = address.toLowerCase();
  const groups = new Map<string, TradeGroup>();

  for (const trade of activity) {
    const tradedAtMs = trade.timestamp * CONFIG.MS_PER_SECOND;
    if (!Number.isFinite(tradedAtMs) || tradedAtMs < cutoffMs) {
      continue;
    }
    const key = `${trade.conditionId}:${trade.outcomeIndex}:${trade.side}`;
    const existing = groups.get(key);
    if (existing) {
      existing.weightedPriceSum += trade.size * trade.price;
      existing.totalSize += trade.size;
      existing.totalUsdc += trade.usdcSize;
      existing.latestMs = Math.max(existing.latestMs, tradedAtMs);
    } else {
      groups.set(key, {
        conditionId: trade.conditionId,
        market: trade.market,
        outcomeIndex: trade.outcomeIndex,
        side: trade.side,
        weightedPriceSum: trade.size * trade.price,
        totalSize: trade.size,
        totalUsdc: trade.usdcSize,
        latestMs: tradedAtMs
      });
    }
  }

  return [...groups.values()]
    .sort((left, right) => right.latestMs - left.latestMs)
    .map((group) => ({
      address: normalized,
      conditionId: group.conditionId,
      market: group.market,
      outcomeIndex: group.outcomeIndex,
      side: group.side,
      // Volume-weighted average cost per share across the grouped fills.
      price: group.totalSize > 0 ? round(group.weightedPriceSum / group.totalSize, 4) : 0,
      size: round(group.totalSize, 4),
      usdcSize: round(group.totalUsdc, 2),
      tradedAt: new Date(group.latestMs).toISOString()
    }));
}
