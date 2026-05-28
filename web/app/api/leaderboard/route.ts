import { NextResponse } from "next/server";
import { getLeaderboard } from "@/lib/supabase";
import { HORIZONS, type HorizonDays } from "@/lib/types";

function parseHorizon(value: string | null): HorizonDays {
  const parsed = Number(value ?? 90);
  return HORIZONS.includes(parsed as HorizonDays) ? parsed as HorizonDays : 90;
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const horizon = parseHorizon(url.searchParams.get("horizon"));
    const rows = await getLeaderboard(horizon);

    return NextResponse.json(rows, {
      headers: {
        "Cache-Control": "s-maxage=3600, stale-while-revalidate=300"
      }
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load leaderboard" },
      { status: 500 }
    );
  }
}
