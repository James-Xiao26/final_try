import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildRecommendations,
  computeConfidenceLevel,
  computeExpiryFactor,
  computeSignals,
  computeSmartMoneyPrice,
  type DECategoryWin,
  type DELeaderboardEntry,
  type DEMarket,
  type DEPosition,
  type DecisionEngineInputs,
} from "./decisionEngine";

// ── Factories ─────────────────────────────────────────────────────────────────

function mkEntry(p: Partial<DELeaderboardEntry> = {}): DELeaderboardEntry {
  return { address: "0xaaa", skillScore: 7.0, rank: 5, ...p };
}

function mkPos(p: Partial<DEPosition> = {}): DEPosition {
  return {
    address: "0xaaa",
    conditionId: "cond1",
    market: "Will it rain?",
    outcomeIndex: 0,
    size: 1000,
    avgPrice: 0.52,
    curPrice: 0.44,
    endDate: null,
    firstTradedAt: "2026-01-01T00:00:00Z",
    lastTradedAt: "2026-01-15T00:00:00Z",
    ...p,
  };
}

function mkMarket(p: Partial<DEMarket> = {}): DEMarket {
  return {
    conditionId: "cond1",
    question: "Will it rain?",
    slug: "will-it-rain",
    category: "Weather",
    liquidityUsd: 200_000,
    lastTradePrice: 0.44,
    endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    image: null,
    spread: 0.02,
    ...p,
  };
}

function mkInputs(overrides: Partial<DecisionEngineInputs> = {}): DecisionEngineInputs {
  return {
    leaderboard: [mkEntry()],
    positions: [mkPos()],
    markets: new Map([["cond1", mkMarket()]]),
    handles: new Map([["0xaaa", "alpha"]]),
    asOf: new Date("2026-06-01T00:00:00Z"),
    ...overrides,
  };
}

// ── computeSmartMoneyPrice ────────────────────────────────────────────────────

test("computeSmartMoneyPrice: single holder returns their avgPrice", () => {
  const result = computeSmartMoneyPrice([{ avgPrice: 0.52, skillScore: 8.0 }]);
  assert.ok(Math.abs(result - 0.52) < 1e-9);
});

test("computeSmartMoneyPrice: equal skills → simple average", () => {
  const result = computeSmartMoneyPrice([
    { avgPrice: 0.40, skillScore: 5.0 },
    { avgPrice: 0.60, skillScore: 5.0 },
  ]);
  assert.ok(Math.abs(result - 0.50) < 1e-9);
});

test("computeSmartMoneyPrice: higher-skill wallet dominates", () => {
  // skill 9 at 0.60, skill 3 at 0.30 → weighted toward 0.60
  const result = computeSmartMoneyPrice([
    { avgPrice: 0.60, skillScore: 9.0 },
    { avgPrice: 0.30, skillScore: 3.0 },
  ]);
  // expected: (9×0.60 + 3×0.30) / 12 = (5.40 + 0.90) / 12 = 6.30 / 12 = 0.525
  assert.ok(Math.abs(result - 0.525) < 1e-9);
});

test("computeSmartMoneyPrice: zero total weight returns 0", () => {
  assert.equal(computeSmartMoneyPrice([{ avgPrice: 0.5, skillScore: 0 }]), 0);
});

test("computeSmartMoneyPrice: empty array returns 0", () => {
  assert.equal(computeSmartMoneyPrice([]), 0);
});

// ── computeExpiryFactor ───────────────────────────────────────────────────────

test("computeExpiryFactor: null → 0.5", () => {
  assert.equal(computeExpiryFactor(null), 0.5);
});

test("computeExpiryFactor: 0 days (expired) → 0", () => {
  assert.equal(computeExpiryFactor(0), 0);
});

test("computeExpiryFactor: negative days → 0", () => {
  assert.equal(computeExpiryFactor(-1), 0);
});

test("computeExpiryFactor: < 7 days → 0.2", () => {
  assert.equal(computeExpiryFactor(3), 0.2);
  assert.equal(computeExpiryFactor(6), 0.2);
});

test("computeExpiryFactor: 7 days still maps to 1.0 (sweet spot starts at 7)", () => {
  assert.equal(computeExpiryFactor(7), 1.0);
});

