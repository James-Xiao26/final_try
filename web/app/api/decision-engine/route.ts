import { NextResponse } from "next/server";
import { buildRecommendations } from "@/lib/decisionEngine";
import { getDecisionEngineData } from "@/lib/supabase";

// Reads no request data, so Next would statically prerender (freeze) this at build
// time — force on-demand. The s-maxage header still CDN-caches it. See CLAUDE.md.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const data = await getDecisionEngineData();
    const result = buildRecommendations(data);

    return NextResponse.json(result, {
      headers: {
        // 5-minute edge cache: positions refresh daily, markets hourly — stale-while-revalidate
        // lets repeat renders share one computation without waiting for full revalidation.
        "Cache-Control": "s-maxage=300, stale-while-revalidate=600",
      },
    });
  } catch (error) {
    console.error("[decision-engine] error:", error instanceof Error ? error.message : JSON.stringify(error));
    return NextResponse.json(
      { error: "Failed to compute signals" },
      { status: 500 }
    );
  }
}
