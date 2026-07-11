import { CONFIG } from "./config.js";
import type { RawHistory } from "./priceHistory.js";

export interface ClosedPosition {
  proxyWallet: string;
  asset: string;
  conditionId: string;
  market: string;
  outcomeIndex: number;
  size: number;
  avgPrice: number;
  realizedPnl: number;
  closeTime: string;
  // Resolved outcome of THIS position's token: 1 if it settled to $1, 0 if to $0, null if the
  // market hasn't resolved (or we can't tell). Drives the forecasting-edge metric (entry price vs.
  // eventual outcome). Positions held to resolution always have it (curPrice is 0/1); positions
  // sold before resolution only have it if the API payload carries a settled price.
  outcome: number | null;
  // Human outcome label ("Over"/"Under"/team/"Yes"/"No") and event slug from the API, for display.
  outcomeLabel: string | null;
  eventSlug: string | null;
}

export interface Position {
  proxyWallet: string;
  asset: string;
  conditionId: string;
  market: string;
  outcomeIndex: number;
  size: number;
  avgPrice: number;
  initialValue: number;
  currentValue: number;
  cashPnl: number;
  realizedPnl: number;
  curPrice: number;
  endDate: string | null;
  // True once the market has resolved (the position is settleable). Distinguishes resolved-but-
  // unredeemed positions (which carry a realized win/loss) from genuinely-open ones.
  redeemable: boolean;
  // Human outcome label ("Over"/"Under"/team/"Yes"/"No") and event slug from the API, for display.
  outcomeLabel: string | null;
  eventSlug: string | null;
}

export interface TradeActivity {
  proxyWallet: string;
  timestamp: number;
  conditionId: string;
  size: number;
  usdcSize: number;
  price: number;
  side: "BUY" | "SELL" | "UNKNOWN";
  asset: string;
  outcomeIndex: number;
  market: string;
  // Human outcome label ("Over"/"Under"/team/"Yes"/"No") and event slug from the API — index alone
  // can't say whether an O/U bet was Over or Under, and the market title omits the event.
  outcomeLabel: string | null;
  eventSlug: string | null;
  transactionHash: string | null;
}

export interface LeaderboardEntry {
  rank: string;
  proxyWallet: string;
  userName: string | null;
  vol: number;
  pnl: number;
}

// A Polymarket *event* — the grouping shown as one row on the Markets page. Sourced from the Gamma
// API's /events endpoint (gamma-api.polymarket.com), which rolls up the individual outcome markets
// (e.g. one per team in "World Cup Winner") into a single event with aggregate liquidity/volume.
// `id` is the Gamma event id. Multi-outcome events have no single price, so `currentPrice`/
// `topOutcome` describe the leading (most-likely) outcome among the event's markets; `spread` is
// that leading market's bid/ask spread (the volatility proxy). null = not derivable.
export interface EventSummary {
  id: string;
  conditionId: string | null;
  yesTokenId: string | null;
  question: string;
  slug: string;
  category: string | null;
  liquidityUsd: number;
  volumeUsd: number;
  volume24hrUsd: number;
  volume1wkUsd: number;
  currentPrice: number | null;
  topOutcome: string | null;
  spread: number | null;
  oneDayPriceChange: number | null;
  endDate: string | null;
  gameStartTime: string | null;
  image: string | null;
  active: boolean;
  closed: boolean;
}

type JsonRecord = Record<string, unknown>;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type RateLane = keyof typeof CONFIG.REQUEST_INTERVAL_MS;

// One serial rate gate per rate-limit lane. Polymarket budgets /closed-positions & /positions
// (150 req/10s) separately from the general endpoints (>=200 req/10s), so spacing each lane on
// its own gate lets the cheap activity/leaderboard calls run in parallel with the expensive
// closed-position pagination instead of all sharing a single queue. Within a lane, requests
// still start at least REQUEST_INTERVAL_MS apart so concurrent wallets can't burst past the cap.
const requestGates: Record<RateLane, Promise<void>> = {
  restricted: Promise.resolve(),
  general: Promise.resolve(),
  clob: Promise.resolve()
};

function throttle(lane: RateLane): Promise<void> {
  const next = requestGates[lane].then(() => sleep(CONFIG.REQUEST_INTERVAL_MS[lane]));
  requestGates[lane] = next;
  return next;
}

// Lightweight ingest profiling: lets main() compare actual processing time against the gate's
// theoretical floor (requests * interval) to tell whether we're rate-gate-bound or starving it.
export const apiStats = {
  requests: { restricted: 0, general: 0, clob: 0 } as Record<RateLane, number>,
  retries: 0
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function readString(record: JsonRecord, keys: readonly string[], fallback = ""): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") {
      return value;
    }
    if (typeof value === "number") {
      return String(value);
    }
  }

  return fallback;
}

function readNumber(record: JsonRecord, keys: readonly string[], fallback = 0): number {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  return fallback;
}

// Like readNumber but returns null (not a fallback) when no key is present, so callers can tell
// "field absent" from "field is 0" — needed for resolution prices, where 0 is a real outcome.
function readOptionalNumber(record: JsonRecord, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  return null;
}

// Resolved markets settle at exactly $1 or $0. Snap a (near-)settled price to a 0/1 outcome; return
// null for anything in between, which means the market is still trading and has no outcome yet. The
// epsilon is deliberately tiny so a near-certain-but-unresolved price (e.g. 0.99) is NOT mistaken
// for a resolution.
const RESOLUTION_EPSILON = 0.001;
function outcomeFromResolvedPrice(price: number | null): number | null {
  if (price === null) {
    return null;
  }
  if (price >= 1 - RESOLUTION_EPSILON) {
    return 1;
  }
  if (price <= RESOLUTION_EPSILON) {
    return 0;
  }
  return null;
}

function readSide(record: JsonRecord): "BUY" | "SELL" | "UNKNOWN" {
  const side = readString(record, ["side", "action", "type"]).toUpperCase();
  return side === "BUY" || side === "SELL" ? side : "UNKNOWN";
}

