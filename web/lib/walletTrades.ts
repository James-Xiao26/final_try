import type { WalletFill, WalletTradeGroup } from "./types";

// The snake_case fill shape this collapse reads — a structural subset of the wallet_trades Row, so
// the Pick used at the call site in supabase.ts is assignable here.
export interface WalletTradeRowInput {
  condition_id: string | null;
  market: string | null;
  outcome_index: number | null;
  side: string | null;
  price: number | null;
  size: number | null;
  usdc_size: number | null;
  traded_at: string;
  transaction_hash: string | null;
}

function num(value: number | null): number {
  return typeof value === "number" ? value : 0;
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

interface TradeGroupAcc {
  conditionId: string | null;
  market: string | null;
  outcomeIndex: number | null;
  buyWeighted: number; // Σ price·size over BUY fills, for the volume-weighted avg entry
  buySize: number;
  sellWeighted: number; // Σ price·size over SELL fills, for the volume-weighted avg exit
  sellSize: number;
  totalUsdc: number;
  latestMs: number;
  fills: WalletFill[];
}

// Collapse raw fills (expected newest-first) into per-market-position groups: volume-weighted average
// entry from BUY fills and average exit from SELL fills (null when no sells), with the raw fills kept
// for the UI's expandable dropdown. Grouped by conditionId + outcomeIndex so the two outcome tokens
// of a market stay distinct. Groups are returned most-recent-activity first.
export function groupWalletTrades(rows: WalletTradeRowInput[]): WalletTradeGroup[] {
  const groups = new Map<string, TradeGroupAcc>();
  for (const row of rows) {
    const key = `${row.condition_id}:${row.outcome_index}`;
    let acc = groups.get(key);
    if (!acc) {
      acc = {
        conditionId: row.condition_id,
        market: row.market,
        outcomeIndex: row.outcome_index,
        buyWeighted: 0,
        buySize: 0,
        sellWeighted: 0,
        sellSize: 0,
        totalUsdc: 0,
        latestMs: 0,
        fills: []
      };
      groups.set(key, acc);
    }
    const side = (row.side ?? "").toUpperCase();
    if (row.price !== null && row.size !== null) {
      if (side === "BUY") {
        acc.buyWeighted += row.price * row.size;
        acc.buySize += row.size;
      } else if (side === "SELL") {
        acc.sellWeighted += row.price * row.size;
        acc.sellSize += row.size;
      }
    }
    acc.totalUsdc += num(row.usdc_size);
    const tradedMs = Date.parse(row.traded_at);
    if (Number.isFinite(tradedMs)) {
      acc.latestMs = Math.max(acc.latestMs, tradedMs);
    }
    acc.fills.push({
      side: row.side,
      price: row.price,
      size: row.size,
      usdcSize: row.usdc_size,
      tradedAt: row.traded_at,
      transactionHash: row.transaction_hash
    });
  }

  return [...groups.values()]
    .sort((left, right) => right.latestMs - left.latestMs)
    .map((acc) => ({
      conditionId: acc.conditionId,
      market: acc.market,
      outcomeIndex: acc.outcomeIndex,
      avgEntryPrice: acc.buySize > 0 ? roundTo(acc.buyWeighted / acc.buySize, 4) : null,
      avgExitPrice: acc.sellSize > 0 ? roundTo(acc.sellWeighted / acc.sellSize, 4) : null,
      totalBoughtSize: roundTo(acc.buySize, 4),
      totalSoldSize: roundTo(acc.sellSize, 4),
      totalUsdc: roundTo(acc.totalUsdc, 2),
      realizedPnl: null, // backfilled by applyClosedBasis from the closed-positions cache
      realizedPnlPct: null,
      latestTradedAt: new Date(acc.latestMs).toISOString(),
      fills: acc.fills
    }));
}

// One closed-position basis row, keyed by conditionId + outcomeIndex. Both the cached read path
// (wallet_closed_positions) and the live fallback (/closed-positions) map their rows into this.
export interface ClosedBasisInput {
  conditionId: string | null;
  outcomeIndex: number | null;
  market: string | null;
  avgPrice: number | null; // true cost-basis entry price
  size: number | null; // shares closed (≈ shares bought for a fully-closed position)
  realizedPnl: number | null;
  closeTime: string | null;
}

// Cost basis of a closed row (avgPrice·size); 0 when either is missing.
function closedBasisCost(row: ClosedBasisInput): number {
  return row.avgPrice !== null && row.size !== null ? row.avgPrice * row.size : 0;
}

// Merge the closed-positions cache into the fill-grouped trade history. Two jobs:
//  1. Backfill: the history is grouped from only the last ~200 fills, so a position bought before that
//     window shows blank avg entry / 0 bought shares — the closed row carries the truth. Attach P/L too.
//  2. Append: a wallet that churns one market (a scalper) can fill the entire 200-fill window with a
//     single market, hiding every other position it ever closed. Closed positions with no fill group
//     are appended as synthetic rows (entry/size/P/L from the closed row, exit derived from realized
//     P/L, no raw fills) so the trade history reflects real history, not just the saturated window.
// Kept here (not duplicated per read path) so the cached and live fallbacks stay in sync.
export function applyClosedBasis(groups: WalletTradeGroup[], closed: ClosedBasisInput[]): WalletTradeGroup[] {
  const byKey = new Map<string, ClosedBasisInput>();
  for (const row of closed) {
    if (row.conditionId) byKey.set(`${row.conditionId}:${row.outcomeIndex}`, row);
  }
  const seen = new Set<string>();
  const backfilled = groups.map((group) => {
    const key = `${group.conditionId}:${group.outcomeIndex}`;
    seen.add(key);
    const match = byKey.get(key);
    if (!match) return group;
    const { avgPrice, size, realizedPnl } = match;
    const basis = closedBasisCost(match);
    return {
      ...group,
      avgEntryPrice: group.avgEntryPrice === null && avgPrice !== null && avgPrice > 0 ? avgPrice : group.avgEntryPrice,
      totalBoughtSize: group.totalBoughtSize === 0 && size !== null && size > 0 ? size : group.totalBoughtSize,
      realizedPnl,
      realizedPnlPct: realizedPnl !== null && basis > 0 ? realizedPnl / basis : null
    };
  });

  // Synthetic rows for closed positions with no fill group in the window.
  for (const row of closed) {
    if (!row.conditionId || seen.has(`${row.conditionId}:${row.outcomeIndex}`)) continue;
    const { avgPrice, size, realizedPnl } = row;
    const basis = closedBasisCost(row);
    // Effective exit price implied by the realized P/L: exit = entry + realizedPnl/size.
    const exit = avgPrice !== null && size !== null && size > 0 && realizedPnl !== null ? avgPrice + realizedPnl / size : null;
    backfilled.push({
      conditionId: row.conditionId,
      market: row.market,
      outcomeIndex: row.outcomeIndex,
      avgEntryPrice: avgPrice !== null && avgPrice > 0 ? avgPrice : null,
      avgExitPrice: exit,
      totalBoughtSize: size ?? 0,
      totalSoldSize: size ?? 0,
      totalUsdc: roundTo(basis, 2),
      realizedPnl,
      realizedPnlPct: realizedPnl !== null && basis > 0 ? realizedPnl / basis : null,
      latestTradedAt: row.closeTime ?? "",
      fills: [] // no raw fills available for an out-of-window closed position
    });
  }

  // Re-sort the combined list newest-activity first (invalid/empty dates sink to the bottom).
  return backfilled.sort((a, b) => (Date.parse(b.latestTradedAt) || 0) - (Date.parse(a.latestTradedAt) || 0));
}
