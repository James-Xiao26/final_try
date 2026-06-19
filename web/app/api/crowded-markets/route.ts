import { NextResponse } from "next/server";
import { getCrowdedMarkets, withTimeout } from "@/lib/supabase";

// Same static-prerender trap as /api/recent-trades: a no-arg GET gets baked at build time and the
// Convergence list freezes until the next deploy. force-dynamic keeps it live; the Cache-Control
// header still bounds origin/DB hits to ~once per s-maxage window. See CLAUDE.md "Stuck edge-cache gotcha".
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const markets = await withTimeout(getCrowdedMarkets(), 8000, []);

    return NextResponse.json(
      { markets },
      {
        headers: {
          // Short edge cache: crowded markets only change when the full ingest repopulates the
          // position caches, so a minute of staleness is fine.
          "Cache-Control": "s-maxage=60, stale-while-revalidate=120"
        }
      }
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load crowded markets" },
      { status: 500 }
    );
  }
}
