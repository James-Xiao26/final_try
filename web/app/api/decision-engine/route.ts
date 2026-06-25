import { NextResponse } from "next/server";
import { buildRecommendations } from "@/lib/decisionEngine";
import { getDecisionEngineData, getRequestUser } from "@/lib/supabase";

// Reads the auth cookie, so it must render per-request (also avoids the static-prerender freeze —
// see CLAUDE.md).
export const dynamic = "force-dynamic";

export async function GET() {
  // Gated: Signals is a signed-in feature. No shared CDN cache — the response depends on auth.
  const user = await getRequestUser();
  if (!user) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401, headers: { "Cache-Control": "private, no-store" } });
  }

  try {
    const data = await getDecisionEngineData();
    const result = buildRecommendations(data);

    return NextResponse.json(result, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    console.error("[decision-engine] error:", error instanceof Error ? error.message : JSON.stringify(error));
    return NextResponse.json(
      { error: "Failed to compute signals" },
      { status: 500 }
    );
  }
}
