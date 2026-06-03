import LeaderboardTable from "@/components/LeaderboardTable";
import { getLeaderboard } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export default async function LeaderboardPage() {
  const initialRows = await getLeaderboard(90);

  return (
    <main className="page">
      <header className="topbar">
        <div>
          <h1 className="brand">WhaleWatcher</h1>
          <p className="subtitle">
            Polymarket traders ranked by statistical forecasting edge — how reliably their entry prices beat the market's eventual resolution, scored 0–10 with confidence for sample size.
          </p>
        </div>
        <div className="mono muted">PUBLIC LEADERBOARD / 90D</div>
      </header>
      <LeaderboardTable initialRows={initialRows} initialHorizon={90} />
    </main>
  );
}
