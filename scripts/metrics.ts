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
  maxDrawdown: number;
  totalPnlUsd: number;
  unrealizedPnlUsd: number;
  totalVolumeUsd: number;
  avgEntryPrice: number;
  nTrades: number;
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
 * Drawdown uses the realized cumulative PnL path and penalizes losses from the prior realized peak.
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
  // Return, win rate, drawdown, outlier flag, and the Skill Score stay strictly realized — they
  // measure realized discipline. Only totalPnlUsd and the curve's final point fold in unrealized.
  const pctReturn = totalVolumeUsd > 0 ? realizedPnlUsd / totalVolumeUsd : 0;
  const wins = positions.filter((position) => position.realizedPnl > 0).length;
  const winRate = positions.length > 0 ? wins / positions.length : 0;

  let cumulativePnl = 0;
  let peakSoFar = 0;
  let maxDrawdown = 0;

  positions.forEach((position) => {
    cumulativePnl += position.realizedPnl;
    peakSoFar = Math.max(peakSoFar, cumulativePnl);
    // This is a realized-PnL path: it starts at 0 and can go deeply negative. When a small
    // early peak is followed by a large net loss, (peak - cumulative)/|peak| blows up well past
    // 1 (we saw 200+), which both overflows max_drawdown's NUMERIC(6,4) column and distorts the
    // skill-score penalty. Cap at 1.0 (a 100% drawdown) — the conventional max-drawdown ceiling.
    const drawdown = peakSoFar === 0 ? 0 : Math.min(1, (peakSoFar - cumulativePnl) / Math.abs(peakSoFar));
    maxDrawdown = Math.max(maxDrawdown, drawdown);
  });

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
    maxDrawdown: round(maxDrawdown, 4),
    totalPnlUsd: round(realizedPnlUsd + unrealizedPnlUsd, 2),
    unrealizedPnlUsd: round(unrealizedPnlUsd, 2),
    totalVolumeUsd: round(totalVolumeUsd, 2),
    avgEntryPrice: round(avgEntryPrice, 4),
    nTrades: positions.length,
    outlierFlag,
    equityCurve: buildDailyCurve(positions, unrealizedPnlUsd)
  };

  return {
    ...metricsWithoutScore,
    skillScore: computeSkillScore(metricsWithoutScore, config)
  };
}

/**
 * Skill Score blends return, win rate, and sample-size confidence, then subtracts excess drawdown.
 * A single `confidence` value (a sqrt ramp in trade count, so it tracks how standard error shrinks
 * with sample size) is used two ways: as an additive depth reward weighted by SKILL_WEIGHTS.sampleSize,
 * and as a multiplier that discounts — but never guts — thin samples, bounded below by SAMPLE_CONFIDENCE_FLOOR.
 * Ineligible wallets receive null when the sample is too small, volume is too low, one win dominates
 * PnL, or the wallet is a sub-cent longshot trader (low volume-weighted average entry price).
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

  const weights = config.SKILL_WEIGHTS;
  const drawdownPenalty = metrics.maxDrawdown > config.DRAWDOWN_PENALTY_THRESHOLD
    ? (metrics.maxDrawdown - config.DRAWDOWN_PENALTY_THRESHOLD) / (1 - config.DRAWDOWN_PENALTY_THRESHOLD)
    : 0;
  const confidence = Math.min(1, Math.sqrt(metrics.nTrades / (config.MIN_TRADES * 3)));
  const confidenceMultiplier = config.SAMPLE_CONFIDENCE_FLOOR
    + (1 - config.SAMPLE_CONFIDENCE_FLOOR) * confidence;
  const rawScore = (metrics.pctReturn * weights.pctReturn)
    + (metrics.winRate * weights.winRate)
    + (confidence * weights.sampleSize)
    - (drawdownPenalty * weights.drawdown);

  return round(rawScore * confidenceMultiplier * 1000, 4);
}
