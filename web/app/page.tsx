import LeaderboardTable from "@/components/LeaderboardTable";
import { getLeaderboard } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const initialRows = await getLeaderboard(90);

  return (
    <main className="page">
      <header className="topbar">
        <div>
          <h1 className="brand">WhaleWatcher</h1>
          <p className="subtitle">
            Polymarket traders ranked by risk-adjusted realized skill: return, forecasting edge, win rate, sample size, and outlier discipline.
          </p>
        </div>
        <div className="mono muted">PUBLIC LEADERBOARD / 90D</div>
      </header>
      <LeaderboardTable initialRows={initialRows} initialHorizon={90} />
    </main>
  );
}
