import { NextResponse } from "next/server";
import { getMarkets, withTimeout } from "@/lib/supabase";
import { MARKET_SORTS, type MarketSort } from "@/lib/types";

function parseSort(value: string | null): MarketSort {
  return MARKET_SORTS.includes(value as MarketSort) ? (value as MarketSort) : "liquidity";
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const sort = parseSort(url.searchParams.get("sort"));
    const category = url.searchParams.get("category");
    const rows = await withTimeout(getMarkets({ sort, category }), 8000, []);

    return NextResponse.json(rows, {
      headers: {
        // Markets are repopulated ~hourly by ingest:markets, so a 60s window just re-reads the same
        // data 60x/hour for no fresher result. Cache 5 min to cut Supabase egress while staying responsive.
        "Cache-Control": "s-maxage=300, stale-while-revalidate=300"
      }
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load markets" },
      { status: 500 }
    );
  }
}
