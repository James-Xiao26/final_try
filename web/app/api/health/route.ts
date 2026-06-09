import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// TEMPORARY diagnostic endpoint. Reports whether the Supabase env vars are present/well-formed and
// what a trivial query returns, as plain JSON (HTTP 200 always — never throws), so the cause of the
// Activity-feed 500 is readable straight in the browser. Remove once the env issue is resolved.
export const dynamic = "force-dynamic";

export async function GET() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // Never echo the full secret values. Shape/length/whitespace is enough to spot a BOM, a stray
  // newline, or a wrong value — and these are NEXT_PUBLIC (already in the browser bundle) anyway.
  const report = {
    url: {
      present: Boolean(url),
      length: url?.length ?? 0,
      startsWithHttps: url?.startsWith("https://") ?? false,
      hasWhitespace: url ? /\s/.test(url) : null,
      // A UTF-8 BOM shows up as a leading ﻿; flag it explicitly.
      hasBom: url ? url.charCodeAt(0) === 0xfeff : null,
      sample: url ? `${url.slice(0, 14)}…${url.slice(-10)}` : null
    },
    anonKey: {
      present: Boolean(key),
      length: key?.length ?? 0,
      hasWhitespace: key ? /\s/.test(key) : null,
      hasBom: key ? key.charCodeAt(0) === 0xfeff : null
    },
    siteAccessKeyPresent: Boolean(process.env.SITE_ACCESS_KEY)
  };

  if (!url || !key) {
    return NextResponse.json({ ok: false, stage: "env", report }, { status: 200 });
  }

  try {
    const supabase = createClient(url, key, { auth: { persistSession: false } });
    const { error } = await supabase.from("recent_trades").select("address").limit(1);
    return NextResponse.json(
      {
        ok: !error,
        stage: "query",
        queryError: error
          ? { message: error.message, code: error.code, details: error.details, hint: error.hint }
          : null,
        report
      },
      { status: 200 }
    );
  } catch (e) {
    return NextResponse.json(
      { ok: false, stage: "client", thrown: e instanceof Error ? e.message : String(e), report },
      { status: 200 }
    );
  }
}
