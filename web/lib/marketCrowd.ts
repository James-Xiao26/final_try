import type { CrowdedMarketSummary, CrowdFill, CrowdMarketDetail, CrowdParticipant, CrowdTimelinePoint } from "./types";

// Read-time aggregation of the leaderboard's positions into "crowded markets" — the markets the most
// tracked wallets are converging on. All inputs are already scoped to leaderboard wallets by the
// caller (the wallet_positions / wallet_closed_positions / wallet_trades caches only hold board
// wallets). camelCase intermediates; the supabase reader maps the snake_case rows into these.

export interface CrowdOpenPosition {
  address: string;
  conditionId: string | null;
  asset: string;
  market: string | null;
  outcomeIndex: number | null;
  size: number;
  avgPrice: number;
  curPrice: number;
  currentValue: number;
  cashPnl: number;
  // First/last fill day for this holding, from the ingest-time /activity scan. Fallback for the
  // participant's first-buy/last-trade when the capped fill cache has no fills for this market.
  firstTradedAt: string | null;
  lastTradedAt: string | null;
}

export interface CrowdClosedPosition {
  address: string;
  conditionId: string | null;
  outcomeIndex: number | null;
  market: string | null;
  avgPrice: number;
  realizedPnl: number;
  size: number;
  closeTime: string | null;
  // First fill day from /activity; "last trade" falls back to closeTime.
  firstTradedAt: string | null;
}

export interface CrowdTradeFill {
  address: string;
  conditionId: string | null;
  market: string | null;
  outcomeIndex: number | null;
  side: string | null;
  price: number | null;
  size: number | null;
  usdcSize: number | null;
  tradedAt: string;
}

export interface CrowdLookups {
  rankByAddress: Map<string, number>;
  handleByAddress: Map<string, string | null>;
  skillByAddress: Map<string, number | null>;
}

function sideLabel(index: number | null): "YES" | "NO" | "—" {
  if (index === 0) return "YES";
  if (index === 1) return "NO";
  return "—";
}

// A fill's USDC magnitude — prefer the reported usdcSize, fall back to price·size, else 0.
function fillUsdc(fill: CrowdTradeFill): number {
  if (fill.usdcSize !== null) return Math.abs(fill.usdcSize);
  if (fill.price !== null && fill.size !== null) return Math.abs(fill.price * fill.size);
  return 0;
}

function isBuy(side: string | null): boolean {
  return (side ?? "").toUpperCase() === "BUY";
}

function dayOf(iso: string): string {
  return iso.slice(0, "YYYY-MM-DD".length);
}

// Cost basis a position row represents (USD committed): size · avg entry price.
function openCost(p: CrowdOpenPosition): number {
  return p.size * p.avgPrice;
}
function closedCost(p: CrowdClosedPosition): number {
  return p.size * p.avgPrice;
}

