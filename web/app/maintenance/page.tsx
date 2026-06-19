import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "WhaleWatcher — Under Maintenance",
  description: "WhaleWatcher is briefly offline for scheduled maintenance. We'll be back shortly."
};

// Standalone maintenance screen. Rendered for every route while MAINTENANCE_MODE is on (see
// web/middleware.ts). It draws a fixed full-viewport overlay (`wm-` styles in globals.css) so it
// covers the shared topnav + ocean scene from app/layout.tsx without needing its own layout.
export default function MaintenancePage() {
  return (
    <div className="wm-page">
      <div className="wm-card">
        <span className="wm-status">
          <span className="wm-dot" /> System offline · Scheduled maintenance
        </span>

        <div className="wm-scope" aria-hidden>
          <svg viewBox="0 0 200 200">
            <circle cx="100" cy="100" r="96" fill="none" stroke="rgba(54,236,208,0.16)" />
            <circle cx="100" cy="100" r="64" fill="none" stroke="rgba(54,236,208,0.12)" />
            <circle cx="100" cy="100" r="32" fill="none" stroke="rgba(54,236,208,0.10)" />
            <line x1="100" y1="4" x2="100" y2="196" stroke="rgba(54,236,208,0.08)" />
            <line x1="4" y1="100" x2="196" y2="100" stroke="rgba(54,236,208,0.08)" />
          </svg>
          <div className="wm-sweep" />
        </div>

        <h1 className="wm-title">
          Down for <span className="g">maintenance.</span>
        </h1>
        <p className="wm-sub">
          We&apos;ve surfaced the console for a moment to tune the instruments. WhaleWatcher will be
          back online shortly — thanks for your patience.
        </p>

        <div className="wm-foot">
          <span className="g">WHALE</span>WATCHER · Hydrophone Console
        </div>
      </div>
    </div>
  );
}
