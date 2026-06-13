import test from "node:test";
import assert from "node:assert/strict";
import { mapEvent } from "./polymarket.js";

// A representative Gamma /events record. Nested markets carry outcomePrices/groupItemTitle/spread
// in the JSON-string form Gamma returns most often.
function nestedMarket(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    groupItemTitle: "Spain",
    outcomes: "[\"Yes\", \"No\"]",
    outcomePrices: "[\"0.17\", \"0.83\"]",
    lastTradePrice: 0.17,
    spread: 0.004,
    ...overrides
  };
}

function eventRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "30615",
    title: "World Cup Winner",
    slug: "world-cup-winner",
    category: "Sports",
    liquidity: 299_790_000,
    volume: 1_400_000_000,
    volume24hr: 98_830_000,
    volume1wk: 120_000_000,
    endDate: "2026-07-20T00:00:00Z",
    image: "https://img/wc.png",
    active: true,
    closed: false,
    markets: [
      nestedMarket({ groupItemTitle: "France", outcomePrices: "[\"0.22\", \"0.78\"]", spread: 0.003 }),
      nestedMarket({ groupItemTitle: "Spain", outcomePrices: "[\"0.17\", \"0.83\"]", spread: 0.004 })
    ],
    ...overrides
  };
}

test("mapEvent rolls up event-level aggregate fields", () => {
  const event = mapEvent(eventRecord());
  assert.equal(event.id, "30615");
  assert.equal(event.question, "World Cup Winner");
  assert.equal(event.slug, "world-cup-winner");
  assert.equal(event.liquidityUsd, 299_790_000);
  assert.equal(event.volumeUsd, 1_400_000_000);
  assert.equal(event.volume24hrUsd, 98_830_000);
  assert.equal(event.volume1wkUsd, 120_000_000);
});

test("mapEvent surfaces the most-favored outcome (highest probability, not highest volume)", () => {
  const event = mapEvent(
    eventRecord({
      markets: [
        nestedMarket({ groupItemTitle: "France", outcomePrices: "[\"0.22\", \"0.78\"]", spread: 0.003, volume: 1_000 }),
        nestedMarket({ groupItemTitle: "Spain", outcomePrices: "[\"0.17\", \"0.83\"]", spread: 0.004, volume: 5_000 })
      ]
    })
  );
  // France has the higher implied probability, so it leads — even though Spain trades more volume.
  assert.equal(event.topOutcome, "France");
  assert.equal(event.currentPrice, 0.22);
  assert.equal(event.spread, 0.003);
});

test("mapEvent surfaces the favored (highest-probability) outcome's 24h price change", () => {
  const event = mapEvent(
    eventRecord({
      markets: [
        nestedMarket({ groupItemTitle: "France", outcomePrices: "[\"0.22\", \"0.78\"]", oneDayPriceChange: 0.05, volume: 1_000 }),
        nestedMarket({ groupItemTitle: "Spain", outcomePrices: "[\"0.17\", \"0.83\"]", oneDayPriceChange: -0.01, volume: 5_000 })
      ]
    })
  );
  // France leads by probability, so its change is surfaced (not Spain's).
  assert.equal(event.oneDayPriceChange, 0.05);
});

test("mapEvent surfaces the favored leg of a plain binary market (No when it leads)", () => {
  const event = mapEvent(
    eventRecord({
      markets: [nestedMarket({ groupItemTitle: "", outcomePrices: "[\"0.30\", \"0.70\"]", oneDayPriceChange: 0.04, spread: 0.01 })]
    })
  );
  // No is priced higher than Yes, so it's the favored outcome; its 24h move is the Yes leg inverted.
  assert.equal(event.topOutcome, "No");
  assert.equal(event.currentPrice, 0.7);
  assert.equal(event.oneDayPriceChange, -0.04);
});

test("mapEvent yields null 24h change when the field is absent", () => {
  assert.equal(mapEvent(eventRecord()).oneDayPriceChange, null);
});

test("mapEvent labels a plain binary market by its first outcome", () => {
  const event = mapEvent(
    eventRecord({
      markets: [nestedMarket({ groupItemTitle: "", outcomePrices: "[\"0.64\", \"0.36\"]", spread: 0.01 })]
    })
  );
  assert.equal(event.topOutcome, "Yes");
  assert.equal(event.currentPrice, 0.64);
  assert.equal(event.spread, 0.01);
});

test("mapEvent parses array-form nested prices too", () => {
  const event = mapEvent(
    eventRecord({ markets: [nestedMarket({ groupItemTitle: "Brazil", outcomePrices: [0.3, 0.7] })] })
  );
  assert.equal(event.topOutcome, "Brazil");
  assert.equal(event.currentPrice, 0.3);
});

test("mapEvent yields null price/outcome when there are no markets", () => {
  const event = mapEvent(eventRecord({ markets: [] }));
  assert.equal(event.currentPrice, null);
  assert.equal(event.topOutcome, null);
  assert.equal(event.spread, null);
});

test("mapEvent falls back to the first tag when no category, else null", () => {
  const tagged = mapEvent(eventRecord({ category: undefined, tags: [{ label: "Politics" }, { label: "US" }] }));
  assert.equal(tagged.category, "Politics");

  const none = mapEvent(eventRecord({ category: undefined, tags: undefined }));
  assert.equal(none.category, null);
});

test("mapEvent defaults missing aggregate numbers to 0 and maps status flags", () => {
  const event = mapEvent(eventRecord({ volume24hr: undefined, active: false, closed: true }));
  assert.equal(event.volume24hrUsd, 0);
  assert.equal(event.active, false);
  assert.equal(event.closed, true);
});
