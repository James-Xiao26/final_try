import { NextResponse } from "next/server";
import { getTrendingMarkets, withTimeout } from "@/lib/supabase";

// Same force-dynamic reasoning as /api/recent-trades: a no-arg GET would otherwise be statically
// baked at build time. See CLAUDE.md "Stuck edge-cache gotcha".
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const rows = await withTimeout(getTrendingMarkets(), 8000, []);

    return NextResponse.json(rows, {
      // Bounded by wallet_positions' ~10-min feed-cron freshness (not the daily-only closed-positions
      // cache), so match /api/recent-trades' cadence rather than the longer resolved-markets window.
      headers: { "Cache-Control": "s-maxage=600, stale-while-revalidate=300" }
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load trending markets" },
      { status: 500 }
    );
  }
}