function timestampToIso(timestamp: number | string): string {
  const parsed = typeof timestamp === "number" ? timestamp : Number(timestamp);
  if (!Number.isFinite(parsed)) {
    return new Date(0).toISOString();
  }

  const millis = parsed > CONFIG.SECONDS_PER_DAY * CONFIG.MS_PER_SECOND * CONFIG.SECONDS_PER_DAY
    ? parsed
    : parsed * CONFIG.MS_PER_SECOND;

  return new Date(millis).toISOString();
}

async function fetchJson(
  path: string,
  params: URLSearchParams = new URLSearchParams(),
  lane: RateLane = "general",
  // Defaults to the Data API host; the Gamma markets calls pass CONFIG.GAMMA_API_BASE so they can
  // reuse this same throttle/retry/stats path against a different host.
  base: string = CONFIG.POLYMARKET_API_BASE
): Promise<unknown> {
  const url = new URL(path, base);
  params.forEach((value, key) => url.searchParams.set(key, value));

  let lastError: Error | null = null;
  let retryAfterMs = 0;
  for (let attempt = 0; attempt <= CONFIG.API_RETRIES; attempt += 1) {
    try {
      await throttle(lane);
      apiStats.requests[lane] += 1;
      const response = await fetch(url, {
        headers: {
          accept: "application/json",
          "user-agent": "edgeboard-ingest/1.0"
        }
      });

      if (response.ok) {
        return await response.json();
      }

      lastError = new Error(`Polymarket ${response.status} ${response.statusText} for ${url.toString()}`);
      const retryAfter = Number(response.headers.get("retry-after"));
      retryAfterMs = Number.isFinite(retryAfter) ? retryAfter * CONFIG.MS_PER_SECOND : 0;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      retryAfterMs = 0;
    }

    if (attempt < CONFIG.API_RETRIES) {
      apiStats.retries += 1;
      await sleep(Math.max(retryAfterMs, CONFIG.RETRY_BASE_DELAY_MS * 2 ** attempt));
    }
  }

  throw lastError ?? new Error(`Polymarket request failed for ${url.toString()}`);
}

export function mapClosedPosition(record: JsonRecord): ClosedPosition {
  const timestamp = record.closeTime ?? record.timestamp ?? record.resolutionTime ?? record.endDate ?? 0;
  const size = readNumber(record, ["size", "totalBought", "tokens"]);
  const avgPrice = readNumber(record, ["avgPrice", "averagePrice", "price"]);
  // Sold positions only expose an outcome if the payload carries a settled price; absent that
  // (or if the market is still trading), this is null and the position is excluded from edge.
  const outcome = outcomeFromResolvedPrice(readOptionalNumber(record, ["curPrice", "outcome", "payout", "resolvedPrice"]));
  // Polymarket reports realizedPnl=0 for a position held to resolution but not yet REDEEMED — the bet
  // settled (curPrice 0/1) but the winnings sit unclaimed. Recording that as $0 understated win rate
  // and showed a blank P/L in trade history. When the outcome is known and the reported P/L is 0, use
  // the settlement value size·(outcome−avgPrice) (the true realized result). A partially-sold position
  // reports a non-zero P/L, so this only corrects the fully-held-to-resolution case.
  const reportedPnl = readNumber(record, ["realizedPnl", "realizedPnL", "pnl", "cashPnl"]);
  const realizedPnl = reportedPnl === 0 && outcome !== null ? size * (outcome - avgPrice) : reportedPnl;
  return {
    proxyWallet: readString(record, ["proxyWallet", "user", "wallet"]).toLowerCase(),
    asset: readString(record, ["asset", "tokenId"]),
    conditionId: readString(record, ["conditionId", "market", "marketId"]),
    market: readString(record, ["market", "title", "question"]),
    outcomeIndex: readNumber(record, ["outcomeIndex"]),
    size,
    avgPrice,
    realizedPnl,
    closeTime: timestampToIso(typeof timestamp === "string" || typeof timestamp === "number" ? timestamp : 0),
    outcome,
    outcomeLabel: readString(record, ["outcome"]) || null,
    eventSlug: readString(record, ["eventSlug"]) || null
  };
}

export function mapPosition(record: JsonRecord): Position {
  return {
    proxyWallet: readString(record, ["proxyWallet", "user", "wallet"]).toLowerCase(),
    asset: readString(record, ["asset", "tokenId"]),
    conditionId: readString(record, ["conditionId", "market", "marketId"]),
    market: readString(record, ["market", "title", "question"]),
    outcomeIndex: readNumber(record, ["outcomeIndex"]),
    size: readNumber(record, ["size", "totalBought", "tokens"]),
    avgPrice: readNumber(record, ["avgPrice", "averagePrice", "price"]),
    initialValue: readNumber(record, ["initialValue"]),
    currentValue: readNumber(record, ["currentValue"]),
    cashPnl: readNumber(record, ["cashPnl"]),
    realizedPnl: readNumber(record, ["realizedPnl", "realizedPnL"]),
    curPrice: readNumber(record, ["curPrice", "price"]),
    endDate: readString(record, ["endDate"]) || null,
    redeemable: record.redeemable === true,
    outcomeLabel: readString(record, ["outcome"]) || null,
    eventSlug: readString(record, ["eventSlug"]) || null
  };
}

// endDate on a position is a calendar date string ("2026-05-10"), not a numeric timestamp, so it
// needs Date.parse (timestampToIso would Number() it to NaN and fall back to the epoch).
function isoFromEndDate(endDate: string | null): string {
  const ms = endDate ? Date.parse(endDate) : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : new Date(0).toISOString();
}

