import { NextResponse } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { Database } from "@/lib/types";

type CookieToSet = { name: string; value: string; options: CookieOptions };

// OAuth landing: Google → Supabase → here with a one-time ?code. We exchange it for a session
// (writing the auth cookies) and bounce the user to wherever they were headed.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  // Only allow same-site relative paths back — never an attacker-supplied absolute URL (open redirect).
  const nextParam = url.searchParams.get("next") ?? "/";
  const next = nextParam.startsWith("/") ? nextParam : "/";

  if (code) {
    const cookieStore = cookies();
    const supabase = createServerClient<Database>(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return cookieStore.getAll();
          },
          setAll(toSet: CookieToSet[]) {
            toSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
          }
        }
      }
    );
    await supabase.auth.exchangeCodeForSession(code);
  }

  return NextResponse.redirect(new URL(next, url.origin));
}
