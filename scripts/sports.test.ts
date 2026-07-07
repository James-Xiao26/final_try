import test from "node:test";
import assert from "node:assert/strict";
import { isSportsText } from "./sports.js";

test("isSportsText: matches unambiguous sports texts across question/title/slug", () => {
  assert.ok(isSportsText("Lakers vs Celtics — NBA")); // league word
  assert.ok(isSportsText(null, "FIFA World Cup Final", null)); // event title
  assert.ok(isSportsText("Will Argentina win?", null, "fifa-world-cup-argentina-egypt")); // hyphenated slug
  assert.ok(isSportsText("Chiefs to win the Super Bowl"));
  assert.ok(isSportsText("Alcaraz to win Wimbledon"));
});

test("isSportsText: rejects non-sports (incl. bare 'vs' politics)", () => {
  assert.ok(!isSportsText("Trump vs Biden 2028")); // no league/sport term
  assert.ok(!isSportsText("Bitcoin above $100k?", null, "bitcoin-100k"));
  assert.ok(!isSportsText(null, null, null));
  assert.ok(!isSportsText("Will the Fed cut rates?"));
});
