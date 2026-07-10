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
  avgPrice: number; // the price you'd pay to copy now (fills: their fill price; holdings: current price)
  latestAgeDays: number;
  theirAvgEntry?: number | undefined; // holdings only: the elite wallets' cost-weighted entry, for "did it move" context
}

// A current open position held by a board wallet (wallet_positions row).
export interface Holding {
  address: string;
  condition_id: string | null;
  market: string | null;
  outcome_index: number | null;
  size: number | null;
  avg_price: number | null;
  cur_price: number | null;
}

// Collapse fresh ELITE BUYs into one candidate per (market, side): distinct elite wallets on it, mean
// elite edge, total $, $-weighted avg entry price, freshest trade. Only trades from wallets in the
// `elite` map count. Pure so it's unit-testable. Ranked best-first: agreement, then edge, then size.
// `gameStart` (optional): conditionId -> game kickoff (ms). A trade placed at/after its market's kickoff
// is an in-game (live) bet and is dropped — only PRE-GAME entries count. Markets absent from the map
// (futures/season markets with no single kickoff) keep all their trades.
export function buildCandidates(trades: Trade[], elite: Map<string, WalletQuality>, nowMs: number, opts: { freshDays: number; minPrice: number; maxPrice: number; minLiquidity: number }, gameStart?: Map<string, number>): Candidate[] {
  const ageDays = (t: string): number => (nowMs - Date.parse(t)) / 86_400_000;
  const isPreGame = (t: Trade): boolean => {
    const start = gameStart?.get(t.condition_id!);
    return start === undefined || Date.parse(t.traded_at) < start;
  };
  const fresh = trades.filter(
    (t) =>
      t.side === "BUY" &&
      t.condition_id !== null &&
      ageDays(t.traded_at) <= opts.freshDays &&
      elite.has(t.address) &&
      t.price >= opts.minPrice &&
      t.price <= opts.maxPrice &&
      isPreGame(t)
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
    .sort((a, b) => b.wallets - a.wallets || b.avgEliteEdge - a.avgEliteEdge || b.usd - a.usd);
}

// Agreement from CURRENT HOLDINGS: one candidate per (market, side) that elite wallets currently hold a
// non-dust position in. Far richer than the 1-day fill feed (a wallet still holding = a live conviction,
// not a one-off click). You copy at the CURRENT price (cur_price); `theirAvgEntry` shows where they got
// in (if cur_price >> entry the move already happened; if <= entry you'd get in cheaper than they did).
// Pure/unit-tested. Ranked best-first: agreement, then elite edge, then committed capital.
export function buildHoldingCandidates(holdings: Holding[], elite: Map<string, WalletQuality>, opts: { minPrice: number; maxPrice: number; minLiquidity: number; dustUsd: number }): Candidate[] {
  const cost = (h: Holding): number => (h.size ?? 0) * (h.avg_price ?? 0);
  const kept = holdings.filter(
    (h) =>
      h.condition_id !== null &&
      h.cur_price !== null &&
      elite.has(h.address) &&
      cost(h) >= opts.dustUsd &&
      h.cur_price >= opts.minPrice &&
      h.cur_price <= opts.maxPrice
  );
  const agg = new Map<string, { conditionId: string; outcomeIndex: number; question: string; yes: boolean; wallets: Set<string>; usd: number; curSum: number; curN: number; entryCostSum: number; costSum: number }>();
  for (const h of kept) {
    const key = `${h.condition_id}:${h.outcome_index}`;
    const g = agg.get(key) ?? { conditionId: h.condition_id!, outcomeIndex: h.outcome_index ?? 0, question: h.market ?? "(unknown)", yes: h.outcome_index === 0, wallets: new Set<string>(), usd: 0, curSum: 0, curN: 0, entryCostSum: 0, costSum: 0 };
    const c = cost(h);
    g.wallets.add(h.address);
    g.usd += c;
    g.curSum += h.cur_price!;
    g.curN += 1;
    g.entryCostSum += (h.avg_price ?? 0) * c; // cost-weighted entry
    g.costSum += c;
    agg.set(key, g);
  }
  return [...agg.values()]
    .filter((g) => g.usd >= opts.minLiquidity)
    .map((g) => ({
      conditionId: g.conditionId,
      outcomeIndex: g.outcomeIndex,
      question: g.question,
      side: (g.yes ? "YES" : "NO") as "YES" | "NO",
      wallets: g.wallets.size,
      avgEliteEdge: [...g.wallets].reduce((a, w) => a + (elite.get(w)?.edge ?? 0), 0) / g.wallets.size,
      usd: g.usd,
      avgPrice: g.curSum / g.curN, // current price = what you'd pay
      latestAgeDays: 0,
      theirAvgEntry: g.costSum > 0 ? g.entryCostSum / g.costSum : undefined
    }))
    .sort((a, b) => b.wallets - a.wallets || b.avgEliteEdge - a.avgEliteEdge || b.usd - a.usd);
}

// Profit on a $1 copy of a bet on `outcomeIndex` at `entryPrice`, given the market's YES(index 0)
// settlement `resolvedYesOutcome` (1=YES won, 0=NO won). Win => you bought 1/entry shares each paying
// $1 => profit 1/entry − 1; Loss => −1. Shared by the copylist forward test's scorecard.
export function copyPnlPerDollar(outcomeIndex: number, entryPrice: number, resolvedYesOutcome: number): number {
  const betWon = (outcomeIndex === 0 ? resolvedYesOutcome : 1 - resolvedYesOutcome) === 1;
  return betWon ? 1 / entryPrice - 1 : -1;
}
