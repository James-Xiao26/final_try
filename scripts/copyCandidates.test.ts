import test from "node:test";
import assert from "node:assert/strict";
import { buildCandidates, buildHoldingCandidates, copyPnlPerDollar, type Trade, type Holding } from "./copyCandidates.js";
import type { WalletQuality } from "./eliteWallets.js";

// --- buildHoldingCandidates: agreement from current elite holdings, priced at cur_price ---
test("buildHoldingCandidates aggregates elite holders of a side; pays current price, notes their entry", () => {
  const elite = new Map<string, WalletQuality>([
    ["a", { address: "a", edge: 0.08, families: 10, firstHalfEdge: 0.05, secondHalfEdge: 0.06 }],
    ["b", { address: "b", edge: 0.04, families: 9, firstHalfEdge: 0.04, secondHalfEdge: 0.05 }]
  ]);
  const h = (address: string, cond: string, oi: number, size: number, entry: number, cur: number): Holding => ({ address, condition_id: cond, market: `Market ${cond}`, outcome_index: oi, size, avg_price: entry, cur_price: cur });
  const holdings: Holding[] = [
    h("a", "m1", 0, 1000, 0.2, 0.35), // elite, cost $200, cur 0.35
    h("b", "m1", 0, 500, 0.3, 0.35), // 2nd elite same side -> wallets=2, cost $150
    h("c", "m1", 0, 1000, 0.2, 0.35), // NON-elite -> ignored
    h("a", "m2", 0, 10, 0.2, 0.35), // cost $2 < dust -> dropped
    h("a", "m3", 0, 1000, 0.9, 0.97) // cur 0.97 > maxPrice -> dropped
  ];
  const out = buildHoldingCandidates(holdings, elite, { minPrice: 0.1, maxPrice: 0.9, minLiquidity: 100, dustUsd: 10 });
  assert.equal(out.length, 1);
  assert.equal(out[0]!.wallets, 2);
  assert.ok(Math.abs(out[0]!.avgPrice - 0.35) < 1e-9); // pay current price
  assert.ok(Math.abs(out[0]!.theirAvgEntry! - (0.2 * 200 + 0.3 * 150) / 350) < 1e-9); // cost-weighted entry
  assert.ok(Math.abs(out[0]!.usd - 350) < 1e-9);
});

// --- buildCandidates: only elite wallets, fresh BUYs, price band, liquidity floor; ranked ---
test("buildCandidates keeps only fresh elite BUYs and aggregates a market-side", () => {
  const now = Date.parse("2026-07-05T00:00:00Z");
  const mk = (address: string, cond: string, oi: number, side: string, price: number, usd: number, ageDays: number): Trade => ({ address, condition_id: cond, market: `Market ${cond}`, outcome_index: oi, side, price, usdc_size: usd, traded_at: new Date(now - ageDays * 86_400_000).toISOString() });
  const elite = new Map<string, WalletQuality>([
    ["a", { address: "a", edge: 0.08, families: 10, firstHalfEdge: 0.05, secondHalfEdge: 0.06 }],
    ["b", { address: "b", edge: 0.05, families: 9, firstHalfEdge: 0.04, secondHalfEdge: 0.05 }]
  ]);
  const trades: Trade[] = [
    mk("a", "m1", 0, "BUY", 0.6, 200, 1), // elite YES
    mk("b", "m1", 0, "BUY", 0.7, 100, 0.5), // 2nd elite same side -> wallets=2
    mk("c", "m1", 0, "BUY", 0.5, 999, 0.1), // NON-elite -> excluded
    mk("a", "m2", 1, "BUY", 0.4, 50, 1), // below MIN_LIQUIDITY (50<100) -> dropped
    mk("a", "m3", 0, "SELL", 0.6, 500, 1), // SELL -> excluded
    mk("a", "m4", 0, "BUY", 0.95, 500, 1), // above MAX_PRICE -> excluded
    mk("a", "m5", 0, "BUY", 0.6, 500, 9) // too old (>freshDays) -> excluded
  ];
  const out = buildCandidates(trades, elite, now, { freshDays: 3, minPrice: 0.1, maxPrice: 0.9, minLiquidity: 100 });
  assert.equal(out.length, 1);
  assert.equal(out[0]!.wallets, 2);
  assert.equal(out[0]!.side, "YES");
  assert.ok(Math.abs(out[0]!.avgPrice - (0.6 * 200 + 0.7 * 100) / 300) < 1e-9);
  assert.ok(Math.abs(out[0]!.avgEliteEdge - (0.08 + 0.05) / 2) < 1e-9);
});

test("buildCandidates ranks more-agreement first", () => {
  const now = Date.parse("2026-07-05T00:00:00Z");
  const mk = (address: string, cond: string, price: number): Trade => ({ address, condition_id: cond, market: `Market ${cond}`, outcome_index: 0, side: "BUY", price, usdc_size: 500, traded_at: new Date(now).toISOString() });
  const elite = new Map<string, WalletQuality>(["a", "b", "c"].map((x) => [x, { address: x, edge: 0.05, families: 9, firstHalfEdge: 0.01, secondHalfEdge: 0.01 }]));
  const trades = [mk("a", "solo", 0.5), mk("a", "duo", 0.5), mk("b", "duo", 0.5)]; // duo has 2 wallets
  const out = buildCandidates(trades, elite, now, { freshDays: 3, minPrice: 0.1, maxPrice: 0.9, minLiquidity: 100 });
  assert.equal(out[0]!.conditionId, "duo");
});

// --- copyPnlPerDollar ---
test("copyPnlPerDollar: YES side wins / loses", () => {
  assert.ok(Math.abs(copyPnlPerDollar(0, 0.4, 1) - (1 / 0.4 - 1)) < 1e-9);
  assert.equal(copyPnlPerDollar(0, 0.4, 0), -1);
});
test("copyPnlPerDollar: NO side wins / loses", () => {
  assert.ok(Math.abs(copyPnlPerDollar(1, 0.3, 0) - (1 / 0.3 - 1)) < 1e-9);
  assert.equal(copyPnlPerDollar(1, 0.3, 1), -1);
});
