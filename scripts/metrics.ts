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
  // Why skillScore is null, or null when eligible. Mirrors botSignal's reason-code pattern — lets
  // ingest persist *why* a wallet is ineligible (not just that it is), which the tiered recheck
  // cooldown (scripts/walletRecheck.ts) uses to decide how long to skip re-fetching it. "too_new"
  // (the age gate) is never set here — that signal comes from /activity, which this function never
  // sees, so processWallet overrides it directly.
  ineligibleReason: IneligibilityReason | null;
  equityCurve: EquityPoint[];
}

export type IneligibilityReason =
  | "insufficient_trades"
  | "insufficient_volume"
  | "longshot_entry"
  | "longshot_churn"
  | "too_new";

// Longshot-churner: resolves an unusually high number of positions while averaging a tiny per-bet cost
// basis — micro-longshot farming, not copyable forecasting edge. Needs BOTH signals (high churn alone
// is a legit high-volume trader; small average bets alone is a cautious one). Detected on the widest
// horizon (the most complete sample — a shorter window under-counts the churn) and applied wallet-wide
// in processWallet like the age gate, because it's a property of the trader, not one horizon. Kept out
// of computeSkillScore/ineligibilityReason so their exact-constant tests stay untouched.
export function isLongshotChurner(metrics: WalletMetrics, config: typeof CONFIG): boolean {
  if (metrics.nResolved <= config.LONGSHOT_CHURN_MIN_RESOLVED) {
    return false;
  }
  const avgBetUsd = metrics.nTrades > 0 ? metrics.totalVolumeUsd / metrics.nTrades : 0;
  return avgBetUsd > 0 && avgBetUsd < config.LONGSHOT_CHURN_MAX_AVG_BET_USD;
}

