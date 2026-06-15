import type { EventCandidate, MarketMeta, PricePoint } from "./marketAnalytics";
import { parseEventCandidates, parseJsonArray } from "./marketAnalytics";

// Server-side, on-demand enrichment from Polymarket's public APIs, used as a *fallback* by
// getMarketAnalytics. The batch pipeline only caches the top-N listed markets (Gamma) and the outcome
// tokens leaderboard wallets hold (CLOB), so a market a user opens from Convergence/a wallet page that
// isn't in those sets would otherwise render blank (no liquidity/volume/resolution, no price chart).
// Rather than wait for an ingest cycle that may never cover it, we read the canonical data directly:
// Gamma `/markets?condition_ids=` for the snapshot, CLOB `/prices-history` for the YES daily series.
//
// This is the one place the web app talks to Polymarket. Calls are cached in Next's Data Cache for
// REVALIDATE seconds (keyed by URL), so repeated views and concurrent renders share one fetch, and the
// page stays fast after the first hit. No write-back to Supabase — the web app holds only the anon key.

const GAMMA_API_BASE = "https://gamma-api.polymarket.com";
const CLOB_API_BASE = "https://clob.polymarket.com";
const REVALIDATE_SECONDS = 600; // 10 min

function toNumber(value: unknown): number {
  const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(n) ? n : 0;
}

function toOptionalNumber(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(n) ? n : null;
}

function toOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

// Sports/event markets carry no tags on the Gamma market row; derive a coarse category from the
// league prefix in the slug so the header chip isn't blank for the common case.
const SLUG_CATEGORY: ReadonlyArray<readonly [string, string]> = [
  ["nhl-", "NHL"],
  ["nba-", "NBA"],
  ["nfl-", "NFL"],
  ["mlb-", "MLB"],
  ["ncaa", "College Sports"],
  ["ucl-", "Soccer"],
  ["epl-", "Soccer"],
  ["lal-", "Soccer"],
  ["ufc-", "UFC"],
  ["atp-", "Tennis"]
];

function categoryFromSlug(slug: string | null): string | null {
  if (!slug) return null;
  const lc = slug.toLowerCase();
  for (const [prefix, label] of SLUG_CATEGORY) {
    if (lc.startsWith(prefix)) return label;
  }
  return null;
}

export interface LiveMarket {
  meta: MarketMeta;
  yesTokenId: string | null;
  noTokenId: string | null;
  // Set when this market is one leg of a grouped event (e.g. "Spain" in "World Cup Winner"). Grouped
  // legs are themselves Yes/No markets, so topOutcome can't distinguish them — the caller uses this to
  // decide whether to fetch the sibling candidate lines.
  groupItemTitle: string | null;
}

// Pure mapping of one Gamma `/markets` row into LiveMarket. Exported (and unit-tested) separately from
// the fetch so the defensive field handling — JSON-string arrays, fallback keys, event-level
// image/slug, favored-outcome pick — is covered without network I/O. Returns null for an empty row.
export function mapLiveMarketRow(row: Record<string, unknown> | null): LiveMarket | null {
  if (!row) return null;
  const outcomes = parseJsonArray(row.outcomes).map(String);
  const outcomePrices = parseJsonArray(row.outcomePrices)
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v));
  const tokenIds = parseJsonArray(row.clobTokenIds).map(String);
  const events = parseJsonArray(row.events).filter((e): e is Record<string, unknown> => typeof e === "object" && e !== null);
  const firstEvent = events[0] ?? null;

  const slug = toOptionalString(row.slug) ?? (firstEvent ? toOptionalString(firstEvent.slug) : null);
  const image =
    toOptionalString(row.image) ??
    toOptionalString(row.icon) ??
    (firstEvent ? toOptionalString(firstEvent.image) : null);
  const category =
    (firstEvent ? toOptionalString(firstEvent.category) : null) ?? categoryFromSlug(slug);

  // Favored outcome: the leg with the highest implied probability.
  let topOutcome: string | null = null;
  if (outcomePrices.length > 0 && outcomes.length > 0) {
    let best = 0;
    for (let i = 1; i < outcomePrices.length; i += 1) {
      if ((outcomePrices[i] ?? 0) > (outcomePrices[best] ?? 0)) best = i;
    }
    topOutcome = outcomes[best] ?? null;
  }

  const meta: MarketMeta = {
    question: toOptionalString(row.question) ?? "Untitled market",
    slug,
    category,
    image,
    endDate: toOptionalString(row.endDate) ?? toOptionalString(row.endDateIso),
    liquidityUsd: toNumber(row.liquidity ?? row.liquidityNum ?? row.liquidityClob),
    volumeUsd: toNumber(row.volume ?? row.volumeNum ?? row.volumeClob),
    volume24hrUsd: toNumber(row.volume24hr ?? row.volume24hrClob),
    volume1wkUsd: toNumber(row.volume1wk ?? row.volume1wkClob),
    spread: toOptionalNumber(row.spread),
    lastTradePrice: toOptionalNumber(row.lastTradePrice),
    topOutcome,
    oneDayPriceChange: toOptionalNumber(row.oneDayPriceChange),
    outcomes: outcomes.length > 0 ? outcomes : null,
    outcomePrices: outcomePrices.length > 0 ? outcomePrices : null,
    active: row.active === true,
    closed: row.closed === true
  };

  return {
    meta,
    yesTokenId: tokenIds[0] ?? null,
    noTokenId: tokenIds[1] ?? null,
    groupItemTitle: toOptionalString(row.groupItemTitle)
  };
}