test("computeExpiryFactor: 30 days → 1.0 (peak)", () => {
  assert.equal(computeExpiryFactor(30), 1.0);
});

test("computeExpiryFactor: 90 days → 0.85", () => {
  assert.equal(computeExpiryFactor(90), 0.85);
});

test("computeExpiryFactor: 180 days → 0.65", () => {
  assert.equal(computeExpiryFactor(180), 0.65);
});

test("computeExpiryFactor: 365 days → 0.4", () => {
  assert.equal(computeExpiryFactor(365), 0.4);
});

// ── computeConfidenceLevel ────────────────────────────────────────────────────

test("computeConfidenceLevel: 0/6 → low", () => {
  assert.equal(computeConfidenceLevel(0, 6), "low");
});

test("computeConfidenceLevel: 2/6 → low", () => {
  assert.equal(computeConfidenceLevel(2, 6), "low");
});

test("computeConfidenceLevel: 3/6 → medium", () => {
  assert.equal(computeConfidenceLevel(3, 6), "medium");
});

test("computeConfidenceLevel: 4/6 → high", () => {
  assert.equal(computeConfidenceLevel(4, 6), "high");
});

test("computeConfidenceLevel: 5/6 → very_high", () => {
  assert.equal(computeConfidenceLevel(5, 6), "very_high");
});

test("computeConfidenceLevel: 6/6 → very_high", () => {
  assert.equal(computeConfidenceLevel(6, 6), "very_high");
});

test("computeConfidenceLevel: 0 total signals → low", () => {
  assert.equal(computeConfidenceLevel(0, 0), "low");
});

// ── computeSignals ────────────────────────────────────────────────────────────

test("computeSignals: strong edge fires Signal 1 with 'strong'", () => {
  const sigs = computeSignals({
    edgeCents: 20, holderCount: 10, avgSkill: 8.0,
    topRank: 3, hadRecentBuy: true, liquidityUsd: 800_000, daysToExpiry: 45,
  });
  const s = sigs.find((x) => x.name === "Smart Money Premium");
  assert.ok(s?.fired);
  assert.equal(s?.strength, "strong");
});

test("computeSignals: edge below 5¢ does not fire Signal 1", () => {
  const sigs = computeSignals({
    edgeCents: 3, holderCount: 10, avgSkill: 8.0,
    topRank: 3, hadRecentBuy: true, liquidityUsd: 800_000, daysToExpiry: 45,
  });
  const s = sigs.find((x) => x.name === "Smart Money Premium");
  assert.ok(!s?.fired);
});

test("computeSignals: 2 holders does not fire Top Wallet Coverage", () => {
  const sigs = computeSignals({
    edgeCents: 10, holderCount: 2, avgSkill: 7.0,
    topRank: 5, hadRecentBuy: false, liquidityUsd: 200_000, daysToExpiry: 30,
  });
  const s = sigs.find((x) => x.name === "Top Wallet Coverage");
  assert.ok(!s?.fired);
});

test("computeSignals: topRank 12 fires Apex Conviction as 'weak' (outside the moderate threshold)", () => {
  // rank 12 <= 15 so the signal fires, but the 'moderate' tier requires rank <= 10 or avgSkill >= 7
  const sigs = computeSignals({
    edgeCents: 10, holderCount: 4, avgSkill: 6.0,
    topRank: 12, hadRecentBuy: false, liquidityUsd: 200_000, daysToExpiry: 30,
  });
  const s = sigs.find((x) => x.name === "Apex Conviction");
  assert.ok(s?.fired);
  assert.equal(s?.strength, "weak");
});

test("computeSignals: hadRecentBuy=false does not fire Recent Accumulation", () => {
  const sigs = computeSignals({
    edgeCents: 10, holderCount: 5, avgSkill: 7.0,
    topRank: 8, hadRecentBuy: false, liquidityUsd: 200_000, daysToExpiry: 30,
  });
  const s = sigs.find((x) => x.name === "Recent Accumulation");
  assert.ok(!s?.fired);
});

test("computeSignals: liquidity below 50K does not fire Market Depth", () => {
  const sigs = computeSignals({
    edgeCents: 10, holderCount: 5, avgSkill: 7.0,
    topRank: 8, hadRecentBuy: true, liquidityUsd: 30_000, daysToExpiry: 30,
  });
  const s = sigs.find((x) => x.name === "Market Depth");
  assert.ok(!s?.fired);
});

