"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { formatPrice, formatUsd, shortenAddress } from "@/lib/format";
import type { RecentTrade, RecentTradesFeed as RecentTradesFeedData } from "@/lib/types";

interface RecentTradesFeedProps {
  initialTrades: RecentTrade[];
  initialTraderCount: number;
}

const POLL_INTERVAL_MS = 60_000;
const MAX_HANDLE_LENGTH = 16;

function traderLabel(handle: string | null, address: string): string {
  if (!handle) {
    return shortenAddress(address);
  }
  const label = `@${handle}`;
  return label.length > MAX_HANDLE_LENGTH ? `${label.slice(0, MAX_HANDLE_LENGTH - 1)}…` : label;
}

function elapsedFrom(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) {
    return "—";
  }
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

// Live hydrophone oscilloscope — a scrolling acoustic trace with occasional "ping" bursts.
function Oscilloscope() {
  const pathRef = useRef<SVGPathElement>(null);

  useEffect(() => {
    const path = pathRef.current;
    if (!path) return;
    const W = 600;
    const H = 74;
    const mid = H / 2;
    const N = 120;
    const buf: number[] = new Array(N).fill(0);
    let ph = 0;
    let burst = 0;
    let raf = 0;

    const frame = (): void => {
      ph += 0.18;
      if (Math.random() < 0.03) burst = 1;
      burst *= 0.92;
      const sample =
        Math.sin(ph) * 0.4 +
        Math.sin(ph * 2.3) * 0.18 +
        (Math.random() - 0.5) * 0.25 +
        burst * (Math.random() - 0.5) * 2.4;
      buf.push(sample);
      if (buf.length > N) buf.shift();
      let d = "";
      for (let i = 0; i < buf.length; i++) {
        const x = (i / (N - 1)) * W;
        const y = Math.max(2, Math.min(H - 2, mid - (buf[i] ?? 0) * mid * 0.8));
        d += `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)} `;
      }
      path.setAttribute("d", d);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="act-osc">
      <svg viewBox="0 0 600 74" preserveAspectRatio="none" aria-hidden>
        <line x1="0" x2="600" y1="37" y2="37" stroke="rgba(54,236,208,0.15)" strokeDasharray="3 4" />
        <path
          ref={pathRef}
          fill="none"
          stroke="#36ecd0"
          strokeWidth="1.4"
          strokeLinejoin="round"
          style={{ filter: "drop-shadow(0 0 4px rgba(54,236,208,0.7))" }}
        />
      </svg>
    </div>
  );
}

export default function RecentTradesFeed({ initialTrades, initialTraderCount }: RecentTradesFeedProps) {
  const [trades, setTrades] = useState(initialTrades);
  const [traderCount, setTraderCount] = useState(initialTraderCount);

  useEffect(() => {
    let active = true;
    const poll = (): void => {
      if (document.hidden) {
        return;
      }
      fetch("/api/recent-trades")
        .then((response) =>
          response.ok ? (response.json() as Promise<RecentTradesFeedData>) : Promise.reject(new Error("Recent trades request failed"))
        )
        .then((feed) => {
          if (active) {
            setTrades(feed.trades);
            setTraderCount(feed.traderCount);
          }
        })
        .catch(() => {
          /* keep last good data */
        });
    };
    const intervalId = setInterval(poll, POLL_INTERVAL_MS);
    const onVisibility = (): void => {
      if (!document.hidden) poll();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      active = false;
      clearInterval(intervalId);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return (
    <>
      <div className="panel act-scope-strip">
        <div className="meta"><div className="k">Intercepts · 24h</div><div className="v">{trades.length}</div></div>
        <div className="meta"><div className="k">Active Contacts</div><div className="v">{traderCount}</div></div>
        <Oscilloscope />
      </div>

      <section className="act-feed">
        <div className="act-feed-head">
          <h2>Acoustic <span className="g">Log</span></h2>
          <span className="meta">newest intercept first</span>
        </div>
        <div className="panel act-feed-panel">
          <table>
            <thead>
              <tr>
                <th>Contact</th>
                <th>Transmission</th>
                <th>Bearing</th>
                <th className="r">Depth</th>
                <th className="r">Tonnage</th>
                <th className="r">Elapsed</th>
              </tr>
            </thead>
            <tbody>
              {trades.length === 0 ? (
                <tr><td colSpan={6} className="muted" style={{ padding: 36, textAlign: "center" }}>No intercepts from board contacts in the last 24 hours.</td></tr>
              ) : (
                trades.map((trade, index) => {
                  const buy = trade.side === "BUY";
                  const sell = trade.side === "SELL";
                  return (
                    <tr key={`${trade.address}-${trade.tradedAt}-${index}`}>
                      <td className="act-contact">
                        <Link href={`/wallet/${trade.address}`} className="name" title={trade.handle ? `@${trade.handle}` : trade.address}>
                          {trade.handle ? <><span className="at">@</span>{traderLabel(trade.handle, trade.address).replace(/^@/, "")}</> : shortenAddress(trade.address)}
                        </Link>
                        <div className="skl"><span className="sigchip">SIG {trade.skillScore === null ? "—" : trade.skillScore.toFixed(1)}</span></div>
                      </td>
                      <td className="act-market"><span title={trade.market ?? ""}>{trade.market || "—"}</span></td>
                      <td>
                        {trade.side === null ? (
                          <span className="muted">—</span>
                        ) : (
                          <span className={`act-bearing ${buy ? "buy" : sell ? "sell" : ""}`}>
                            <span className="ar">{buy ? "▲" : sell ? "▼" : "•"}</span>
                            {buy ? "INBOUND" : sell ? "SOUNDING" : trade.side}
                          </span>
                        )}
                      </td>
                      <td className="act-depth"><div className="v">{trade.price === null ? "—" : formatPrice(trade.price)}</div></td>
                      <td className="act-tonnage"><div className="v">{trade.usdcSize === null ? "—" : formatUsd(trade.usdcSize)}</div></td>
                      <td className="act-elapsed" title={trade.tradedAt} suppressHydrationWarning><div className="v">{elapsedFrom(trade.tradedAt)}</div></td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

