import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

type CookieToSet = { name: string; value: string; options: CookieOptions };

// Two jobs:
// 1. Maintenance gate — when MAINTENANCE_MODE is "on" (Vercel env var + redeploy), every page is
//    rewritten to /maintenance and answered 503. Flip it off (or remove) and redeploy to restore.
// 2. Auth — refresh the Supabase session cookie on every navigation (so logins persist) and bounce
//    logged-out visitors away from the gated Signals page.
const MAINTENANCE_ENABLED = ["on", "1", "true", "yes"];

// Pages that require a signed-in user. Anonymous visitors are redirected to /signin.
const GATED_PREFIXES = ["/decision"];

export async function middleware(request: NextRequest) {
  const flag = (process.env.MAINTENANCE_MODE ?? "").trim().toLowerCase();
  if (MAINTENANCE_ENABLED.includes(flag)) {
    const url = request.nextUrl.clone();
    url.pathname = "/maintenance";
    return NextResponse.rewrite(url, { status: 503, headers: { "Retry-After": "3600" } });
  }

  // Refresh the auth cookie. The setAll callback rebuilds `response` so refreshed tokens ride along.
  let response = NextResponse.next({ request });
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(toSet: CookieToSet[]) {
          toSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          toSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        }
      }
    }
  );

  // No session cookie → getUser() returns null without a network call, so anonymous traffic is free.
  const { data: { user } } = await supabase.auth.getUser();

  if (!user && GATED_PREFIXES.some((p) => request.nextUrl.pathname.startsWith(p))) {
    const url = request.nextUrl.clone();
    url.pathname = "/signin";
    url.search = `?next=${encodeURIComponent(request.nextUrl.pathname)}`;
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  // Everything except Next internals, the maintenance page, static files, and API routes (those
  // run their own auth check).
  matcher: ["/((?!_next/|maintenance|favicon.ico|icon.svg|apple-icon.png|api/).*)"]
};
