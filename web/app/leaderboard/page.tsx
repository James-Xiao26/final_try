import LeaderboardTable from "@/components/LeaderboardTable";
import { getLeaderboard } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export default async function LeaderboardPage() {
  // Degrade gracefully on a Supabase failure (free-tier cold-start 57014 timeout, etc.) rather than
  // throwing a server-side exception — LeaderboardTable polls /api/leaderboard on mount to fill in.
  const initialRows = await getLeaderboard(90).catch(() => []);

  return (
    <main className="page">
      <LeaderboardTable initialRows={initialRows} initialHorizon={90} />

      <footer className="ww-ops">
        <div className="ww-ops-rule"><span>Operations Manual</span><span className="line" /><span className="orn">✦</span></div>
        <div className="ww-ops-grid">
          <div className="panel ww-ops-card">
            <h3>Signal = Skill</h3>
            <p>A contact&apos;s signal strength is its Skill Score (0–10): how reliably entry prices beat the market&apos;s eventual resolution, Bayesian-shrunk so a few lucky pings can&apos;t fake a strong return.</p>
          </div>
          <div className="panel ww-ops-card">
            <h3>Edge per share</h3>
            <p>The per-position mean of <code>resolution − entry</code> across resolved markets, in cents. A whale buying YES at 41¢ on outcomes that resolve true banks <code>+59¢</code> of edge on those shares.</p>
          </div>
          <div className="panel ww-ops-card">
            <h3>Whale class</h3>
            <p>Class is assigned by signal: <code>BLUE WHALE</code> (≥9), <code>SPERM WHALE</code> (≥8), <code>ORCA</code> (≥7), down to <code>PORPOISE</code>. Suspected bots and sub-threshold wallets never surface.</p>
          </div>
        </div>
      </footer>
    </main>
  );
}
