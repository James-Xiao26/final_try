// Shared candidate-building for the copylist tools (copyList.ts view + copylistForward.ts test).
// Pure — no I/O, no top-level side effects — so both can import it (copyList.ts runs main() on import,
// so the shared logic can't live there). Unit-tested via copyList's selfCheck + copylistForward.
import type { WalletQuality } from "./eliteWallets.js";

export interface Trade {
  address: string;
  condition_id: string | null;
  market: string | null;
  outcome_index: number | null;
  side: string;
  price: number;
  usdc_size: number;
  traded_at: string;
}

export interface Candidate {
  conditionId: string;
  outcomeIndex: number;
  question: string;
  side: "YES" | "NO";
  wallets: number;
  avgEliteEdge: number; // mean historical per-share edge of the elite wallets copying this side
  usd: number;
  avgPrice: number;
  latestAgeDays: number;
}

// Collapse fresh ELITE BUYs into one candidate per (market, side): distinct elite wallets on it, mean
// elite edge, total $, $-weighted avg entry price, freshest trade. Only trades from wallets in the
// `elite` map count. Pure so it's unit-testable. Ranked best-first: EDGE, then agreement, then size —
// the walk-forward policy search (backtestCopylist.ts) found edge-ranked top slices beat agreement-
// ranked ones decisively out-of-time (+0.93 vs +0.41 $/$1 top-10%), and the in-band agreement
// gradient is flat, so agreement is a tiebreak, not the signal.
export function buildCandidates(trades: Trade[], elite: Map<string, WalletQuality>, nowMs: number, opts: { freshDays: number; minPrice: number; maxPrice: number; minLiquidity: number }): Candidate[] {
  const ageDays = (t: string): number => (nowMs - Date.parse(t)) / 86_400_000;
  const fresh = trades.filter(
    (t) =>
      t.side === "BUY" &&
      t.condition_id !== null &&
      ageDays(t.traded_at) <= opts.freshDays &&
      elite.has(t.address) &&
      t.price >= opts.minPrice &&
      t.price <= opts.maxPrice
  );
  const agg = new Map<string, { conditionId: string; outcomeIndex: number; question: string; yes: boolean; wallets: Set<string>; usd: number; pSum: number; latest: string }>();
  for (const t of fresh) {
    const key = `${t.condition_id}:${t.outcome_index}`;
    const g = agg.get(key) ?? { conditionId: t.condition_id!, outcomeIndex: t.outcome_index ?? 0, question: t.market ?? "(unknown)", yes: t.outcome_index === 0, wallets: new Set<string>(), usd: 0, pSum: 0, latest: t.traded_at };
    g.wallets.add(t.address);
    g.usd += t.usdc_size;
    g.pSum += t.price * t.usdc_size;
    if (t.traded_at > g.latest) g.latest = t.traded_at;
    agg.set(key, g);
  }
  return [...agg.values()]
    .filter((g) => g.usd >= opts.minLiquidity)
    .map((g) => {
      const avgEliteEdge = [...g.wallets].reduce((a, w) => a + (elite.get(w)?.edge ?? 0), 0) / g.wallets.size;
      return { conditionId: g.conditionId, outcomeIndex: g.outcomeIndex, question: g.question, side: (g.yes ? "YES" : "NO") as "YES" | "NO", wallets: g.wallets.size, avgEliteEdge, usd: g.usd, avgPrice: g.usd > 0 ? g.pSum / g.usd : 0, latestAgeDays: ageDays(g.latest) };
    })
    .sort((a, b) => b.avgEliteEdge - a.avgEliteEdge || b.wallets - a.wallets || b.usd - a.usd);
}

// Profit on a $1 copy of a bet on `outcomeIndex` at `entryPrice`, given the market's YES(index 0)
// settlement `resolvedYesOutcome` (1=YES won, 0=NO won). Win => you bought 1/entry shares each paying
// $1 => profit 1/entry − 1; Loss => −1. Shared by the copylist forward test's scorecard.
export function copyPnlPerDollar(outcomeIndex: number, entryPrice: number, resolvedYesOutcome: number): number {
  const betWon = (outcomeIndex === 0 ? resolvedYesOutcome : 1 - resolvedYesOutcome) === 1;
  return betWon ? 1 / entryPrice - 1 : -1;
}
