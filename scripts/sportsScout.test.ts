import test from "node:test";
import assert from "node:assert/strict";
import { buildBets, type GameMarket, type HeldSide } from "./sportsScout.js";
import type { WalletEval } from "./eliteWallets.js";

const q = (edge: number): WalletEval => ({ edge, families: 10, firstHalfEdge: 0.02, secondHalfEdge: 0.02, firstHalfFamilies: 5, secondHalfFamilies: 5 });
const game = (id: string): GameMarket => ({ conditionId: id, gameStartMs: Date.now() + 3_600_000, endMs: Date.now() + 7_200_000, eventTitle: `Event ${id}`, question: `Q ${id}`, outcomes: ["Home", "Away"], prices: [0.6, 0.4], liquidity: 50_000 });

test("buildBets aggregates only GOOD wallets per (game, side); dedups wallets, sums $, means edge", () => {
  const games = new Map<string, GameMarket>([["m1", game("m1")]]);
  const evals = new Map<string, WalletEval>([
    ["a", q(0.10)], // good
    ["b", q(0.06)], // good
    ["c", q(-0.01)] // NOT good -> excluded
  ]);
  const held: HeldSide[] = [
    { conditionId: "m1", outcomeIndex: 0, address: "a", shares: 100 }, // Home, $ = 100*0.6
    { conditionId: "m1", outcomeIndex: 0, address: "b", shares: 50 }, // Home 2nd wallet
    { conditionId: "m1", outcomeIndex: 0, address: "a", shares: 20 }, // same wallet again -> shares add, not wallet
    { conditionId: "m1", outcomeIndex: 0, address: "c", shares: 999 }, // bad wallet -> ignored
    { conditionId: "m1", outcomeIndex: 1, address: "a", shares: 10 } // Away side -> separate bet
  ];
  const bets = buildBets(held, games, evals, (w) => w.edge > 0);
  const home = bets.find((b) => b.outcomeIndex === 0)!;
  assert.equal(home.wallets, 2); // a and b, not c; a not double-counted
  assert.ok(Math.abs(home.avgEdge - (0.10 + 0.06) / 2) < 1e-9);
  assert.ok(Math.abs(home.usd - (100 + 50 + 20) * 0.6) < 1e-9);
  assert.equal(home.price, 0.6);
  const away = bets.find((b) => b.outcomeIndex === 1)!;
  assert.equal(away.wallets, 1);
  // Away mean edge 0.10 (1 wallet) > Home mean edge 0.08 (2 wallets): edge-first ranking puts Away first;
  // agreement is only a tiebreak (the walk-forward finding wired into buildBets).
  assert.equal(bets[0]!.outcomeIndex, 1);
});

test("buildBets ignores holdings whose game isn't in the upcoming set", () => {
  const games = new Map<string, GameMarket>([["m1", game("m1")]]);
  const evals = new Map<string, WalletEval>([["a", q(0.1)]]);
  const held: HeldSide[] = [{ conditionId: "GONE", outcomeIndex: 0, address: "a", shares: 100 }];
  assert.equal(buildBets(held, games, evals, () => true).length, 0);
});

test("buildBets price band drops longshots/locks (and unknown prices) when bounds given", () => {
  // Home @0.60 in-band; Away @0.40 in-band; add a longshot market and a lock market.
  const longshot: GameMarket = { ...game("ls"), outcomes: ["Yes", "No"], prices: [0.04, 0.96] };
  const games = new Map<string, GameMarket>([["m1", game("m1")], ["ls", longshot]]);
  const evals = new Map<string, WalletEval>([["a", q(0.1)]]);
  const held: HeldSide[] = [
    { conditionId: "m1", outcomeIndex: 0, address: "a", shares: 100 }, // @0.60 kept
    { conditionId: "ls", outcomeIndex: 0, address: "a", shares: 100 }, // @0.04 longshot dropped
    { conditionId: "ls", outcomeIndex: 1, address: "a", shares: 100 } // @0.96 lock dropped
  ];
  const bets = buildBets(held, games, evals, () => true, { minPrice: 0.1, maxPrice: 0.9 });
  assert.equal(bets.length, 1);
  assert.equal(bets[0]!.g.conditionId, "m1");
  // Without bounds, all three sides survive.
  assert.equal(buildBets(held, games, evals, () => true).length, 3);
});