// Convert resolved-but-unredeemed positions into ClosedPosition records so they can be scored
// alongside actually-closed positions. `/closed-positions` only contains positions the trader sold
// or redeemed — i.e. winners — so without this the metric set is winner-biased (abandoned losers
// that resolved to $0 never appear). cashPnl already equals currentValue - initialValue, giving the
// realized win/loss; endDate is the resolution time. Genuinely-open (redeemable=false) positions are
// dropped: they have no realized outcome yet.
export function resolvedToClosed(positions: Position[]): ClosedPosition[] {
  return positions
    .filter((position) => position.redeemable)
    .map((position) => ({
      proxyWallet: position.proxyWallet,
      asset: position.asset,
      conditionId: position.conditionId,
      market: position.market,
      outcomeIndex: position.outcomeIndex,
      size: position.size,
      avgPrice: position.avgPrice,
      realizedPnl: position.cashPnl,
      closeTime: isoFromEndDate(position.endDate),
      // Held to resolution and redeemable, so curPrice is the settled price (0 or 1) = the outcome.
      outcome: outcomeFromResolvedPrice(position.curPrice),
      outcomeLabel: position.outcomeLabel,
      eventSlug: position.eventSlug
    }));
}

// Current unrealized PnL across genuinely-open positions (redeemable === false). Resolved-but-
// unredeemed positions are excluded here — their realized win/loss already enters the metric set via
// resolvedToClosed. currentValue - initialValue is unrealized-only: it marks the *remaining* held
// shares to market against their cost basis, and any partially-sold portion already appears in
// /closed-positions, so this never double-counts realized PnL.
export function openUnrealizedPnl(positions: Position[]): number {
  return positions
    .filter((position) => !position.redeemable)
    .reduce((sum, position) => sum + (position.currentValue - position.initialValue), 0);
}

export function mapActivity(record: JsonRecord): TradeActivity {
  const size = readNumber(record, ["size", "tokens"]);
  const price = readNumber(record, ["price", "avgPrice"]);
  return {
    proxyWallet: readString(record, ["proxyWallet", "user", "wallet"]).toLowerCase(),
    timestamp: readNumber(record, ["timestamp", "createdAt"]),
    conditionId: readString(record, ["conditionId", "market", "marketId"]),
    size,
    usdcSize: readNumber(record, ["usdcSize", "cash"], size * price),
    price,
    side: readSide(record),
    asset: readString(record, ["asset", "tokenId"]),
    outcomeIndex: readNumber(record, ["outcomeIndex"]),
    market: readString(record, ["market", "title", "question"]),
    outcomeLabel: readString(record, ["outcome"]) || null,
    eventSlug: readString(record, ["eventSlug"]) || null,
    transactionHash: readString(record, ["transactionHash", "txHash"]) || null
  };
}

// Flatten a Data API /holders response — an array of { token, holders: [{ proxyWallet, ... }] } — into
// a deduped, lowercased list of holder addresses. Defensive against the field-name drift the other
// mappers guard for. Exported for unit testing (the response shape is the only non-trivial bit).
export function parseHoldersResponse(response: unknown): string[] {
  const out = new Set<string>();
  for (const meta of asArray(response)) {
    const holders = Array.isArray(meta.holders) ? meta.holders : [];
    for (const holder of holders) {
      if (!isRecord(holder)) continue;
      const address = readString(holder, ["proxyWallet", "user", "wallet", "address"]).toLowerCase();
      if (address) out.add(address);
    }
  }
  return [...out];
}

export function mapLeaderboard(record: JsonRecord): LeaderboardEntry {
  return {
    rank: readString(record, ["rank"]),
    proxyWallet: readString(record, ["proxyWallet", "user", "wallet"]).toLowerCase(),
    userName: readString(record, ["userName", "name", "pseudonym"]) || null,
    vol: readNumber(record, ["vol", "volume"]),
    pnl: readNumber(record, ["pnl", "profit"])
  };
}

// Gamma returns `outcomes`/`outcomePrices` either as a real JSON array or — more commonly — as a
// JSON-encoded string (e.g. "[\"Yes\",\"No\"]"). Parse both shapes into a plain array; anything
// missing or malformed yields []. Mapping the string case wrong would leave every market with empty
// outcomes, so this is covered by markets.test.ts.
function parseJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

// Authoritative binary resolution from a Gamma market record. A market is settled when the UMA oracle
// has resolved it (umaResolutionStatus === "resolved", or the market is closed); outcomePrices is then
// the settled [YES, NO] pair ("1"/"0"), indexed the same as clobTokenIds — index 0 is YES. Returns 1/0,
// or null if the market isn't resolved yet or has no decisive settlement. This is the RIGHT resolution
// source for the forward test: a resolved market's last CLOB *trade* often sits mid-range (0.82, 0.08)
// and never reaches {0,1}, so inferring resolution from price history silently drops contested markets.
export function resolvedOutcomeFromMarket(market: JsonRecord): number | null {
  const settled = market.umaResolutionStatus === "resolved" || market.closed === true;
  if (!settled) return null;
  const prices = parseJsonArray(market.outcomePrices).map((entry) => Number(entry)).filter((value) => Number.isFinite(value));
  const yes = prices[0];
  if (yes === undefined) return null;
  if (yes >= 0.97) return 1;
  if (yes <= 0.03) return 0;
  return null; // settled but not decisive (shouldn't happen for a binary market) — leave pending
}

interface LeadingOutcome {
  price: number | null;
  label: string | null;
  spread: number | null;
  // Change in the leading outcome's price over the last 24h, as a 0–1 fraction (e.g. 0.03 = +3pts).
  oneDayPriceChange: number | null;
  // The leading market's binary condition id — the key the wallet position/trade caches and the
  // Market Analytics page join on. Null when the event exposes no usable conditionId.
  conditionId: string | null;
  // The leading market's scheduled real-world start time (sports/esports only — Gamma has no
  // equivalent for other categories). Powers the Trending panel's "starts soon" signal.
  gameStartTime: string | null;
  // The leading market's YES outcome-token (CLOB asset) id — outcome index 0. Seeds the per-market
  // price-history cache so the analytics page has a price series even with no leaderboard holders.
  yesTokenId: string | null;
}

