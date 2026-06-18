import { NextResponse } from "next/server";
import { getCrowdedMarkets, withTimeout } from "@/lib/supabase";

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
