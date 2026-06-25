import { NextResponse } from "next/server";
import { getFreshEntries, getRequestUser, withTimeout } from "@/lib/supabase";

// Reads the auth cookie, so it must render per-request (not be statically baked, which would also
// freeze the list — see CLAUDE.md "Stuck edge-cache gotcha").
export const dynamic = "force-dynamic";

export async function GET() {
  // Gated: Fresh Contacts is a signed-in feature. No shared CDN cache — the response depends on auth.
  const user = await getRequestUser();
  if (!user) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401, headers: { "Cache-Control": "private, no-store" } });
  }

  try {
    const markets = await withTimeout(getFreshEntries(), 8000, []);

    return NextResponse.json(
      { markets },
      { headers: { "Cache-Control": "private, no-store" } }
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load fresh entries" },
      { status: 500 }
    );
  }
}
