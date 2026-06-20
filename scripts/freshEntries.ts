import { CONFIG } from "./config.js";
import type { TradeActivity } from "./polymarket.js";

// Signal #2 — "Fresh Entries". The flow counterpart to Convergence: instead of who is *holding* a
// market (stock, contaminated by bag-holders), this surfaces who just *opened a brand-new position*
// in it (flow). A wallet is a "new entrant" to a market when the EARLIEST fill for that market in its
// /activity is a BUY inside the recency window — i.e. no prior fill in that market, so they weren't in
// it before. Pure + tested; the ingest wires it into the feed run (which already holds /activity).

// One wallet's brand-new entry into one market, derived from its /activity.
export interface NewEntry {
  address: string;
  conditionId: string;
  market: string;
  outcomeIndex: number; // the side they entered on (0 = YES, 1 = NO)
  buyUsd: number;       // total in-window BUY USDC for this market (capital committed entering)
  tradedAt: string;     // most recent in-window BUY fill in this market (ISO)
}

// The ranked per-market aggregate written to fresh_entries_cache.
export interface FreshEntrySummary {
  conditionId: string;
  market: string | null;
  entrantCount: number;  // distinct wallets newly entering (headline)
  skillWeight: number;   // sum of entrants' skill scores (sort tiebreak)
  topSkill: number | null;
  yesEntrants: number;
  noEntrants: number;
  committedUsd: number;
  topRank: number | null;
  lastEntryAt: string | null;
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

interface MarketFills {
  market: string;
  earliestMs: number;
  earliestSide: TradeActivity["side"];
  earliestOutcome: number;
  buyUsd: number;       // Σ usdcSize of in-window BUY fills
  latestBuyMs: number;  // most recent in-window BUY fill
}

// Find the markets a wallet newly entered in-window. For each conditionId we take the EARLIEST fill in
// the fetched /activity: if it's a BUY at/after cutoffMs, the wallet had no prior activity in that
// market, so this is a fresh entry (not averaging down an existing bag — that fill would be older).
// `activity` is already in hand during the feed run, so this adds no Polymarket API calls. Timestamps
// are unix seconds.
// ponytail: "new" = no earlier fill for this market in the FETCHED activity. A position older than the
// activity-fetch depth could misread as new; upgrade path = cross-check wallet_positions if it bites.
export function newEntriesFromActivity(
  activity: TradeActivity[],
  address: string,
  cutoffMs: number
): NewEntry[] {
  const normalized = address.toLowerCase();
  const byMarket = new Map<string, MarketFills>();

  for (const trade of activity) {
    const ms = trade.timestamp * CONFIG.MS_PER_SECOND;
    if (!Number.isFinite(ms)) continue;
    let m = byMarket.get(trade.conditionId);
    if (!m) {
      m = {
        market: trade.market,
        earliestMs: ms,
        earliestSide: trade.side,
        earliestOutcome: trade.outcomeIndex,
        buyUsd: 0,
        latestBuyMs: -Infinity
      };
      byMarket.set(trade.conditionId, m);
    } else if (ms < m.earliestMs) {
      m.earliestMs = ms;
      m.earliestSide = trade.side;
      m.earliestOutcome = trade.outcomeIndex;
    }
    if (trade.side === "BUY" && ms >= cutoffMs) {
      m.buyUsd += trade.usdcSize;
      m.latestBuyMs = Math.max(m.latestBuyMs, ms);
    }
  }

  const entries: NewEntry[] = [];
  for (const [conditionId, m] of byMarket) {
    // New entry only when the very first fill in this market is a BUY inside the window.
    if (m.earliestSide !== "BUY" || m.earliestMs < cutoffMs) continue;
    entries.push({
      address: normalized,
      conditionId,
      market: m.market,
      outcomeIndex: m.earliestOutcome,
      buyUsd: round(m.buyUsd, 2),
      tradedAt: new Date(Number.isFinite(m.latestBuyMs) ? m.latestBuyMs : m.earliestMs).toISOString()
    });
  }
  return entries;
}

interface Bucket {
  market: string | null;
  addresses: Set<string>;
  skillWeight: number;
  topSkill: number | null;
  yesEntrants: number;
  noEntrants: number;
  committedUsd: number;
  topRank: number | null;
  lastMs: number;
}

// Aggregate per-wallet new entries into the ranked per-market list. One wallet counts once per market
// (its first NewEntry for that conditionId wins the side/skill/rank). Ordered by distinct entrant count,
// then summed skill weight — the flow analog of Convergence's trader-count-then-capital ordering.
export function summarizeFreshEntries(
  entries: NewEntry[],
  skillByAddress: Map<string, number>,
  rankByAddress: Map<string, number>,
  limit = 40
): FreshEntrySummary[] {
  const buckets = new Map<string, Bucket>();

  for (const e of entries) {
    let b = buckets.get(e.conditionId);
    if (!b) {
      b = {
        market: e.market || null,
        addresses: new Set(),
        skillWeight: 0,
        topSkill: null,
        yesEntrants: 0,
        noEntrants: 0,
        committedUsd: 0,
        topRank: null,
        lastMs: -Infinity
      };
      buckets.set(e.conditionId, b);
    }
    if (!b.market && e.market) b.market = e.market;
    b.committedUsd += e.buyUsd;
    const ms = Date.parse(e.tradedAt);
    if (Number.isFinite(ms) && ms > b.lastMs) b.lastMs = ms;

    // One wallet counts once per market (a wallet shouldn't produce two NewEntry rows for the same
    // conditionId, but guard anyway so headcount/skill aren't double-counted).
    if (b.addresses.has(e.address)) continue;
    b.addresses.add(e.address);
    if (e.outcomeIndex === 1) b.noEntrants += 1;
    else b.yesEntrants += 1;
    const skill = skillByAddress.get(e.address) ?? 0;
    b.skillWeight += skill;
    if (b.topSkill === null || skill > b.topSkill) b.topSkill = skill;
    const rank = rankByAddress.get(e.address);
    if (rank !== undefined && (b.topRank === null || rank < b.topRank)) b.topRank = rank;
  }

  const summaries: FreshEntrySummary[] = [];
  for (const [conditionId, b] of buckets) {
    summaries.push({
      conditionId,
      market: b.market,
      entrantCount: b.addresses.size,
      skillWeight: round(b.skillWeight, 4),
      topSkill: b.topSkill,
      yesEntrants: b.yesEntrants,
      noEntrants: b.noEntrants,
      committedUsd: round(b.committedUsd, 2),
      topRank: b.topRank,
      lastEntryAt: Number.isFinite(b.lastMs) ? new Date(b.lastMs).toISOString() : null
    });
  }

  return summaries
    .sort((a, c) => c.entrantCount - a.entrantCount || c.skillWeight - a.skillWeight)
    .slice(0, limit);
}
