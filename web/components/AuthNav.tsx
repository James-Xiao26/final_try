"use client";

import Link from "next/link";
import { supabaseBrowser, useUser } from "@/lib/supabaseBrowser";

// Top-nav auth control: a "Sign in" link when logged out, the avatar + "Sign out" when logged in.
export default function AuthNav() {
  const { loading, signedIn, email, avatar } = useUser();

  if (loading) return <span className="auth-slot" />;

  if (!signedIn) {
    return (
      <Link href="/signin" className="auth-signin mono">
        Sign in
      </Link>
    );
  }

  const signOut = async (): Promise<void> => {
    await supabaseBrowser().auth.signOut();
    window.location.href = "/";
  };

  return (
    <div className="auth-user">
      {avatar ? (
        // eslint-disable-next-line @next/next/no-img-element -- a Google avatar URL, not a static asset
        <img src={avatar} alt="" className="auth-avatar" referrerPolicy="no-referrer" />
      ) : (
        <span className="auth-avatar auth-avatar-fallback">{(email ?? "?").charAt(0).toUpperCase()}</span>
      )}
      <button type="button" className="auth-signout mono" onClick={signOut}>
        Sign out
      </button>
    </div>
  );
}
