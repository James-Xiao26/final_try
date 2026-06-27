import WorldCupBoard from "@/components/WorldCupBoard";
import { getWorldCupBoard, withTimeout } from "@/lib/supabase";

// World Cup board updates only on the daily full ingest, so a long revalidate matches the data cadence
// (design rule 4 — don't re-read the same bytes more often than they change).
export const revalidate = 600;

export default async function WorldCupPage() {
  // Degrade gracefully on a Supabase failure (free-tier cold-start timeout, pre-migration empty table)
  // rather than throwing — the board simply renders its empty state.
  const rows = await withTimeout(getWorldCupBoard(100), 1500, []).catch(() => []);

  return (
    <main className="page">
      <WorldCupBoard rows={rows} />
    </main>
  );
}
