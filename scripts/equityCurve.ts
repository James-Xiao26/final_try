import type { EquityPoint } from "./metrics.js";

const MS_PER_DAY = 86_400_000;

// One position as a single block for the mark-to-market curve: its final size + avg cost, held from
// entry to close (or to now if still open). closeTs null = still open. realizedPnl null = open (no
// realized contribution yet). Exact for single-entry positions; approximates mid-life adds/partial
// sells (the per-position-block fidelity choice).
export interface CurvePosition {
  asset: string;
  size: number;
  avgCost: number;
  realizedPnl: number | null;
  closeTs: string | null; // ISO timestamp or null when still open
}

export interface DailyCurveParams {
  positions: CurvePosition[];
  // Cached daily prices per asset, ascending by ts ("YYYY-MM-DD"), as stored in market_price_history.
  pricesByAsset: Map<string, { ts: string; price: number }[]>;
  // Earliest fill date per asset ("YYYY-MM-DD"); missing → entry clamped to the window start.
  entryByAsset: Map<string, string>;
  windowStartUtc: string; // "YYYY-MM-DD"
  todayUtc: string; // "YYYY-MM-DD"
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

// ponytail: 3-point median filter that drops isolated single-day price outliers. Thinly-traded
// longshot tokens occasionally print a lone near-zero last-trade for one day; multiplied by a
// multi-million-share position that lurches the mark-to-market by six figures for that one day and
// snaps back the next — the visible "sawtooth". A median of each point against its two neighbors
// removes a one-day spike/dip while leaving any genuine multi-day move intact. Endpoints are kept
// as-is so the current ("today") mark is never altered. Upgrade path: a volume-weighted daily VWAP
// from the CLOB if single-print noise still leaks through.
function medianFilterSeries(series: { ts: string; price: number }[]): { ts: string; price: number }[] {
  if (series.length < 3) {
    return series;
  }
  return series.map((point, i) => {
    const prev = series[i - 1];
    const next = series[i + 1];
    if (!prev || !next) {
      return point; // first/last point: no smoothing
    }
    const a = prev.price;
    const b = point.price;
    const c = next.price;
    const median = a + b + c - Math.min(a, b, c) - Math.max(a, b, c);
    return median === b ? point : { ts: point.ts, price: median };
  });
}

function dayList(startUtc: string, endUtc: string): string[] {
  const startMs = Date.parse(startUtc);
  const endMs = Date.parse(endUtc);
  const days: string[] = [];
  for (let ms = startMs; ms <= endMs; ms += MS_PER_DAY) {
    days.push(new Date(ms).toISOString().slice(0, "YYYY-MM-DD".length));
  }
  return days;
}

// Builds the daily mark-to-market curve for one wallet + horizon. For each UTC day in the window:
//   cumulative_pnl(t) = Σ realizedPnl[closed positions with windowStart < closeTs ≤ t]
//                     + Σ size·(price_asset(t) − avgCost)  [positions open at day t]
// price_asset(t) is forward-filled to the latest cached day ≤ t; before a token's first cached point
// it falls back to avgCost (zero unrealized). At t = today this equals realized_in_window + current
// unrealized — the displayed Total P/L — so the curve endpoint stays continuous with the old one.
export function buildMarkToMarketCurve(params: DailyCurveParams): EquityPoint[] {
  const { positions, pricesByAsset, entryByAsset, windowStartUtc, todayUtc } = params;
  const days = dayList(windowStartUtc, todayUtc);
  if (days.length === 0) {
    return [];
  }
  const windowStartMs = Date.parse(windowStartUtc);

  // Smooth each asset's price series once (shared across positions on the same asset) to strip the
  // single-day last-trade outliers that otherwise sawtooth the mark-to-market.
  const smoothedByAsset = new Map<string, { ts: string; price: number }[]>();
  for (const [asset, series] of pricesByAsset) {
    smoothedByAsset.set(asset, medianFilterSeries(series));
  }

  // Per-position derived bounds + a forward-fill cursor into its asset's price series.
  const tracked = positions.map((position) => {
    const rawEntry = entryByAsset.get(position.asset);
    const entryMs = rawEntry ? Date.parse(rawEntry) : NaN;
    const entryMsClamped = Number.isFinite(entryMs) ? Math.max(entryMs, windowStartMs) : windowStartMs;
    const closeMs = position.closeTs ? Date.parse(position.closeTs) : Number.POSITIVE_INFINITY;
    return {
      position,
      entryMs: entryMsClamped,
      closeMs,
      series: smoothedByAsset.get(position.asset) ?? [],
      cursor: 0,
      price: position.avgCost // forward-filled mark; avgCost until the first cached point ≤ t
    };
  });

  let realizedCumulative = 0;
  let closedIdx = 0;
  // Closed positions sorted by closeTs so we can fold realized in chronologically as days advance.
  const closes = positions
    .filter((p) => p.closeTs !== null && p.realizedPnl !== null && Date.parse(p.closeTs) > windowStartMs)
    .map((p) => ({ closeMs: Date.parse(p.closeTs as string), realizedPnl: p.realizedPnl as number }))
    .sort((a, b) => a.closeMs - b.closeMs);

  const out: EquityPoint[] = [];
  for (const day of days) {
    const dayMs = Date.parse(day);

    // Fold in any positions that closed on/before this day (realized step).
    while (closedIdx < closes.length && (closes[closedIdx] as { closeMs: number }).closeMs <= dayMs) {
      realizedCumulative += (closes[closedIdx] as { realizedPnl: number }).realizedPnl;
      closedIdx += 1;
    }

    let unrealized = 0;
    for (const t of tracked) {
      // Advance the forward-fill cursor to the latest cached point with ts ≤ day.
      while (t.cursor < t.series.length && Date.parse((t.series[t.cursor] as { ts: string }).ts) <= dayMs) {
        t.price = (t.series[t.cursor] as { price: number }).price;
        t.cursor += 1;
      }
      // Marked only while open at this day: entry ≤ day < close.
      if (t.entryMs <= dayMs && dayMs < t.closeMs) {
        unrealized += t.position.size * (t.price - t.position.avgCost);
      }
    }

    out.push({ ts: day, cumulativePnl: round(realizedCumulative + unrealized, 2) });
  }
  return out;
}
