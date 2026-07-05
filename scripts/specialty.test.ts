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

// Distinct non-numeric suffixes so each generated title is its own market FAMILY (marketFamilyKey
// strips numbers, so "market 1"/"market 2" would collapse — these words don't). walletSpecialty now
// counts distinct families, not positions, so a category needs MIN_SPECIALTY_TRADES separate families.
const FAMILY_SUFFIXES = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet", "kilo", "lima"];
function families(base: string, count: number, make: (market: string) => ClosedPosition): ClosedPosition[] {
  return FAMILY_SUFFIXES.slice(0, count).map((suffix) => make(`${base} ${suffix}`));
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
  const positions = [...families("Trump election", 10, winning), ...families("NBA game", 10, losing)];
  // Geopolitics: +edge, 10 families ≥ MIN; Sports: −edge, disqualified.
  assert.equal(walletSpecialty(positions, CONFIG), "Geopolitics");
});

test("walletSpecialty ranks by shrunk edge when multiple qualify", () => {
  const geopolitics = families("Senate race", 10, (m) => position({ market: m, outcome: 1, avgPrice: 0.7 })); // +0.3
  const crypto = families("Bitcoin above", 10, (m) => position({ market: m, outcome: 1, avgPrice: 0.5 })); // +0.5
  assert.equal(walletSpecialty([...geopolitics, ...crypto], CONFIG), "Crypto");
});

test("walletSpecialty returns null below the sample floor", () => {
  const positions = families("Trump election", CONFIG.MIN_SPECIALTY_TRADES - 1, winning);
  assert.equal(walletSpecialty(positions, CONFIG), null);
});

test("walletSpecialty returns null with no positive-edge category", () => {
  assert.equal(walletSpecialty(families("Trump election", 10, losing), CONFIG), null);
});

test("walletSpecialty ignores unresolved and unclassifiable positions", () => {
  const unresolved = families("Trump election", 10, (m) => position({ market: m, outcome: null }));
  const other = families("Denver snow", 10, winning);
  assert.equal(walletSpecialty([...unresolved, ...other], CONFIG), null);
});

test("walletSpecialty ignores recurring 'Up or Down' windowed positions, same carve-out as Skill Score", () => {
  const windowed = many(20, () => winning("Bitcoin Up or Down - May 31, 1:55PM-2:00PM ET"));
  // Would otherwise easily clear MIN_SPECIALTY_TRADES with a strong positive edge.
  assert.equal(walletSpecialty(windowed, CONFIG), null);
});

test("walletSpecialty no longer mints a chip from one recurring family grind (family-collapse)", () => {
  // 40 bets, all the same market family (date/number variants collapse) — one correlated observation,
  // not 40. Would clear the old per-position floor easily; now counts as a single family < MIN.
  const grind = [
    ...many(20, () => winning("Elon posts 200-219 tweets this week")),
    ...many(20, () => winning("Elon posts 40-64 tweets this week"))
  ];
  assert.equal(walletSpecialty(grind, CONFIG), null);
});
