import type { RecentFill, RecentTrade, RecentTradePosition } from "./types";

// Authoritative open-position state from the wallet_positions cache (Polymarket-computed): cost
// basis, current mark, value and unrealized PnL. Keyed by `${address}:${conditionId}:${outcomeIndex}`.
export interface OpenBasis {
  avgEntry: number | null;
  curPrice: number | null;
  currentValue: number | null;
  cashPnl: number | null;
  size: number | null;
}

// Closed-position basis from the wallet_closed_positions cache: avg entry, realized PnL, and the
// share count that closed (to turn realizedPnl into a percent return).
export interface ClosedBasis {
  avgEntry: number | null;
  realizedPnl: number | null;
  size: number | null;
}

const EPS = 1; // shares; treat |in-window net| < 1 share as a flat round-trip

export function positionKey(address: string, conditionId: string | null, outcomeIndex: number | null): string {
  return `${address}:${conditionId}:${outcomeIndex}`;
}

interface Acc {
  trade: RecentTrade; // carries identity (address/handle/skill/rank/market/outcome) + the latest fill
  latestMs: number;
  buyWeighted: number;
  buySize: number;
  sellWeighted: number;
  sellSize: number;
  fills: RecentFill[];
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

// Collapse the flat feed fills (expected newest-first) into one row per market position. The headline
// is the most recent fill; the aggregate prefers the position caches and falls back to the in-window
// fills. Returns positions most-recent-activity first.
export function groupRecentTrades(
  trades: RecentTrade[],
  openByKey: Map<string, OpenBasis>,
  closedByKey: Map<string, ClosedBasis>
): RecentTradePosition[] {
  const groups = new Map<string, Acc>();
  for (const trade of trades) {
    const key = positionKey(trade.address, trade.conditionId, trade.outcomeIndex);
    let acc = groups.get(key);
    if (!acc) {
      acc = { trade, latestMs: -Infinity, buyWeighted: 0, buySize: 0, sellWeighted: 0, sellSize: 0, fills: [] };
      groups.set(key, acc);
    }
    const side = (trade.side ?? "").toUpperCase();
    if (trade.price !== null && trade.size !== null) {
      if (side === "BUY") {
        acc.buyWeighted += trade.price * trade.size;
        acc.buySize += trade.size;
      } else if (side === "SELL") {
        acc.sellWeighted += trade.price * trade.size;
        acc.sellSize += trade.size;
      }
    }
    const ms = Date.parse(trade.tradedAt);
    // `trades` arrives newest-first, so the first fill seen for a group is its headline (latest).
    if (Number.isFinite(ms) && ms > acc.latestMs) {
      acc.latestMs = ms;
      acc.trade = trade;
    }
    acc.fills.push({
      side: trade.side,
      price: trade.price,
      size: trade.size,
      usdcSize: trade.usdcSize,
      tradedAt: trade.tradedAt
    });
  }

  return [...groups.entries()]
    .sort((a, b) => b[1].latestMs - a[1].latestMs)
    .map(([key, acc]) => buildPosition(key, acc, openByKey.get(key), closedByKey.get(key)));
}

function buildPosition(key: string, acc: Acc, open: OpenBasis | undefined, closed: ClosedBasis | undefined): RecentTradePosition {
  const t = acc.trade;
  const avgBuy = ratio(acc.buyWeighted, acc.buySize); // in-window volume-weighted buy price
  const avgExit = ratio(acc.sellWeighted, acc.sellSize);
  const basisFromFills = acc.buySize > 0 && acc.buySize >= acc.sellSize - EPS;

  const base = {
    address: t.address,
    handle: t.handle,
    skillScore: t.skillScore,
    rank: t.rank,
    conditionId: t.conditionId,
    market: t.market,
    outcomeIndex: t.outcomeIndex,
    lastSide: t.side,
    lastPrice: t.price,
    lastSize: t.size,
    boughtSize: acc.buySize,
    soldSize: acc.sellSize,
    latestTradedAt: new Date(acc.latestMs).toISOString(),
    fills: acc.fills
  };

  // 1) Still held → authoritative open state from the wallet_positions cache (Polymarket-computed
  //    basis + mark + value), with the in-window fills as the recent-activity ledger.
  if (open) {
    const avgEntry = open.avgEntry ?? avgBuy;
    const mark = open.curPrice;
    const unrealizedPct =
      avgEntry !== null && avgEntry > 0 && mark !== null ? (mark - avgEntry) / avgEntry : null;
    return {
      ...base,
      state: "open",
      basisSource: open.avgEntry !== null ? "cache" : basisFromFills ? "fills" : "none",
      avgEntry,
      mark,
      remainingSize: open.size ?? Math.max(0, acc.buySize - acc.sellSize),
      positionValue: open.currentValue ?? (avgEntry !== null && open.size !== null ? avgEntry * open.size : null),
      unrealizedPct,
      realizedPct: null
    };
  }

  // 2) Fully closed → realized P/L from the wallet_closed_positions cache when present, else from the
  //    in-window fills, else unknown (opened before the window with no cache row).
  if (closed) {
    const avgEntry = closed.avgEntry;
    const realizedPct =
      closed.realizedPnl !== null && avgEntry !== null && closed.size !== null && avgEntry * closed.size > 0
        ? closed.realizedPnl / (avgEntry * closed.size)
        : null;
    return {
      ...base,
      state: "closed",
      basisSource: avgEntry !== null ? "cache" : "none",
      avgEntry,
      mark: null,
      remainingSize: 0,
      positionValue: null,
      unrealizedPct: null,
      realizedPct
    };
  }

  // 3) No cache row: reconstruct from in-window fills alone.
  const netRemaining = acc.buySize - acc.sellSize;
  if (netRemaining > EPS) {
    // Opened (and added) within the window, still held. We have no mark, so value is at cost.
    const avgEntry = avgBuy;
    return {
      ...base,
      state: "open",
      basisSource: avgEntry !== null ? "fills" : "none",
      avgEntry,
      mark: null,
      remainingSize: netRemaining,
      positionValue: avgEntry !== null ? avgEntry * netRemaining : null,
      unrealizedPct: null,
      realizedPct: null
    };
  }

  // Closed within / before the window.
  const realizedPct =
    basisFromFills && avgBuy !== null && avgBuy > 0 && avgExit !== null ? (avgExit - avgBuy) / avgBuy : null;
  return {
    ...base,
    state: "closed",
    basisSource: basisFromFills && avgBuy !== null ? "fills" : "none",
    avgEntry: basisFromFills ? avgBuy : null,
    mark: null,
    remainingSize: 0,
    positionValue: null,
    unrealizedPct: null,
    realizedPct
  };
}