// Per-market outcome extraction, shared by pickLeadingOutcome (which keeps only the single best
// candidate) and mapEventCandidates (which keeps all of them). null yesPrice means the market has no
// usable price data (caller decides whether to skip it).
function extractOutcome(market: JsonRecord): LeadingOutcome & { yesPrice: number | null } {
  const prices = parseJsonArray(market.outcomePrices)
    .map((entry) => Number(entry))
    .filter((value) => Number.isFinite(value));
  // Implied Yes probability from outcomePrices[0]; fall back to the last trade price.
  const yesPrice = prices.length > 0 ? prices[0] ?? null : readOptionalNumber(market, ["lastTradePrice"]);
  if (yesPrice === null) {
    return { price: null, label: null, spread: null, oneDayPriceChange: null, conditionId: null, gameStartTime: null, yesTokenId: null, yesPrice: null };
  }

  const outcomes = parseJsonArray(market.outcomes).map((entry) => String(entry));
  const groupTitle = readString(market, ["groupItemTitle"]);
  const change = readOptionalNumber(market, ["oneDayPriceChange"]);
  const spread = readOptionalNumber(market, ["spread"]);
  const conditionId = readString(market, ["conditionId", "condition_id", "id"]) || null;
  // Scheduled real-world start time — set on sports/esports games, absent everywhere else.
  const gameStartTime = readString(market, ["gameStartTime"]) || null;
  // clobTokenIds is a JSON-string array [yesToken, noToken]; index 0 is the YES outcome token.
  const yesTokenId = parseJsonArray(market.clobTokenIds).map((entry) => String(entry))[0] || null;

  if (groupTitle) {
    // Candidate within a multi-outcome event: the candidate *is* the Yes side.
    return { price: yesPrice, label: groupTitle, spread, oneDayPriceChange: change, conditionId, gameStartTime, yesTokenId, yesPrice };
  }
  // Plain binary market: surface whichever leg (Yes/No) is priced higher.
  const noPrice = prices.length > 1 ? prices[1] ?? null : 1 - yesPrice;
  const noLeads = noPrice !== null && noPrice > yesPrice;
  return {
    price: noLeads ? noPrice : yesPrice,
    label: noLeads ? outcomes[1] || "No" : outcomes[0] || "Yes",
    spread,
    // oneDayPriceChange tracks the Yes leg; the No leg moves the opposite way.
    oneDayPriceChange: change === null ? null : noLeads ? -change : change,
    conditionId,
    gameStartTime,
    yesTokenId,
    yesPrice
  };
}

// An event has many outcome markets (e.g. one per team). There's no single event price, so we
// surface the *favored* outcome — the one the market judges most likely, not the most-traded. For a
// multi-candidate event that's the candidate market with the highest implied (Yes) probability and
// its groupItemTitle ("France"). For a plain binary market it's whichever leg is priced higher, so a
// market trading "No" at 70% shows "No 70%", not "Yes 30%".
function pickLeadingOutcome(markets: JsonRecord[]): LeadingOutcome {
  let leading: LeadingOutcome = { price: null, label: null, spread: null, oneDayPriceChange: null, conditionId: null, gameStartTime: null, yesTokenId: null };
  let bestYes = -Infinity;

  for (const market of markets) {
    const outcome = extractOutcome(market);
    // Rank candidates by implied probability — the favored outcome leads, regardless of volume.
    if (outcome.yesPrice === null || outcome.yesPrice <= bestYes) {
      continue;
    }
    bestYes = outcome.yesPrice;
    leading = outcome;
  }

  return leading;
}

export function mapEvent(record: JsonRecord): EventSummary {
  const markets = parseJsonArray(record.markets).filter(isRecord);
  const leading = pickLeadingOutcome(markets);
  // No explicit category on events — fall back to the first tag's label/slug.
  const firstTag = parseJsonArray(record.tags)[0];
  const tagLabel = isRecord(firstTag) ? readString(firstTag, ["label", "slug", "name"]) || null : null;
  const category = readString(record, ["category"]) || tagLabel;

  return {
    id: readString(record, ["id", "eventId"]),
    conditionId: leading.conditionId,
    yesTokenId: leading.yesTokenId,
    question: readString(record, ["title", "question"]),
    slug: readString(record, ["slug"]),
    category,
    liquidityUsd: readNumber(record, ["liquidity", "liquidityNum"]),
    volumeUsd: readNumber(record, ["volume", "volumeNum"]),
    volume24hrUsd: readNumber(record, ["volume24hr"]),
    volume1wkUsd: readNumber(record, ["volume1wk"]),
    currentPrice: leading.price,
    topOutcome: leading.label,
    spread: leading.spread,
    oneDayPriceChange: leading.oneDayPriceChange,
    endDate: readString(record, ["endDate", "endDateIso"]) || null,
    gameStartTime: leading.gameStartTime,
    image: readString(record, ["image", "icon"]) || null,
    active: record.active === true,
    closed: record.closed === true
  };
}

