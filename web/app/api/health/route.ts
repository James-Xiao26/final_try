import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase";

// Temporary diagnostic endpoint — remove once the DB connectivity issue is resolved.
// Hit /api/health to see the raw Supabase response and env var status.
export async function GET() {
  const url = process.env["NEXT_PUBLIC_SUPABASE_URL"];
  const key = process.env["NEXT_PUBLIC_SUPABASE_ANON_KEY"];

  const envStatus = {
    hasUrl: !!url,
    urlPrefix: url ? url.slice(0, 30) + "..." : null,
    hasKey: !!key,
    keyPrefix: key ? key.slice(0, 20) + "..." : null,
  };

  // Try the simplest possible query — count rows in leaderboard_cache.
  let dbResult: unknown = null;
  let dbError: unknown = null;
  let durationMs: number | null = null;
  try {
    const supabase = createSupabaseServerClient();
    const start = Date.now();
    const { data, error, count } = await supabase
      .from("leaderboard_cache")
      .select("rank", { count: "exact", head: true });
    durationMs = Date.now() - start;
    dbResult = { count, data };
    dbError = error;
  } catch (e) {
    dbError = e instanceof Error ? { message: e.message, name: e.name } : String(e);
  }

  return NextResponse.json({ envStatus, dbResult, dbError, durationMs }, {
    headers: { "Cache-Control": "no-store" }
  });
}
