import type { CrowdLookups, CrowdOpenPosition } from "./marketCrowd";
import type { MarketRow, TrendingLean, TrendingMarket } from "./types";

// Home-page Trending panel. Selection is leaderboard-driven, not volume-driven: a market only
// qualifies with TRENDING_MIN_PARTICIPANTS+ distinct wallets holding a real (non-dust) position, then
// the qualifying set is ranked by how *actionable* it is right now (resolving soon, still near the
// leaderboard's entry, and — sports/esports only — starting soon). All inputs are already scoped to
// leaderboard wallets by the caller. Operates directly on CrowdOpenPosition — Trending only ever cares
// about currently-open holdings, so it skips buildCrowdMarketDetail's open+closed+fills merge entirely.

export const TRENDING_DUST_FLOOR_USD = 10;
export const TRENDING_MIN_PARTICIPANTS = 5;
export const NEAR_ENTRY_CENTS = 0.05; // near-entry score decays to 0 by a 5¢ gap
export const RESOLVE_SOON_HALFLIFE_DAYS = 1; // score ~0.5 at 1 day out
export const START_SOON_HALFLIFE_DAYS = 1;

function cost(p: CrowdOpenPosition): number {
  return p.size * p.avgPrice;
}

function isDustFloored(p: CrowdOpenPosition): boolean {
  return cost(p) >= TRENDING_DUST_FLOOR_USD;
}

// A NO entry at 47¢ is a YES-equivalent entry of 53¢ — same inversion convention as the price chart's
// whale overlay (see CLAUDE.md's PriceChart notes).
function yesEquivalentEntry(p: CrowdOpenPosition): number {
  return p.outcomeIndex === 1 ? 1 - p.avgPrice : p.avgPrice;
}

function groupByCondition(positions: CrowdOpenPosition[]): Map<string, CrowdOpenPosition[]> {
  const map = new Map<string, CrowdOpenPosition[]>();
  for (const p of positions) {
    if (!p.conditionId) continue;
    const group = map.get(p.conditionId);
    if (group) group.push(p);
    else map.set(p.conditionId, [p]);
  }
  return map;
}

// Markets with at least `minParticipants` distinct wallets holding a non-dust position — the hard gate
// before any ranking happens.
export function qualifyingConditionIds(
  positions: CrowdOpenPosition[],
  minParticipants = TRENDING_MIN_PARTICIPANTS
): Set<string> {
  const qualifying = new Set<string>();
  for (const [conditionId, rows] of groupByCondition(positions)) {
    const addresses = new Set(rows.filter(isDustFloored).map((p) => p.address));
    if (addresses.size >= minParticipants) qualifying.add(conditionId);
  }
  return qualifying;
}

// Dollar-weighted mean YES-equivalent entry price across non-dust positions — "where did the
// leaderboard actually get in?" Null only if nothing clears the dust floor (shouldn't happen for an
// already-qualifying market).
function weightedAvgEntry(rows: CrowdOpenPosition[]): number | null {
  const positioned = rows.filter(isDustFloored);
  if (positioned.length === 0) return null;
  let totalCost = 0;
  let weighted = 0;
  for (const p of positioned) {
    const c = cost(p);
    totalCost += c;
    weighted += c * yesEquivalentEntry(p);
  }
  return totalCost > 0 ? weighted / totalCost : null;
}

// Decays 1 -> 0 as `days` grows; already-due (days <= 0) scores 1.
function proximityScore(days: number, halfLifeDays: number): number {
  return 1 / (1 + Math.max(0, days) / halfLifeDays);
}

function daysUntil(iso: string, now: number): number {
  return (Date.parse(iso) - now) / 86_400_000;
}

// Composite "worth surfacing right now" score for an already-qualifying market. Three independent
// terms, each only ever adds — a market missing one signal (no endDate, no gameStartTime) just scores
// 0 on that term rather than being penalized, so non-sports markets aren't docked for lacking a
// scheduled start time nobody has for them.
export function scoreTrendingMarket(market: MarketRow, rows: CrowdOpenPosition[], now = Date.now()): number {
  let score = 0;

  if (market.endDate) {
    const days = daysUntil(market.endDate, now);
    if (Number.isFinite(days) && days > 0) score += proximityScore(days, RESOLVE_SOON_HALFLIFE_DAYS);
  }

  const avgEntry = weightedAvgEntry(rows);
  if (avgEntry !== null && market.currentPrice !== null) {
    const gap = Math.abs(market.currentPrice - avgEntry);
    score += Math.max(0, 1 - gap / NEAR_ENTRY_CENTS);
  }

  if (market.gameStartTime) {
    const days = daysUntil(market.gameStartTime, now);
    if (Number.isFinite(days) && days > 0) score += proximityScore(days, START_SOON_HALFLIFE_DAYS);
  }

  return score;
}

function deriveLean(rows: CrowdOpenPosition[], lookups: CrowdLookups): TrendingLean | null {
  const positioned = rows.filter(isDustFloored);
  if (positioned.length === 0) return null;

  let yesCapital = 0;
  let noCapital = 0;
  let topRank: number | null = null;
  for (const p of positioned) {
    const c = cost(p);
    if (p.outcomeIndex === 0) yesCapital += c;
    else if (p.outcomeIndex === 1) noCapital += c;
    const rank = lookups.rankByAddress.get(p.address) ?? null;
    if (rank !== null && (topRank === null || rank < topRank)) topRank = rank;
  }

  const label: TrendingLean["label"] = yesCapital > noCapital ? "YES" : noCapital > yesCapital ? "NO" : "SPLIT";

  return { yesCapital, noCapital, label, topRank, positionedCount: positioned.length };
}

// `markets` should already be the qualifying set (see qualifyingConditionIds) — this scores, sorts by
// score desc, and truncates to `limit`.
export function buildTrendingMarkets(
  markets: MarketRow[],
  positions: CrowdOpenPosition[],
  lookups: CrowdLookups,
  limit = 12,
  now = Date.now()
): TrendingMarket[] {
  const byCondition = groupByCondition(positions);

  const scored = markets.map((market) => {
    const rows = market.conditionId ? byCondition.get(market.conditionId) ?? [] : [];
    return { market, rows, score: scoreTrendingMarket(market, rows, now) };
  });

  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, limit).map(({ market, rows }) => ({
    conditionId: market.conditionId,
    market: market.question,
    slug: market.slug,
    category: market.category,
    image: market.image,
    liquidityUsd: market.liquidityUsd,
    volume24hrUsd: market.volume24hrUsd,
    currentPrice: market.currentPrice,
    topOutcome: market.topOutcome,
    endDate: market.endDate,
    gameStartTime: market.gameStartTime,
    lean: deriveLean(rows, lookups)
  }));
}
