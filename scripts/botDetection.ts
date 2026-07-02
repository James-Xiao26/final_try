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
export type BotSignal = "trade_rate" | "dust_trades" | "simultaneous_markets" | "fast_flipper";

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
  // Holding-time tracking: when a position first opens, stamp the timestamp; when it fully closes,
  // record how long it was held. Positions still open at the end of the window have no completed
  // round-trip and don't count. timestamps are unix seconds (same units as the trades/day window).
  const openedAt = new Map<string, number>();
  const holdingSeconds: number[] = [];
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
      const opened = openedAt.get(positionKey);
      if (opened !== undefined) {
        holdingSeconds.push(trade.timestamp - opened);
        openedAt.delete(positionKey);
      }
    } else if (!wasOpen && isOpen) {
      openPositionsByMarket.set(trade.conditionId, (openPositionsByMarket.get(trade.conditionId) ?? 0) + 1);
      openedAt.set(positionKey, trade.timestamp);
    }

    maxSimultaneousMarkets = Math.max(maxSimultaneousMarkets, openPositionsByMarket.size);
  }

  if (maxSimultaneousMarkets > config.BOT.MAX_SIMULTANEOUS_MARKETS) {
    return "simultaneous_markets";
  }

  // Fast-flipper / scalper: completed round-trips dominated by sub-FAST_FLIP_MAX_HOURS holds are
  // non-copyable churn (arb/hedge/scalp), not forecasting bets. Catches wallets the rate/size/breadth
  // signals miss. Gated on FAST_FLIP_MIN_ROUNDTRIPS so a wallet with only a couple quick trades isn't
  // judged on noise.
  if (holdingSeconds.length >= config.BOT.FAST_FLIP_MIN_ROUNDTRIPS) {
    const flipCutoffSeconds = config.BOT.FAST_FLIP_MAX_HOURS * 60 * 60;
    const flips = holdingSeconds.filter((seconds) => seconds <= flipCutoffSeconds).length;
    if (flips / holdingSeconds.length >= config.BOT.FAST_FLIP_FRACTION) {
      return "fast_flipper";
    }
  }

  return null;
}

// conditionIds where the wallet held BOTH outcome legs concurrently (overlapping open windows), each
// leg's cost basis clearing ARBITRAGE_MIN_LEG_USD — locking in a YES+NO<$1 mispricing or hedging, not
// a directional forecast. A separate pass from botSignal (not folded in) because its output is a
// per-market exclusion set consumed by excludeArbitrage (scripts/metrics.ts), not a wallet-level ban:
// only the specific two-sided positions are stripped from scoring, everything else the wallet
// forecasted still counts. Concurrency (not just "held both sides ever") matters — a wallet that
// genuinely changed its mind (sold YES, later bought NO) must NOT be flagged, and only the raw
// chronological /activity stream (not the aggregated ClosedPosition records computeMetrics sees) can
// tell the two apart. Once a conditionId is flagged it stays flagged for the whole run, even if one
// leg is later closed — the two-sided hold already happened.
export function detectArbitrageConditions(activity: TradeActivity[], config: typeof CONFIG): Set<string> {
  const netSizeByPosition = new Map<string, number>();
  const netCostByPosition = new Map<string, number>();
  const openLegsByCondition = new Map<string, Set<string>>();
  const arbConditionIds = new Set<string>();
  const chronological = [...activity].sort((left, right) => left.timestamp - right.timestamp);

  for (const trade of chronological) {
    const positionKey = keyFor(trade);
    const sign = trade.side === "BUY" ? 1 : trade.side === "SELL" ? -1 : 0;
    const nextSize = (netSizeByPosition.get(positionKey) ?? 0) + sign * trade.size;
    const nextCost = (netCostByPosition.get(positionKey) ?? 0) + sign * trade.usdcSize;
    const isOpen = nextSize > CLOSED_SIZE_EPSILON;

    if (isOpen) {
      netSizeByPosition.set(positionKey, nextSize);
      netCostByPosition.set(positionKey, nextCost);
    } else {
      netSizeByPosition.delete(positionKey);
      netCostByPosition.delete(positionKey);
    }

    let legs = openLegsByCondition.get(trade.conditionId);
    if (isOpen && nextCost >= config.ARBITRAGE_MIN_LEG_USD) {
      if (!legs) {
        legs = new Set();
        openLegsByCondition.set(trade.conditionId, legs);
      }
      legs.add(positionKey);
    } else if (legs) {
      legs.delete(positionKey);
      if (legs.size === 0) {
        openLegsByCondition.delete(trade.conditionId);
      }
    }

    if ((openLegsByCondition.get(trade.conditionId)?.size ?? 0) >= 2) {
      arbConditionIds.add(trade.conditionId);
    }
  }

  return arbConditionIds;
}
