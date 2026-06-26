import type { CONFIG } from "./config.js";
import type { ClosedPosition, Position } from "./polymarket.js";

// Limited-time World Cup board: a trader's standing is purely their forecasting edge on World Cup
// soccer markets — the same Bayesian-shrunk per-share edge the Skill Score uses (metrics.ts), sliced
// to World Cup markets, with a gentler prior (WORLD_CUP_SHRINKAGE_K) because a single tournament
// yields few bets per wallet. Settled bets drive the score; current open WC positions ride along as
// "live conviction" for display.
//
// ponytail: World Cup markets are detected by keyword on the question title (no condition_id→tag map,
// no extra API). Catches "World Cup", "Club World Cup", "Women's World Cup", and "FIFA". Upgrade path
// = the same Gamma-tag map noted in specialty.ts, if the keyword misses real markets.
const WORLD_CUP_RE = /\b(?:world cup|fifa)\b/i;

export function isWorldCupMarket(title: string): boolean {
  return WORLD_CUP_RE.test(title);
}

export interface WorldCupStats {
  score: number; // 0-SCORE_MAX
  nBets: number; // resolved WC bets
  winRate: number; // 0-1
  avgEdgePerShare: number; // per-position mean (outcome - entry)
  pnlUsd: number; // realized $ on resolved WC bets
  openBets: number; // current open WC positions
  topMarket: string | null; // largest open WC position's market
  topSide: "YES" | "NO" | null; // its side (outcomeIndex 0 = YES, 1 = NO)
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * A wallet's World Cup board stats, or null if it has too few resolved WC bets to rank.
 *
 * Over resolved WC positions (outcome known), sums per-share edge and shrinks by
 * WORLD_CUP_SHRINKAGE_K, then remaps with the Skill Score's bands: zero/negative edge → 0, any
 * positive shrunk edge lands in [SCORE_FLOOR, SCORE_MAX]. Open WC positions don't affect the score
 * (no known outcome) but are summarized for the "live conviction" display.
 */
export function worldCupStats(
  resolved: ClosedPosition[],
  open: Position[],
  config: Pick<typeof CONFIG, "WORLD_CUP_MIN_BETS" | "WORLD_CUP_SHRINKAGE_K" | "SCORE_FLOOR" | "SCORE_MAX" | "EDGE_FOR_TEN">
): WorldCupStats | null {
  let edgeSum = 0;
  let pnl = 0;
  let wins = 0;
  let n = 0;
  for (const position of resolved) {
    if (position.outcome === null || !isWorldCupMarket(position.market)) {
      continue;
    }
    edgeSum += position.outcome - position.avgPrice;
    pnl += position.realizedPnl;
    if (position.realizedPnl > 0) {
      wins += 1;
    }
    n += 1;
  }
  if (n < config.WORLD_CUP_MIN_BETS) {
    return null;
  }

  const shrunkEdge = edgeSum / (n + config.WORLD_CUP_SHRINKAGE_K);
  const score =
    shrunkEdge <= 0
      ? 0
      : Math.min(
          config.SCORE_MAX,
          Math.max(
            config.SCORE_FLOOR,
            config.SCORE_FLOOR + (config.SCORE_MAX - config.SCORE_FLOOR) * shrunkEdge / config.EDGE_FOR_TEN
          )
        );

  // Live conviction: WC positions still open (not yet settleable, with value on the book). The
  // largest by current value is the wallet's headline open pick.
  let top: Position | null = null;
  let openBets = 0;
  for (const position of open) {
    if (position.redeemable || position.currentValue <= 0 || !isWorldCupMarket(position.market)) {
      continue;
    }
    openBets += 1;
    if (top === null || position.currentValue > top.currentValue) {
      top = position;
    }
  }

  return {
    score: round(score, 2),
    nBets: n,
    winRate: round(wins / n, 4),
    avgEdgePerShare: round(edgeSum / n, 4),
    pnlUsd: round(pnl, 2),
    openBets,
    topMarket: top?.market ?? null,
    topSide: top ? (top.outcomeIndex === 0 ? "YES" : "NO") : null
  };
}
