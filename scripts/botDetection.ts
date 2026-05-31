import type { CONFIG } from "./config.js";
import type { TradeActivity } from "./polymarket.js";

// A position is one market + outcome token. Buying YES and NO of the same market are tracked as
// two positions, but collapse to one "market" (conditionId) in the simultaneous-markets count.
function keyFor(activity: TradeActivity): string {
  return `${activity.conditionId}:${activity.asset || activity.outcomeIndex}`;
}

// Net open token size at or below this counts as a closed position. Guards against float residue
// from partial sells and against sells whose matching buys fell outside the fetched activity window
// (which would otherwise drive net size negative).
const CLOSED_SIZE_EPSILON = 1e-9;

// Which heuristic flagged a wallet. Returned (instead of a bare boolean) so ingest can report a
// per-signal breakdown — essential for tuning, since the thresholds interact and a spike in
// exclusions is otherwise opaque.
export type BotSignal = "trade_rate" | "dust_trades" | "simultaneous_markets";

export function isSuspectedBot(activity: TradeActivity[], config: typeof CONFIG): boolean {
  return botSignal(activity, config) !== null;
}

export function botSignal(activity: TradeActivity[], config: typeof CONFIG): BotSignal | null {
  if (activity.length === 0) {
    return null;
  }

  // Trades per day over the window the trades actually occupy. /activity returns the most recent
  // ACTIVITY_LIMIT trades with no date filter, so a fixed-horizon denominator both under-counts a
  // bursty bot (e.g. 500 trades in 3 days looks like ~5/day against a 90-day horizon) and lets a
  // truncated history hide its true rate. The observed span fixes both; MIN_RATE_WINDOW_DAYS floors
  // it so a handful of quick trades in one session don't divide by a near-zero window.
  let earliest = Infinity;
  let latest = -Infinity;
  for (const trade of activity) {
    if (trade.timestamp < earliest) {
      earliest = trade.timestamp;
    }
    if (trade.timestamp > latest) {
      latest = trade.timestamp;
    }
  }
  const spanDays = (latest - earliest) / config.SECONDS_PER_DAY;
  const windowDays = Math.max(spanDays, config.BOT.MIN_RATE_WINDOW_DAYS);
  const averageTradesPerDay = activity.length / windowDays;
  if (averageTradesPerDay > config.BOT.MAX_TRADES_PER_DAY) {
    return "trade_rate";
  }

  const totalUsd = activity.reduce((sum, trade) => sum + trade.usdcSize, 0);
  const averageTradeSizeUsd = totalUsd / activity.length;
  if (averageTradeSizeUsd < config.BOT.MIN_AVG_TRADE_SIZE_USD) {
    return "dust_trades";
  }

  // Track net open token size per position so a partial sell no longer fully closes a position.
  // openPositionsByMarket counts open positions per market, so its size is the number of distinct
  // markets currently held; maxSimultaneousMarkets is the peak of that over time.
  const netSizeByPosition = new Map<string, number>();
  const openPositionsByMarket = new Map<string, number>();
  let maxSimultaneousMarkets = 0;
  const chronological = [...activity].sort((left, right) => left.timestamp - right.timestamp);

  for (const trade of chronological) {
    const positionKey = keyFor(trade);
    const delta = trade.side === "BUY" ? trade.size : trade.side === "SELL" ? -trade.size : 0;
    const previous = netSizeByPosition.get(positionKey) ?? 0;
    const next = previous + delta;
    const wasOpen = previous > CLOSED_SIZE_EPSILON;
    const isOpen = next > CLOSED_SIZE_EPSILON;

    if (isOpen) {
      netSizeByPosition.set(positionKey, next);
    } else {
      netSizeByPosition.delete(positionKey);
    }

    if (wasOpen && !isOpen) {
      const remaining = (openPositionsByMarket.get(trade.conditionId) ?? 1) - 1;
      if (remaining <= 0) {
        openPositionsByMarket.delete(trade.conditionId);
      } else {
        openPositionsByMarket.set(trade.conditionId, remaining);
      }
    } else if (!wasOpen && isOpen) {
      openPositionsByMarket.set(trade.conditionId, (openPositionsByMarket.get(trade.conditionId) ?? 0) + 1);
    }

    maxSimultaneousMarkets = Math.max(maxSimultaneousMarkets, openPositionsByMarket.size);
  }

  return maxSimultaneousMarkets > config.BOT.MAX_SIMULTANEOUS_MARKETS ? "simultaneous_markets" : null;
}
