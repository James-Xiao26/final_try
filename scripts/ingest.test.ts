import test from "node:test";
import assert from "node:assert/strict";
import { CONFIG } from "./config.js";
import {
  describeError,
  processWallet,
  rebuildLeaderboardCache,
  toRecentTradeRow
} from "./ingest.js";
import type { ClosedPosition, Position, PolymarketClient, TradeActivity } from "./polymarket.js";
import type { RecentTrade } from "./recentTrades.js";

// ---------------------------------------------------------------------------
// A minimal stand-in for the Supabase query builder. The real client returns a
// chainable, thenable builder; this records every terminal operation (table, op,
// filters, payload) into `log` and resolves with a canned response from `resolver`,
// so we can assert on what ingest wrote without a live database.
// ---------------------------------------------------------------------------

interface QueryResponse {
  data: unknown;
  error: unknown;
}

interface RecordedOp {
  table: string;
  op: "select" | "delete" | "insert" | "upsert";
  filters: Record<string, unknown>;
  inValues: unknown[] | undefined;
  payload: unknown;
}

class FakeQueryBuilder implements PromiseLike<QueryResponse> {
  private op: RecordedOp["op"] = "select";
  private filters: Record<string, unknown> = {};
  private inValues: unknown[] | undefined = undefined;
  private payload: unknown = undefined;

  constructor(
    private readonly table: string,
    private readonly resolver: (op: RecordedOp) => QueryResponse,
    private readonly log: RecordedOp[]
  ) {}

  select(): this {
    return this;
  }
  not(): this {
    return this;
  }
  or(): this {
    return this;
  }
  order(): this {
    return this;
  }
  eq(column: string, value: unknown): this {
    this.filters[column] = value;
    return this;
  }
  gte(column: string, value: unknown): this {
    this.filters[column] = value;
    return this;
  }
  in(column: string, values: unknown[]): this {
    this.filters[column] = values;
    this.inValues = values;
    return this;
  }
  delete(): this {
    this.op = "delete";
    return this;
  }
  insert(rows: unknown): this {
    this.op = "insert";
    this.payload = rows;
    return this;
  }
  upsert(rows: unknown, _options?: unknown): this {
    this.op = "upsert";
    this.payload = rows;
    return this;
  }

  then<R1 = QueryResponse, R2 = never>(
    onFulfilled?: ((value: QueryResponse) => R1 | PromiseLike<R1>) | null,
    onRejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null
  ): PromiseLike<R1 | R2> {
    const op: RecordedOp = {
      table: this.table,
      op: this.op,
      filters: this.filters,
      inValues: this.inValues,
      payload: this.payload
    };
    this.log.push(op);
    return Promise.resolve(this.resolver(op)).then(onFulfilled, onRejected);
  }
}

function makeSupabase(resolver: (op: RecordedOp) => QueryResponse, log: RecordedOp[]) {
  return { from: (table: string) => new FakeQueryBuilder(table, resolver, log) };
}

// Both functions under test take the Supabase client as their first arg; reuse its type so the
// cast stays honest if that signature ever changes.
type SupabaseArg = Parameters<typeof rebuildLeaderboardCache>[0];
const asSupabase = (fake: ReturnType<typeof makeSupabase>): SupabaseArg => fake as unknown as SupabaseArg;

// ---------------------------------------------------------------------------
// describeError
// ---------------------------------------------------------------------------

test("describeError returns the message of an Error instance", () => {
  assert.equal(describeError(new Error("boom")), "boom");
});

test("describeError surfaces PostgrestError fields (message/code/details/hint)", () => {
  const pgError = { message: "insert failed", code: "23505", details: "dup key", hint: "retry" };
  assert.equal(describeError(pgError), "insert failed | code=23505 | details=dup key | hint=retry");
});

test("describeError omits absent PostgrestError fields", () => {
  assert.equal(describeError({ message: "nope" }), "nope");
});

