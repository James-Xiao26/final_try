import RecentTradesFeed from "@/components/RecentTradesFeed";
import { getRecentLeaderboardTrades } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const { trades, traderCount } = await getRecentLeaderboardTrades();

  return (
    <main className="page">
      <header className="topbar">
        <div>
          <h1 className="brand">Live Activity</h1>
          <p className="subtitle">
            Trades placed in the last 24 hours by wallets currently on the leaderboard — who traded, at what price, how much, and when. Refreshed each ingest.
          </p>
        </div>
        <div className="mono muted">
          LAST 24H / {traderCount} {traderCount === 1 ? "TRADER" : "TRADERS"}
        </div>
      </header>
      <RecentTradesFeed trades={trades} />
    </main>
  );
}
