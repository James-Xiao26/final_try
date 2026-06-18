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

  // Try the simplest possible query with a hard 5s timeout so this endpoint always responds.
  let dbResult: unknown = null;
  let dbError: unknown = null;
  let durationMs: number | null = null;
  let timedOut = false;

  try {
    const supabase = createSupabaseServerClient();
    const start = Date.now();

    const queryPromise = supabase
      .from("leaderboard_cache")
      .select("rank", { count: "exact", head: true });

    const timeoutPromise = new Promise<null>((resolve) =>
      setTimeout(() => { timedOut = true; resolve(null); }, 5000)
    );

    const winner = await Promise.race([queryPromise, timeoutPromise]);
    durationMs = Date.now() - start;

    if (!timedOut && winner !== null) {
      const { data, error, count } = winner as Awaited<typeof queryPromise>;
      dbResult = { count, data };
      dbError = error ? { code: error.code, message: error.message } : null;
    }
  } catch (e) {
    dbError = e instanceof Error ? { message: e.message, name: e.name } : String(e);
  }

  return NextResponse.json(
    { envStatus, dbResult, dbError, timedOut, durationMs },
    { headers: { "Cache-Control": "no-store" } }
  );
}