test("describeError JSON-stringifies an object without a message field", () => {
  assert.equal(describeError({ status: 500 }), JSON.stringify({ status: 500 }));
});

test("describeError falls back to String() when JSON.stringify throws (circular ref)", () => {
  const circular: Record<string, unknown> = { status: 1 };
  circular.self = circular; // no `message` field -> stringify path -> throws -> String() fallback
  assert.equal(describeError(circular), String(circular));
});

test("describeError handles primitives", () => {
  assert.equal(describeError("plain string"), "plain string");
  assert.equal(describeError(42), "42");
});

// ---------------------------------------------------------------------------
// toRecentTradeRow
// ---------------------------------------------------------------------------

test("toRecentTradeRow maps camelCase RecentTrade to the snake_case DB row", () => {
  const trade: RecentTrade = {
    address: "0xabc",
    conditionId: "cond",
    market: "Some market",
    outcomeIndex: 1,
    side: "BUY",
    price: 0.42,
    size: 100,
    usdcSize: 42,
    tradedAt: "2026-06-01T00:00:00.000Z"
  };
  assert.deepEqual(toRecentTradeRow(trade), {
    address: "0xabc",
    condition_id: "cond",
    market: "Some market",
    outcome_index: 1,
    side: "BUY",
    price: 0.42,
    size: 100,
    usdc_size: 42,
    traded_at: "2026-06-01T00:00:00.000Z"
  });
});

// ---------------------------------------------------------------------------
// rebuildLeaderboardCache
// ---------------------------------------------------------------------------

interface Fixtures {
  walletStatsByHorizon: Map<number, Array<Record<string, unknown>>>;
  allowed: Set<string>;
}

function statRow(address: string): Record<string, unknown> {
  return { address, skill_score: 5, pct_return: 0.1, win_rate: 0.5, n_trades: 25, avg_edge_per_share: 0.02 };
}

// Models the DB: wallet_stats returns pre-ordered candidate rows per horizon; the wallets table
// returns only the addresses in the requested slice that pass the bot/lifetime-pnl filter.
function defaultResolver(fx: Fixtures): (op: RecordedOp) => QueryResponse {
  return (op) => {
    if (op.table === "wallet_stats" && op.op === "select") {
      const horizon = op.filters.horizon_days as number;
      return { data: fx.walletStatsByHorizon.get(horizon) ?? [], error: null };
    }
    if (op.table === "wallets" && op.op === "select") {
      const slice = (op.inValues ?? []) as string[];
      return { data: slice.filter((address) => fx.allowed.has(address)).map((address) => ({ address })), error: null };
    }
    return { data: null, error: null };
  };
}

function statsForBothHorizons(rows: Array<Record<string, unknown>>): Map<number, Array<Record<string, unknown>>> {
  return new Map(CONFIG.HORIZONS.map((horizon) => [horizon, rows]));
}

test("rebuildLeaderboardCache writes only allowed wallets, ranked from 1, per horizon", async () => {
  const fx: Fixtures = {
    walletStatsByHorizon: statsForBothHorizons([statRow("a"), statRow("b"), statRow("c")]),
    allowed: new Set(["a", "c"]) // 'b' is filtered out (bot or proven lifetime loser)
  };
  const log: RecordedOp[] = [];
  await rebuildLeaderboardCache(asSupabase(makeSupabase(defaultResolver(fx), log)));

  const inserts = log.filter((o) => o.table === "leaderboard_cache" && o.op === "insert");
  assert.equal(inserts.length, CONFIG.HORIZONS.length);
  for (const insert of inserts) {
    const rows = insert.payload as Array<Record<string, unknown>>;
    assert.deepEqual(rows.map((r) => r.address), ["a", "c"]);
    assert.deepEqual(rows.map((r) => r.rank), [1, 2]);
  }
});