interface BucketAddress {
  // exposure (cost-basis USD) per outcome index, for picking the wallet's dominant side
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

// Roll the leaderboard's open + closed positions up into one bucket per market (condition_id), used
// by summarizeCrowdedMarkets for the ranked list. The detail path re-derives per wallet richly and
// also pulls the tracked fills; the list deliberately skips fills (they'd blow past Supabase's
// 1000-row page cap across all board wallets) and measures committed capital from the position caches.
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
    // YES current price, best-effort: outcome 0 directly, outcome 1 as its complement.
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
// the top `limit` summaries, each with the YES/NO split, exposure, and freshest close time. Built
// from the position caches only (open + closed); fills are reserved for the per-market detail.
export function summarizeCrowdedMarkets(
  positions: CrowdOpenPosition[],
  closed: CrowdClosedPosition[],
  lookups: Pick<CrowdLookups, "rankByAddress">,
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
      // Dominant side: the outcome the wallet has more cost basis in. Ties / fill-only wallets with
      // no position cost fall through to neither side but still count as a participant.
      if (s.yesCost > s.noCost) yesTraders += 1;
      else if (s.noCost > s.yesCost) noTraders += 1;
      if (s.hasOpen) openCount += 1;
      else closedCount += 1;
      const rank = lookups.rankByAddress.get(address);
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
    .sort((a, c) => c.traderCount - a.traderCount || c.committedUsd - a.committedUsd)
    .slice(0, limit);
}

// Reconstruct the leaderboard's cumulative net holdings on each side over time, forward from the
// tracked fills (oldest→newest), one point per UTC day with activity. Net shares/cost are clamped at
// 0: the tracked window keeps only the last N fills/wallet, so a sell whose matching buy predates the
// window would otherwise drive the running total negative. `price` carries forward the last known YES
// price for a continuous overlay.
export function buildCrowdTimeline(
  fills: CrowdTradeFill[],
  pricesByDay: Map<string, number>
): CrowdTimelinePoint[] {
  const chron = [...fills].sort((a, b) => Date.parse(a.tradedAt) - Date.parse(b.tradedAt));
  let yesShares = 0;
  let noShares = 0;
  let yesCost = 0;
  let noCost = 0;
  let lastPrice: number | null = null;

  const byDay = new Map<string, CrowdTimelinePoint>();
  for (const f of chron) {
    const size = f.size ?? 0;
    const usdc = fillUsdc(f);
    const dir = isBuy(f.side) ? 1 : -1;
    if (f.outcomeIndex === 1) {
      noShares += dir * size;
      noCost += dir * usdc;
    } else {
      yesShares += dir * size;
      yesCost += dir * usdc;
    }
    const day = dayOf(f.tradedAt);
    const price = pricesByDay.get(day);
    if (price !== undefined) lastPrice = price;
    byDay.set(day, {
      ts: day,
      yesShares: Math.max(0, yesShares),
      noShares: Math.max(0, noShares),
      yesCostUsd: Math.max(0, yesCost),
      noCostUsd: Math.max(0, noCost),
      price: lastPrice
    });
  }

  return [...byDay.values()].sort((a, b) => a.ts.localeCompare(b.ts));
}

// Build the full detail for one market: per-wallet participant rows + the convergence timeline.
// `positions`/`closed`/`fills` should already be filtered to this conditionId.
export function buildCrowdMarketDetail(
  conditionId: string,
  positions: CrowdOpenPosition[],
  closed: CrowdClosedPosition[],
  fills: CrowdTradeFill[],
  lookups: CrowdLookups,
  pricesByDay: Map<string, number>
): CrowdMarketDetail | null {
  const addresses = new Set<string>();
  positions.forEach((p) => addresses.add(p.address));
  closed.forEach((p) => addresses.add(p.address));
  fills.forEach((f) => addresses.add(f.address));
  if (addresses.size === 0) return null;

  const market =
    positions.find((p) => p.market)?.market ??
    closed.find((p) => p.market)?.market ??
    fills.find((f) => f.market)?.market ??
    null;

  // YES current price, best-effort from an open position row (outcome 0 directly, 1 as complement).
  let curPrice: number | null = null;
  for (const p of positions) {
    if (p.outcomeIndex === 0) {
      curPrice = p.curPrice;
      break;
    }
    if (p.outcomeIndex === 1 && curPrice === null) curPrice = 1 - p.curPrice;
  }

  const participants: CrowdParticipant[] = [];
  let yesTraders = 0;
  let noTraders = 0;
  let yesCost = 0;
  let noCost = 0;
  let totalVolumeUsd = 0;

  for (const address of addresses) {
    const myFills = fills
      .filter((f) => f.address === address)
      .sort((a, b) => Date.parse(b.tradedAt) - Date.parse(a.tradedAt));
    myFills.forEach((f) => (totalVolumeUsd += fillUsdc(f)));
    const fillTimes = myFills.map((f) => Date.parse(f.tradedAt)).filter((ms) => Number.isFinite(ms));
    let firstTradedAt = fillTimes.length ? new Date(Math.min(...fillTimes)).toISOString() : null;
    let lastTradedAt = fillTimes.length ? new Date(Math.max(...fillTimes)).toISOString() : null;

    const myOpen = positions.filter((p) => p.address === address && p.size > 0).sort((a, b) => b.size - a.size);
    const myClosed = closed.filter((p) => p.address === address).sort((a, b) => b.size - a.size);

    // Fall back to the position cache's dates when the (capped) fill window has no fills for this
    // market — the common case for held positions opened before the tracked window. closeTime is the
    // closed position's exit, i.e. its last trade.
    if (firstTradedAt === null) firstTradedAt = myOpen[0]?.firstTradedAt ?? myClosed[0]?.firstTradedAt ?? null;
    if (lastTradedAt === null) lastTradedAt = myOpen[0]?.lastTradedAt ?? myClosed[0]?.closeTime ?? null;

    let outcomeIndex: number | null;
    let state: "open" | "closed";
    let size = 0;
    let avgEntry: number | null = null;
    let curMark: number | null = null;
    let value: number | null = null;
    let pnl: number | null = null;
    let pnlPct: number | null = null;
    let costBasis = 0;

    const open = myOpen[0];
    const closedRow = myClosed[0];
    if (open) {
      state = "open";
      outcomeIndex = open.outcomeIndex;
      size = open.size;
      avgEntry = open.avgPrice;
      curMark = open.curPrice;
      value = open.currentValue;
      pnl = open.cashPnl;
      pnlPct = open.avgPrice > 0 ? (open.curPrice - open.avgPrice) / open.avgPrice : null;
      costBasis = openCost(open);
    } else if (closedRow) {
      state = "closed";
      outcomeIndex = closedRow.outcomeIndex;
      size = closedRow.size;
      avgEntry = closedRow.avgPrice;
      pnl = closedRow.realizedPnl;
      const basis = closedRow.avgPrice * closedRow.size;
      pnlPct = basis > 0 ? closedRow.realizedPnl / basis : null;
      costBasis = closedCost(closedRow);
    } else {
      // No cache row (opened/closed outside the tracked position caches) — derive from fills alone.
      const buys = myFills.filter((f) => isBuy(f.side));
      const buySize = buys.reduce((sum, f) => sum + (f.size ?? 0), 0);
      const buyCost = buys.reduce((sum, f) => sum + fillUsdc(f), 0);
      const sellSize = myFills.filter((f) => !isBuy(f.side)).reduce((sum, f) => sum + (f.size ?? 0), 0);
      const net = buySize - sellSize;
      outcomeIndex = myFills[0]?.outcomeIndex ?? null;
      avgEntry = buySize > 0 ? buyCost / buySize : null;
      state = net > 1 ? "open" : "closed";
      size = Math.max(0, net);
      costBasis = avgEntry !== null ? avgEntry * size : 0;
    }

    if (outcomeIndex === 1) {
      noTraders += 1;
      noCost += costBasis;
    } else if (outcomeIndex === 0) {
      yesTraders += 1;
      yesCost += costBasis;
    }

    const crowdFills: CrowdFill[] = myFills.map((f) => ({
      outcomeIndex: f.outcomeIndex,
      side: f.side,
      price: f.price,
      size: f.size,
      usdcSize: f.usdcSize,
      tradedAt: f.tradedAt
    }));

    participants.push({
      address,
      handle: lookups.handleByAddress.get(address) ?? null,
      rank: lookups.rankByAddress.get(address) ?? null,
      skillScore: lookups.skillByAddress.get(address) ?? null,
      outcomeIndex,
      side: sideLabel(outcomeIndex),
      state,
      size,
      avgEntry,
      curPrice: curMark,
      value,
      pnl,
      pnlPct,
      firstTradedAt,
      lastTradedAt,
      fills: crowdFills
    });
  }

  // Open positions first, then best rank (nulls last), then larger stake.
  participants.sort((a, b) => {
    if (a.state !== b.state) return a.state === "open" ? -1 : 1;
    const ra = a.rank ?? Number.POSITIVE_INFINITY;
    const rb = b.rank ?? Number.POSITIVE_INFINITY;
    if (ra !== rb) return ra - rb;
    return b.size - a.size;
  });

  return {
    conditionId,
    market,
    curPrice,
    traderCount: addresses.size,
    yesTraders,
    noTraders,
    totalVolumeUsd,
    netExposureUsd: yesCost - noCost,
    participants,
    timeline: buildCrowdTimeline(fills, pricesByDay)
  };
}
