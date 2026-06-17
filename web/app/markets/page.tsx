import MarketsTable from "@/components/MarketsTable";
import { getMarkets } from "@/lib/supabase";

export const revalidate = 300;

export default async function MarketsPage() {
  // Degrade gracefully on a Supabase failure (free-tier cold-start 57014 timeout, etc.) rather than
  // throwing a server-side exception — MarketsTable polls /api/markets on mount to fill in.
  const initialRows = await getMarkets({ sort: "volume" }).catch(() => []);

  return (
    <main className="page">
      <div className="mkt-page-head">
        <h1 className="brand">Open <span className="g">Water</span></h1>
        <p className="subtitle">
          The hunting grounds — active Polymarket events where the whales feed. Sounded for depth (liquidity), current (volume), and drift (24-hour move on the favored outcome).
        </p>
      </div>

      <MarketsTable initialRows={initialRows} initialSort="volume" />
    </main>
  );
}
