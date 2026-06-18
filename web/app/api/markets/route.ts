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
        // Short edge cache so the client poll surfaces a fresh markets ingest within ~a minute,
        // while still collapsing concurrent requests to one origin hit per window.
        "Cache-Control": "s-maxage=60, stale-while-revalidate=120"
      }
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load markets" },
      { status: 500 }
    );
  }
}
