import Link from "next/link";
import { Radar, Crosshair, Waypoints } from "lucide-react";
import SignInButton from "@/components/SignInButton";

export const metadata = {
  title: "Sign in · WhaleWatcher",
  description: "Sign in with Google to unlock Signals, Convergence Zones, and Fresh Contacts."
};

// Where logged-out visitors land when they hit a gated feature. Reads ?next so we return them to
// where they were headed after Google sign-in.
export default function SignInPage({ searchParams }: { searchParams: { next?: string } }) {
  const next = typeof searchParams.next === "string" && searchParams.next.startsWith("/") ? searchParams.next : "/";

  return (
    <main className="page signin-page">
      <Link href="/" className="wl-back">← Back</Link>
      <section className="panel signin-card">
        <h1 className="brand">Sign in to <span className="g">WhaleWatcher</span></h1>
        <p className="subtitle">
          One click with Google unlocks the tracking tools. We only ever see your name, email, and
          profile photo — nothing else.
        </p>

        <ul className="signin-feats">
          <li><Crosshair size={16} /> <strong>Signals</strong> — skill-weighted trade calls where the sharpest wallets are positioned above market price.</li>
          <li><Waypoints size={16} /> <strong>Convergence Zones</strong> — the markets the most tracked contacts are crowding into.</li>
          <li><Radar size={16} /> <strong>Fresh Contacts</strong> — new wallets breaking onto the board in the last 24h.</li>
        </ul>

        <SignInButton next={next} />
      </section>
    </main>
  );
}
