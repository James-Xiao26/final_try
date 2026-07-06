// Personal trade tracker for the copylist method — "is this actually making me money?"
//
//   pnpm --filter edgeboard-scripts trades
//
// Records the real trades you took by mirroring copyList, auto-resolves the settled ones via Gamma/UMA
// (same authoritative source as the forward test), and prints your realized P/L + win rate. You don't
// edit the file by hand: tell Claude "I bought <side> on <market> at <price> for $<stake>" and it appends
// a row (looking up the condition_id so this can auto-resolve it later). This command then settles + scores.
//
// P/L per trade: you buy `stake` USD of the bet side at `price` => shares = stake/price, each paying $1
// if it wins. Win  => profit = stake*(1/price - 1);  Loss => profit = -stake.
import { config as loadEnv } from "dotenv";
import { PolymarketClient } from "./polymarket.js";
import { strict as assert } from "node:assert";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

loadEnv({ path: "../.env.local" });
loadEnv();

const LOG_PATH = fileURLToPath(new URL("./tradesLog.json", import.meta.url));

export interface Trade {
  date: string; // when you bought, YYYY-MM-DD
  market: string; // human market name, e.g. "Mexico vs. England: Team to Advance"
  bet: string; // the exact side you bought, e.g. "Mexico" / "Over" / "Yes"
  conditionId: string; // Polymarket condition_id (for auto-resolution)
  outcomeIndex: number; // which outcome you bought (0 or 1); index 0 is the YES/first side
  price: number; // price you paid (0–1)
  stakeUsd: number; // dollars you put in
  resolvedOutcome: number | null; // filled in by this script: 1 if YES(index0) won, 0 if NO(index1) won
  resolvedAt: string | null;
  note?: string;
}

// Did this trade win, and what's the profit? null outcome => still open (profit null).
export function tradePnl(t: Trade): { won: boolean | null; profit: number | null } {
  if (t.resolvedOutcome === null) return { won: null, profit: null };
  const betSideWon = (t.outcomeIndex === 0 ? t.resolvedOutcome : 1 - t.resolvedOutcome) === 1;
  return { won: betSideWon, profit: betSideWon ? t.stakeUsd * (1 / t.price - 1) : -t.stakeUsd };
}

function load(): Trade[] {
  try {
    return JSON.parse(readFileSync(LOG_PATH, "utf8")) as Trade[];
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  selfCheck();
  const trades = load();
  if (trades.length === 0) {
    console.log("No trades logged yet. Tell Claude the trades you took (side, market, price, stake) and it'll add them.");
    return;
  }

  // Resolve any still-open trades via Gamma/UMA (authoritative settlement).
  const client = new PolymarketClient();
  let newly = 0;
  for (const t of trades) {
    if (t.resolvedOutcome !== null) continue;
    const outcome = await client.getResolvedOutcome(t.conditionId).catch(() => null);
    if (outcome === null) continue;
    t.resolvedOutcome = outcome;
    t.resolvedAt = new Date().toISOString();
    newly += 1;
  }
  if (newly > 0) writeFileSync(LOG_PATH, JSON.stringify(trades, null, 2) + "\n");

  const resolved = trades.filter((t) => t.resolvedOutcome !== null);
  const open = trades.filter((t) => t.resolvedOutcome === null);

  console.log(`\n=== YOUR COPYLIST TRADES (${trades.length} total, ${newly} newly settled) ===\n`);
  if (resolved.length > 0) {
    console.log(`SETTLED (${resolved.length}):`);
    for (const t of resolved) {
      const { won, profit } = tradePnl(t);
      const tag = won ? "WIN " : "LOSS";
      const p = `${profit! >= 0 ? "+" : "-"}$${Math.abs(profit!).toFixed(2)}`;
      console.log(`  ${won ? "✓" : "✗"} ${tag}  ${t.bet.slice(0, 14).padEnd(14)} @${t.price.toFixed(2)}  stake $${t.stakeUsd.toFixed(2)} -> ${p.padStart(7)}   ${t.market.slice(0, 46)}`);
    }
    const staked = resolved.reduce((a, t) => a + t.stakeUsd, 0);
    const profit = resolved.reduce((a, t) => a + (tradePnl(t).profit ?? 0), 0);
    const wins = resolved.filter((t) => tradePnl(t).won).length;
    console.log(`\n  Staked $${staked.toFixed(2)} -> profit ${profit >= 0 ? "+" : "-"}$${Math.abs(profit).toFixed(2)}  (ROI ${((profit / staked) * 100).toFixed(0)}%)   win rate ${wins}/${resolved.length} (${((wins / resolved.length) * 100).toFixed(0)}%)`);
  }
  if (open.length > 0) {
    console.log(`\nOPEN (${open.length}, not settled yet):`);
    for (const t of open) console.log(`  …  ${t.bet.slice(0, 14).padEnd(14)} @${t.price.toFixed(2)}  stake $${t.stakeUsd.toFixed(2)}   ${t.market.slice(0, 46)}`);
    console.log(`  Open exposure: $${open.reduce((a, t) => a + t.stakeUsd, 0).toFixed(2)} (run again after they resolve).`);
  }
  console.log(`\n(This is your REAL track record for the copylist method — the honest test of whether it works.)`);
}

function selfCheck(): void {
  // Bought YES-side (index 0) at 0.40 for $1; YES won (resolved 1) => profit $1*(1/0.4 - 1) = $1.5.
  const win = tradePnl({ date: "", market: "", bet: "Yes", conditionId: "", outcomeIndex: 0, price: 0.4, stakeUsd: 1, resolvedOutcome: 1, resolvedAt: null });
  assert.equal(win.won, true);
  assert.ok(Math.abs(win.profit! - 1.5) < 1e-9);
  // Bought NO-side (index 1) at 0.30 for $1; YES won (resolved 1) => your NO side lost => -$1.
  const loss = tradePnl({ date: "", market: "", bet: "No", conditionId: "", outcomeIndex: 1, price: 0.3, stakeUsd: 1, resolvedOutcome: 1, resolvedAt: null });
  assert.equal(loss.won, false);
  assert.equal(loss.profit, -1);
  // NO-side (index 1) at 0.30, NO won (resolved 0) => win, profit $1*(1/0.3 - 1).
  const noWin = tradePnl({ date: "", market: "", bet: "No", conditionId: "", outcomeIndex: 1, price: 0.3, stakeUsd: 1, resolvedOutcome: 0, resolvedAt: null });
  assert.equal(noWin.won, true);
  assert.ok(Math.abs(noWin.profit! - (1 / 0.3 - 1)) < 1e-9);
  // Unresolved => null.
  assert.equal(tradePnl({ date: "", market: "", bet: "Yes", conditionId: "", outcomeIndex: 0, price: 0.4, stakeUsd: 1, resolvedOutcome: null, resolvedAt: null }).profit, null);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