test("computeSignals: expiry 200d does not fire Resolution Window", () => {
  const sigs = computeSignals({
    edgeCents: 10, holderCount: 5, avgSkill: 7.0,
    topRank: 8, hadRecentBuy: true, liquidityUsd: 200_000, daysToExpiry: 200,
  });
  const s = sigs.find((x) => x.name === "Resolution Window");
  assert.ok(!s?.fired);
});

test("computeSignals: expiry null does not fire Resolution Window", () => {
  const sigs = computeSignals({
    edgeCents: 10, holderCount: 5, avgSkill: 7.0,
    topRank: 8, hadRecentBuy: true, liquidityUsd: 200_000, daysToExpiry: null,
  });
  const s = sigs.find((x) => x.name === "Resolution Window");
  assert.ok(!s?.fired);
});

// ── buildRecommendations: filtering ──────────────────────────────────────────

test("buildRecommendations: empty inputs → empty recommendations", () => {
  const result = buildRecommendations({
    leaderboard: [],
    positions: [],
    markets: new Map(),
    handles: new Map(),
    asOf: new Date(),
  });
  assert.equal(result.recommendations.length, 0);
  assert.equal(result.universeSummary.marketsScanned, 0);
});

test("buildRecommendations: produces a recommendation when all conditions met", () => {
  const inputs = mkInputs({
    leaderboard: [
      mkEntry({ address: "0xaaa", skillScore: 8.0, rank: 2 }),
      mkEntry({ address: "0xbbb", skillScore: 7.5, rank: 5 }),
      mkEntry({ address: "0xccc", skillScore: 6.0, rank: 12 }),
    ],
    positions: [
      mkPos({ address: "0xaaa", avgPrice: 0.55, curPrice: 0.44 }),
      mkPos({ address: "0xbbb", avgPrice: 0.50, curPrice: 0.44 }),
      mkPos({ address: "0xccc", avgPrice: 0.52, curPrice: 0.44 }),
    ],
    handles: new Map([["0xaaa", "alpha"], ["0xbbb", null], ["0xccc", "gamma"]]),
  });
  const result = buildRecommendations(inputs);
  assert.equal(result.recommendations.length, 1);
  const rec = result.recommendations[0];
  assert.ok(rec);
  assert.equal(rec.conditionId, "cond1");
  assert.equal(rec.side, "YES");
  assert.ok(rec.edgeCents > 0);
  assert.ok(rec.maxEntryPrice > rec.currentPrice);
  assert.ok(rec.maxEntryPrice < rec.smartMoneyPrice);
});

test("buildRecommendations: maxEntryPrice is between currentPrice and smartMoneyPrice", () => {
  const inputs = mkInputs({
    leaderboard: [
      mkEntry({ address: "0xaaa", skillScore: 8.0, rank: 2 }),
      mkEntry({ address: "0xbbb", skillScore: 7.0, rank: 5 }),
      mkEntry({ address: "0xccc", skillScore: 6.5, rank: 9 }),
    ],
    positions: [
      mkPos({ address: "0xaaa", avgPrice: 0.60, curPrice: 0.40 }),
      mkPos({ address: "0xbbb", avgPrice: 0.55, curPrice: 0.40 }),
      mkPos({ address: "0xccc", avgPrice: 0.58, curPrice: 0.40 }),
    ],
  });
  const result = buildRecommendations(inputs);
  assert.equal(result.recommendations.length, 1);
  const rec = result.recommendations[0];
  assert.ok(rec);
  assert.ok(rec.maxEntryPrice > rec.currentPrice, "maxEntry must exceed current");
  assert.ok(rec.maxEntryPrice < rec.smartMoneyPrice, "maxEntry must be below smart money");
});

test("buildRecommendations: negative edge is excluded", () => {
  // curPrice > avgPrice → smart money bought cheaper than market → no buy signal
  const inputs = mkInputs({
    leaderboard: [
      mkEntry({ address: "0xaaa", skillScore: 8.0, rank: 1 }),
      mkEntry({ address: "0xbbb", skillScore: 7.0, rank: 3 }),
      mkEntry({ address: "0xccc", skillScore: 6.0, rank: 6 }),
    ],
    positions: [
      mkPos({ address: "0xaaa", avgPrice: 0.35, curPrice: 0.55 }),
      mkPos({ address: "0xbbb", avgPrice: 0.38, curPrice: 0.55 }),
      mkPos({ address: "0xccc", avgPrice: 0.36, curPrice: 0.55 }),
    ],
  });
  const result = buildRecommendations(inputs);
  assert.equal(result.recommendations.length, 0);
});

