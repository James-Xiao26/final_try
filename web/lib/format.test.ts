import assert from "node:assert/strict";
import { test } from "node:test";
import { parseChip } from "./format";

test("parseChip maps a PnL chip entry to label + rank + kind", () => {
  assert.deepEqual(parseChip("pnl-all:3"), { label: "All-Time PnL", rank: 3, kind: "pnl" });
  assert.deepEqual(parseChip("pnl-week:42"), { label: "Weekly PnL", rank: 42, kind: "pnl" });
});

test("parseChip maps a Volume chip entry and flags its kind", () => {
  assert.deepEqual(parseChip("vol-all:127"), { label: "All-Time Volume", rank: 127, kind: "vol" });
  assert.deepEqual(parseChip("vol-month:8"), { label: "Monthly Volume", rank: 8, kind: "vol" });
});

test("parseChip returns null for an unknown code or malformed rank", () => {
  assert.equal(parseChip("pnl-day:1"), null);   // unknown window
  assert.equal(parseChip("pnl-all"), null);     // no rank
  assert.equal(parseChip("pnl-all:NaN"), null); // non-numeric rank
  assert.equal(parseChip(""), null);
});
