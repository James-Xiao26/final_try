import type { Metadata } from "next";
import { buildRecommendations } from "@/lib/decisionEngine";
import { getDecisionEngineData } from "@/lib/supabase";
import DecisionFeed from "@/components/DecisionFeed";
import type { DecisionEngineResult } from "@/lib/types";

export const metadata: Metadata = {
  title: "Fire Control · WhaleWatcher",
  description:
    "Skill-weighted trade signals — markets where the leaderboard's sharpest traders are positioned above current prices.",
};

// Revalidate every 5 minutes. Positions refresh at daily full ingest; markets refresh hourly.
// 300s gives the page a warm cache most of the time while staying responsive to new ingest runs.
export const revalidate = 300;

export default async function DecisionPage() {
  // loading.tsx shows the shell instantly via Suspense streaming while this awaits.
  // No timeout needed here — running to completion avoids zombie queries that would
  // exhaust the connection pool and break the client-side /api/decision-engine poll.
  let result: DecisionEngineResult | null = null;
  try {
    const data = await getDecisionEngineData();
    result = buildRecommendations(data);
  } catch {
    // DB unavailable (cold start 57014, etc.) — DecisionFeed sees null and polls /api/decision-engine.
  }

  return (
    <div className="page">
      <div className="topbar">
        <div>
          <h1 className="brand">
            Fire <span style={{ color: "var(--green)" }}>Control</span>
          </h1>
          <p className="subtitle">
            Markets where the leaderboard&apos;s verified-edge traders hold positions{" "}
            <em>above</em> current prices — ranked by the size and confidence of that discount.
            Not financial advice.
          </p>
        </div>
        <span className="act-live">
          <span className="dot" />
          SIGNAL ACTIVE
        </span>
      </div>

      <DecisionFeed initialResult={result} />
    </div>
  );
}