test("buildRecommendations: too few smart-money holders (< 3 with skill >= 4) is excluded", () => {
  // Only 2 holders above MIN_SKILL
  const inputs = mkInputs({
    leaderboard: [
      mkEntry({ address: "0xaaa", skillScore: 7.0, rank: 3 }),
      mkEntry({ address: "0xbbb", skillScore: 6.5, rank: 7 }),
      mkEntry({ address: "0xccc", skillScore: 2.0, rank: 40 }), // below MIN_SKILL
    ],
    positions: [
      mkPos({ address: "0xaaa", avgPrice: 0.55, curPrice: 0.44 }),
      mkPos({ address: "0xbbb", avgPrice: 0.54, curPrice: 0.44 }),
      mkPos({ address: "0xccc", avgPrice: 0.52, curPrice: 0.44 }),
    ],
  });
  const result = buildRecommendations(inputs);
  assert.equal(result.recommendations.length, 0);
});

test("buildRecommendations: expired market (daysToExpiry <= 0) is excluded", () => {
  const asOf = new Date("2026-06-01T00:00:00Z");
  const expiredMarket = mkMarket({
    endDate: new Date(asOf.getTime() - 24 * 60 * 60 * 1000).toISOString(), // day before asOf
  });
  const inputs = mkInputs({
    leaderboard: [
      mkEntry({ address: "0xaaa", skillScore: 8.0, rank: 2 }),
      mkEntry({ address: "0xbbb", skillScore: 7.0, rank: 5 }),
      mkEntry({ address: "0xccc", skillScore: 6.0, rank: 10 }),
    ],
    positions: [
      mkPos({ address: "0xaaa", avgPrice: 0.55, curPrice: 0.44 }),
      mkPos({ address: "0xbbb", avgPrice: 0.54, curPrice: 0.44 }),
      mkPos({ address: "0xccc", avgPrice: 0.52, curPrice: 0.44 }),
    ],
    markets: new Map([["cond1", expiredMarket]]),
    asOf,
  });
  const result = buildRecommendations(inputs);
  assert.equal(result.recommendations.length, 0);
});

test("buildRecommendations: market with no metadata row is excluded", () => {
  const inputs = mkInputs({
    leaderboard: [
      mkEntry({ address: "0xaaa", skillScore: 8.0, rank: 2 }),
      mkEntry({ address: "0xbbb", skillScore: 7.0, rank: 5 }),
      mkEntry({ address: "0xccc", skillScore: 6.0, rank: 10 }),
    ],
    positions: [
      mkPos({ address: "0xaaa", conditionId: "unknown" }),
      mkPos({ address: "0xbbb", conditionId: "unknown" }),
      mkPos({ address: "0xccc", conditionId: "unknown" }),
    ],
    markets: new Map(), // no markets table row for "unknown"
  });
  const result = buildRecommendations(inputs);
  assert.equal(result.recommendations.length, 0);
});

test("buildRecommendations: below-minimum-liquidity market is excluded", () => {
  const lowLiqMarket = mkMarket({ liquidityUsd: 10_000 });
  const inputs = mkInputs({
    leaderboard: [
      mkEntry({ address: "0xaaa", skillScore: 8.0, rank: 2 }),
      mkEntry({ address: "0xbbb", skillScore: 7.0, rank: 5 }),
      mkEntry({ address: "0xccc", skillScore: 6.0, rank: 10 }),
    ],
    positions: [
      mkPos({ address: "0xaaa", avgPrice: 0.55, curPrice: 0.44 }),
      mkPos({ address: "0xbbb", avgPrice: 0.54, curPrice: 0.44 }),
      mkPos({ address: "0xccc", avgPrice: 0.52, curPrice: 0.44 }),
    ],
    markets: new Map([["cond1", lowLiqMarket]]),
  });
  const result = buildRecommendations(inputs);
  assert.equal(result.recommendations.length, 0);
});

