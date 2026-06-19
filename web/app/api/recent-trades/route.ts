import { NextResponse } from "next/server";
import { getRecentLeaderboardTrades, withTimeout } from "@/lib/supabase";

// This GET takes no args and reads no request data, so Next.js 14 would otherwise STATICALLY
// prerender it at build time — baking one snapshot of the feed into the deployment that never
// refreshes until the next deploy (symptom: the "Acoustic Log" freezes at the deploy time and the
// newest trade ages indefinitely; a redeploy "fixes" it only until it re-freezes). force-dynamic
// keeps the handler running live on each origin request; the Cache-Control header below still lets
// the Vercel edge serve a cached copy and only hit the origin (and Supabase) ~once per s-maxage
// window, so this does NOT re-introduce per-request DB load. See CLAUDE.md "Stuck edge-cache gotcha".
export const dynamic = "force-dynamic";

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