// Same three gates computeSkillScore checks (age gate excluded — see the field comment above),
// broken out into a reason code instead of a bare null. Kept separate from computeSkillScore itself
// (not folded in) so computeSkillScore's exact-constant-asserted tests don't need touching.
export function ineligibilityReason(metrics: WalletMetrics, config: typeof CONFIG): IneligibilityReason | null {
  if (metrics.nTrades < config.MIN_TRADES) {
    return "insufficient_trades";
  }
  if (metrics.totalVolumeUsd < config.MIN_VOLUME_USD) {
    return "insufficient_volume";
  }
  if (metrics.avgEntryPrice < config.MIN_AVG_ENTRY_PRICE) {
    return "longshot_entry";
  }
  return null;
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function toMillis(closeTime: string): number {
  const parsed = Date.parse(closeTime);
  return Number.isFinite(parsed) ? parsed : 0;
}

// Recurring "Up or Down" windowed markets (e.g. "Bitcoin Up or Down - May 31, 1:55PM-2:00PM ET")
// resolve on a single price-feed snapshot minutes after the window opens. Winning them consistently
// looks like high-frequency market-making/spread-capture (dozens of fills within one 5-min window),
// not forecasting, and can't be copied by anyone with even a few seconds of lag — so they're excluded
// from every metric below, as if the wallet never took the position. Matched by the "<time>-<time>"
// range in the title, which is specific to this recurring-window template; a once-daily market like
// "S&P 500 (SPX) Up or Down on March 2?" has no time range and isn't affected.
const RECURRING_WINDOW_MARKET = /up or down - .*\d{1,2}:\d{2}\s*[ap]m\s*-\s*\d{1,2}:\d{2}\s*[ap]m/i;

export function isScorableMarket(title: string): boolean {
  return !RECURRING_WINDOW_MARKET.test(title);
}

const FAMILY_MONTHS = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/gi;

// Normalize a market title to its recurring-SERIES family key: strip numbers, ranges, dates, and month
// names so that date/number variants of one template collapse together — e.g. "Elon posts 40-64 tweets
// from Jun 13 to Jun 15" and "...200-219 tweets from May 12 to May 19", or "US–Iran peace deal by May
// 31" and "...by June 30". Used only to keep correlated variants of one series from each counting as a
// separate independent prediction in the Skill Score (see collapseFamilyEdges below).
// ponytail: keyword-ish normalizer; upgrade path = a condition_id→event map from Gamma tags at ingest.
export function marketFamilyKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/\b\d[\d,.:-]*\b/g, "#")
    .replace(FAMILY_MONTHS, "")
    .replace(/\b(st|nd|rd|th)\b/g, "")
    .replace(/[?,.'"]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Strips positions in a conditionId where the wallet held both outcome legs concurrently (detected
// from /activity by scripts/botDetection.ts detectArbitrageConditions) — locking in a YES+NO<$1
// mispricing or hedging isn't a directional forecast, so it shouldn't count toward Skill Score or a
// specialty chip. Same non-punitive shape as isScorableMarket: only the arb positions are dropped,
// not the whole wallet: everything else it forecasted still counts normally.
export function excludeArbitrage(positions: ClosedPosition[], arbConditionIds: ReadonlySet<string>): ClosedPosition[] {
  if (arbConditionIds.size === 0) {
    return positions;
  }
  return positions.filter((position) => !arbConditionIds.has(position.conditionId));
}

// Builds the daily cumulative-PnL curve. The interior is the realized path (steps on close dates);
// a final "today" point folds in current unrealized PnL on open positions so the curve ends at the
// marked-to-market total, matching the displayed Total P/L. When unrealized is 0 the today-point
// simply extends the line flat to now; when there are no closed positions but unrealized != 0 the
// curve is that single today-point.
function buildDailyCurve(sortedPositions: ClosedPosition[], unrealizedPnlUsd: number): EquityPoint[] {
  const byDate = new Map<string, number>();
  let cumulative = 0;
  const today = new Date().toISOString().slice(0, "YYYY-MM-DD".length);

  sortedPositions.forEach((position) => {
    cumulative += position.realizedPnl;
    const date = new Date(toMillis(position.closeTime)).toISOString().slice(0, "YYYY-MM-DD".length);
    // Polymarket sometimes reports a sold position's closeTime as the market's *future* end date
    // (e.g. a World Cup market settling months out), which would plot a realized point past today
    // and become a bogus right edge. Clamp any future close into today's total.
    byDate.set(date > today ? today : date, cumulative);
  });

  // Final marked-to-market point. Keyed by today's date, so a position that closed today is
  // overwritten with the day's total (realized + unrealized) rather than duplicated. Skip it only
  // when there's nothing to plot (no closed positions and no open exposure), to preserve the empty
  // curve for inactive wallets.
  if (sortedPositions.length > 0 || unrealizedPnlUsd !== 0) {
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
    .filter((position) => isScorableMarket(position.market))
    .filter((position) => toMillis(position.closeTime) >= cutoffMs)
    .sort((left, right) => toMillis(left.closeTime) - toMillis(right.closeTime));

  const realizedPnlUsd = positions.reduce((sum, position) => sum + position.realizedPnl, 0);
  const totalVolumeUsd = positions.reduce((sum, position) => sum + position.size * position.avgPrice, 0);
  const totalShares = positions.reduce((sum, position) => sum + position.size, 0);
  // Volume-weighted average entry price = total cost / total shares. Catches longshot wallets
  // whose capital sits in cheap shares (see MIN_AVG_ENTRY_PRICE gate in computeSkillScore).
  const avgEntryPrice = totalShares > 0 ? totalVolumeUsd / totalShares : 0;
  // Return, win rate, and the Skill Score stay strictly realized — they measure realized discipline.
  // Only totalPnlUsd and the curve's final point fold in unrealized.
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
  // FAMILY-COLLAPSE the per-position edge: date/number variants of one recurring series (a wallet
  // grinding hundreds of "Elon posts N-M tweets" buckets, or a dozen "US–Iran peace by <date>" markets)
  // are correlated forecasts, not independent ones. Counting each as its own resolved prediction
  // inflates the shrinkage sample (nResolved) and lets one single-theme grind pin a high Skill Score.
  // So each market FAMILY contributes ONE equal-weight observation (its mean per-share edge), and
  // nResolved is the count of distinct resolved families. pctEdge (share-weighted display stat) stays
  // raw over all positions. Diversified wallets (all-distinct families) are unaffected — this is a
  // no-op unless a wallet holds multiple variants of the same series. See ALPHA_RESEARCH_LOG.md §5/§8.
  const familyEdge = new Map<string, { sum: number; n: number }>();
  let edgeDollars = 0;
  let edgeCapital = 0;
  for (const position of positions) {
    if (position.outcome === null) {
      continue;
    }
    edgeDollars += position.size * (position.outcome - position.avgPrice);
    edgeCapital += position.size * position.avgPrice;
    const key = marketFamilyKey(position.market);
    const fam = familyEdge.get(key) ?? { sum: 0, n: 0 };
    fam.sum += position.outcome - position.avgPrice;
    fam.n += 1;
    familyEdge.set(key, fam);
  }
  const familyMeanEdges = [...familyEdge.values()].map((f) => f.sum / f.n);
  const nResolved = familyMeanEdges.length;
  const pctEdge = edgeCapital > 0 ? edgeDollars / edgeCapital : 0;
  const avgEdgePerShare = nResolved > 0 ? familyMeanEdges.reduce((a, b) => a + b, 0) / nResolved : 0;

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
    ineligibleReason: null,
    equityCurve: buildDailyCurve(positions, unrealizedPnlUsd)
  };

  return {
    ...metricsWithoutScore,
    skillScore: computeSkillScore(metricsWithoutScore, config),
    ineligibleReason: ineligibilityReason(metricsWithoutScore, config)
  };
}

/**
 * Skill Score = pure statistical forecasting edge on a 0–SCORE_MAX scale.
 * Each resolved position is a Bernoulli trial whose entry price is the market's implied
 * probability; per-share edge is (outcome − price). We shrink the per-position mean edge toward 0
 * by EDGE_SHRINKAGE_K pseudo-bets, so small/lucky samples can't earn a high score, then remap the
 * shrunk edge: zero/negative edge → 0, and any positive shrunk edge lands in
 * [SCORE_FLOOR, SCORE_MAX] (floor at SCORE_FLOOR, EDGE_FOR_TEN shrunk edge == SCORE_MAX), clamped.
 * Ineligible wallets receive null (too few trades, too little volume, or a sub-cent longshot
 * trader — see ineligibilityReason for the reason code breakdown).
 */
export function computeSkillScore(metrics: WalletMetrics, config: typeof CONFIG): number | null {
  if (
    metrics.nTrades < config.MIN_TRADES ||
    metrics.totalVolumeUsd < config.MIN_VOLUME_USD ||
    metrics.avgEntryPrice < config.MIN_AVG_ENTRY_PRICE
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
