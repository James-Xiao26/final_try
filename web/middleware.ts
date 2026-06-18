import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Maintenance gate. When the MAINTENANCE_MODE env var is "on" (set in the Vercel dashboard, then
// redeploy), every request is rewritten to the standalone /maintenance page and answered with a 503
// so uptime monitors and search engines treat the outage correctly. Flip it back to anything else
// (or remove it) and redeploy to restore the site.
//
// The matcher below already excludes Next's static assets, the API routes, and the maintenance page
// itself, so this only ever fires for real page navigations.
const ENABLED = ["on", "1", "true", "yes"];

export function middleware(request: NextRequest) {
  const flag = (process.env.MAINTENANCE_MODE ?? "").trim().toLowerCase();
  if (!ENABLED.includes(flag)) {
    return NextResponse.next();
  }

  const url = request.nextUrl.clone();
  url.pathname = "/maintenance";
  return NextResponse.rewrite(url, { status: 503, headers: { "Retry-After": "3600" } });
}

export const config = {
  // Run on everything except Next internals, the maintenance page, and common static files.
  matcher: ["/((?!_next/|maintenance|favicon.ico|icon.svg|apple-icon.png|api/).*)"]
};
