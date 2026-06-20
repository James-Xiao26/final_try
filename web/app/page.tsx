import ConvergencePanel from "@/components/ConvergencePanel";
import FreshEntriesPanel from "@/components/FreshEntriesPanel";
import RecentTradesFeed from "@/components/RecentTradesFeed";
import ResolvedMarketsPanel from "@/components/ResolvedMarketsPanel";
import { getCrowdedMarkets, getFreshEntries, getRecentLeaderboardTrades, getResolvedMarkets, withTimeout } from "@/lib/supabase";

// 10 min: the feed/convergence/resolved data only changes on the ~10-min feed cron and the daily
// full ingest, and building the feed scans the position cache — regenerating more often just burns
// Supabase egress for identical output.
export const revalidate = 600;

export default async function HomePage() {
  // Each section degrades independently: a Supabase failure (e.g. free-tier cold-start 57014
  // timeout on the first hit) must never crash the whole page. The client components poll their
  // /api/* routes on mount, so empty initial data just renders the shell and then hydrates live.
  const [{ positions, traderCount }, resolvedMarkets, crowdedMarkets, freshEntries] = await Promise.all([
    withTimeout(getRecentLeaderboardTrades(), 1500, { positions: [], traderCount: 0 }).catch(() => ({ positions: [], traderCount: 0 })),
    withTimeout(getResolvedMarkets(), 1500, []).catch(() => []),
    withTimeout(getCrowdedMarkets(), 1500, []).catch(() => []),
    withTimeout(getFreshEntries(), 1500, []).catch(() => [])
  ]);

  return (
    <main className="page">
      <div className="act-page-head">
        <div>
          <h1 className="brand">Hydrophone <span className="g">Feed</span></h1>
          <p className="subtitle">
            Live acoustic intercepts — every fill placed in the last 24 hours by a contact currently on the board. Who transmitted, on what bearing, at what depth, and how long ago. Auto-refreshes every minute.
          </p>
        </div>
        <span className="act-live"><span className="dot" /> Live · Last 24h</span>
      </div>

      <RecentTradesFeed initialPositions={positions} initialTraderCount={traderCount} />

      <ResolvedMarketsPanel rows={resolvedMarkets} />

      <FreshEntriesPanel initialRows={freshEntries} />

      <ConvergencePanel initialRows={crowdedMarkets} />
    </main>
  );
}
