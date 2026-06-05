import { NextResponse } from "next/server";

// Server-side proxy to Waitlister's form-action endpoint. Posting from the server (rather than the
// browser) avoids CORS and lets the client keep our own styled success state instead of being
// redirected to Waitlister's hosted confirmation page. The waitlist key is public (it ships in
// Waitlister's own embed snippets), so a sane default is baked in; override with WAITLISTER_KEY.
const WAITLISTER_KEY = process.env.WAITLISTER_KEY ?? "ztTKuFNeBL_D";
const ENDPOINT = `https://waitlister.me/s/${WAITLISTER_KEY}`;

// Pragmatic email shape check — the real validation happens at Waitlister; this just rejects
// obvious junk before we spend a round-trip.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(request: Request) {
  let email: unknown;
  try {
    ({ email } = await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (typeof email !== "string" || !EMAIL_RE.test(email.trim())) {
    return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
  }

  try {
    // Waitlister gates the form endpoint on a domain allow-list, checked against Origin/Referer.
    // Posting server-side we have neither, so forward the browser's — Waitlister then matches the
    // site's real host (which must be added under Settings → Whitelisted domains in the dashboard).
    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json"
    };
    const origin = request.headers.get("origin");
    const referer = request.headers.get("referer");
    if (origin) headers.Origin = origin;
    if (referer) headers.Referer = referer;

    const body = new URLSearchParams({ email: email.trim() });
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers,
      body,
      // Don't follow Waitlister's post-submit redirect to its hosted success page — a 3xx means the
      // signup landed, which is all we need.
      redirect: "manual"
    });

    // 2xx (JSON/no-content) and 3xx (redirect to hosted confirmation) both indicate success.
    if (res.ok || (res.status >= 300 && res.status < 400)) {
      return NextResponse.json({ ok: true });
    }

    // Surface Waitlister's own message — e.g. "Domain not whitelisted. Please add this domain to
    // your waitlist settings." — which is far more actionable than a generic failure.
    const detail = (await res.json().catch(() => null)) as { message?: string } | null;
    const message = detail?.message ?? "We couldn't add you right now. Please try again.";
    console.error(`[waitlist] Waitlister ${res.status}: ${message}`);
    return NextResponse.json({ error: message }, { status: 502 });
  } catch {
    return NextResponse.json(
      { error: "We couldn't reach the waitlist. Please try again." },
      { status: 502 }
    );
  }
}
