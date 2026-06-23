import type { EquityPoint } from "./metrics.js";

// Copy-trade simulation: "what if I started with $100 and staked BET_FRACTION of my running balance
// on every trade this wallet made, buying the whole number of shares closest to that stake?" One sim
// per horizon window (the $100 stake resets at each window start). Closed trades step the balance at
// their close date; still-open positions add a single mark-to-market at today's price.
export interface CopyTrade {
  avgPrice: number; // entry price (0..1) — what one share cost
  size: number; // trader's share count (used to scale their realized result when outcome is unknown)
  outcome: number | null; // 1 if the market settled YES, 0 if NO, null if we never learned the outcome
  realizedPnl: number; // trader's actual realized P/L (fallback sizing when outcome is null)
  closeTime: string; // ISO timestamp the position closed
}

export interface CopyOpen {
  avgPrice: number;
  curPrice: number; // current YES price — marks the still-open copied shares to today
}

export interface CopySimParams {
  closed: CopyTrade[];
  open: CopyOpen[];
  windowStartUtc: string; // "YYYY-MM-DD" — left edge; balance starts at startStake here
  todayUtc: string; // "YYYY-MM-DD" — right edge; folds in open-position mark-to-market
  startStake?: number; // default 100
  betFraction?: number; // default 0.01 (1%)
}

// equity_curve.cumulative_pnl is NUMERIC(14,2) — its absolute value must stay below 10^12. Compounding
// 1% stakes on sub-penny longshot winners can otherwise blow a $100 stake past a trillion and overflow
// the insert (it crashed a full ingest). ponytail: clamp the balance to a column-safe ceiling; the DB
// column is the hard limit and a wallet pinned here already reads as "off the charts". Upgrade path:
// a log-scale chart y-axis so explosive curves stay readable instead of being clipped.
const MAX_BALANCE = 1e11;

function clampBalance(value: number): number {
  return Math.min(MAX_BALANCE, Math.max(0, value));
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

// Whole number of shares closest to staking `bet` dollars at `price`/share.
function sharesFor(bet: number, price: number): number {
  return price > 0 ? Math.round(bet / price) : 0;
}

export function simulateCopyCurve(params: CopySimParams): EquityPoint[] {
  const startStake = params.startStake ?? 100;
  const betFraction = params.betFraction ?? 0.01;
  const { windowStartUtc, todayUtc } = params;
  const windowStartMs = Date.parse(windowStartUtc);

  const inWindow = params.closed
    .filter((t) => {
      const ms = Date.parse(t.closeTime);
      return Number.isFinite(ms) && ms > windowStartMs && t.closeTime.slice(0, 10) <= todayUtc;
    })
    .sort((a, b) => Date.parse(a.closeTime) - Date.parse(b.closeTime));

  // One point per UTC day, last-write-wins so multiple same-day closes collapse to the day's balance.
  const byDate = new Map<string, number>();
  let balance = startStake;
  byDate.set(windowStartUtc, balance);

  for (const t of inWindow) {
    const shares = sharesFor(betFraction * balance, t.avgPrice);
    if (shares > 0) {
      const cost = shares * t.avgPrice;
      // Ride to final resolution when we know it ($1/share win, $0 loss); otherwise scale the trader's
      // own realized result down to our share count.
      const profit = t.outcome !== null
        ? shares * t.outcome - cost
        : t.size > 0
          ? shares * (t.realizedPnl / t.size)
          : 0;
      balance = clampBalance(balance + profit); // floor at 0, ceiling at the column limit
    }
    const date = new Date(Date.parse(t.closeTime)).toISOString().slice(0, 10);
    byDate.set(date, balance);
  }

  // Today's mark-to-market on still-open copied positions. ponytail: each open position is sized off
  // the same final balance rather than replaying its true entry-time balance — an illustrative tail,
  // not an exact backtest. Upgrade path: thread open-position entry dates and size at each.
  let unrealized = 0;
  for (const o of params.open) {
    const shares = sharesFor(betFraction * balance, o.avgPrice);
    unrealized += shares * (o.curPrice - o.avgPrice);
  }
  byDate.set(todayUtc, clampBalance(balance + unrealized));

  return [...byDate.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([ts, value]) => ({ ts, cumulativePnl: round(value, 2) }));
}
