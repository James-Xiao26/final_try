import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { IBM_Plex_Mono } from "next/font/google";
import type { ReactNode } from "react";
import SidebarNav from "@/components/SidebarNav";

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-plex-mono"
});

export const metadata: Metadata = {
  title: "WhaleWatcher",
  description: "Risk-adjusted Polymarket trader leaderboard."
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${plexMono.variable}`}>
      <body>
        <style>{`
          :root {
            --bg: #0A0B0E;
            --panel: #101217;
            --line: #262A33;
            --text: #F2F5F7;
            --muted: #8D95A3;
            --green: #00FF88;
            --red: #FF3B5C;
            --yellow: #FFD166;
          }
          * { box-sizing: border-box; }
          html { color-scheme: dark; background: var(--bg); }
          body {
            margin: 0;
            min-height: 100vh;
            background:
              linear-gradient(rgba(255,255,255,0.025) 1px, transparent 1px),
              linear-gradient(90deg, rgba(255,255,255,0.025) 1px, transparent 1px),
              var(--bg);
            background-size: 24px 24px;
            color: var(--text);
            font-family: var(--font-geist-sans), Inter, system-ui, sans-serif;
            letter-spacing: 0;
          }
          a { color: inherit; text-decoration: none; }
          button, input { font: inherit; }
          button { cursor: pointer; }
          .mono { font-family: var(--font-plex-mono), ui-monospace, SFMono-Regular, monospace; }
          .shell { display: flex; min-height: 100vh; }
          .sidebar {
            width: 220px;
            flex-shrink: 0;
            border-right: 1px solid var(--line);
            background: rgba(16, 18, 23, 0.9);
            padding: 24px 14px;
            position: sticky;
            top: 0;
            height: 100vh;
            display: flex;
            flex-direction: column;
            gap: 20px;
          }
          .brand-mark { font-size: 15px; font-weight: 700; letter-spacing: 1px; color: var(--text); }
          .nav-links { display: flex; flex-direction: column; gap: 4px; }
          .nav-link {
            display: block;
            padding: 10px 12px;
            color: var(--muted);
            border: 1px solid transparent;
            font-size: 13px;
          }
          .nav-link:hover { color: var(--text); }
          .nav-link[aria-current=page] {
            color: var(--text);
            border-color: var(--line);
            background: rgba(0, 255, 136, 0.06);
          }
          /* min-width:0 lets wide tables inside scroll instead of stretching the flex layout. */
          .content { flex: 1; min-width: 0; }
          .page {
            width: min(1180px, calc(100vw - 32px));
            margin: 0 auto;
            padding: 32px 0 56px;
          }
          .topbar {
            display: flex;
            align-items: end;
            justify-content: space-between;
            gap: 20px;
            margin-bottom: 28px;
          }
          .brand { font-size: 28px; font-weight: 700; margin: 0; letter-spacing: 0; }
          .subtitle { margin: 6px 0 0; color: var(--muted); max-width: 680px; line-height: 1.5; }
          .panel {
            border: 1px solid var(--line);
            background: rgba(16, 18, 23, 0.9);
            box-shadow: 0 0 0 1px rgba(0,255,136,0.04);
          }
          .toolbar {
            display: flex;
            justify-content: space-between;
            gap: 16px;
            padding: 14px;
            border-bottom: 1px solid var(--line);
          }
          .muted { color: var(--muted); }
          .positive { color: var(--green); }
          .negative { color: var(--red); }
          .warning { color: var(--yellow); }
          @keyframes pulse { 50% { opacity: 0.45; } }
          .skeleton {
            background: linear-gradient(90deg, #151922, #202632, #151922);
            background-size: 200% 100%;
            animation: pulse 1.2s ease-in-out infinite;
          }
          @media (max-width: 760px) {
            .shell { flex-direction: column; }
            .sidebar {
              width: auto;
              height: auto;
              position: static;
              flex-direction: row;
              align-items: center;
              gap: 14px;
              border-right: 0;
              border-bottom: 1px solid var(--line);
              padding: 14px 16px;
              overflow-x: auto;
            }
            .nav-links { flex-direction: row; }
            .page { width: min(100vw - 20px, 1180px); padding-top: 18px; }
            .topbar, .toolbar { align-items: stretch; flex-direction: column; }
            .brand { font-size: 24px; }
          }
        `}</style>
        <div className="shell">
          <nav className="sidebar" aria-label="Primary">
            <div className="brand-mark mono">EDGEBOARD</div>
            <SidebarNav />
          </nav>
          <div className="content">{children}</div>
        </div>
      </body>
    </html>
  );
}
