import assert from "node:assert/strict";
import { test } from "node:test";
import { pnlBoardLabel } from "./format";

test("pnlBoardLabel maps known PnL-board codes to display labels", () => {
  assert.equal(pnlBoardLabel("pnl-all"), "All-Time PnL");
  assert.equal(pnlBoardLabel("pnl-month"), "Monthly PnL");
  assert.equal(pnlBoardLabel("pnl-week"), "Weekly PnL");
});

test("pnlBoardLabel returns null for an unknown code (forward-compatible)", () => {
  assert.equal(pnlBoardLabel("pnl-day"), null);
  assert.equal(pnlBoardLabel(""), null);
});