type RawPoint = { t?: unknown; p?: unknown };

// Pure: merge several raw CLOB series of differing fidelity into one intraday point list, taking the
// FINEST series available in each time region — so recent moves are captured at high resolution while
// older history stays at daily resolution (Polymarket caps fine-fidelity history to ~1000 points, so a
// finer series only reaches back so far). `series` must be ordered coarse→fine (e.g. [daily, hourly,
// minute]); each finer series owns its window and the coarser ones only fill the gap before it begins.
// `invert` returns the YES series from a NO token (1 − price).
export function mergeSeries(series: RawPoint[][], invert = false): PricePoint[] {
  const clean = series.map((s) =>
    s
      .map((pt) => ({ t: Number(pt?.t), p: Number(pt?.p) }))
      .filter((pt) => Number.isFinite(pt.t) && Number.isFinite(pt.p))
      .sort((a, b) => a.t - b.t)
  );
  const startOf = (s: { t: number }[]): number => (s.length > 0 ? s[0]!.t : Infinity);

  const out: { t: number; p: number }[] = [];
  for (let i = 0; i < clean.length; i += 1) {
    // Bound by the earliest start across ALL finer series, not just the next one — otherwise an empty
    // middle series (start = Infinity) would leave this series unbounded and overlap a finer series.
    let upper = Infinity;
    for (let j = i + 1; j < clean.length; j += 1) upper = Math.min(upper, startOf(clean[j]!));
    for (const pt of clean[i]!) if (pt.t < upper) out.push(pt);
  }
  out.sort((a, b) => a.t - b.t);
  return out.map((pt) => ({ ts: new Date(pt.t * 1000).toISOString(), price: invert ? 1 - pt.p : pt.p }));
}

async function fetchRawHistory(tokenId: string, fidelityMin: number): Promise<RawPoint[]> {
  try {
    const res = await fetch(
      `${CLOB_API_BASE}/prices-history?market=${encodeURIComponent(tokenId)}&interval=max&fidelity=${fidelityMin}`,
      { next: { revalidate: REVALIDATE_SECONDS } }
    );
    if (!res.ok) return [];
    const payload = await res.json();
    return payload && typeof payload === "object" && Array.isArray((payload as { history?: unknown }).history)
      ? ((payload as { history: unknown[] }).history as RawPoint[])
      : [];
  } catch {
    return [];
  }
}

// Intraday YES price points for one outcome token: full-lifetime daily + recent hourly + recent minute
// resolution, merged finest-first into one continuous line. `invert` returns YES from a NO token. The
// three fetches run in parallel and share Next's Data Cache. Returns [] on failure.
export async function fetchLivePriceSeries(tokenId: string, invert = false): Promise<PricePoint[]> {
  const [daily, hourly, minute] = await Promise.all([
    fetchRawHistory(tokenId, 1440),
    fetchRawHistory(tokenId, 60),
    fetchRawHistory(tokenId, 1)
  ]);
  return mergeSeries([daily, hourly, minute], invert);
}

async function fetchGammaRow(query: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`${GAMMA_API_BASE}/markets?${query}`, { next: { revalidate: REVALIDATE_SECONDS } });
    if (!res.ok) return null;
    const payload = await res.json();
    return (Array.isArray(payload) ? payload[0] : null) as Record<string, unknown> | null;
  } catch {
    return null;
  }
}

// Fetch + map a single market by condition_id from Gamma. Returns null on any miss (unknown market,
// network error, malformed payload) so the caller degrades gracefully. Gamma's `condition_ids` filter
// excludes resolved markets by default, so when the plain query is empty we retry with `closed=true`
// to cover markets that have already settled.
export async function fetchLiveMarket(conditionId: string): Promise<LiveMarket | null> {
  const id = encodeURIComponent(conditionId);
  const row = (await fetchGammaRow(`condition_ids=${id}`)) ?? (await fetchGammaRow(`condition_ids=${id}&closed=true`));
  return mapLiveMarketRow(row);
}

// For a market that belongs to a multi-candidate event (e.g. one team in "World Cup Winner"), return
// the event's candidates ranked favored-first. Returns null for a plain binary market (no
// groupItemTitle) or on any miss. One market lookup (shares Next's cache with fetchLiveMarket) to find
// the event slug + confirm it's grouped, then one event lookup for the sibling candidates.
export async function fetchEventCandidates(conditionId: string): Promise<EventCandidate[] | null> {
  const id = encodeURIComponent(conditionId);
  const market = (await fetchGammaRow(`condition_ids=${id}`)) ?? (await fetchGammaRow(`condition_ids=${id}&closed=true`));
  if (!market) return null;
  const grouped = toOptionalString(market.groupItemTitle);
  const events = parseJsonArray(market.events).filter((e): e is Record<string, unknown> => typeof e === "object" && e !== null);
  const eventSlug = events[0] ? toOptionalString(events[0].slug) : null;
  if (!grouped || !eventSlug) return null; // plain binary market

  let payload: unknown;
  try {
    const res = await fetch(`${GAMMA_API_BASE}/events?slug=${encodeURIComponent(eventSlug)}`, {
      next: { revalidate: REVALIDATE_SECONDS }
    });
    if (!res.ok) return null;
    payload = await res.json();
  } catch {
    return null;
  }
  const event = (Array.isArray(payload) ? payload[0] : null) as Record<string, unknown> | null;
  if (!event) return null;
  const candidates = parseEventCandidates(parseJsonArray(event.markets) as Parameters<typeof parseEventCandidates>[0]);
  return candidates.length > 0 ? candidates : null;
}
