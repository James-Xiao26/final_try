import { buildCrowdMarketDetail } from "./marketCrowd";
import type { CrowdClosedPosition, CrowdLookups, CrowdOpenPosition, CrowdTradeFill } from "./marketCrowd";
import { committedOf } from "./marketAnalytics";
import type { CrowdParticipant, MarketRow, TrendingLean, TrendingMarket } from "./types";

// Home-page Trending panel: which currently-hot markets (by 24h volume, selected by the caller) the
// leaderboard is positioned on, and which side. Reuses buildCrowdMarketDetail's per-wallet rollup —
// all inputs are already scoped to leaderboard wallets by the caller, same as marketCrowd.ts.

export const TRENDING_DUST_FLOOR_USD = 10;

function groupByCondition<T extends { conditionId: string | null }>(rows: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    if (!row.conditionId) continue;
    const group = map.get(row.conditionId);
    if (group) group.push(row);
    else map.set(row.conditionId, [row]);
  }
  return map;
}

// "Positioned" = an open holding worth at least the dust floor. A wallet that fully exited, or
// whose stake is throwaway change, isn't telling you where the leaderboard stands *today* — unlike
// smartMoneyLean's historical/skill-weighted use on the Market Analytics page, this filters to both.
function isPositioned(p: CrowdParticipant): boolean {
  return p.state === "open" && committedOf(p) >= TRENDING_DUST_FLOOR_USD;
}

function deriveLean(participants: CrowdParticipant[]): TrendingLean | null {
  const positioned = participants.filter(isPositioned);
  if (positioned.length === 0) return null;

  let yesCapital = 0;
  let noCapital = 0;
  let topRank: number | null = null;
  for (const p of positioned) {
    const capital = committedOf(p);
    if (p.outcomeIndex === 0) yesCapital += capital;
    else if (p.outcomeIndex === 1) noCapital += capital;
    if (p.rank !== null && (topRank === null || p.rank < topRank)) topRank = p.rank;
  }

  // Dollar-weighted lean, deliberately NOT smartMoneyLean's .label (that's skill-weighted headcount
  // — see trendingMarkets.test.ts for the regression case where the two disagree).
  const label: TrendingLean["label"] = yesCapital > noCapital ? "YES" : noCapital > yesCapital ? "NO" : "SPLIT";

  return { yesCapital, noCapital, label, topRank, positionedCount: positioned.length };
}

// Order preserved from `markets` (already ranked by the caller, e.g. 24h volume) — a market with
// zero tracked participants still gets a row (lean: null) so it doesn't silently vanish from the panel.
export function buildTrendingMarkets(
  markets: MarketRow[],
  positions: CrowdOpenPosition[],
  closed: CrowdClosedPosition[],
  fills: CrowdTradeFill[],
  lookups: CrowdLookups
): TrendingMarket[] {
  const positionsByCondition = groupByCondition(positions);
  const closedByCondition = groupByCondition(closed);
  const fillsByCondition = groupByCondition(fills);

  return markets.map((market) => {
    const base = {
      conditionId: market.conditionId,
      market: market.question,
      slug: market.slug,
      category: market.category,
      image: market.image,
      liquidityUsd: market.liquidityUsd,
      volume24hrUsd: market.volume24hrUsd,
      currentPrice: market.currentPrice,
      topOutcome: market.topOutcome,
      endDate: market.endDate
    };

    if (!market.conditionId) {
      return { ...base, lean: null };
    }

    const detail = buildCrowdMarketDetail(
      market.conditionId,
      positionsByCondition.get(market.conditionId) ?? [],
      closedByCondition.get(market.conditionId) ?? [],
      fillsByCondition.get(market.conditionId) ?? [],
      lookups,
      new Map()
    );

    return { ...base, lean: detail ? deriveLean(detail.participants) : null };
  });
}
