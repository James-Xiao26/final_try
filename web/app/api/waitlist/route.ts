import { NextResponse } from "next/server";
import { createSupabaseWriteClient } from "@/lib/supabase";

// Captures early-access signups into our own Supabase `waitlist` table (migration 010). Writes go
// through the anon key, which the table's RLS allows to INSERT but not SELECT — so this route can
// add an address yet never read the list back out. Collect signups from the Supabase dashboard.

// Pragmatic email shape check — Postgres has the final say via the CITEXT UNIQUE column; this just
// rejects obvious junk before we spend a round-trip.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// --- Per-IP rate limit -------------------------------------------------------------------------
// Cheap in-memory sliding window to blunt scripted spam against the waitlist. Caveat: serverless
// instances don't share memory and cold-start fresh, so this throttles a burst hitting one warm
// instance, not a distributed flood — for that you'd reach for Vercel WAF or Upstash. Still covers
// the realistic threat (a bot padding the list) with zero dependencies.
const WINDOW_MS = 60_000;
const MAX_REQUESTS = 5; // signups per IP per minute — far above any human cadence
const hits = new Map<string, number[]>();

function clientIp(request: Request): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]?.trim() || "unknown";
  return request.headers.get("x-real-ip") ?? "unknown";
}

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= MAX_REQUESTS) {
    hits.set(ip, recent);
    return true;
  }
  recent.push(now);
  hits.set(ip, recent);
  // Opportunistic sweep so the map can't grow unbounded across many unique IPs.
  if (hits.size > 5000) {
    for (const [key, times] of hits) {
      if (times.every((t) => now - t >= WINDOW_MS)) hits.delete(key);
    }
  }
  return false;
}

export async function POST(request: Request) {
  if (isRateLimited(clientIp(request))) {
    return NextResponse.json(
      { error: "Too many requests. Please slow down and try again shortly." },
      { status: 429, headers: { "Retry-After": "60" } }
    );
  }

  let email: unknown;
  let company: unknown;
  let source: unknown;
  try {
    ({ email, company, source } = await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  // Honeypot: a hidden field no human fills. If it has a value, it's a bot — return a fake success
  // (so the bot can't tell it was caught) and never touch the database.
  if (typeof company === "string" && company.trim() !== "") {
    return NextResponse.json({ ok: true });
  }

  if (typeof email !== "string" || !EMAIL_RE.test(email.trim())) {
    return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
  }

  try {
    const supabase = createSupabaseWriteClient();
    // No .select() chained, so the insert uses Prefer: return=minimal and needs no SELECT grant —
    // which is exactly what the anon RLS policy allows (INSERT only, no read-back).
    const { error } = await supabase.from("waitlist").insert({
      email: email.trim().toLowerCase(),
      source: typeof source === "string" && source.trim() !== "" ? source.trim() : null
    });

    // 23505 = unique_violation: the email is already on the list. That's a success from the user's
    // point of view, so report ok rather than leaking that they'd already signed up.
    if (error && error.code !== "23505") {
      console.error(`[waitlist] Supabase insert failed (${error.code ?? "?"}): ${error.message}`);
      return NextResponse.json(
        { error: "We couldn't add you right now. Please try again." },
        { status: 502 }
      );
    }

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json(
      { error: "We couldn't reach the waitlist. Please try again." },
      { status: 502 }
    );
  }
}
