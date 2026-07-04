import type { CrowdLookups, CrowdOpenPosition } from "./marketCrowd";
import type { MarketRow, TrendingConsensus, TrendingMarket } from "./types";

// Home-page Trending panel. Selection is leaderboard-driven, not volume-driven: a market only
// qualifies with TRENDING_MIN_PARTICIPANTS+ distinct wallets holding a real (non-dust) position, then
// the qualifying set is ranked by how *actionable* it is right now (resolving soon, still near what
// smart money's track record implies, and — sports/esports only — starting soon). All inputs are
// already scoped to leaderboard wallets by the caller. Operates directly on CrowdOpenPosition —
// Trending only ever cares about currently-open holdings, so it skips buildCrowdMarketDetail's
// open+closed+fills merge entirely.

export const TRENDING_DUST_FLOOR_USD = 10;
export const TRENDING_MIN_PARTICIPANTS = 5;
// A market whose committed capital is more than this fraction in ONE wallet isn't multi-wallet
// convergence — it's a single whale/specialist. Mirror of CONFIG.MAX_WHALE_COST_SHARE (scripts side).
export const MAX_WHALE_COST_SHARE = 0.6;
export const NEAR_ENTRY_CENTS = 0.05; // near-entry score decays to 0 by a 5¢ gap
// Above this bid/ask spread Polymarket's displayed price flips from the midpoint to the (stale) last
// trade, so the price-vs-smart-money gap is noise. Skip the near-entry term on markets wider than this.
export const NEAR_ENTRY_MAX_SPREAD = 0.1;
export const RESOLVE_SOON_HALFLIFE_DAYS = 1; // score ~0.5 at 1 day out
export const START_SOON_HALFLIFE_DAYS = 1;

// Gamma's gameStartTime isn't exclusively a scheduled-game field despite the name — spot-checking
// production data turned up the same field on recurring/periodic markets (e.g. weekly "tweet count"
// trackers) in Culture/Finance/Politics categories, where it represents some internal bucket-open
// timestamp, not a real-world event about to happen. Gate the "start soon" score to categories that
// are actually sports/esports so a leaked timestamp on an unrelated market can't earn undeserved
// credit. ponytail: a category-string allowlist, not exhaustive — extend as new sports categories
// show up in `markets.category` (mapEvent's category is Gamma's own tag label, so it varies by sport).
const SPORTS_CATEGORIES = new Set([
  "sports", "esports", "soccer", "basketball", "baseball", "football", "hockey",
  "tennis", "mma", "boxing", "golf", "cricket", "rugby", "formula 1", "fifa world cup"
]);

export function isSportsCategory(category: string | null): boolean {
  return category !== null && SPORTS_CATEGORIES.has(category.toLowerCase());
}

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
// before any ranking happens. Headcount-based on purpose (a separate concern from how those wallets
// are weighted once a market qualifies).
export function qualifyingConditionIds(
  positions: CrowdOpenPosition[],
  minParticipants = TRENDING_MIN_PARTICIPANTS,
  maxWhaleShare = 1 // default off (production passes MAX_WHALE_COST_SHARE); off keeps unit fixtures unfiltered.
): Set<string> {
  const qualifying = new Set<string>();
  for (const [conditionId, rows] of groupByCondition(positions)) {
    const dust = rows.filter(isDustFloored);
    const addresses = new Set(dust.map((p) => p.address));
    if (addresses.size < minParticipants) continue;
    // Whale-concentration cap: if one wallet holds more than maxWhaleShare of the committed capital,
    // this isn't a crowd — it's a single specialist (often grinding a recurring bucket series).
    const costByAddress = new Map<string, number>();
    let total = 0;
    for (const p of dust) {
      const c = cost(p);
      costByAddress.set(p.address, (costByAddress.get(p.address) ?? 0) + c);
      total += c;
    }
    const whaleShare = total > 0 ? Math.max(...costByAddress.values()) / total : 1;
    if (whaleShare > maxWhaleShare) continue;
    qualifying.add(conditionId);
  }
  return qualifying;
}

