// Pure computation for the Decision Engine: skill-weighted smart money signal analysis.
// No I/O — takes deserialized DB rows, returns ranked trade recommendations.
// Mirrors the marketCrowd.ts / marketAnalytics.ts pattern: DB queries live in supabase.ts,
// all derivation lives here, everything is unit-tested against plain in-memory inputs.

import { formatCompactUsd, formatPrice } from "./format";
import type {
  ConfidenceLevel,
  DecisionEngineResult,
  DecisionSignalResult,
  SmartMoneyHolder,
  TradeRecommendation,
} from "./types";

// ── Raw input types (deserialized DB rows) ────────────────────────────────────

export interface DELeaderboardEntry {
  address: string;
  skillScore: number;
  rank: number;
}

export interface DEPosition {
  address: string;
  conditionId: string | null;
  market: string | null;
  outcomeIndex: number | null;
  size: number;
  avgPrice: number;
  curPrice: number;
  endDate: string | null;
  firstTradedAt: string | null;
  lastTradedAt: string | null;
}

export interface DEMarket {
  conditionId: string;
  question: string;
  slug: string | null;
  category: string | null;
  liquidityUsd: number;
  lastTradePrice: number | null;
  endDate: string | null;
  image: string | null;
  spread: number | null;
}

export interface DecisionEngineInputs {
  leaderboard: DELeaderboardEntry[];
  positions: DEPosition[];
  markets: Map<string, DEMarket>;
  handles: Map<string, string | null>;
  asOf: Date;
}

export interface DecisionEngineOpts {
  maxResults?: number;
}

// ── Tunable thresholds ────────────────────────────────────────────────────────

const MIN_SMART_HOLDERS = 3;      // minimum leaderboard wallets required for a signal
const MIN_SKILL = 4.0;            // minimum skill score to count as "smart money"
const MIN_EDGE_CENTS = 3.0;       // minimum edge (¢/share) to generate a recommendation
const MIN_LIQUIDITY_USD = 25_000; // minimum market liquidity to recommend entry
const MAX_RECOMMENDATIONS = 10;
// Recommend entry at this fraction of the way from current price to smart money price.
// 0.6 means "buy up to 60% of the gap" — conservative relative to smart money's conviction.
const ENTRY_CAPTURE_RATIO = 0.6;

const CONFIDENCE_RANGES: Record<ConfidenceLevel, [number, number]> = {
  low:       [0.40, 0.52],
  medium:    [0.52, 0.62],
  high:      [0.62, 0.75],
  very_high: [0.75, 0.86],
};

// ── Pure helpers ──────────────────────────────────────────────────────────────

// Skill-score-weighted average entry price across a set of position holders.
// Higher-skill wallets receive more weight so a rank-1 wallet at 0.54 outweighs
// five rank-80 wallets at 0.40.
export function computeSmartMoneyPrice(
  positions: { avgPrice: number; skillScore: number }[]
): number {
  const totalWeight = positions.reduce((sum, p) => sum + p.skillScore, 0);
  if (totalWeight === 0) return 0;
  return positions.reduce((sum, p) => sum + p.skillScore * p.avgPrice, 0) / totalWeight;
}

// Maps days-to-expiry to a [0,1] multiplier. Peak at 14–30 days, decays at extremes.
// Near-zero when expired or < 3 days; dampened but non-zero out to 180 days.
export function computeExpiryFactor(daysToExpiry: number | null): number {
  if (daysToExpiry === null) return 0.5;
  if (daysToExpiry <= 0) return 0;
  if (daysToExpiry < 7) return 0.2;
  if (daysToExpiry <= 30) return 1.0;
  if (daysToExpiry <= 90) return 0.85;
  if (daysToExpiry <= 180) return 0.65;
  return 0.4;
}

// Maps the fraction of signals fired to a confidence tier. 6 signals total.
export function computeConfidenceLevel(
  signalsFired: number,
  totalSignals: number
): ConfidenceLevel {
  if (totalSignals === 0) return "low";
  const ratio = signalsFired / totalSignals;
  if (ratio >= 5 / 6) return "very_high";
  if (ratio >= 4 / 6) return "high";
  if (ratio >= 3 / 6) return "medium";
  return "low";
}

