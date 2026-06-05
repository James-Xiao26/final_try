"use client";

import { usePathname } from "next/navigation";

// The console wordmark in the topnav. Normally a link home ("/"), but on the standalone early-access
// landing it points back at the landing itself so the page exposes no route into the rest of the app.
export default function BrandMark() {
  const pathname = usePathname();
  const href = pathname.startsWith("/early-access") ? "/early-access" : "/";

  return (
    <a className="brand-mark" href={href} aria-label="WhaleWatcher home">
      <svg viewBox="0 0 48 48" fill="none" aria-hidden>
        <circle cx="24" cy="24" r="21" stroke="#36ecd0" strokeWidth="1" opacity="0.35" />
        <circle cx="24" cy="24" r="14" stroke="#36ecd0" strokeWidth="1" opacity="0.5" />
        <circle cx="24" cy="24" r="7" stroke="#36ecd0" strokeWidth="1" opacity="0.7" />
        <path d="M11 27c5 2 9 2 13-1 3-2 6-3 10-1-1 3-4 5-8 5-3 0-5-1-6-2-3 2-6 2-9-1z" fill="#36ecd0" />
        <circle cx="30" cy="24" r="1.4" fill="#03141d" />
      </svg>
      <div>
        <div className="wm">
          <b>WHALE</b>
          <span className="light">WATCHER</span>
        </div>
        <div className="tag">Hydrophone Console</div>
      </div>
    </a>
  );
}
