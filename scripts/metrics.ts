import { CONFIG } from "./config.js";
import type { ClosedPosition } from "./polymarket.js";

export interface EquityPoint {
  ts: string;
  cumulativePnl: number;
}

export interface WalletMetrics {
  horizonDays: number;
  skillScore: number | null;
  pctReturn: number;
  winRate: number;
  totalPnlUsd: number;
  unrealizedPnlUsd: number;
  totalVolumeUsd: number;
  avgEntryPrice: number;
  nTrades: number;
  // Forecasting edge over positions whose market has resolved: how far the entry price beat (or
  // missed) the eventual 0/1 outcome. avgEdgePerShare is the PER-POSITION mean of (outcome - price)
  // — the point estimate the Skill Score shrinks. pctEdge is the share-weighted edge as a return on
  // the capital in those positions (display stat). nResolved is the resolved-position sample size.
  pctEdge: number;
  avgEdgePerShare: number;
  nResolved: number;
  outlierFlag: boolean;
  equityCurve: EquityPoint[];
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function toMillis(closeTime: string): number {
  const parsed = Date.parse(closeTime);
  return Number.isFinite(parsed) ? parsed : 0;
}

// Builds the daily cumulative-PnL curve. The interior is the realized path (steps on close dates);
// a final "today" point folds in current unrealized PnL on open positions so the curve ends at the
// marked-to-market total, matching the displayed Total P/L. When unrealized is 0 the today-point
// simply extends the line flat to now; when there are no closed positions but unrealized != 0 the
// curve is that single today-point.
function buildDailyCurve(sortedPositions: ClosedPosition[], unrealizedPnlUsd: number): EquityPoint[] {
  const byDate = new Map<string, number>();
  let cumulative = 0;

  sortedPositions.forEach((position) => {
    cumulative += position.realizedPnl;
    const date = new Date(toMillis(position.closeTime)).toISOString().slice(0, "YYYY-MM-DD".length);
    byDate.set(date, cumulative);
  });

  // Final marked-to-market point. Keyed by today's date, so a position that closed today is
  // overwritten with the day's total (realized + unrealized) rather than duplicated. Skip it only
  // when there's nothing to plot (no closed positions and no open exposure), to preserve the empty
  // curve for inactive wallets.
  if (sortedPositions.length > 0 || unrealizedPnlUsd !== 0) {
    const today = new Date().toISOString().slice(0, "YYYY-MM-DD".length);
    byDate.set(today, cumulative + unrealizedPnlUsd);
  }

  return [...byDate.entries()].map(([ts, cumulativePnl]) => ({
    ts,
    cumulativePnl: round(cumulativePnl, 2)
  }));
}

/**
 * Computes realized performance over a trailing horizon.
 * Return is total realized PnL divided by a capital proxy of shares times average entry price.
 */
export function computeMetrics(
  closedPositions: ClosedPosition[],
  horizonDays: number,
  config: typeof CONFIG,
  unrealizedPnlUsd = 0
): WalletMetrics {
  const cutoffMs = Date.now() - horizonDays * config.SECONDS_PER_DAY * config.MS_PER_SECOND;
  const positions = closedPositions
    .filter((position) => toMillis(position.closeTime) >= cutoffMs)
    .sort((left, right) => toMillis(left.closeTime) - toMillis(right.closeTime));

  const realizedPnlUsd = positions.reduce((sum, position) => sum + position.realizedPnl, 0);
  const totalVolumeUsd = positions.reduce((sum, position) => sum + position.size * position.avgPrice, 0);
  const totalShares = positions.reduce((sum, position) => sum + position.size, 0);
  // Volume-weighted average entry price = total cost / total shares. Catches longshot wallets
  // whose capital sits in cheap shares (see MIN_AVG_ENTRY_PRICE gate in computeSkillScore).
  const avgEntryPrice = totalShares > 0 ? totalVolumeUsd / totalShares : 0;
  // Return, win rate, outlier flag, and the Skill Score stay strictly realized — they measure
  // realized discipline. Only totalPnlUsd and the curve's final point fold in unrealized.
  const pctReturn = totalVolumeUsd > 0 ? realizedPnlUsd / totalVolumeUsd : 0;
  const wins = positions.filter((position) => position.realizedPnl > 0).length;
  const winRate = positions.length > 0 ? wins / positions.length : 0;

  // Forecasting edge: over positions whose market has resolved (outcome known to be 0 or 1), how
  // far the entry price beat the eventual outcome. Exit timing is irrelevant — this measures
  // prediction, not trading. Positions with no known outcome (still trading, or sold without a
  // settled price in the payload) are skipped, not counted as misses.
  //   avgEdgePerShare — PER-POSITION mean of (outcome - price); each resolved position is one
  //     equal-weight prediction. This is the point estimate the Skill Score shrinks (see
  //     computeSkillScore).
  //   pctEdge — share-weighted edge as a return on the capital in those positions (display stat).
  let perShareEdgeSum = 0;
  let edgeDollars = 0;
  let edgeCapital = 0;
  let nResolved = 0;
  for (const position of positions) {
    if (position.outcome === null) {
      continue;
    }
    perShareEdgeSum += position.outcome - position.avgPrice;
    edgeDollars += position.size * (position.outcome - position.avgPrice);
    edgeCapital += position.size * position.avgPrice;
    nResolved += 1;
  }
  const pctEdge = edgeCapital > 0 ? edgeDollars / edgeCapital : 0;
  const avgEdgePerShare = nResolved > 0 ? perShareEdgeSum / nResolved : 0;

  const largestWin = positions.reduce(
    (largest, position) => Math.max(largest, position.realizedPnl),
    0
  );
  const outlierFlag = realizedPnlUsd > 0 && largestWin / realizedPnlUsd > config.OUTLIER_TRADE_FRACTION;
  const metricsWithoutScore: WalletMetrics = {
    horizonDays,
    skillScore: null,
    pctReturn: round(pctReturn, 4),
    winRate: round(winRate, 4),
    totalPnlUsd: round(realizedPnlUsd + unrealizedPnlUsd, 2),
    unrealizedPnlUsd: round(unrealizedPnlUsd, 2),
    totalVolumeUsd: round(totalVolumeUsd, 2),
    avgEntryPrice: round(avgEntryPrice, 4),
    nTrades: positions.length,
    pctEdge: round(pctEdge, 4),
    avgEdgePerShare: round(avgEdgePerShare, 4),
    nResolved,
    outlierFlag,
    equityCurve: buildDailyCurve(positions, unrealizedPnlUsd)
  };

  return {
    ...metricsWithoutScore,
    skillScore: computeSkillScore(metricsWithoutScore, config)
  };
}

/**
 * Skill Score = pure statistical forecasting edge on a 0–SCORE_MAX scale.
 * Each resolved position is a Bernoulli trial whose entry price is the market's implied
 * probability; per-share edge is (outcome − price). We shrink the per-position mean edge toward 0
 * by EDGE_SHRINKAGE_K pseudo-bets, so small/lucky samples can't earn a high score, then remap the
 * shrunk edge: zero/negative edge → 0, and any positive shrunk edge lands in
 * [SCORE_FLOOR, SCORE_MAX] (floor at SCORE_FLOOR, EDGE_FOR_TEN shrunk edge == SCORE_MAX), clamped.
 * Ineligible wallets receive null (too few trades, too little volume, sub-cent longshot trader, or
 * one win dominating realized PnL).
 */
export function computeSkillScore(metrics: WalletMetrics, config: typeof CONFIG): number | null {
  if (
    metrics.nTrades < config.MIN_TRADES ||
    metrics.totalVolumeUsd < config.MIN_VOLUME_USD ||
    metrics.avgEntryPrice < config.MIN_AVG_ENTRY_PRICE ||
    metrics.outlierFlag
  ) {
    return null;
  }

  // Bayesian shrinkage: sum of per-share edges divided by (nResolved + K). The numerator is
  // avgEdgePerShare * nResolved (avgEdgePerShare is the per-position mean), so dividing by
  // nResolved + K pulls the estimate toward 0 — hard for small samples, negligibly for large ones.
  const shrunkEdge = (metrics.avgEdgePerShare * metrics.nResolved) / (metrics.nResolved + config.EDGE_SHRINKAGE_K);
  // Zero/negative proven edge earns nothing; any positive shrunk edge floors at SCORE_FLOOR and
  // climbs linearly toward SCORE_MAX (a hard jump at edge = 0, by design).
  if (shrunkEdge <= 0) {
    return 0;
  }
  const score = config.SCORE_FLOOR + (config.SCORE_MAX - config.SCORE_FLOOR) * shrunkEdge / config.EDGE_FOR_TEN;
  return round(Math.min(config.SCORE_MAX, Math.max(config.SCORE_FLOOR, score)), 2);
}