// Computes the six independent signals for a candidate market+side pair.
// Each signal is a named boolean check with a human-readable value for display.
export function computeSignals(opts: {
  edgeCents: number;
  holderCount: number;
  avgSkill: number;
  topRank: number;
  hadRecentBuy: boolean;
  liquidityUsd: number;
  daysToExpiry: number | null;
}): DecisionSignalResult[] {
  const { edgeCents, holderCount, avgSkill, topRank, hadRecentBuy, liquidityUsd, daysToExpiry } =
    opts;

  const inExpiryWindow =
    daysToExpiry !== null && daysToExpiry >= 10 && daysToExpiry <= 150;
  const inSweetSpot =
    daysToExpiry !== null && daysToExpiry >= 20 && daysToExpiry <= 90;

  return [
    {
      name: "Smart Money Premium",
      description: "Leaderboard traders entered above the current market price",
      fired: edgeCents >= 5,
      strength:
        edgeCents >= 15 ? "strong" :
        edgeCents >= 8  ? "moderate" :
        edgeCents >= 5  ? "weak" : "none",
      value: `+${edgeCents.toFixed(1)}¢/share`,
    },
    {
      name: "Top Wallet Coverage",
      description: "Multiple skilled traders hold this position",
      fired: holderCount >= 3,
      strength:
        holderCount >= 10 ? "strong" :
        holderCount >= 6  ? "moderate" :
        holderCount >= 3  ? "weak" : "none",
      value: `${holderCount} holder${holderCount !== 1 ? "s" : ""}`,
    },
    {
      name: "Apex Conviction",
      description: "A top-ranked or high-skill trader holds this position",
      fired: topRank <= 15 || avgSkill >= 7.0,
      strength:
        topRank <= 5 || avgSkill >= 8.5   ? "strong" :
        topRank <= 10 || avgSkill >= 7.0  ? "moderate" : "weak",
      value: topRank <= 100 ? `Rank #${topRank}` : `Avg ${avgSkill.toFixed(1)}/10`,
    },
    {
      name: "Recent Accumulation",
      description: "Smart money added to this position in the last 7 days",
      fired: hadRecentBuy,
      strength: hadRecentBuy ? "moderate" : "none",
      value: hadRecentBuy ? "active" : "no recent buys",
    },
    {
      name: "Market Depth",
      description: "Sufficient liquidity to enter and exit without excessive slippage",
      fired: liquidityUsd >= 50_000,
      strength:
        liquidityUsd >= 500_000 ? "strong" :
        liquidityUsd >= 150_000 ? "moderate" :
        liquidityUsd >= 50_000  ? "weak" : "none",
      value: formatCompactUsd(liquidityUsd),
    },
    {
      name: "Resolution Window",
      description: "Market resolves within the optimal 10–150 day window",
      fired: inExpiryWindow,
      strength: inSweetSpot ? "strong" : inExpiryWindow ? "moderate" : "none",
      value: daysToExpiry !== null ? `${daysToExpiry}d to expiry` : "unknown",
    },
  ];
}

function buildExplanation(opts: {
  holderCount: number;
  avgSkill: number;
  side: "YES" | "NO";
  smartMoneyPrice: number;
  currentPrice: number;
  edgeCents: number;
  daysToExpiry: number | null;
}): string {
  const { holderCount, avgSkill, side, smartMoneyPrice, currentPrice, edgeCents, daysToExpiry } =
    opts;

  const holderDesc = `${holderCount} leaderboard wallet${holderCount !== 1 ? "s" : ""} (avg skill ${avgSkill.toFixed(1)}/10)`;
  const priceDesc = `hold ${side} at a skill-weighted average of ${formatPrice(smartMoneyPrice)}`;
  const gapDesc = `Current price is ${formatPrice(currentPrice)} — a ${edgeCents.toFixed(1)}¢ discount to their collective conviction`;

  const timeDesc =
    daysToExpiry === null ? "" :
    daysToExpiry <= 14
      ? ` Resolves in ${daysToExpiry} days — short runway.`
      : daysToExpiry <= 60
        ? ` ${daysToExpiry} days to resolution — within the optimal window.`
        : ` ${daysToExpiry} days to resolution.`;

  return `${holderDesc} ${priceDesc}. ${gapDesc}.${timeDesc}`;
}

function buildWarnings(opts: {
  holderCount: number;
  liquidityUsd: number;
  spread: number | null;
  avgSkill: number;
  daysToExpiry: number | null;
}): string[] {
  const { holderCount, liquidityUsd, spread, avgSkill, daysToExpiry } = opts;
  const warnings: string[] = [];

  if (daysToExpiry !== null && daysToExpiry > 0 && daysToExpiry < 14) {
    warnings.push(
      `Resolves in ${daysToExpiry} day${daysToExpiry !== 1 ? "s" : ""} — sharp moves are common near resolution.`
    );
  }
  if (holderCount < MIN_SMART_HOLDERS + 1) {
    warnings.push(
      `Thin signal — only ${holderCount} leaderboard wallet${holderCount !== 1 ? "s" : ""} on this side. Treat confidence interval as wide.`
    );
  }
  if (liquidityUsd < 50_000) {
    warnings.push(
      `Low liquidity (${formatCompactUsd(liquidityUsd)}) — large orders may significantly move the market.`
    );
  }
  if (spread !== null && spread > 0.05) {
    warnings.push(
      `Wide spread (${(spread * 100).toFixed(1)}¢) — expect unfavorable fill prices on entry.`
    );
  }
  if (avgSkill < 5.5) {
    warnings.push(
      `Holder average skill is ${avgSkill.toFixed(1)}/10 — confidence in this signal is reduced.`
    );
  }

  return warnings;
}

