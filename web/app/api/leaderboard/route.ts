import { NextResponse } from "next/server";
import { getLeaderboard, withTimeout } from "@/lib/supabase";
import { HORIZONS, type HorizonDays } from "@/lib/types";

function parseHorizon(value: string | null): HorizonDays {
  const parsed = Number(value ?? 90);
  return HORIZONS.includes(parsed as HorizonDays) ? parsed as HorizonDays : 90;
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const horizon = parseHorizon(url.searchParams.get("horizon"));
    const rows = await withTimeout(getLeaderboard(horizon), 8000, []);

    return NextResponse.json(rows, {
      headers: {
        "Cache-Control": "s-maxage=3600, stale-while-revalidate=300"
      }
    });
  } catch (error) {
    console.error("[api/leaderboard] error:", error instanceof Error ? error.message : JSON.stringify(error));
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load leaderboard" },
      { status: 500 }
    );
  }
}
