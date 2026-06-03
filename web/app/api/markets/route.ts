import { NextResponse } from "next/server";
import { getMarkets } from "@/lib/supabase";
import { MARKET_SORTS, type MarketSort } from "@/lib/types";

function parseSort(value: string | null): MarketSort {
  return MARKET_SORTS.includes(value as MarketSort) ? (value as MarketSort) : "liquidity";
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const sort = parseSort(url.searchParams.get("sort"));
    const category = url.searchParams.get("category");
    const rows = await getMarkets({ sort, category });

    return NextResponse.json(rows, {
      headers: {
        "Cache-Control": "s-maxage=3600, stale-while-revalidate=300"
      }
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load markets" },
      { status: 500 }
    );
  }
}
