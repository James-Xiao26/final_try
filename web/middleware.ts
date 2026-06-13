import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Gate removed for public launch — all routes are open.
export function middleware(_req: NextRequest) {
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt|xml|woff2?)$).*)"]
};
