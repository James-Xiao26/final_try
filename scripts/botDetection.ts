import type { CONFIG } from "./config.js";
import type { TradeActivity } from "./polymarket.js";

function keyFor(activity: TradeActivity): string {
  return `${activity.conditionId}:${activity.asset || activity.outcomeIndex}`;
}

export function isSuspectedBot(
  activity: TradeActivity[],
  horizonDays: number,
  config: typeof CONFIG
): boolean {
  if (activity.length === 0) {
    return false;
  }

  const averageTradesPerDay = activity.length / horizonDays;
  if (averageTradesPerDay > config.BOT.MAX_TRADES_PER_DAY) {
    return true;
  }

  const totalUsd = activity.reduce((sum, trade) => sum + trade.usdcSize, 0);
  const averageTradeSizeUsd = totalUsd / activity.length;
  if (averageTradeSizeUsd < config.BOT.MIN_AVG_TRADE_SIZE_USD) {
    return true;
  }

  const activeMarkets = new Map<string, string>();
  let maxSimultaneousMarkets = 0;
  const chronological = [...activity].sort((left, right) => left.timestamp - right.timestamp);

  chronological.forEach((trade) => {
    const positionKey = keyFor(trade);
    if (trade.side === "SELL") {
      activeMarkets.delete(positionKey);
    } else {
      activeMarkets.set(positionKey, trade.conditionId);
    }

    maxSimultaneousMarkets = Math.max(maxSimultaneousMarkets, new Set(activeMarkets.values()).size);
  });

  return maxSimultaneousMarkets > config.BOT.MAX_SIMULTANEOUS_MARKETS;
}
