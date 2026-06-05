import MarketsTable from "@/components/MarketsTable";
import { getMarkets } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export default async function MarketsPage() {
  const initialRows = await getMarkets({ sort: "liquidity" });

  return (
    <main className="page">
      <div className="mkt-page-head">
        <h1 className="brand">Open <span className="g">Water</span></h1>
        <p className="subtitle">
          The hunting grounds — active Polymarket events where the whales feed. Sounded for depth (liquidity), current (volume), and drift (24-hour move on the favored outcome).
        </p>
      </div>

      <MarketsTable initialRows={initialRows} initialSort="liquidity" />
    </main>
  );
}