// Weight a positioned wallet by proven skill, dampened by position size (sqrt, not linear) — a
// highly-skilled trader's smaller conviction bet can outweigh a big bet from a middling one, but a
// bigger bet from an equally-skilled trader still counts for a bit more. Pure $-weighting (v1) let an
// unskilled whale dominate; pure skill-weighting ignores conviction size entirely — this splits the
// difference. Only ever called on dust-floored rows.
function smartMoneyWeight(p: CrowdOpenPosition, lookups: CrowdLookups): number {
  const skill = Math.max(0, lookups.skillByAddress.get(p.address) ?? 0);
  return skill * Math.sqrt(cost(p));
}

// Smart-money-weighted mean YES-equivalent entry price across non-dust positions — "what does the
// leaderboard's track record imply the odds should be?", directly comparable to the market's live
// price. Null only if nothing clears the dust floor (shouldn't happen for an already-qualifying
// market) or every included wallet's weight rounds to 0.
function smartMoneyImpliedPrice(rows: CrowdOpenPosition[], lookups: CrowdLookups): number | null {
  const positioned = rows.filter(isDustFloored);
  if (positioned.length === 0) return null;
  let totalWeight = 0;
  let weighted = 0;
  for (const p of positioned) {
    const w = smartMoneyWeight(p, lookups);
    totalWeight += w;
    weighted += w * yesEquivalentEntry(p);
  }
  return totalWeight > 0 ? weighted / totalWeight : null;
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
export function scoreTrendingMarket(
  market: MarketRow,
  rows: CrowdOpenPosition[],
  lookups: CrowdLookups,
  now = Date.now()
): number {
  let score = 0;

  if (market.endDate) {
    const days = daysUntil(market.endDate, now);
    if (Number.isFinite(days) && days > 0) score += proximityScore(days, RESOLVE_SOON_HALFLIFE_DAYS);
  }

  // Only trust the currentPrice-vs-implied gap when the book is tight. Above NEAR_ENTRY_MAX_SPREAD the
  // displayed price is a stale last-trade, not the midpoint, so the gap is noise. Unknown spread (null)
  // is treated as tight — consistent with the "each term only ever adds" design.
  const impliedPrice = smartMoneyImpliedPrice(rows, lookups);
  const tightBook = market.spread === null || market.spread <= NEAR_ENTRY_MAX_SPREAD;
  if (tightBook && impliedPrice !== null && market.currentPrice !== null) {
    const gap = Math.abs(market.currentPrice - impliedPrice);
    score += Math.max(0, 1 - gap / NEAR_ENTRY_CENTS);
  }

  if (market.gameStartTime && isSportsCategory(market.category)) {
    const days = daysUntil(market.gameStartTime, now);
    if (Number.isFinite(days) && days > 0) score += proximityScore(days, START_SOON_HALFLIFE_DAYS);
  }

  return score;
}

function deriveConsensus(rows: CrowdOpenPosition[], lookups: CrowdLookups): TrendingConsensus | null {
  const positioned = rows.filter(isDustFloored);
  if (positioned.length === 0) return null;

  const smartMoneyPct = smartMoneyImpliedPrice(rows, lookups);
  if (smartMoneyPct === null) return null;

  let topRank: number | null = null;
  for (const p of positioned) {
    const rank = lookups.rankByAddress.get(p.address) ?? null;
    if (rank !== null && (topRank === null || rank < topRank)) topRank = rank;
  }

  const label: TrendingConsensus["label"] = smartMoneyPct > 0.5 ? "YES" : smartMoneyPct < 0.5 ? "NO" : "SPLIT";

  return { smartMoneyPct, label, topRank, positionedCount: positioned.length };
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
    return { market, rows, score: scoreTrendingMarket(market, rows, lookups, now) };
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
    consensus: deriveConsensus(rows, lookups)
  }));
}
