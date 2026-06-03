import { CONFIG } from "./config.js";
import type { TradeActivity } from "./polymarket.js";

// One recent trade fill, mapped from the /activity payload that bot detection already consumes.
// camelCase intermediate; ingest maps it to the snake_case recent_trades row on the way to Supabase.
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

// Keep only fills at/after cutoffMs and shape them for persistence. `activity` is already in hand in
// processWallet (fetched for bot detection), so this adds no Polymarket API calls. Polymarket
// /activity timestamps are unix seconds.
export function recentTradesFromActivity(
  activity: TradeActivity[],
  address: string,
  cutoffMs: number
): RecentTrade[] {
  const normalized = address.toLowerCase();
  const trades: RecentTrade[] = [];
  for (const trade of activity) {
    const tradedAtMs = trade.timestamp * CONFIG.MS_PER_SECOND;
    if (!Number.isFinite(tradedAtMs) || tradedAtMs < cutoffMs) {
      continue;
    }
    trades.push({
      address: normalized,
      conditionId: trade.conditionId,
      market: trade.market,
      outcomeIndex: trade.outcomeIndex,
      side: trade.side,
      price: trade.price,
      size: trade.size,
      usdcSize: trade.usdcSize,
      tradedAt: new Date(tradedAtMs).toISOString()
    });
  }
  return trades;
}
