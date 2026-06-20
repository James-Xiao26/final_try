import type { EquityPoint, HorizonDays } from "@/lib/types";

const MS_PER_DAY = 86_400_000;

export interface WindowedCurve {
  points: EquityPoint[]; // input points, with a $0 baseline prepended at window start
  startMs: number; // left-edge time (window start)
  endMs: number; // right-edge time (last/"today" point)
}

// Anchors the curve to a fixed [endMs - horizon, endMs] window and prepends a $0 baseline point at
// the window start so the line begins at $0 on the left edge (rather than floating at the first
// close's PnL). `points` is assumed non-empty and chronological, as produced by buildDailyCurve
// (scripts/metrics.ts). `endMs` is taken from the data's last ("today") point rather than Date.now()
// so the render is deterministic across SSR/client (no hydration drift) and the last point lands
// exactly on the right edge.
export function windowedCurve(points: EquityPoint[], horizonDays: HorizonDays): WindowedCurve {
  // Drop future-dated points before anything else. Polymarket can report a position's closeTime as
  // the market's future end date, which leaks a point dated after today; since the right edge is the
  // last point, that ghost would otherwise become "today" and slope the line up to a stale value.
  // Compare on the UTC date string (stored ts are "YYYY-MM-DD") so SSR and client agree.
  const todayUtc = new Date().toISOString().slice(0, 10);
  const inRange = points.filter((p) => p.ts.slice(0, 10) <= todayUtc);
  points = inRange.length > 0 ? inRange : points;

  const last = points[points.length - 1];
  const first = points[0];
  if (!last || !first) {
    const now = Date.now();
    return { points, startMs: now - horizonDays * MS_PER_DAY, endMs: now };
  }
  const endMs = Date.parse(last.ts);
  const startMs = endMs - horizonDays * MS_PER_DAY;
  const firstMs = Date.parse(first.ts);
  // Only prepend if the first real point is strictly after the window start (avoids a duplicate x at
  // the left edge when a close already sits on the boundary).
  if (firstMs <= startMs) {
    return { points, startMs, endMs };
  }
  const baseline: EquityPoint = { ts: new Date(startMs).toISOString().slice(0, 10), cumulativePnl: 0 };
  return { points: [baseline, ...points], startMs, endMs };
}