// Every candidate market in an event, not just the leading one — mapEvent's single-winner view means
// every other candidate in a multi-outcome event (an election, a tournament-winner market) never gets
// a `markets` row, so a non-favorite candidate with real leaderboard activity can never appear on the
// Markets page or qualify for the Trending panel. The /events payload already carries full per-market
// data for every candidate (pickLeadingOutcome just discards all but the best), so this needs no new
// API call — same fetch, more rows kept. A plain binary event has exactly one market object, so this
// naturally yields one row for it too (no special-casing needed).
export function mapEventCandidates(record: JsonRecord): EventSummary[] {
  const markets = parseJsonArray(record.markets).filter(isRecord);
  if (markets.length === 0) return [];

  const eventId = readString(record, ["id", "eventId"]);
  const firstTag = parseJsonArray(record.tags)[0];
  const tagLabel = isRecord(firstTag) ? readString(firstTag, ["label", "slug", "name"]) || null : null;
  const category = readString(record, ["category"]) || tagLabel;
  const question = readString(record, ["title", "question"]);
  const slug = readString(record, ["slug"]);
  const endDate = readString(record, ["endDate", "endDateIso"]) || null;
  const image = readString(record, ["image", "icon"]) || null;
  const active = record.active === true;
  const closed = record.closed === true;

  const candidates: EventSummary[] = [];
  for (const market of markets) {
    const outcome = extractOutcome(market);
    if (outcome.yesPrice === null) continue;
    // Per-candidate liquidity/volume, not the event-level aggregate mapEvent reads — every candidate
    // in a multi-outcome event carries its own, and reusing the event total would make every candidate
    // look equally liquid, which defeats the point of ranking them against each other.
    const liquidityUsd = readNumber(market, ["liquidity", "liquidityNum"]);
    const volumeUsd = readNumber(market, ["volume", "volumeNum"]);
    const volume24hrUsd = readNumber(market, ["volume24hr"]);
    const volume1wkUsd = readNumber(market, ["volume1wk"]);
    // Most candidates in a large multi-outcome event never traded (120 of 128 in a spot-checked
    // election event) — prune dead placeholder rows before they compete for a MARKETS_TOP_N slot.
    if (liquidityUsd <= 0 && volumeUsd <= 0) continue;

    candidates.push({
      id: outcome.conditionId ?? eventId,
      conditionId: outcome.conditionId,
      yesTokenId: outcome.yesTokenId,
      question,
      slug,
      category,
      liquidityUsd,
      volumeUsd,
      volume24hrUsd,
      volume1wkUsd,
      currentPrice: outcome.price,
      topOutcome: outcome.label,
      spread: outcome.spread,
      oneDayPriceChange: outcome.oneDayPriceChange,
      endDate,
      gameStartTime: outcome.gameStartTime,
      image,
      active,
      closed
    });
  }
  // Cap candidates kept per event so one large election/tournament can't crowd out unrelated events
  // once pooled and sliced to MARKETS_TOP_N in getTopEvents.
  candidates.sort((a, b) => b.liquidityUsd - a.liquidityUsd);
  return candidates.slice(0, CONFIG.MARKETS_MAX_CANDIDATES_PER_EVENT);
}

export class PolymarketClient {
  async getClosedPositions(address: string, maxDays = Math.max(...CONFIG.HORIZONS), maxPages = CONFIG.MAX_CLOSED_POSITION_PAGES): Promise<ClosedPosition[]> {
    // Positions older than maxDays are discarded downstream, so stop paginating once we cross that
    // boundary (the API returns newest-first). Defaults to the largest scoring horizon (the daily
    // ingest's needs); the one-off archive backfill passes a wider window for deeper history. `maxPages`
    // caps pagination cost for callers (the sports scout) that only need a sample for a shrunk-edge estimate.
    const cutoffMs = Date.now() - maxDays * CONFIG.SECONDS_PER_DAY * CONFIG.MS_PER_SECOND;
    const positions: ClosedPosition[] = [];
    for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
      const params = new URLSearchParams({
        user: address,
        limit: String(CONFIG.CLOSED_POSITION_PAGE_SIZE),
        offset: String(pageIndex * CONFIG.CLOSED_POSITION_PAGE_SIZE),
        sortBy: "TIMESTAMP",
        sortDirection: "DESC"
      });
      const page = asArray(await fetchJson("/closed-positions", params, "restricted")).map(mapClosedPosition);
      positions.push(...page);
      if (page.length < CONFIG.CLOSED_POSITION_PAGE_SIZE) {
        break;
      }
      const oldest = page[page.length - 1];
      if (oldest && Date.parse(oldest.closeTime) < cutoffMs) {
        break;
      }
    }

