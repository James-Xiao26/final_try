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

// Pre-window buy fill summary from wallet_trades (up to PROFILE_TRADES_LIMIT fills per wallet,
// filtered to traded_at < feed-window cutoff to avoid double-counting with in-window fills).
// Blended with the in-window buy fills from recent_trades it gives a complete cost basis even
// for positions whose opening fills predate the 24h feed window.
export interface TradeBasis {
  preWindowWeighted: number; // sum(price * size) for pre-window BUY fills
  preWindowSize: number;     // sum(size) for pre-window BUY fills
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

// Minimum in-window buy value (USDC) for a BUY-last position to appear in the feed.
// Tiny buys (noise, dust, test fills) are excluded. Pure-sell rows (no in-window buys) are
// always kept — smart-money exits are always interesting regardless of fill size.
const MIN_BUY_USD = 100;

// Collapse the flat feed fills (expected newest-first) into one row per market position. The headline
// is the most recent fill; the aggregate prefers the position caches, then the blended fill history
// (wallet_trades pre-window + recent_trades in-window), and falls back to in-window fills.
// Returns positions most-recent-activity first.
export function groupRecentTrades(
  trades: RecentTrade[],
  openByKey: Map<string, OpenBasis>,
  closedByKey: Map<string, ClosedBasis>,
  tradeByKey: Map<string, TradeBasis> = new Map()
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
    .filter(([, acc]) => {
      // Keep pure-sell rows (no in-window buys) always — exits are always worth surfacing.
      if (acc.buySize === 0) return true;
      // Drop in-window buy totals below the minimum threshold.
      return acc.buyWeighted >= MIN_BUY_USD;
    })
    .map(([key, acc]) => buildPosition(key, acc, openByKey.get(key), closedByKey.get(key), tradeByKey.get(key)));
}

function buildPosition(
  key: string,
  acc: Acc,
  open: OpenBasis | undefined,
  closed: ClosedBasis | undefined,
  trade: TradeBasis | undefined
): RecentTradePosition {
  const t = acc.trade;
  const avgBuy = ratio(acc.buyWeighted, acc.buySize); // in-window VW avg buy
  const avgExit = ratio(acc.sellWeighted, acc.sellSize);

  // Complete buy average: blend pre-window history (wallet_trades, already filtered to < cutoff)
  // with in-window buys. Pre-window fills come from the last ingest's /activity data — zero extra
  // API calls. For the vast majority of positions this eliminates "basis unknown" entirely.
  const preWindowWeighted = trade?.preWindowWeighted ?? 0;
  const preWindowSize = trade?.preWindowSize ?? 0;
  const fullAvgBuy = ratio(acc.buyWeighted + preWindowWeighted, acc.buySize + preWindowSize);

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
    lastUsdcSize: t.usdcSize,
    boughtSize: acc.buySize,
    soldSize: acc.sellSize,
    latestTradedAt: new Date(acc.latestMs).toISOString(),
    fills: acc.fills
  };

  // Derive mark from the open cache; fall back to currentValue/size when curPrice is absent.
  function markFromOpen(o: OpenBasis): number | null {
    return o.curPrice ??
      (o.currentValue !== null && o.size !== null && o.size > 0
        ? o.currentValue / o.size
        : null);
  }

  // 1) Open-cache path: position was open at the last ingest.
  if (open) {
    // If the in-window sells cover the entire open position (within EPS), the wallet has likely
    // fully exited since the last ingest. Show as closed with estimated realized P/L rather than
    // stale "open" state with yesterday's mark price.
    const likelyClosed = open.size !== null && acc.sellSize >= open.size - EPS;

    if (likelyClosed) {
      // Blend the cached cost basis (Polymarket-computed, covering all pre-ingest buys) with any
      // in-window additions. If no cached basis, fall back to the full history from wallet_trades.
      let avgEntry: number | null;
      if (open.avgEntry !== null && open.avgEntry > 0 && open.size !== null) {
        if (acc.buySize > 0 && avgBuy !== null) {
          // Wallet added shares in-window before selling out — blend the two bases.
          const totalSize = open.size + acc.buySize;
          avgEntry = totalSize > 0
            ? (open.avgEntry * open.size + avgBuy * acc.buySize) / totalSize
            : null;
        } else {
          avgEntry = open.avgEntry;
        }
      } else {
        // No cached basis or basis is 0 (API omission): use combined fill history.
        avgEntry = fullAvgBuy;
      }

      const realizedPct =
        avgEntry !== null && avgEntry > 0 && avgExit !== null
          ? (avgExit - avgEntry) / avgEntry
          : null;

      const basisSrc =
        open.avgEntry !== null && open.avgEntry > 0
          ? "cache"
          : fullAvgBuy !== null
          ? (preWindowSize > 0 ? "trades" : "fills")
          : "none";

      return {
        ...base,
        state: "closed",
        basisSource: basisSrc,
        avgEntry,
        mark: null,
        remainingSize: 0,
        positionValue: null,
        unrealizedPct: null,
        realizedPct,
        realizedPnl: null // Polymarket-computed realized PnL not available until next ingest
      };
    }

    // Still held (partial sell or no sell).
    const avgEntry = open.avgEntry !== null && open.avgEntry > 0
      ? open.avgEntry
      : (fullAvgBuy ?? avgBuy);
    const mark = markFromOpen(open);
    const unrealizedPct =
      avgEntry !== null && avgEntry > 0 && mark !== null ? (mark - avgEntry) / avgEntry : null;
    return {
      ...base,
      state: "open",
      basisSource: open.avgEntry !== null && open.avgEntry > 0
        ? "cache"
        : fullAvgBuy !== null
        ? (preWindowSize > 0 ? "trades" : "fills")
        : "none",
      avgEntry,
      mark,
      remainingSize: open.size ?? Math.max(0, acc.buySize - acc.sellSize),
      positionValue: open.currentValue ?? (mark !== null && open.size !== null ? mark * open.size : null),
      unrealizedPct,
      realizedPct: null,
      realizedPnl: null
    };
  }