test("buildRecommendations: dominant side is chosen when smart money is split", () => {
  // cond1: 2 YES holders (skill 8+7), 2 NO holders (skill 6+5) → YES dominates
  const inputs = mkInputs({
    leaderboard: [
      mkEntry({ address: "0xyes1", skillScore: 8.0, rank: 2 }),
      mkEntry({ address: "0xyes2", skillScore: 7.0, rank: 5 }),
      mkEntry({ address: "0xyes3", skillScore: 6.5, rank: 8 }),
      mkEntry({ address: "0xno1", skillScore: 6.0, rank: 12 }),
      mkEntry({ address: "0xno2", skillScore: 5.0, rank: 20 }),
      mkEntry({ address: "0xno3", skillScore: 4.5, rank: 30 }),
    ],
    positions: [
      mkPos({ address: "0xyes1", outcomeIndex: 0, avgPrice: 0.55, curPrice: 0.44, size: 2000 }),
      mkPos({ address: "0xyes2", outcomeIndex: 0, avgPrice: 0.54, curPrice: 0.44, size: 1500 }),
      mkPos({ address: "0xyes3", outcomeIndex: 0, avgPrice: 0.52, curPrice: 0.44, size: 1000 }),
      // NO holders with lower skill × capital
      mkPos({ address: "0xno1", outcomeIndex: 1, avgPrice: 0.50, curPrice: 0.56, size: 500 }),
      mkPos({ address: "0xno2", outcomeIndex: 1, avgPrice: 0.52, curPrice: 0.56, size: 400 }),
      mkPos({ address: "0xno3", outcomeIndex: 1, avgPrice: 0.48, curPrice: 0.56, size: 300 }),
    ],
  });
  const result = buildRecommendations(inputs);
  // Should produce exactly one recommendation (for YES), not two
  assert.equal(result.recommendations.length, 1);
  assert.equal(result.recommendations[0]?.side, "YES");
});

// ── buildRecommendations: ranking ─────────────────────────────────────────────

test("buildRecommendations: higher edge ranks above lower edge (all else equal)", () => {
  const asOf = new Date("2026-06-01T00:00:00Z");
  const expiry = new Date(asOf.getTime() + 45 * 24 * 60 * 60 * 1000).toISOString();

  const markets = new Map([
    ["condA", mkMarket({ conditionId: "condA", question: "Market A", endDate: expiry })],
    ["condB", mkMarket({ conditionId: "condB", question: "Market B", endDate: expiry })],
  ]);

  const leaderboard = [
    mkEntry({ address: "0xa1", skillScore: 7.0, rank: 3 }),
    mkEntry({ address: "0xa2", skillScore: 7.0, rank: 4 }),
    mkEntry({ address: "0xa3", skillScore: 7.0, rank: 5 }),
    mkEntry({ address: "0xb1", skillScore: 7.0, rank: 6 }),
    mkEntry({ address: "0xb2", skillScore: 7.0, rank: 7 }),
    mkEntry({ address: "0xb3", skillScore: 7.0, rank: 8 }),
  ];

  const positions = [
    // condA: large edge (smart money at 0.65, current 0.44)
    mkPos({ address: "0xa1", conditionId: "condA", avgPrice: 0.65, curPrice: 0.44 }),
    mkPos({ address: "0xa2", conditionId: "condA", avgPrice: 0.65, curPrice: 0.44 }),
    mkPos({ address: "0xa3", conditionId: "condA", avgPrice: 0.65, curPrice: 0.44 }),
    // condB: small edge (smart money at 0.50, current 0.44)
    mkPos({ address: "0xb1", conditionId: "condB", avgPrice: 0.50, curPrice: 0.44 }),
    mkPos({ address: "0xb2", conditionId: "condB", avgPrice: 0.50, curPrice: 0.44 }),
    mkPos({ address: "0xb3", conditionId: "condB", avgPrice: 0.50, curPrice: 0.44 }),
  ];

  const result = buildRecommendations({ leaderboard, positions, markets, handles: new Map(), asOf });
  assert.equal(result.recommendations.length, 2);
  assert.equal(result.recommendations[0]?.conditionId, "condA");
  assert.equal(result.recommendations[1]?.conditionId, "condB");
});

