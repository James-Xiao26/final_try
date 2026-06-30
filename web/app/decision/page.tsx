import type { Metadata } from "next";
import ConvergencePanel from "@/components/ConvergencePanel";

export const metadata: Metadata = {
  title: "Convergence Zones · WhaleWatcher",
  description:
    "Markets the most tracked contacts are converging on — the crowd's strongest positions, ranked by how many leaderboard wallets hold them.",
};

// Convergence data is fetched client-side from the auth-gated /api/crowded-markets, so this page
// has no server-side await — it renders instantly and the panel hydrates on mount. The /decision
// route is gated in middleware (GATED_PREFIXES), so logged-out visitors are redirected to /signin.
export default function DecisionPage() {
  return (
    <main className="page">
      <ConvergencePanel />
    </main>
  );
}
