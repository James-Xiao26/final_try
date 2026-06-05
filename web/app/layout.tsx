import type { Metadata } from "next";
import { Chakra_Petch, IBM_Plex_Mono } from "next/font/google";
import type { ReactNode } from "react";
import BrandMark from "@/components/BrandMark";
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
              <BrandMark />
              <SidebarNav />
            </div>
          </header>
          <main className="content">{children}</main>
        </div>
      </body>
    </html>
  );
}