  // 2) Closed-cache path: Polymarket's authoritative realized P/L from wallet_closed_positions.
  //    avg_price can be 0 when the API omits the field (readNumber defaults to 0); fall back to
  //    the blended fill history in that case rather than producing "P/L n/a".
  if (closed) {
    const avgEntry =
      closed.avgEntry !== null && closed.avgEntry > 0
        ? closed.avgEntry
        : (fullAvgBuy ?? avgBuy);

    // Prefer the Polymarket-computed realized PnL (accounts for all historical buys); compute
    // from the avg sell price only when the cache's figure is unavailable.
    const realizedPct =
      closed.realizedPnl !== null &&
      avgEntry !== null &&
      closed.size !== null &&
      avgEntry * closed.size > 0
        ? closed.realizedPnl / (avgEntry * closed.size)
        : avgEntry !== null && avgEntry > 0 && avgExit !== null
        ? (avgExit - avgEntry) / avgEntry
        : null;

    const basisSrc =
      closed.avgEntry !== null && closed.avgEntry > 0
        ? "cache"
        : fullAvgBuy !== null
        ? (preWindowSize > 0 ? "trades" : "fills")
        : "none";

    return {
      ...base,
      state: "closed",
      basisSource: basisSrc,
      avgEntry,
      mark: null,
      remainingSize: 0,
      positionValue: null,
      unrealizedPct: null,
      realizedPct,
      realizedPnl: closed.realizedPnl
    };
  }

  // 3) No cache at all: reconstruct from blended fill history (wallet_trades + in-window).
  const netRemaining = acc.buySize - acc.sellSize;
  if (netRemaining > EPS) {
    // Opened in-window (or added to in-window) and still held.
    const avgEntry = fullAvgBuy ?? avgBuy;
    // Use the most-recent fill price as a mark proxy — the best price point we have.
    const mark = acc.trade.price;
    const unrealizedPct =
      avgEntry !== null && avgEntry > 0 && mark !== null ? (mark - avgEntry) / avgEntry : null;
    return {
      ...base,
      state: "open",
      basisSource: avgEntry !== null ? (preWindowSize > 0 ? "trades" : "fills") : "none",
      avgEntry,
      mark,
      remainingSize: netRemaining,
      positionValue: mark !== null ? mark * netRemaining : (avgEntry !== null ? avgEntry * netRemaining : null),
      unrealizedPct,
      realizedPct: null,
      realizedPnl: null
    };
  }

  // 4) Closed, no cache. Best avg from the complete fill history eliminates "P/L n/a" for any
  //    position whose buys appear in wallet_trades (last 200 fills per wallet). The only remaining
  //    "basis unknown" case is a very old position (>200 fills ago) closed between ingest cycles.
  const avgEntry = fullAvgBuy ?? avgBuy;
  const realizedPct =
    avgEntry !== null && avgEntry > 0 && avgExit !== null
      ? (avgExit - avgEntry) / avgEntry
      : null;
  return {
    ...base,
    state: "closed",
    basisSource: avgEntry !== null ? (preWindowSize > 0 ? "trades" : "fills") : "none",
    avgEntry,
    mark: null,
    remainingSize: 0,
    positionValue: null,
    unrealizedPct: null,
    realizedPct,
    realizedPnl: null
  };
}