test("rebuildLeaderboardCache truncates to TOP_N", async () => {
  const addresses = Array.from({ length: CONFIG.TOP_N + 5 }, (_, i) => `w${i}`);
  const fx: Fixtures = {
    walletStatsByHorizon: statsForBothHorizons(addresses.map(statRow)),
    allowed: new Set(addresses)
  };
  const log: RecordedOp[] = [];
  await rebuildLeaderboardCache(asSupabase(makeSupabase(defaultResolver(fx), log)));

  const firstInsert = log.find((o) => o.table === "leaderboard_cache" && o.op === "insert");
  assert.ok(firstInsert);
  const rows = firstInsert.payload as Array<Record<string, unknown>>;
  assert.equal(rows.length, CONFIG.TOP_N);
  assert.equal(rows[CONFIG.TOP_N - 1]?.rank, CONFIG.TOP_N);
});

test("rebuildLeaderboardCache chunks the wallets filter so the URL can't overflow", async () => {
  const count = CONFIG.LEADERBOARD_FILTER_CHUNK * 2 + 10;
  const addresses = Array.from({ length: count }, (_, i) => `w${i}`);
  const fx: Fixtures = {
    walletStatsByHorizon: statsForBothHorizons(addresses.map(statRow)),
    allowed: new Set(addresses)
  };
  const log: RecordedOp[] = [];
  await rebuildLeaderboardCache(asSupabase(makeSupabase(defaultResolver(fx), log)));

  const expectedChunksPerHorizon = Math.ceil(count / CONFIG.LEADERBOARD_FILTER_CHUNK);
  const walletSelects = log.filter((o) => o.table === "wallets" && o.op === "select");
  assert.equal(walletSelects.length, expectedChunksPerHorizon * CONFIG.HORIZONS.length);
  for (const select of walletSelects) {
    assert.ok((select.inValues ?? []).length <= CONFIG.LEADERBOARD_FILTER_CHUNK);
  }
});

test("rebuildLeaderboardCache deletes the stale cache but inserts nothing when there are no candidates", async () => {
  const fx: Fixtures = { walletStatsByHorizon: statsForBothHorizons([]), allowed: new Set() };
  const log: RecordedOp[] = [];
  await rebuildLeaderboardCache(asSupabase(makeSupabase(defaultResolver(fx), log)));

  const deletes = log.filter((o) => o.table === "leaderboard_cache" && o.op === "delete");
  const inserts = log.filter((o) => o.table === "leaderboard_cache" && o.op === "insert");
  assert.equal(deletes.length, CONFIG.HORIZONS.length);
  assert.equal(inserts.length, 0);
});

test("rebuildLeaderboardCache propagates a query error", async () => {
  const resolver = (op: RecordedOp): QueryResponse =>
    op.table === "wallet_stats" ? { data: null, error: new Error("query boom") } : { data: null, error: null };
  await assert.rejects(rebuildLeaderboardCache(asSupabase(makeSupabase(resolver, []))), /query boom/);
});

// ---------------------------------------------------------------------------
// processWallet
// ---------------------------------------------------------------------------

function activity(overrides: Partial<TradeActivity> = {}): TradeActivity {
  return {
    proxyWallet: "0xabc",
    timestamp: Math.floor(Date.now() / 1000),
    conditionId: "c",
    size: 100,
    usdcSize: 50,
    price: 0.5,
    side: "BUY",
    asset: "a",
    outcomeIndex: 0,
    market: "m",
    transactionHash: null,
    ...overrides
  };
}

function closedPosition(overrides: Partial<ClosedPosition> = {}): ClosedPosition {
  return {
    proxyWallet: "0xabc",
    asset: "a",
    conditionId: "c",
    market: "m",
    outcomeIndex: 0,
    size: 100,
    avgPrice: 0.5,
    realizedPnl: 50,
    closeTime: new Date(Date.now() - 5 * CONFIG.SECONDS_PER_DAY * CONFIG.MS_PER_SECOND).toISOString(),
    outcome: 1,
    ...overrides
  };
}

