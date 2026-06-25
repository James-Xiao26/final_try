"use client";

import { createBrowserClient } from "@supabase/ssr";
import { useEffect, useState } from "react";
import type { Database } from "./types";

// Separate file from supabase.ts on purpose: supabase.ts imports next/headers (server-only), so a
// client component importing it would error. This file is client-safe.
export function supabaseBrowser() {
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}

interface AuthState {
  loading: boolean;
  signedIn: boolean;
  email: string | null;
  avatar: string | null;
}

// UI-only auth state. Uses getSession (reads the local cookie, no network) for a snappy gate; the
// real security boundary is the gated API routes' server-side getUser() check, not this.
// ponytail: client UI gate, not a security check — the 401 in the API routes is the actual lock.
export function useUser(): AuthState {
  const [state, setState] = useState<AuthState>({ loading: true, signedIn: false, email: null, avatar: null });

  useEffect(() => {
    const sb = supabaseBrowser();
    let active = true;

    const apply = (user: { email?: string; user_metadata?: Record<string, unknown> } | null): void => {
      if (!active) return;
      const avatar = typeof user?.user_metadata?.avatar_url === "string" ? user.user_metadata.avatar_url : null;
      setState({ loading: false, signedIn: !!user, email: user?.email ?? null, avatar });
    };

    sb.auth.getSession().then(({ data }) => apply(data.session?.user ?? null));
    const { data: sub } = sb.auth.onAuthStateChange((_event, session) => apply(session?.user ?? null));

    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  return state;
}
