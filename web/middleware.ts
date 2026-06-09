import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Pre-launch access gate. The public may only reach the early-access landing (and the waitlist API
// it posts to); every other route is bounced there — UNLESS the visitor holds the access cookie.
//
// You unlock the full app on the live site by visiting `/unlock?key=<SITE_ACCESS_KEY>` once: this
// sets a long-lived, httpOnly cookie and from then on your browser sees the real pages. Public
// users have no cookie, so they only ever see the waitlist.
//
// Fail-closed: if SITE_ACCESS_KEY is unset, nobody can unlock and everyone sees the waitlist.
// Replaces the old next.config.mjs `/` → `/early-access` redirect (which only covered `/` and gave
// you no way in). Gating is production-only so local `next dev` still shows every page.

const ACCESS_COOKIE = "eb_access";

// Reachable without the cookie. The waitlist API must stay open so the form works for the public.
// (/api/health is a temporary diagnostic — remove it from here and delete the route once env is fixed.)
const PUBLIC_PATHS = ["/early-access", "/api/waitlist", "/api/health"];

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export function middleware(req: NextRequest) {
  // Only gate the live site; local dev shows everything so we can work on the gated pages.
  if (process.env.NODE_ENV !== "production") return NextResponse.next();

  const { pathname, searchParams } = req.nextUrl;
  const accessKey = process.env.SITE_ACCESS_KEY;

  // Unlock flow: /unlock?key=… sets the cookie on a correct key, then redirects to the app root.
  if (pathname === "/unlock") {
    const dest = req.nextUrl.clone();
    dest.search = "";
    if (accessKey && searchParams.get("key") === accessKey) {
      dest.pathname = "/";
      const res = NextResponse.redirect(dest);
      res.cookies.set(ACCESS_COOKIE, accessKey, {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        path: "/",
        maxAge: 60 * 60 * 24 * 365 // one year
      });
      return res;
    }
    // Wrong or missing key → just show the waitlist, no hint that anything else exists.
    dest.pathname = "/early-access";
    return NextResponse.redirect(dest);
  }

  const hasAccess = Boolean(accessKey) && req.cookies.get(ACCESS_COOKIE)?.value === accessKey;
  if (hasAccess || isPublic(pathname)) {
    return NextResponse.next();
  }

  const dest = req.nextUrl.clone();
  dest.pathname = "/early-access";
  dest.search = "";
  return NextResponse.redirect(dest);
}

export const config = {
  // Run on everything except Next internals and static asset files (icons, fonts, etc.) so those
  // load on the waitlist page without a cookie.
  matcher: ["/((?!_next/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt|xml|woff2?)$).*)"]
};
