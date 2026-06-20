import type { CONFIG } from "./config.js";
import type { ClosedPosition } from "./polymarket.js";

// A wallet's "specialty" is the market category where it has both enough resolved bets AND a proven
// positive forecasting edge — the same edge math the Skill Score uses (Bayesian-shrunk per-share
// edge), but sliced per category. Positions carry no category from Polymarket, so we classify by
// keyword on the market question title (zero extra API calls).
//
// ponytail: keyword classification on the title is a naive heuristic. Upgrade path = cache a
// condition_id→category map from Gamma tags during ingest:markets and look up by conditionId,
// falling back to keywords. Only worth it if title classification misfires on real data.

export type Specialty = "Politics" | "Crypto" | "Sports" | "Economy" | "Geopolitics" | "Culture";

// Ordered most-distinctive-first so an ambiguous title lands in the more specific bucket. Politics
// is checked before Sports so "Trump vs Biden" is Politics (not matched by Sports' generic "vs"),
// and before Geopolitics so a domestic-politics title isn't stolen by a stray country name.
const CATEGORY_KEYWORDS: ReadonlyArray<readonly [Specialty, readonly string[]]> = [
  ["Crypto", ["bitcoin", "btc", "ethereum", "eth", "solana", "sol", "crypto", "dogecoin", "doge", "xrp", "ripple", "binance", "coinbase", "nft", "memecoin", "altcoin", "blockchain", "stablecoin", "cardano"]],
  ["Politics", ["trump", "biden", "harris", "election", "senate", "congress", "president", "presidential", "governor", "primary", "republican", "democrat", "gop", "ballot", "nominee", "impeach", "parliament", "prime minister", "referendum", "mayor", "cabinet"]],
  ["Geopolitics", ["russia", "ukraine", "putin", "israel", "gaza", "hamas", "palestine", "iran", "china", "taiwan", "north korea", "war", "ceasefire", "nato", "invasion", "nuclear", "missile", "sanctions", "venezuela", "syria"]],
  ["Economy", ["fed", "interest rate", "rate cut", "rate hike", "cpi", "inflation", "gdp", "recession", "jobs report", "unemployment", "treasury", "s&p", "nasdaq", "dow jones", "earnings", "tariff", "powell", "jerome powell"]],
  ["Sports", ["nba", "nfl", "nhl", "mlb", "ufc", "premier league", "world cup", "super bowl", "champions league", "playoff", "championship", "vs", "finals", "grand slam", "formula 1", "f1", "wnba", "la liga", "the masters"]],
  ["Culture", ["oscar", "oscars", "grammy", "emmy", "box office", "movie", "album", "time person", "elon", "taylor swift", "kanye", "celebrity", "tiktok", "rotten tomatoes", "pope", "royal", "netflix", "billboard"]]
];

// One word-boundary regex per category, built once. Word boundaries stop "vs" matching inside
// "vsphere" or "eth" inside "ethereum", and still match multi-word keywords like "world cup".
const CATEGORY_MATCHERS: ReadonlyArray<readonly [Specialty, RegExp]> = CATEGORY_KEYWORDS.map(
  ([category, keywords]) => {
    const escaped = keywords.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    return [category, new RegExp(`\\b(?:${escaped.join("|")})\\b`, "i")] as const;
  }
);

// First category whose keywords appear in the title; null = unclassifiable ("Other"), which can
// never become a specialty.
export function classifyMarket(title: string): Specialty | null {
  for (const [category, matcher] of CATEGORY_MATCHERS) {
    if (matcher.test(title)) {
      return category;
    }
  }
  return null;
}

interface CategoryEdge {
  edgeSum: number;
  n: number;
}

/**
 * The category a wallet is demonstrably best at, or null if it has no standout specialty.
 *
 * Over the wallet's resolved positions (outcome known), groups by classified category and computes
 * the Bayesian-shrunk per-share edge for each: edgeSum / (n + EDGE_SHRINKAGE_K) — the same shrink
 * the Skill Score uses, so a 3-bet fluke can't out-rank a 40-bet record. A category qualifies only
 * with at least MIN_SPECIALTY_TRADES resolved bets and a positive shrunk edge; the specialty is the
 * qualifying category with the highest shrunk edge. Unclassifiable ("Other") positions count toward
 * nothing and can never win.
 */
export function walletSpecialty(
  positions: ClosedPosition[],
  config: Pick<typeof CONFIG, "MIN_SPECIALTY_TRADES" | "EDGE_SHRINKAGE_K">
): Specialty | null {
  const byCategory = new Map<Specialty, CategoryEdge>();

  for (const position of positions) {
    if (position.outcome === null) {
      continue; // unresolved → no known edge
    }
    const category = classifyMarket(position.market);
    if (category === null) {
      continue; // "Other"
    }
    const entry = byCategory.get(category) ?? { edgeSum: 0, n: 0 };
    entry.edgeSum += position.outcome - position.avgPrice;
    entry.n += 1;
    byCategory.set(category, entry);
  }

  let best: Specialty | null = null;
  let bestShrunkEdge = 0;
  for (const [category, { edgeSum, n }] of byCategory) {
    if (n < config.MIN_SPECIALTY_TRADES) {
      continue;
    }
    const shrunkEdge = edgeSum / (n + config.EDGE_SHRINKAGE_K);
    if (shrunkEdge > bestShrunkEdge) {
      best = category;
      bestShrunkEdge = shrunkEdge;
    }
  }
  return best;
}