function fakeClient(handlers: {
  getActivity: () => Promise<TradeActivity[]>;
  getClosedPositions?: () => Promise<ClosedPosition[]>;
  getCurrentPositions?: () => Promise<Position[]>;
}): PolymarketClient {
  return {
    getActivity: handlers.getActivity,
    getClosedPositions: handlers.getClosedPositions ?? (async () => []),
    getCurrentPositions: handlers.getCurrentPositions ?? (async () => [])
  } as unknown as PolymarketClient;
}

test("processWallet short-circuits on a detected bot without fetching positions", async () => {
  // Three dust fills (avg trade size < MIN_AVG_TRADE_SIZE_USD) trip the 'dust_trades' signal.
  const dust = [
    activity({ usdcSize: 0.1, conditionId: "c1", asset: "a1" }),
    activity({ usdcSize: 0.1, conditionId: "c2", asset: "a2" }),
    activity({ usdcSize: 0.1, conditionId: "c3", asset: "a3" })
  ];
  const client = fakeClient({
    getActivity: async () => dust,
    // If processWallet fetched positions for a flagged bot, these would throw and fail the test.
    getClosedPositions: async () => {
      throw new Error("must not fetch closed positions for a bot");
    },
    getCurrentPositions: async () => {
      throw new Error("must not fetch current positions for a bot");
    }
  });
  const log: RecordedOp[] = [];
  const supabase = asSupabase(makeSupabase(() => ({ data: null, error: null }), log));

  const result = await processWallet(
    supabase,
    client,
    { address: "0xABC", userName: "BotName", lifetimePnl: 1000 },
    Date.now()
  );

  assert.equal(result.bot, true);
  assert.equal(result.botReason, "dust_trades");
  assert.equal(result.recentTrades.length, 0);
  assert.match(result.summary, /bot/);

  const walletUpsert = log.find((o) => o.table === "wallets" && o.op === "upsert");
  assert.ok(walletUpsert);
  const row = walletUpsert.payload as Record<string, unknown>;
  assert.equal(row.address, "0xabc");
  assert.equal(row.is_bot_suspected, true);
});

test("processWallet scores an eligible wallet and upserts stats for every horizon", async () => {
  const acts = [activity({ conditionId: "m1", asset: "a1" }), activity({ conditionId: "m2", asset: "a2" })];
  // 25 winning resolved positions (entry 0.5, outcome 1) clear MIN_TRADES/volume/edge gates, so the
  // wallet earns a skill score on both horizons -> insufficient=false -> recent trades are kept.
  const closed = Array.from({ length: 25 }, (_, i) => closedPosition({ conditionId: `k${i}`, asset: `t${i}` }));
  const client = fakeClient({
    getActivity: async () => acts,
    getClosedPositions: async () => closed,
    getCurrentPositions: async () => []
  });
  const log: RecordedOp[] = [];
  const supabase = asSupabase(makeSupabase(() => ({ data: null, error: null }), log));
  const recentCutoff = Date.now() - CONFIG.RECENT_TRADE_WINDOW_HOURS * 60 * 60 * CONFIG.MS_PER_SECOND;

  const result = await processWallet(
    supabase,
    client,
    { address: "0xABC", userName: null, lifetimePnl: null },
    recentCutoff
  );

  assert.equal(result.bot, false);
  assert.equal(result.insufficient, false);
  assert.ok(result.recentTrades.length > 0);

  const statsUpserts = log.filter((o) => o.table === "wallet_stats" && o.op === "upsert");
  assert.equal(statsUpserts.length, CONFIG.HORIZONS.length);

  const walletUpsert = log.find((o) => o.table === "wallets" && o.op === "upsert");
  assert.ok(walletUpsert);
  assert.equal((walletUpsert.payload as Record<string, unknown>).is_bot_suspected, false);
});
