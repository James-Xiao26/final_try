import { NextResponse } from "next/server";
import { getFreshEntries, withTimeout } from "@/lib/supabase";

// Same static-prerender trap as /api/crowded-markets: a no-arg GET gets baked at build time and the
// list freezes until the next deploy. force-dynamic keeps it live; the Cache-Control header still
// bounds origin/DB hits to ~once per s-maxage window. See CLAUDE.md "Stuck edge-cache gotcha".
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const markets = await withTimeout(getFreshEntries(), 8000, []);

    return NextResponse.json(
      { markets },
      {
        headers: {
          // Fresh entries only change on the ~10-min feed run, so a minute of edge staleness is fine.
          "Cache-Control": "s-maxage=60, stale-while-revalidate=120"
        }
      }
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load fresh entries" },
      { status: 500 }
    );
  }
}
