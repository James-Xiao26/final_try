import { NextResponse } from "next/server";
import { buildRecommendations } from "@/lib/decisionEngine";
import { getDecisionEngineData } from "@/lib/supabase";
import { isValidAddress } from "@/lib/format";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const rawWallet = url.searchParams.get("wallet");
    const walletAddress =
      rawWallet && isValidAddress(rawWallet) ? rawWallet.toLowerCase() : undefined;

    const data = await getDecisionEngineData(walletAddress ? { walletAddress } : {});
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
