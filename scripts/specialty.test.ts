import test from "node:test";
import assert from "node:assert/strict";
import { CONFIG } from "./config.js";
import { classifyMarket, walletSpecialty } from "./specialty.js";
import type { ClosedPosition } from "./polymarket.js";

function position(overrides: Partial<ClosedPosition> = {}): ClosedPosition {
  return {
    proxyWallet: "0xabc",
    asset: "asset",
    conditionId: "cond",
    market: "market",
    outcomeIndex: 0,
    size: 100,
    avgPrice: 0.5,
    realizedPnl: 0,
    closeTime: new Date().toISOString(),
    outcome: 1,
    outcomeLabel: null,
    eventSlug: null,
    ...overrides
  };
}

// A resolved position whose entry price beat (outcome 1) or missed (outcome 0) the result.
function winning(market: string): ClosedPosition {
  return position({ market, outcome: 1, avgPrice: 0.5 }); // +0.5 edge/share
}
function losing(market: string): ClosedPosition {
  return position({ market, outcome: 0, avgPrice: 0.6 }); // -0.6 edge/share
}

function many(n: number, make: () => ClosedPosition): ClosedPosition[] {
  return Array.from({ length: n }, make);
}

test("classifyMarket buckets titles by keyword, null for unclassifiable", () => {
  assert.equal(classifyMarket("Will Trump win Pennsylvania in the election?"), "Geopolitics");
  assert.equal(classifyMarket("Bitcoin above $100k by year end?"), "Crypto");
  assert.equal(classifyMarket("Lakers vs Celtics — who wins Game 7?"), "Sports");
  assert.equal(classifyMarket("Will the Fed cut the interest rate in March?"), "Economy");
  assert.equal(classifyMarket("Russia–Ukraine ceasefire before July?"), "Geopolitics");
  assert.equal(classifyMarket("Best Picture winner at the Oscars?"), "Culture");
  assert.equal(classifyMarket("Will it rain in Seattle tomorrow?"), null);
});

test("word boundaries prevent substring false positives", () => {
  // "eth" must not match inside "ethics"; "vs" must not match inside "vsync".
  assert.equal(classifyMarket("Senate ethics committee ruling?"), "Geopolitics");
  assert.notEqual(classifyMarket("vsync display standard adopted?"), "Sports");
});

test("Geopolitics is matched before Sports' generic 'vs'", () => {
  assert.equal(classifyMarket("Trump vs Biden: who wins the debate?"), "Geopolitics");
});

test("walletSpecialty picks the strongest qualifying category", () => {
  const positions = [...many(10, () => winning("Trump 2024 election")), ...many(10, () => losing("Lakers vs Celtics"))];
  // Geopolitics: +edge, n=10 ≥ MIN; Sports: −edge, disqualified.
  assert.equal(walletSpecialty(positions, CONFIG), "Geopolitics");
});

test("walletSpecialty ranks by shrunk edge when multiple qualify", () => {
  const geopolitics = many(10, () => position({ market: "Senate race 2024", outcome: 1, avgPrice: 0.7 })); // +0.3
  const crypto = many(10, () => position({ market: "Bitcoin to $100k", outcome: 1, avgPrice: 0.5 })); // +0.5
  assert.equal(walletSpecialty([...geopolitics, ...crypto], CONFIG), "Crypto");
});

test("walletSpecialty returns null below the sample floor", () => {
  const positions = many(CONFIG.MIN_SPECIALTY_TRADES - 1, () => winning("Trump 2024 election"));
  assert.equal(walletSpecialty(positions, CONFIG), null);
});

test("walletSpecialty returns null with no positive-edge category", () => {
  assert.equal(walletSpecialty(many(12, () => losing("Trump 2024 election")), CONFIG), null);
});

test("walletSpecialty ignores unresolved and unclassifiable positions", () => {
  const unresolved = many(12, () => position({ market: "Trump 2024 election", outcome: null }));
  const other = many(12, () => winning("Will it snow in Denver this week?"));
  assert.equal(walletSpecialty([...unresolved, ...other], CONFIG), null);
});