// ── Main entry point ──────────────────────────────────────────────────────────

export function buildRecommendations(
  inputs: DecisionEngineInputs,
  opts: DecisionEngineOpts = {}
): DecisionEngineResult {
  const maxResults = opts.maxResults ?? MAX_RECOMMENDATIONS;
  const { asOf } = inputs;

  // Deduplicate leaderboard: keep best skill score and best (lowest) rank per address.
  const skillMap = new Map<string, DELeaderboardEntry>();
  for (const entry of inputs.leaderboard) {
    const existing = skillMap.get(entry.address);
    if (!existing) {
      skillMap.set(entry.address, entry);
    } else {
      skillMap.set(entry.address, {
        address: entry.address,
        skillScore: Math.max(existing.skillScore, entry.skillScore),
        rank: Math.min(existing.rank, entry.rank),
      });
    }
  }

  // Group open positions by conditionId + outcomeIndex.
  interface PositionGroup {
    conditionId: string;
    outcomeIndex: number;
    positions: DEPosition[];
  }
  const groups = new Map<string, PositionGroup>();
  for (const pos of inputs.positions) {
    if (pos.conditionId === null || pos.outcomeIndex === null) continue;
    const key = `${pos.conditionId}:${pos.outcomeIndex}`;
    const existing = groups.get(key);
    if (existing) {
      existing.positions.push(pos);
    } else {
      groups.set(key, {
        conditionId: pos.conditionId,
        outcomeIndex: pos.outcomeIndex,
        positions: [pos],
      });
    }
  }

  // For each conditionId, select the dominant side by skill-weighted committed capital.
  // This avoids split-signal cards when smart money is divided.
  const conditionBestSide = new Map<string, { outcomeIndex: number; score: number }>();
  for (const [, group] of groups) {
    const score = group.positions.reduce((sum, pos) => {
      const skill = skillMap.get(pos.address)?.skillScore ?? 0;
      return sum + skill * pos.size * pos.avgPrice;
    }, 0);
    const existing = conditionBestSide.get(group.conditionId);
    if (!existing || score > existing.score) {
      conditionBestSide.set(group.conditionId, { outcomeIndex: group.outcomeIndex, score });
    }
  }

  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

  const recommendations: TradeRecommendation[] = [];

  for (const [conditionId, { outcomeIndex }] of conditionBestSide) {
    const group = groups.get(`${conditionId}:${outcomeIndex}`);
    if (!group) continue;

    const market = inputs.markets.get(conditionId);
    if (!market) continue; // skip: no market metadata (unlisted or inactive)

    if (market.liquidityUsd < MIN_LIQUIDITY_USD) continue;

    // Filter to "smart money": must be in leaderboard with skill >= MIN_SKILL.
    const smartHolders = group.positions
      .map((pos) => ({ pos, entry: skillMap.get(pos.address) }))
      .filter(
        (p): p is { pos: DEPosition; entry: DELeaderboardEntry } =>
          p.entry !== undefined && p.entry.skillScore >= MIN_SKILL
      );

    if (smartHolders.length < MIN_SMART_HOLDERS) continue;

    const smartMoneyPrice = computeSmartMoneyPrice(
      smartHolders.map(({ pos, entry }) => ({ avgPrice: pos.avgPrice, skillScore: entry.skillScore }))
    );

    // Use the average cur_price across holders as current market price.
    // In practice these are all nearly identical since they come from the same ingest pass.
    const currentPrice =
      smartHolders.reduce((sum, { pos }) => sum + pos.curPrice, 0) / smartHolders.length;

    const edgeCents = (smartMoneyPrice - currentPrice) * 100;
    if (edgeCents < MIN_EDGE_CENTS) continue;

    // Recommend entry at ENTRY_CAPTURE_RATIO of the way from current to smart money price.
    const maxEntryPrice = currentPrice + (smartMoneyPrice - currentPrice) * ENTRY_CAPTURE_RATIO;
    const edgePct = (smartMoneyPrice - currentPrice) / smartMoneyPrice;

    const daysToExpiry = market.endDate
      ? Math.floor(
          (new Date(market.endDate).getTime() - asOf.getTime()) / (1000 * 60 * 60 * 24)
        )
      : null;

    if (daysToExpiry !== null && daysToExpiry <= 0) continue; // expired

    const totalSkill = smartHolders.reduce((sum, { entry }) => sum + entry.skillScore, 0);
    const avgHolderSkill = totalSkill / smartHolders.length;
    const topRank = Math.min(...smartHolders.map(({ entry }) => entry.rank));
    const holderCount = smartHolders.length;
    const totalCommittedUsd = smartHolders.reduce(
      (sum, { pos }) => sum + pos.size * pos.avgPrice,
      0
    );

    // A holder counts as "recently accumulating" if their last trade on this position is
    // within 7 days of asOf — derived from wallet_positions.last_traded_at (already fetched).
    const hadRecentBuy = smartHolders.some(
      ({ pos }) =>
        pos.lastTradedAt !== null &&
        asOf.getTime() - new Date(pos.lastTradedAt).getTime() < SEVEN_DAYS_MS
    );

    const signals = computeSignals({
      edgeCents,
      holderCount,
      avgSkill: avgHolderSkill,
      topRank,
      hadRecentBuy,
      liquidityUsd: market.liquidityUsd,
      daysToExpiry,
    });

    const signalsFired = signals.filter((s) => s.fired).length;
    const confidenceLevel = computeConfidenceLevel(signalsFired, signals.length);
    const confidenceRange = CONFIDENCE_RANGES[confidenceLevel];

    const side: "YES" | "NO" = outcomeIndex === 0 ? "YES" : "NO";

    const topHolders: SmartMoneyHolder[] = smartHolders
      .slice()
      .sort((a, b) => b.entry.skillScore - a.entry.skillScore)
      .slice(0, 5)
      .map(({ pos, entry }) => ({
        address: pos.address,
        handle: inputs.handles.get(pos.address) ?? null,
        rank: entry.rank,
        skillScore: entry.skillScore,
        side,
        avgEntry: pos.avgPrice,
        size: pos.size,
        currentValue: pos.size * pos.curPrice,
        lastTradedAt: pos.lastTradedAt,
      }));

    const explanation = buildExplanation({
      holderCount,
      avgSkill: avgHolderSkill,
      side,
      smartMoneyPrice,
      currentPrice,
      edgeCents,
      daysToExpiry,
    });

    const warnings = buildWarnings({
      holderCount,
      liquidityUsd: market.liquidityUsd,
      spread: market.spread,
      avgSkill: avgHolderSkill,
      daysToExpiry,
    });

    // Ranking: edge × holder quality × liquidity alignment × expiry alignment × signal coverage.
    const liquidityFactor = Math.min(
      1.0,
      Math.log10(Math.max(market.liquidityUsd, 1_000)) / Math.log10(1_000_000)
    );
    const expiryFactor = computeExpiryFactor(daysToExpiry);
    const confidenceFraction = signalsFired / signals.length;
    const baseRankingScore =
      edgeCents *
      Math.log1p(holderCount) *
      avgHolderSkill *
      liquidityFactor *
      expiryFactor *
      confidenceFraction;

    const rankingScore = baseRankingScore;

    recommendations.push({
      conditionId,
      market: market.question,
      side,
      maxEntryPrice,
      currentPrice,
      smartMoneyPrice,
      edgeCents,
      edgePct,
      confidenceLevel,
      confidenceRange,
      signalsFired,
      totalSignals: signals.length,
      signals,
      topHolders,
      holderCount,
      avgHolderSkill,
      totalCommittedUsd,
      category: market.category,
      slug: market.slug,
      endDate: market.endDate,
      daysToExpiry,
      liquidityUsd: market.liquidityUsd,
      spread: market.spread,
      image: market.image,
      explanation,
      warnings,
      rankingScore,
    });
  }

  recommendations.sort((a, b) => b.rankingScore - a.rankingScore);

  return {
    recommendations: recommendations.slice(0, maxResults),
    universeSummary: {
      marketsScanned: inputs.markets.size,
      marketsWithSmartMoney: conditionBestSide.size,
      totalLeaderboardHolders: skillMap.size,
      generatedAt: asOf.toISOString(),
    },
    disclaimer:
      "These suggestions reflect where leaderboard traders entered positions — not guaranteed outcomes. " +
      "You can lose your entire investment. Past forecasting edge does not guarantee future returns. " +
      "Always size positions according to your own risk tolerance.",
  };
}
