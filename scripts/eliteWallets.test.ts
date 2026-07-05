import test from "node:test";
import assert from "node:assert/strict";
import { rankWallets, type ArchiveRow } from "./eliteWallets.js";

// Distinct family names so marketFamilyKey keeps them separate (letters, no dates/numbers to strip).
const FAMILIES = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet", "kilo", "lima"];
const row = (address: string, fam: string, outcome: number, price: number, day: number): ArchiveRow => ({
  address,
  market: `${fam} market outcome`,
  avg_price: price,
  outcome,
  close_time: new Date(2026, 0, day).toISOString()
});

const OPTS = { minFamilies: 6, minHalfFamilies: 3, minEdge: 0.02 };

test("rankWallets keeps a strong, consistent wallet", () => {
  // 12 distinct families, all won at 0.50 -> +0.50/family both halves.
  const rows = FAMILIES.map((f, i) => row("good", f, 1, 0.5, i + 1));
  const out = rankWallets(rows, OPTS);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.address, "good");
  assert.ok(out[0]!.edge > 0.02 && out[0]!.firstHalfEdge > 0 && out[0]!.secondHalfEdge > 0);
});

test("rankWallets rejects a one-lucky-streak wallet (fails the consistency gate)", () => {
  // Earliest 6 families lost, latest 6 won -> first-half edge negative even though overall is positive.
  const rows = FAMILIES.map((f, i) => row("lucky", f, i < 6 ? 0 : 1, 0.5, i + 1));
  assert.equal(rankWallets(rows, OPTS).length, 0);
});

test("rankWallets rejects a thin sample", () => {
  const rows = FAMILIES.slice(0, 4).map((f, i) => row("thin", f, 1, 0.5, i + 1));
  assert.equal(rankWallets(rows, OPTS).length, 0);
});

test("rankWallets rejects a real-but-tiny edge (below minEdge)", () => {
  // Won every time but only at 0.98 -> ~+0.02/family, shrunk well below the 0.02 floor.
  const rows = FAMILIES.map((f, i) => row("tiny", f, 1, 0.98, i + 1));
  assert.equal(rankWallets(rows, OPTS).length, 0);
});

test("rankWallets sorts by edge, best first", () => {
  const strong = FAMILIES.map((f, i) => row("strong", f, 1, 0.5, i + 1)); // +0.50/family
  const ok = FAMILIES.map((f, i) => row("ok", f, 1, 0.8, i + 1)); // +0.20/family
  const out = rankWallets([...strong, ...ok], OPTS);
  assert.deepEqual(out.map((w) => w.address), ["strong", "ok"]);
});
