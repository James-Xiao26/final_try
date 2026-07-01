import { NextResponse } from "next/server";
import { getResolvedMarkets, withTimeout } from "@/lib/supabase";

// Same force-dynamic reasoning as /api/recent-trades: a no-arg GET would otherwise be statically
// baked at build time. See CLAUDE.md "Stuck edge-cache gotcha".
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const rows = await withTimeout(getResolvedMarkets(), 8000, []);

    return NextResponse.json(rows, {
      // wallet_closed_positions is written only by the daily full ingest, so this barely changes
      // intra-day — cache long to match.
      headers: { "Cache-Control": "s-maxage=1800, stale-while-revalidate=900" }
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load resolved markets" },
      { status: 500 }
    );
  }
}
