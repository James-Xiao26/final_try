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
      latestTradedAt: new Date(acc.latestMs).toISOString(),
      fills: acc.fills
    }));
}
