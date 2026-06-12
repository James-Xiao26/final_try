import ClosedTradesFeed from "@/components/ClosedTradesFeed";
import ConvergencePanel from "@/components/ConvergencePanel";
import RecentTradesFeed from "@/components/RecentTradesFeed";
import { getCrowdedMarkets, getRecentClosedTrades, getRecentLeaderboardTrades } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const [{ positions, traderCount }, closed, crowdedMarkets] = await Promise.all([
    getRecentLeaderboardTrades(),
    getRecentClosedTrades(),
    getCrowdedMarkets()
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

      <ClosedTradesFeed trades={closed.trades} traderCount={closed.traderCount} />

      <ConvergencePanel initialRows={crowdedMarkets} />
    </main>
  );
}