    return positions;
  }

  async getCurrentPositions(address: string): Promise<Position[]> {
    // /positions defaults to 100 rows; paginate so heavy accounts' full holdings are captured.
    const positions: Position[] = [];
    for (let pageIndex = 0; pageIndex < CONFIG.MAX_POSITION_PAGES; pageIndex += 1) {
      const params = new URLSearchParams({
        user: address,
        limit: String(CONFIG.POSITION_PAGE_SIZE),
        offset: String(pageIndex * CONFIG.POSITION_PAGE_SIZE)
      });
      const page = asArray(await fetchJson("/positions", params, "restricted")).map(mapPosition);
      positions.push(...page);
      if (page.length < CONFIG.POSITION_PAGE_SIZE) {
        break;
      }
    }

    return positions;
  }

  // Resolved-but-unredeemed positions, shaped as ClosedPosition so they merge with getClosedPositions.
  async getResolvedPositions(address: string): Promise<ClosedPosition[]> {
    return resolvedToClosed(await this.getCurrentPositions(address));
  }

  // Full daily price series for one outcome token, from the CLOB prices-history endpoint. `asset`
  // is the CLOB token id (Position.asset). interval=max returns the token's whole life at the given
  // fidelity (1440min = daily); the caller windows/dedupes to the horizon (dailyPointsFromHistory).
  // Runs on the dedicated "clob" lane against CLOB_API_BASE.
  async getPriceHistory(asset: string): Promise<RawHistory[]> {
    const params = new URLSearchParams({
      market: asset,
      interval: "max",
      fidelity: String(CONFIG.PRICE_HISTORY_FIDELITY_MIN)
    });
    const response = await fetchJson("/prices-history", params, "clob", CONFIG.CLOB_API_BASE);
    const history = isRecord(response) ? response.history : null;
    return Array.isArray(history) ? history.filter(isRecord).map((point) => ({ t: readNumber(point, ["t"]), p: readNumber(point, ["p"]) })) : [];
  }

  // Resolves a condition_id to its YES outcome token id (clobTokenIds[0] — same index-0-is-YES
  // convention as pickLeadingOutcome), for backtest tooling that needs price history for a market no
  // wallet_positions/wallet_closed_positions row retains a token id for. closed=true since this is
  // only ever called for already-resolved markets — Gamma hides them by default otherwise.
  async getYesTokenId(conditionId: string): Promise<string | null> {
    const params = new URLSearchParams({ condition_ids: conditionId, closed: "true" });
    const response = await fetchJson("/markets", params, "general", CONFIG.GAMMA_API_BASE);
    const first = asArray(response).filter(isRecord)[0];
    if (!first) return null;
    return parseJsonArray(first.clobTokenIds).map((entry) => String(entry))[0] || null;
  }

  // Authoritative resolution for a condition_id from Gamma (UMA settlement), for the forward test.
  // Returns 1 (YES won) / 0 (NO won) / null (not resolved, or Gamma has no record). See
  // resolvedOutcomeFromMarket for why this beats inferring resolution from the last CLOB trade.
  async getResolvedOutcome(conditionId: string): Promise<number | null> {
    const params = new URLSearchParams({ condition_ids: conditionId, closed: "true" });
    const response = await fetchJson("/markets", params, "general", CONFIG.GAMMA_API_BASE);
    const first = asArray(response).filter(isRecord)[0];
    if (!first) return null;
    return resolvedOutcomeFromMarket(first);
  }

  // Brief market metadata for a condition_id (Gamma). `outcomes` are the real side labels
  // ("Over"/"Under", team names, "Yes"/"No"), index-aligned with a trade's outcome_index and with
  // clobTokenIds — so outcomes[outcome_index] is exactly the side a fill was on. `endDate` is the
  // scheduled close; `resolved` is true once the UMA oracle settles or the market is closed.
  // `eventTitle`/`groupItemTitle` are Polymarket's own grouping: one game is split across several events
  // that share a title stem (e.g. "Mexico vs. England", "… - More Markets", "… - Total Corners"), and
  // groupItemTitle names the specific market within it ("Team to Advance", "O/U 2.5"). For the copy-list
  // tool: label the exact bet, group markets by game, and drop already-decided ones. Queries WITHOUT
  // closed=true so still-open markets are returned (Gamma includes open by default); a null return = no
  // open market (closed/hidden/unknown) and the caller drops it.
  async getMarketBrief(conditionId: string): Promise<{ outcomes: string[]; outcomePrices: (number | null)[]; endDate: string | null; resolved: boolean; eventTitle: string | null; groupItemTitle: string | null; gameStartTime: string | null } | null> {
    const params = new URLSearchParams({ condition_ids: conditionId });
    const response = await fetchJson("/markets", params, "general", CONFIG.GAMMA_API_BASE);
    const first = asArray(response).filter(isRecord)[0];
    if (!first) return null;
    const events = Array.isArray(first.events) ? first.events.filter(isRecord) : [];
    return {
      outcomes: parseJsonArray(first.outcomes).map((entry) => String(entry)),
      // Current price per outcome index (index-aligned with `outcomes`) — what a copier pays RIGHT NOW.
      // The copylist forward test freezes outcomePrices[outcome_index] as copy_price so the scorecard
      // isn't flattered by the elite wallets' earlier fill price.
      outcomePrices: parseJsonArray(first.outcomePrices).map((entry) => {
        const n = Number(entry);
        return Number.isFinite(n) ? n : null;
      }),
      endDate: readString(first, ["endDate", "end_date"]) || null,
      resolved: first.umaResolutionStatus === "resolved" || first.closed === true,
      eventTitle: (events[0] && readString(events[0], ["title"])) || null,
      groupItemTitle: readString(first, ["groupItemTitle"]) || null,
      // Single-game markets carry the real kickoff here; futures/season markets have none. Used by the
      // copy list to drop in-game (live) entries so only PRE-GAME bets count. Format is Gamma's loose
      // "YYYY-MM-DD HH:MM:SS+00", which Date.parse handles.
      gameStartTime: readString(first, ["gameStartTime", "game_start_time"]) || null
    };
  }

  async getActivity(address: string, limit = CONFIG.ACTIVITY_LIMIT): Promise<TradeActivity[]> {
    const params = new URLSearchParams({
      user: address,
      limit: String(limit),
      type: "TRADE",
      sortDirection: "DESC"
    });
    // Drop combo (multi-market) legs: a combo row's conditionId/price describe one leg of a
    // combinatorial bet, not a clean single-market forecast, so counting them would inflate bot
    // detection (trade rate / simultaneous markets) and show misleading single-market rows in the feed.
    // The Skill Score is unaffected — it reads /closed-positions, which carries no combos.
    // ponytail: flag-filter at the fetch choke point, not a combo-aware feature.
    return asArray(await fetchJson("/activity", params))
      .filter((record) => record.isCombo !== true)
      .map(mapActivity);
  }

  // Top holders (by token balance) of the given markets, from the public Data API /holders endpoint.
  // Discovers high-conviction wallets that never surface on a volume-sorted leaderboard. Markets are
  // batched comma-separated per request (chunked by count to stay under the URL-length limit); returns
  // a deduped, lowercased address set across all requested markets. General lane, no auth.
  async getTopHolders(conditionIds: string[]): Promise<string[]> {
    const found = new Set<string>();
    for (let i = 0; i < conditionIds.length; i += CONFIG.HOLDER_MARKET_CHUNK) {
      const slice = conditionIds.slice(i, i + CONFIG.HOLDER_MARKET_CHUNK);
      const params = new URLSearchParams({ market: slice.join(","), limit: "20" });
      for (const addr of parseHoldersResponse(await fetchJson("/holders", params))) {
        found.add(addr);
      }
    }
    return [...found];
  }

  // One page of open sports events (Gamma, tag_slug=sports) with their markets inlined. Lets the sports
  // scout enumerate upcoming game markets + metadata straight from Polymarket, independent of our
  // (leaderboard-scoped) caches. General lane, Gamma host.
  async getSportsEvents(limit: number, offset: number): Promise<JsonRecord[]> {
    // Most-liquid first: front-loads the marquee upcoming games (a World Cup match, a Wimbledon match, a
    // big Dota/MLB game) so the scout reaches copyable games without paging the long tail of thin ITF
    // matches and season futures. Gamma caps a page at ~100.
    const params = new URLSearchParams({ closed: "false", limit: String(limit), offset: String(offset), tag_slug: "sports", order: "liquidity", ascending: "false" });
    return asArray(await fetchJson("/events", params, "general", CONFIG.GAMMA_API_BASE)).filter(isRecord);
  }

  // Current holders of one market WITH their side (outcomeIndex) and shares held — richer than
  // getTopHolders (addresses only), so the scout can aggregate per-side agreement. Data API /holders,
  // general lane. Holders come sorted by size; `limit` caps per outcome token.
  async getMarketHolders(conditionId: string, limit = 20): Promise<{ address: string; outcomeIndex: number; shares: number }[]> {
    const params = new URLSearchParams({ market: conditionId, limit: String(limit) });
    const out: { address: string; outcomeIndex: number; shares: number }[] = [];
    for (const group of asArray(await fetchJson("/holders", params))) {
      const holders = Array.isArray(group.holders) ? group.holders : [];
      for (const holder of holders) {
        if (!isRecord(holder)) continue;
        const address = readString(holder, ["proxyWallet", "user", "wallet", "address"]).toLowerCase();
        if (!address) continue;
        out.push({ address, outcomeIndex: readNumber(holder, ["outcomeIndex"]), shares: readNumber(holder, ["amount", "shares", "size"]) });
      }
    }
    return out;
  }

  async getTotalValue(address: string): Promise<number> {
    const params = new URLSearchParams({ user: address });
    const response = await fetchJson("/value", params);
    const first = asArray(response)[0];
    return first ? readNumber(first, ["value"]) : 0;
  }

  // Top active events by liquidity, from the Gamma API. A single global pass (not per-wallet):
  // we persist one liquidity-sorted superset and re-order it by volume/24h/volatility at read time,
  // so no per-sort fetch is needed. /events groups the per-outcome markets into one row each. Gamma
  // returns a bare array, so asArray handles it.
  async getTopEvents(): Promise<EventSummary[]> {
    // Pagination is bounded by raw events fetched, not by the expanded candidate pool (one event can
    // now yield many rows via mapEventCandidates — see its header note) — so the loop count and the
    // short-page stop-detection below both track rawEventCount, matching this function's cost/behavior
    // before candidates were expanded per-event.
    const candidates: EventSummary[] = [];
    let rawEventCount = 0;
    for (
      let offset = 0;
      rawEventCount < CONFIG.MARKETS_TOP_N;
      offset += CONFIG.MARKETS_PAGE_SIZE
    ) {
      const params = new URLSearchParams({
        limit: String(CONFIG.MARKETS_PAGE_SIZE),
        offset: String(offset),
        order: "liquidity",
        ascending: "false",
        active: "true",
        closed: "false",
        archived: "false",
        liquidity_min: String(CONFIG.MARKETS_MIN_LIQUIDITY),
        volume_min: String(CONFIG.MARKETS_MIN_VOLUME)
      });
      const rawPage = asArray(await fetchJson("/events", params, "general", CONFIG.GAMMA_API_BASE));
      rawEventCount += rawPage.length;
      for (const record of rawPage) candidates.push(...mapEventCandidates(record));
      if (rawPage.length < CONFIG.MARKETS_PAGE_SIZE) {
        break;
      }
    }

    // Re-rank across the full candidate pool by liquidity (Gamma's own ordering was per-event, not
    // per-candidate) and take the top MARKETS_TOP_N — same cap and selection principle as before, just
    // applied per-market instead of per-event.
    candidates.sort((a, b) => b.liquidityUsd - a.liquidityUsd);
    return candidates.slice(0, CONFIG.MARKETS_TOP_N);
  }
}

