import { CONFIG } from "./config.js";

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
  general: Promise.resolve()
};

function throttle(lane: RateLane): Promise<void> {
  const next = requestGates[lane].then(() => sleep(CONFIG.REQUEST_INTERVAL_MS[lane]));
  requestGates[lane] = next;
  return next;
}

// Lightweight ingest profiling: lets main() compare actual processing time against the gate's
// theoretical floor (requests * interval) to tell whether we're rate-gate-bound or starving it.
export const apiStats = {
  requests: { restricted: 0, general: 0 } as Record<RateLane, number>,
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
  return {
    proxyWallet: readString(record, ["proxyWallet", "user", "wallet"]).toLowerCase(),
    asset: readString(record, ["asset", "tokenId"]),
    conditionId: readString(record, ["conditionId", "market", "marketId"]),
    market: readString(record, ["market", "title", "question"]),
    outcomeIndex: readNumber(record, ["outcomeIndex"]),
    size: readNumber(record, ["size", "totalBought", "tokens"]),
    avgPrice: readNumber(record, ["avgPrice", "averagePrice", "price"]),
    realizedPnl: readNumber(record, ["realizedPnl", "realizedPnL", "pnl", "cashPnl"]),
    closeTime: timestampToIso(typeof timestamp === "string" || typeof timestamp === "number" ? timestamp : 0),
    // Sold positions only expose an outcome if the payload carries a settled price; absent that
    // (or if the market is still trading), this is null and the position is excluded from edge.
    outcome: outcomeFromResolvedPrice(readOptionalNumber(record, ["curPrice", "outcome", "payout", "resolvedPrice"]))
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
    redeemable: record.redeemable === true
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
      outcome: outcomeFromResolvedPrice(position.curPrice)
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
    transactionHash: readString(record, ["transactionHash", "txHash"]) || null
  };
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

interface LeadingOutcome {
  price: number | null;
  label: string | null;
  spread: number | null;
  // Change in the leading outcome's price over the last 24h, as a 0–1 fraction (e.g. 0.03 = +3pts).
  oneDayPriceChange: number | null;
}

// An event has many outcome markets (e.g. one per team). There's no single event price, so we
// surface the *most-traded* outcome: the market with the highest volume within the event, and show
// that market's price. Its label is the market's groupItemTitle ("Spain"), or the first outcome name
// for a plain binary market ("Yes").
function pickLeadingOutcome(markets: JsonRecord[]): LeadingOutcome {
  let leading: LeadingOutcome = { price: null, label: null, spread: null, oneDayPriceChange: null };
  let bestVolume = -Infinity;

  for (const market of markets) {
    const volume = readNumber(market, ["volume", "volumeNum"]);
    if (volume <= bestVolume) {
      continue;
    }
    bestVolume = volume;

    const prices = parseJsonArray(market.outcomePrices)
      .map((entry) => Number(entry))
      .filter((value) => Number.isFinite(value));
    // Implied Yes probability from outcomePrices[0]; fall back to the last trade price.
    const yesPrice = prices.length > 0 ? prices[0] ?? null : readOptionalNumber(market, ["lastTradePrice"]);
    const outcomes = parseJsonArray(market.outcomes).map((entry) => String(entry));
    const groupTitle = readString(market, ["groupItemTitle"]);
    leading = {
      price: yesPrice,
      label: groupTitle || outcomes[0] || "Yes",
      spread: readOptionalNumber(market, ["spread"]),
      oneDayPriceChange: readOptionalNumber(market, ["oneDayPriceChange"])
    };
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
    image: readString(record, ["image", "icon"]) || null,
    active: record.active === true,
    closed: record.closed === true
  };
}

export class PolymarketClient {
  async getClosedPositions(address: string): Promise<ClosedPosition[]> {
    // Positions older than the largest scoring horizon are discarded downstream, so stop
    // paginating once we cross that boundary (the API returns newest-first).
    const maxHorizonDays = Math.max(...CONFIG.HORIZONS);
    const cutoffMs = Date.now() - maxHorizonDays * CONFIG.SECONDS_PER_DAY * CONFIG.MS_PER_SECOND;
    const positions: ClosedPosition[] = [];
    for (let pageIndex = 0; pageIndex < CONFIG.MAX_CLOSED_POSITION_PAGES; pageIndex += 1) {
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

  async getActivity(address: string, limit = CONFIG.ACTIVITY_LIMIT): Promise<TradeActivity[]> {
    const params = new URLSearchParams({
      user: address,
      limit: String(limit),
      type: "TRADE",
      sortDirection: "DESC"
    });
    return asArray(await fetchJson("/activity", params)).map(mapActivity);
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
    const events: EventSummary[] = [];
    for (
      let offset = 0;
      events.length < CONFIG.MARKETS_TOP_N;
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
      const page = asArray(await fetchJson("/events", params, "general", CONFIG.GAMMA_API_BASE)).map(mapEvent);
      events.push(...page);
      if (page.length < CONFIG.MARKETS_PAGE_SIZE) {
        break;
      }
    }

    return events.slice(0, CONFIG.MARKETS_TOP_N);
  }
}

export interface DiscoveredWallet {
  address: string;
  userName: string | null;
  // All-time P/L from the leaderboard (timePeriod=ALL). null when discovered via the /trades
  // fallback, which carries no pnl.
  lifetimePnl: number | null;
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