test("buildRecommendations: maxResults caps the output", () => {
  const asOf = new Date("2026-06-01T00:00:00Z");
  const expiry = new Date(asOf.getTime() + 45 * 24 * 60 * 60 * 1000).toISOString();

  // Build 5 distinct markets with 3 holders each
  const nMarkets = 5;
  const leaderboard: DELeaderboardEntry[] = [];
  const positions: DEPosition[] = [];
  const markets = new Map<string, DEMarket>();

  for (let m = 0; m < nMarkets; m++) {
    const cid = `cond${m}`;
    markets.set(cid, mkMarket({ conditionId: cid, question: `Market ${m}`, endDate: expiry }));
    for (let w = 0; w < 3; w++) {
      const addr = `0x${m}${w}`;
      leaderboard.push(mkEntry({ address: addr, skillScore: 7.0, rank: m * 3 + w + 1 }));
      positions.push(mkPos({ address: addr, conditionId: cid, avgPrice: 0.55, curPrice: 0.44 }));
    }
  }

  const result = buildRecommendations(
    { leaderboard, positions, markets, handles: new Map(), asOf },
    { maxResults: 3 }
  );
  assert.equal(result.recommendations.length, 3);
});

// ── buildRecommendations: signals ─────────────────────────────────────────────

test("buildRecommendations: hadRecentBuy is true when a holder's lastTradedAt is within 7 days", () => {
  // asOf = 2026-06-01; lastTradedAt 3 days prior → Recent Accumulation should fire
  const asOf = new Date("2026-06-01T00:00:00Z");
  const recentTs = new Date(asOf.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const inputs = mkInputs({
    leaderboard: [
      mkEntry({ address: "0xaaa", skillScore: 8.0, rank: 2 }),
      mkEntry({ address: "0xbbb", skillScore: 7.0, rank: 5 }),
      mkEntry({ address: "0xccc", skillScore: 6.5, rank: 9 }),
    ],
    positions: [
      mkPos({ address: "0xaaa", avgPrice: 0.55, curPrice: 0.44, lastTradedAt: recentTs }),
      mkPos({ address: "0xbbb", avgPrice: 0.54, curPrice: 0.44 }),
      mkPos({ address: "0xccc", avgPrice: 0.52, curPrice: 0.44 }),
    ],
    asOf,
  });
  const result = buildRecommendations(inputs);
  assert.equal(result.recommendations.length, 1);
  const rec = result.recommendations[0];
  assert.ok(rec);
  const recentSig = rec.signals.find((s) => s.name === "Recent Accumulation");
  assert.ok(recentSig?.fired, "Recent Accumulation should fire");
});

test("buildRecommendations: confidence level maps correctly from signalsFired", () => {
  // Set up all 6 signals to fire: >5¢ edge, 10 holders, rank ≤5, recent lastTradedAt, >500K liq, 30d expiry
  const asOf = new Date("2026-06-01T00:00:00Z");
  const expiry = new Date(asOf.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const recentTs = new Date(asOf.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString();

  const leaderboard: DELeaderboardEntry[] = Array.from({ length: 10 }, (_, i) => ({
    address: `0x${i.toString().padStart(3, "0")}`,
    skillScore: 7.5,
    rank: i + 1,
  }));
  const positions: DEPosition[] = leaderboard.map((e, i) =>
    mkPos({ address: e.address, avgPrice: 0.60, curPrice: 0.44, lastTradedAt: i === 0 ? recentTs : "2026-01-01T00:00:00Z" })
  );
  const market = mkMarket({ liquidityUsd: 600_000, endDate: expiry });

  const result = buildRecommendations({
    leaderboard,
    positions,
    markets: new Map([["cond1", market]]),
    handles: new Map(),
    asOf,
  });

  assert.equal(result.recommendations.length, 1);
  const rec = result.recommendations[0];
  assert.ok(rec);
  assert.equal(rec.signalsFired, 6, "All 6 signals should fire");
  assert.equal(rec.confidenceLevel, "very_high");
});

// ── buildRecommendations: personalization ─────────────────────────────────────

test("buildRecommendations: personalizedBoost is set for matching strong categories", () => {
  const categoryWins: DECategoryWin[] = [
    { category: "Weather", wins: 8, total: 10, winRate: 0.80 },
  ];
  const inputs = mkInputs({
    leaderboard: [
      mkEntry({ address: "0xaaa", skillScore: 8.0, rank: 2 }),
      mkEntry({ address: "0xbbb", skillScore: 7.0, rank: 5 }),
      mkEntry({ address: "0xccc", skillScore: 6.5, rank: 9 }),
    ],
    positions: [
      mkPos({ address: "0xaaa", avgPrice: 0.55, curPrice: 0.44 }),
      mkPos({ address: "0xbbb", avgPrice: 0.54, curPrice: 0.44 }),
      mkPos({ address: "0xccc", avgPrice: 0.52, curPrice: 0.44 }),
    ],
    categoryWins,
  });
  const result = buildRecommendations(inputs);
  assert.equal(result.recommendations.length, 1);
  assert.ok(result.recommendations[0]?.personalizedBoost);
});

test("buildRecommendations: personalizedBoost is false for weak category match (winRate < 0.55)", () => {
  const categoryWins: DECategoryWin[] = [
    { category: "Weather", wins: 5, total: 10, winRate: 0.50 },
  ];
  const inputs = mkInputs({
    leaderboard: [
      mkEntry({ address: "0xaaa", skillScore: 8.0, rank: 2 }),
      mkEntry({ address: "0xbbb", skillScore: 7.0, rank: 5 }),
      mkEntry({ address: "0xccc", skillScore: 6.5, rank: 9 }),
    ],
    positions: [
      mkPos({ address: "0xaaa", avgPrice: 0.55, curPrice: 0.44 }),
      mkPos({ address: "0xbbb", avgPrice: 0.54, curPrice: 0.44 }),
      mkPos({ address: "0xccc", avgPrice: 0.52, curPrice: 0.44 }),
    ],
    categoryWins,
  });
  const result = buildRecommendations(inputs);
  assert.ok(!result.recommendations[0]?.personalizedBoost);
});

test("buildRecommendations: personalizedBoost raises rankingScore by PERSONALIZATION_BOOST factor", () => {
  const asOf = new Date("2026-06-01T00:00:00Z");
  const expiry = new Date(asOf.getTime() + 45 * 24 * 60 * 60 * 1000).toISOString();

  // condA: "Weather" (personalized), condB: "Politics" (not personalized), identical signals
  const markets = new Map([
    ["condA", mkMarket({ conditionId: "condA", question: "Will it rain?", category: "Weather", endDate: expiry })],
    ["condB", mkMarket({ conditionId: "condB", question: "Will they win?", category: "Politics", endDate: expiry })],
  ]);

  const leaderboard: DELeaderboardEntry[] = [
    ...["0xa1", "0xa2", "0xa3"].map((addr, i) => mkEntry({ address: addr, skillScore: 7.0, rank: i + 1 })),
    ...["0xb1", "0xb2", "0xb3"].map((addr, i) => mkEntry({ address: addr, skillScore: 7.0, rank: i + 4 })),
  ];
  const positions: DEPosition[] = [
    ...["0xa1", "0xa2", "0xa3"].map((addr) => mkPos({ address: addr, conditionId: "condA", avgPrice: 0.55, curPrice: 0.44 })),
    ...["0xb1", "0xb2", "0xb3"].map((addr) => mkPos({ address: addr, conditionId: "condB", avgPrice: 0.55, curPrice: 0.44 })),
  ];

  const result = buildRecommendations(
    {
      leaderboard, positions, markets, handles: new Map(), asOf,
      categoryWins: [{ category: "Weather", wins: 8, total: 10, winRate: 0.80 }],
    }
  );

  // condA should rank first because of the personalization boost
  assert.equal(result.recommendations[0]?.conditionId, "condA");
  assert.ok(result.recommendations[0]?.personalizedBoost);
  assert.ok(!result.recommendations[1]?.personalizedBoost);
});

// ── buildRecommendations: warnings ────────────────────────────────────────────

test("buildRecommendations: near-expiry warning fires when daysToExpiry < 14", () => {
  const asOf = new Date("2026-06-01T00:00:00Z");
  const expiry = new Date(asOf.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days
  const market = mkMarket({ endDate: expiry });
  const inputs = mkInputs({
    leaderboard: [
      mkEntry({ address: "0xaaa", skillScore: 8.0, rank: 2 }),
      mkEntry({ address: "0xbbb", skillScore: 7.0, rank: 5 }),
      mkEntry({ address: "0xccc", skillScore: 6.5, rank: 9 }),
    ],
    positions: [
      mkPos({ address: "0xaaa", avgPrice: 0.55, curPrice: 0.44 }),
      mkPos({ address: "0xbbb", avgPrice: 0.54, curPrice: 0.44 }),
      mkPos({ address: "0xccc", avgPrice: 0.52, curPrice: 0.44 }),
    ],
    markets: new Map([["cond1", market]]),
    asOf,
  });
  const result = buildRecommendations(inputs);
  const rec = result.recommendations[0];
  assert.ok(rec);
  assert.ok(rec.warnings.some((w) => w.includes("Resolves in")), "should warn about short runway");
});

test("buildRecommendations: wide spread triggers warning", () => {
  const wideSpreadMarket = mkMarket({ spread: 0.08 });
  const inputs = mkInputs({
    leaderboard: [
      mkEntry({ address: "0xaaa", skillScore: 8.0, rank: 2 }),
      mkEntry({ address: "0xbbb", skillScore: 7.0, rank: 5 }),
      mkEntry({ address: "0xccc", skillScore: 6.5, rank: 9 }),
    ],
    positions: [
      mkPos({ address: "0xaaa", avgPrice: 0.55, curPrice: 0.44 }),
      mkPos({ address: "0xbbb", avgPrice: 0.54, curPrice: 0.44 }),
      mkPos({ address: "0xccc", avgPrice: 0.52, curPrice: 0.44 }),
    ],
    markets: new Map([["cond1", wideSpreadMarket]]),
  });
  const result = buildRecommendations(inputs);
  const rec = result.recommendations[0];
  assert.ok(rec);
  assert.ok(rec.warnings.some((w) => w.includes("spread")), "should warn about wide spread");
});

// ── buildRecommendations: universe summary ────────────────────────────────────

test("buildRecommendations: universeSummary reflects the scanned universe", () => {
  const asOf = new Date("2026-06-01T00:00:00Z");
  const markets = new Map([
    ["condA", mkMarket({ conditionId: "condA", question: "A" })],
    ["condB", mkMarket({ conditionId: "condB", question: "B" })],
  ]);
  const result = buildRecommendations({
    leaderboard: [mkEntry({ address: "0xaaa" })],
    positions: [],
    markets,
    handles: new Map(),
    asOf,
  });
  assert.equal(result.universeSummary.marketsScanned, 2);
  assert.equal(result.universeSummary.totalLeaderboardHolders, 1);
  assert.equal(result.universeSummary.marketsWithSmartMoney, 0);
});

test("buildRecommendations: disclaimer is always present", () => {
  const result = buildRecommendations(mkInputs());
  assert.ok(result.disclaimer.length > 0);
  assert.ok(result.disclaimer.includes("lose"));
});

// ── buildRecommendations: deduplication across horizons ───────────────────────

test("buildRecommendations: duplicate leaderboard entries (two horizons) take best skill+rank", () => {
  // Same address appears twice (30d and 90d leaderboard rows) — only the better one should count
  const inputs = mkInputs({
    leaderboard: [
      mkEntry({ address: "0xaaa", skillScore: 7.0, rank: 10 }), // 30d row
      mkEntry({ address: "0xaaa", skillScore: 8.5, rank: 3 }),  // 90d row (better)
      mkEntry({ address: "0xbbb", skillScore: 6.0, rank: 8 }),
      mkEntry({ address: "0xccc", skillScore: 5.5, rank: 15 }),
    ],
    positions: [
      mkPos({ address: "0xaaa", avgPrice: 0.55, curPrice: 0.44 }),
      mkPos({ address: "0xbbb", avgPrice: 0.54, curPrice: 0.44 }),
      mkPos({ address: "0xccc", avgPrice: 0.52, curPrice: 0.44 }),
    ],
  });
  const result = buildRecommendations(inputs);
  assert.equal(result.recommendations.length, 1);
  const rec = result.recommendations[0];
  assert.ok(rec);
  // The top holder should reflect the deduped best (skill 8.5, rank 3)
  const topHolder = rec.topHolders.find((h) => h.address === "0xaaa");
  assert.ok(topHolder);
  assert.equal(topHolder.skillScore, 8.5);
  assert.equal(topHolder.rank, 3);
});
