// Pure helpers for the market price-history cache (see ingest.ts cacheMarketPriceHistory and
// scripts/polymarket.ts getPriceHistory). No I/O here so they stay unit-testable.

const MS_PER_DAY = 86_400_000;

// One raw point from the CLOB /prices-history endpoint: t = unix seconds, p = token price [0,1].
export interface RawHistory {
  t: number;
  p: number;
}

// One cached daily price. ts is a "YYYY-MM-DD" UTC calendar day.
export interface PricePoint {
  ts: string;
  price: number;
}

// What we know about an asset already in the cache, used to decide whether to (re)fetch it.
export interface CacheState {
  maxTs: string | null; // newest cached "YYYY-MM-DD", or null if never cached
  resolved: boolean; // market has resolved → its past is final and complete
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, "YYYY-MM-DD".length);
}

// Collapse raw CLOB history into one price per UTC day (last point of a day wins), keeping only
// days within the last `horizonDays`. nowMs is injectable for deterministic tests.
export function dailyPointsFromHistory(history: RawHistory[], horizonDays: number, nowMs: number): PricePoint[] {
  const cutoffMs = nowMs - horizonDays * MS_PER_DAY;
  const byDay = new Map<string, number>();
  for (const point of history) {
    if (!Number.isFinite(point.t) || !Number.isFinite(point.p)) {
      continue;
    }
    const ms = point.t * 1000;
    if (ms < cutoffMs) {
      continue;
    }
    // History is chronological, so a later point for the same day overwrites the earlier one.
    byDay.set(utcDay(ms), point.p);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([ts, price]) => ({ ts, price }));
}

// Decide which assets to fetch this run, bounded by `cap`. A resolved market that's already
// cached is skipped — its past is immutable and complete, the amortization win. Everything else
// (never-seen, or unresolved with a stale tail) is (re)fetched; the endpoint returns the full
// series cheaply at daily fidelity, so we just re-upsert. Returns the fetch list plus how many
// eligible assets were deferred past the cap (to fetch on a later run).
export function planPriceFetches(
  neededAssets: string[],
  state: Map<string, CacheState>,
  todayUtc: string,
  cap: number
): { fetch: string[]; deferred: number } {
  const fetch: string[] = [];
  let deferred = 0;
  for (const asset of new Set(neededAssets)) {
    const known = state.get(asset);
    if (known && known.resolved && known.maxTs !== null) {
      continue; // immutable and complete
    }
    if (known && known.maxTs === todayUtc && !known.resolved) {
      continue; // already fresh through today
    }
    if (fetch.length >= cap) {
      deferred += 1;
      continue;
    }
    fetch.push(asset);
  }
  return { fetch, deferred };
}
