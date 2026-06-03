import MarketsTable from "@/components/MarketsTable";
import { getMarkets } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export default async function MarketsPage() {
  const initialRows = await getMarkets({ sort: "liquidity" });

  return (
    <main className="page">
      <header className="topbar">
        <div>
          <h1 className="brand">Markets</h1>
          <p className="subtitle">
            The most active Polymarket markets right now — sort by liquidity, total volume, 24-hour trading, or volatility, and filter by category.
          </p>
        </div>
        <div className="mono muted">MARKETS / LIQUIDITY</div>
      </header>
      <MarketsTable initialRows={initialRows} initialSort="liquidity" />
    </main>
  );
}
