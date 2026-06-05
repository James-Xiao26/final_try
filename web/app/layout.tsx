import type { Metadata } from "next";
import { Chakra_Petch, IBM_Plex_Mono } from "next/font/google";
import type { ReactNode } from "react";
import OceanScene from "@/components/OceanScene";
import SidebarNav from "@/components/SidebarNav";
import "./globals.css";

// Chakra Petch: a squared, technical display face that reads like an instrument console — used for
// the wordmark, nav, headings, and key figures. IBM Plex Mono carries body text and tabular data.
const display = Chakra_Petch({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-display",
  display: "swap"
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  variable: "--font-plex-mono"
});

export const metadata: Metadata = {
  title: "WhaleWatcher",
  description: "Polymarket trader leaderboard, ranked by forecasting edge."
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${plexMono.variable}`}>
      <body>
        <OceanScene />

        <div className="shell">
          <header className="topnav">
            <div className="topnav-inner">
              <a className="brand-mark" href="/" aria-label="WhaleWatcher home">
                <svg viewBox="0 0 48 48" fill="none" aria-hidden>
                  <circle cx="24" cy="24" r="21" stroke="#36ecd0" strokeWidth="1" opacity="0.35" />
                  <circle cx="24" cy="24" r="14" stroke="#36ecd0" strokeWidth="1" opacity="0.5" />
                  <circle cx="24" cy="24" r="7" stroke="#36ecd0" strokeWidth="1" opacity="0.7" />
                  <path d="M11 27c5 2 9 2 13-1 3-2 6-3 10-1-1 3-4 5-8 5-3 0-5-1-6-2-3 2-6 2-9-1z" fill="#36ecd0" />
                  <circle cx="30" cy="24" r="1.4" fill="#03141d" />
                </svg>
                <div>
                  <div className="wm"><b>WHALE</b><span className="light">WATCHER</span></div>
                  <div className="tag">Hydrophone Console</div>
                </div>
              </a>
              <SidebarNav />
            </div>
          </header>
          <main className="content">{children}</main>
        </div>
      </body>
    </html>
  );
}
