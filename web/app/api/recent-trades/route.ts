import { NextResponse } from "next/server";
import { getRecentLeaderboardTrades, withTimeout } from "@/lib/supabase";

export async function GET() {
  try {
    const feed = await withTimeout(getRecentLeaderboardTrades(), 8000, { positions: [], traderCount: 0 });

    return NextResponse.json(feed, {
      headers: {
        // The feed only changes when the --feed-only cron repopulates recent_trades (~10 min), but
        // building it scans the whole position cache (basis lookups). Cache for 10 min to match that
        // cadence and keep that heavy scan from re-running every minute (Supabase egress). Clients
        // still poll every 60s; the edge serves them the cached copy until this window expires.
        "Cache-Control": "s-maxage=600, stale-while-revalidate=300"
      }
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load recent trades" },
      { status: 500 }
    );
  }
}
