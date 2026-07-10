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

test("isSportsText: catches team-matchup markets via their sport slug prefix", () => {
  // Bare matchup titles have no league word — the slug prefix is what identifies the sport.
  assert.ok(isSportsText("Athletics vs. Detroit Tigers: O/U 5.5", null, "mlb-ath-det-2026-07-07"));
  assert.ok(isSportsText("Will Spain win on 2026-07-06?", null, "fifwc-prt-esp-2026-07-06"));
  assert.ok(isSportsText("LoL: T1 vs FURIA - Game 1 Winner", null, "lol-t1-fur-2026-07-06")); // esports
  assert.ok(!isSportsText("Athletics vs. Detroit Tigers")); // no slug, no league word -> not matched
});

test("isSportsText: rejects non-sports (incl. bare 'vs' politics)", () => {
  assert.ok(!isSportsText("Trump vs Biden 2028")); // no league/sport term
  assert.ok(!isSportsText("Bitcoin above $100k?", null, "bitcoin-100k"));
  assert.ok(!isSportsText(null, null, null));
  assert.ok(!isSportsText("Will the Fed cut rates?"));
});
