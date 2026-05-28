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

interface LeaderboardEntry {
  rank: string;
  proxyWallet: string;
  userName: string | null;
  vol: number;
  pnl: number;
}

type JsonRecord = Record<string, unknown>;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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

async function fetchJson(path: string, params: URLSearchParams = new URLSearchParams()): Promise<unknown> {
  const url = new URL(path, CONFIG.POLYMARKET_API_BASE);
  params.forEach((value, key) => url.searchParams.set(key, value));

  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= CONFIG.API_RETRIES; attempt += 1) {
    try {
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
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }

    if (attempt < CONFIG.API_RETRIES) {
      await sleep(CONFIG.RETRY_BASE_DELAY_MS * 2 ** attempt);
    }
  }

  throw lastError ?? new Error(`Polymarket request failed for ${url.toString()}`);
}

function mapClosedPosition(record: JsonRecord): ClosedPosition {
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
    closeTime: timestampToIso(typeof timestamp === "string" || typeof timestamp === "number" ? timestamp : 0)
  };
}

function mapPosition(record: JsonRecord): Position {
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
    endDate: readString(record, ["endDate"]) || null
  };
}

function mapActivity(record: JsonRecord): TradeActivity {
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

function mapLeaderboard(record: JsonRecord): LeaderboardEntry {
  return {
    rank: readString(record, ["rank"]),
    proxyWallet: readString(record, ["proxyWallet", "user", "wallet"]).toLowerCase(),
    userName: readString(record, ["userName", "name", "pseudonym"]) || null,
    vol: readNumber(record, ["vol", "volume"]),
    pnl: readNumber(record, ["pnl", "profit"])
  };
}

export class PolymarketClient {
  async getClosedPositions(address: string): Promise<ClosedPosition[]> {
    const positions: ClosedPosition[] = [];
    for (let offset = 0; ; offset += CONFIG.CLOSED_POSITION_PAGE_SIZE) {
      const params = new URLSearchParams({
        user: address,
        limit: String(CONFIG.CLOSED_POSITION_PAGE_SIZE),
        offset: String(offset),
        sortBy: "TIMESTAMP",
        sortDirection: "DESC"
      });
      const page = asArray(await fetchJson("/closed-positions", params)).map(mapClosedPosition);
      positions.push(...page);
      if (page.length < CONFIG.CLOSED_POSITION_PAGE_SIZE) {
        break;
      }
    }

    return positions;
  }

  async getCurrentPositions(address: string): Promise<Position[]> {
    const params = new URLSearchParams({ user: address });
    return asArray(await fetchJson("/positions", params)).map(mapPosition);
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
}

export async function discoverTopWallets(): Promise<string[]> {
  const wallets = new Set<string>();

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
      page.forEach((entry) => {
        if (entry.proxyWallet.startsWith("0x")) {
          wallets.add(entry.proxyWallet);
        }
      });

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
      candidates.forEach((candidate) => {
        const normalized = candidate.toLowerCase();
        if (normalized.startsWith("0x")) {
          wallets.add(normalized);
        }
      });
    });
  }

  return [...wallets].slice(0, CONFIG.SEED_WALLET_COUNT);
}
