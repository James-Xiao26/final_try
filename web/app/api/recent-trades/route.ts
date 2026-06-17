import { NextResponse } from "next/server";
import { getRecentLeaderboardTrades, withTimeout } from "@/lib/supabase";

export async function GET() {
  try {
    const feed = await withTimeout(getRecentLeaderboardTrades(), 8000, { positions: [], traderCount: 0 });

    return NextResponse.json(feed, {
      headers: {
        // Short edge cache: the feed only changes when the --feed-only cron repopulates recent_trades.
        "Cache-Control": "s-maxage=60, stale-while-revalidate=120"
      }
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load recent trades" },
      { status: 500 }
    );
  }
}