export interface DiscoveredWallet {
  address: string;
  userName: string | null;
  // All-time P/L from the leaderboard (timePeriod=ALL). null when discovered via the /trades
  // fallback, which carries no pnl.
  lifetimePnl: number | null;
}

// A wallet surfaced by the extended candidate discovery pipeline (multi-period leaderboard
// variants + /trades stream). Carries a `discoverySource` annotation so candidate_wallets
// can record how each wallet was first found. Merges into the candidate scoring batch
// without touching any existing status/scoring history.
export interface DiscoveredCandidate {
  address: string;
  discoverySource: string;
  userName: string | null;
  lifetimePnl: number | null;
}

// Stable chip code for a Polymarket leaderboard: "{pnl|vol}-{all|month|week}" (e.g. "pnl-all",
// "vol-month"). Null for an unrecognized sort. Pure + tested.
export function chipBoardCode(timePeriod: string, orderBy: string): string | null {
  const sort = orderBy.toUpperCase() === "PNL" ? "pnl" : orderBy.toUpperCase() === "VOL" ? "vol" : null;
  return sort ? `${sort}-${timePeriod.toLowerCase()}` : null;
}

// Scan each CHIP_BOARDS leaderboard to PNL_BOARD_CHIP_TOP_N depth and record every wallet's rank on
// each board it makes, as "code:rank" entries (e.g. "pnl-all:3"). The map covers ALL wallets on those
// boards — the leaderboard-chip targets are mostly main-pool wallets. Each board scans independently;
// a failure is logged and skipped. ~ (topN / page) requests per board on the general lane.
export async function scanChipBoards(): Promise<Map<string, string[]>> {
  const chipsByAddress = new Map<string, string[]>();
  const add = (address: string, entry: string): void => {
    const normalized = address.toLowerCase();
    if (!normalized.startsWith("0x")) return;
    let entries = chipsByAddress.get(normalized);
    if (!entries) {
      entries = [];
      chipsByAddress.set(normalized, entries);
    }
    entries.push(entry);
  };

  for (const { timePeriod, orderBy } of CONFIG.CHIP_BOARDS) {
    const code = chipBoardCode(timePeriod, orderBy);
    if (!code) continue;
    try {
      for (let offset = 0; offset < CONFIG.PNL_BOARD_CHIP_TOP_N; offset += CONFIG.LEADERBOARD_PAGE_SIZE) {
        const params = new URLSearchParams({
          category: "OVERALL",
          timePeriod,
          orderBy,
          limit: String(CONFIG.LEADERBOARD_PAGE_SIZE),
          offset: String(offset)
        });
        const page = asArray(await fetchJson("/v1/leaderboard", params)).map(mapLeaderboard);
        page.forEach((entry, i) => {
          const rank = offset + i + 1; // 1-based board rank by scan position
          if (rank <= CONFIG.PNL_BOARD_CHIP_TOP_N) add(entry.proxyWallet, `${code}:${rank}`);
        });
        if (page.length < CONFIG.LEADERBOARD_PAGE_SIZE) break;
      }
    } catch (error) {
      console.warn(`Chip-board scan (${code}) failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return chipsByAddress;
}

// Pull wallets from every CANDIDATE_SOURCES variant and the live /trades stream.
// Returns only addresses not already in `knownAddresses` (main leaderboard pass + existing
// candidate_wallets rows) — callers insert with ignoreDuplicates so no existing scoring
// history is overwritten.
//
// Each leaderboard source runs independently: a network failure in one is logged and
// skipped without aborting the others. The trades stream is similarly non-fatal.
export async function discoverCandidateAddresses(
  knownAddresses: Set<string>
): Promise<DiscoveredCandidate[]> {
  const found = new Map<string, DiscoveredCandidate>();

  const remember = (address: string, source: string, userName: string | null, lifetimePnl: number | null): void => {
    const normalized = address.toLowerCase();
    if (!normalized.startsWith("0x")) {
      return;
    }
    if (found.has(normalized)) {
      return; // first source wins — never overwrite the lineage annotation
    }
    found.set(normalized, { address: normalized, discoverySource: source, userName, lifetimePnl });
  };

  for (const { timePeriod, orderBy } of CONFIG.CANDIDATE_SOURCES) {
    const source = `leaderboard_${orderBy.toLowerCase()}_${timePeriod}`;
    try {
      for (let offset = 0; offset < CONFIG.SEED_WALLET_COUNT; offset += CONFIG.LEADERBOARD_PAGE_SIZE) {
        const params = new URLSearchParams({
          category: "OVERALL",
          timePeriod,
          orderBy,
          limit: String(CONFIG.LEADERBOARD_PAGE_SIZE),
          offset: String(offset)
        });
        const page = asArray(await fetchJson("/v1/leaderboard", params)).map(mapLeaderboard);
        page.forEach((entry) => remember(entry.proxyWallet, source, entry.userName, entry.pnl));
        if (page.length < CONFIG.LEADERBOARD_PAGE_SIZE) {
          break;
        }
      }
    } catch (error) {
      console.warn(
        `Candidate discovery (${source}) failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // /trades stream: captures active traders absent from every leaderboard variant.
  // Always run (not just as a fallback) so recent activity supplements ranked lists.
  try {
    const params = new URLSearchParams({
      limit: String(CONFIG.TRADES_DISCOVERY_LIMIT),
      offset: "0",
      takerOnly: "false"
    });
    const trades = asArray(await fetchJson("/trades", params));
    trades.forEach((trade) => {
      [
        readString(trade, ["maker", "makerAddress"]),
        readString(trade, ["taker", "takerAddress"]),
        readString(trade, ["proxyWallet", "user", "wallet"])
      ].forEach((addr) => remember(addr, "trades_stream", null, null));
    });
  } catch (error) {
    console.warn(
      `Candidate trades-stream discovery failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  // Exclude already-known addresses so the caller only receives genuinely new wallets.
  return [...found.values()].filter((c) => !knownAddresses.has(c.address));
}

export async function discoverTopWallets(): Promise<DiscoveredWallet[]> {
  const wallets = new Map<string, { userName: string | null; lifetimePnl: number | null }>();
  const remember = (address: string, userName: string | null, lifetimePnl: number | null): void => {
    if (!address.startsWith("0x")) {
      return;
    }
    const existing = wallets.get(address);
    // Keep the first non-null name/pnl we see; never downgrade a known value to null.
    wallets.set(address, {
      userName: existing?.userName ?? userName,
      lifetimePnl: existing?.lifetimePnl ?? lifetimePnl
    });
  };

  try {
    for (let offset = 0; wallets.size < CONFIG.SEED_WALLET_COUNT; offset += CONFIG.LEADERBOARD_PAGE_SIZE) {
      const params = new URLSearchParams({
        category: "OVERALL",
        timePeriod: "ALL",
        orderBy: "VOL",
        limit: String(CONFIG.LEADERBOARD_PAGE_SIZE),
        offset: String(offset)
      });
      const page = asArray(await fetchJson("/v1/leaderboard", params)).map(mapLeaderboard);
      page.forEach((entry) => remember(entry.proxyWallet, entry.userName, entry.pnl));

      if (page.length < CONFIG.LEADERBOARD_PAGE_SIZE) {
        break;
      }
    }
  } catch (error) {
    console.warn(`Leaderboard discovery failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (wallets.size === 0) {
    const params = new URLSearchParams({
      limit: String(CONFIG.TRADES_DISCOVERY_LIMIT),
      offset: "0",
      takerOnly: "false"
    });
    const trades = asArray(await fetchJson("/trades", params));
    trades.forEach((trade) => {
      const candidates = [
        readString(trade, ["maker", "makerAddress"]),
        readString(trade, ["taker", "takerAddress"]),
        readString(trade, ["proxyWallet", "user", "wallet"])
      ];
      candidates.forEach((candidate) => remember(candidate.toLowerCase(), null, null));
    });
  }

  return [...wallets.entries()]
    .slice(0, CONFIG.SEED_WALLET_COUNT)
    .map(([address, info]) => ({ address, userName: info.userName, lifetimePnl: info.lifetimePnl }));
}
