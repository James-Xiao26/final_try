// Ingest-time port of the Convergence ("crowded markets") aggregation. This mirrors the read-time
// helper in web/lib/marketCrowd.ts so the daily full ingest can precompute the ranked list into
// crowded_markets_cache instead of the web app scanning the whole wallet_positions table per request.
// Kept as a parallel implementation (like scripts/recentTrades.ts vs web/lib/recentTrades.ts): the
// two workspaces use different module systems, so the pure function is copied and independently
// tested rather than imported across the boundary. Keep this in sync with the web copy.

export interface CrowdOpenPosition {
  address: string;
  conditionId: string | null;
  market: string | null;
  outcomeIndex: number | null;
  size: number;
  avgPrice: number;
  curPrice: number;
}

export interface CrowdClosedPosition {
  address: string;
  conditionId: string | null;
  market: string | null;
  outcomeIndex: number | null;
  size: number;
  avgPrice: number;
  closeTime: string | null;
}

export interface CrowdedMarketSummary {
  conditionId: string;
  market: string | null;
  traderCount: number;
  yesTraders: number;
  noTraders: number;
  openCount: number;
  closedCount: number;
  committedUsd: number;
  netExposureUsd: number;
  topRank: number | null;
  curPrice: number | null;
  lastTradedAt: string | null;
}

// Cost basis a position row represents (USD committed): size · avg entry price.
function openCost(p: CrowdOpenPosition): number {
  return p.size * p.avgPrice;
}
function closedCost(p: CrowdClosedPosition): number {
  return p.size * p.avgPrice;
}

interface BucketAddress {
  yesCost: number;
  noCost: number;
  hasOpen: boolean;
}

interface Bucket {
  conditionId: string;
  market: string | null;
  byAddress: Map<string, BucketAddress>;
  yesCost: number;
  noCost: number;
  lastMs: number;
  curPrice: number | null; // YES price
}

function emptyBucket(conditionId: string, market: string | null): Bucket {
  return { conditionId, market, byAddress: new Map(), yesCost: 0, noCost: 0, lastMs: -Infinity, curPrice: null };
}

function addrState(bucket: Bucket, address: string): BucketAddress {
  let s = bucket.byAddress.get(address);
  if (!s) {
    s = { yesCost: 0, noCost: 0, hasOpen: false };
    bucket.byAddress.set(address, s);
  }
  return s;
}

function bucketize(positions: CrowdOpenPosition[], closed: CrowdClosedPosition[]): Map<string, Bucket> {
  const buckets = new Map<string, Bucket>();
  const get = (conditionId: string | null, market: string | null): Bucket | null => {
    if (!conditionId) return null;
    let b = buckets.get(conditionId);
    if (!b) {
      b = emptyBucket(conditionId, market);
      buckets.set(conditionId, b);
    } else if (!b.market && market) {
      b.market = market;
    }
    return b;
  };

  for (const p of positions) {
    const b = get(p.conditionId, p.market);
    if (!b) continue;
    const s = addrState(b, p.address);
    const cost = openCost(p);
    if (p.outcomeIndex === 1) {
      b.noCost += cost;
      s.noCost += cost;
    } else {
      b.yesCost += cost;
      s.yesCost += cost;
    }
    if (p.size > 0) s.hasOpen = true;
    if (b.curPrice === null) {
      if (p.outcomeIndex === 0) b.curPrice = p.curPrice;
      else if (p.outcomeIndex === 1) b.curPrice = 1 - p.curPrice;
    }
  }

  for (const p of closed) {
    const b = get(p.conditionId, p.market);
    if (!b) continue;
    const s = addrState(b, p.address);
    const cost = closedCost(p);
    if (p.outcomeIndex === 1) {
      b.noCost += cost;
      s.noCost += cost;
    } else {
      b.yesCost += cost;
      s.yesCost += cost;
    }
    const ms = p.closeTime ? Date.parse(p.closeTime) : NaN;
    if (Number.isFinite(ms) && ms > b.lastMs) b.lastMs = ms;
  }

  return buckets;
}

// Rank the markets by how many leaderboard wallets are in them (then by committed capital). Returns
// the top `limit` summaries. Built from the position caches only (open + closed). `rankByAddress`
// supplies the best leaderboard rank among participants.
export function summarizeCrowdedMarkets(
  positions: CrowdOpenPosition[],
  closed: CrowdClosedPosition[],
  rankByAddress: Map<string, number>,
  limit = 40
): CrowdedMarketSummary[] {
  const buckets = bucketize(positions, closed);
  const summaries: CrowdedMarketSummary[] = [];

  for (const b of buckets.values()) {
    let yesTraders = 0;
    let noTraders = 0;
    let openCount = 0;
    let closedCount = 0;
    let topRank: number | null = null;
    for (const [address, s] of b.byAddress) {
      if (s.yesCost > s.noCost) yesTraders += 1;
      else if (s.noCost > s.yesCost) noTraders += 1;
      if (s.hasOpen) openCount += 1;
      else closedCount += 1;
      const rank = rankByAddress.get(address);
      if (rank !== undefined && (topRank === null || rank < topRank)) topRank = rank;
    }
    summaries.push({
      conditionId: b.conditionId,
      market: b.market,
      traderCount: b.byAddress.size,
      yesTraders,
      noTraders,
      openCount,
      closedCount,
      committedUsd: b.yesCost + b.noCost,
      netExposureUsd: b.yesCost - b.noCost,
      topRank,
      curPrice: b.curPrice,
      lastTradedAt: Number.isFinite(b.lastMs) ? new Date(b.lastMs).toISOString() : null
    });
  }

  return summaries
    // Convergence = markets leaderboard wallets are converging on *now*. Drop markets no one currently
    // holds (openCount 0) — resolved or fully-exited — so a settled market (every position closed)
    // can't sit at the top forever on historical participation alone.
    .filter((s) => s.openCount > 0)
    .sort((a, c) => c.traderCount - a.traderCount || c.committedUsd - a.committedUsd)
    .slice(0, limit);
}
