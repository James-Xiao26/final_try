"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Activity" },
  { href: "/leaderboard", label: "Leaderboard" },
  { href: "/markets", label: "Markets" },
  { href: "/decision", label: "Signals" },
] as const;

export default function SidebarNav() {
  const pathname = usePathname();

  // The early-access landing is a standalone funnel — no links out to the rest of the app.
  if (pathname.startsWith("/early-access")) return null;

  return (
    <div className="nav-links">
      {LINKS.map((link) => {
        // Activity ("/") is active only on the exact path. Leaderboard owns wallet profiles (linked
        // from both views); other links match their own subtree.
        const isActive =
          link.href === "/"
            ? pathname === "/" || pathname.startsWith("/market/")
            : link.href === "/leaderboard"
              ? pathname.startsWith("/leaderboard") || pathname.startsWith("/wallet")
              : pathname.startsWith(link.href);
        return (
          <Link
            key={link.href}
            href={link.href}
            className="nav-link mono"
            aria-current={isActive ? "page" : undefined}
          >
            {link.label}
          </Link>
        );
      })}
    </div>
  );
}
