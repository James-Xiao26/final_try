"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { formatNumber, formatPercent, formatPrice, formatUsd, shortenAddress } from "@/lib/format";
import type { RecentTradePosition, RecentTradesFeed as RecentTradesFeedData } from "@/lib/types";

interface RecentTradesFeedProps {
  initialPositions: RecentTradePosition[];
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
  if (s < 45) return "just now";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

function clockFrom(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

// Binary Polymarket markets index outcome 0 = YES, 1 = NO. Anything else gets no chip.
function outcomeLabel(index: number | null): "YES" | "NO" | null {
  if (index === 0) return "YES";
  if (index === 1) return "NO";
  return null;
}

function positionId(p: RecentTradePosition): string {
  return `${p.address}:${p.conditionId}:${p.outcomeIndex}`;
}

// Running average-cost after each fill, oldest→newest, mapped back to the newest-first `fills` order
// for the expandable ledger. Pure presentation — the authoritative basis comes from the server.
function runningAverages(fills: RecentTradePosition["fills"]): (number | null)[] {
  const chron = [...fills].reverse();
  let size = 0;
  let cost = 0;
  const out: (number | null)[] = [];
  for (const f of chron) {
    const side = (f.side ?? "").toUpperCase();
    if (f.price !== null && f.size !== null) {
      if (side === "BUY") {
        cost += f.price * f.size;
        size += f.size;
      } else if (side === "SELL") {
        const avg = size > 0 ? cost / size : 0;
        cost -= f.size * avg;
        size -= f.size;
      }
    }
    out.push(size > 0 ? cost / size : f.price);
  }
  return out.reverse();
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

// One P/L pill: green for gains, red for losses, neutral "P/L n/a" when basis is unknown.
function PlPill({ pct }: { pct: number | null }) {
  if (pct === null) {
    return <span className="af-pl na">P/L n/a</span>;
  }
  return <span className={`af-pl ${pct >= 0 ? "up" : "dn"}`}>{formatPercent(pct, true)}</span>;
}

function PositionRow({ p }: { p: RecentTradePosition }) {
  const [open, setOpen] = useState(false);
  const grouped = p.fills.length > 1;
  const out = outcomeLabel(p.outcomeIndex);
  const buy = (p.lastSide ?? "").toUpperCase() === "BUY";
  const sell = (p.lastSide ?? "").toUpperCase() === "SELL";
  const runAvgs = grouped ? runningAverages(p.fills) : [];

  // Avg-entry cell content varies by where the basis came from.
  let avgLead: JSX.Element;
  let avgSub: string;
  if (p.avgEntry === null) {
    avgLead = <>—</>;
    avgSub = "opened earlier";
  } else if (p.basisSource === "cache") {
    avgLead = (
      <>
        {formatPrice(p.avgEntry)}
        <span className="af-srcchip" title="From the Polymarket position cache — this position's buys predate the 24h feed window">
          cache
        </span>
      </>
    );
    avgSub = p.state === "open" ? "cost basis" : "cached basis";
  } else {
    avgLead = <>{formatPrice(p.avgEntry)}</>;
    avgSub = grouped ? "blended basis" : "single fill";
  }

  // Position cell: current value + unrealized % (open) or "closed" + realized % (closed).
  const posLead =
    p.state === "open" ? (
      <>
        {p.positionValue === null ? "—" : formatUsd(p.positionValue)} <PlPill pct={p.unrealizedPct} />
      </>
    ) : (
      <>
        closed <PlPill pct={p.realizedPct} />
      </>
    );
  const posSub =
    p.state === "open"
      ? `${formatNumber(p.remainingSize)} sh${p.mark !== null ? ` · mark ${formatPrice(p.mark)}` : ""}`
      : `sold ${formatNumber(p.soldSize)} sh`;

  return (
    <>
      <tr className={`af-row ${grouped ? "group" : ""} ${open ? "open" : ""}`} onClick={grouped ? () => setOpen((v) => !v) : undefined}>
        <td className="af-contact">
          <Link
            href={`/wallet/${p.address}`}
            className="name"
            title={p.handle ? `@${p.handle}` : p.address}
            onClick={(e) => e.stopPropagation()}
          >
            {p.handle ? (
              <>
                <span className="at">@</span>
                {traderLabel(p.handle, p.address).replace(/^@/, "")}
              </>
            ) : (
              shortenAddress(p.address)
            )}
          </Link>
          <div className="skl">
            <span className="sigchip">{p.rank === null ? "Unranked" : `Rank #${p.rank}`}</span>
            {grouped ? <span className="af-fillcount">{p.fills.length} fills</span> : null}
          </div>
        </td>
        <td className="af-market">
          <span className="q" title={p.market ?? ""}>
            {p.market || "—"}
          </span>
          {out ? <span className={`af-out ${out === "YES" ? "yes" : "no"}`}>{out}</span> : null}
        </td>
        <td className="af-fill">
          {p.lastSide === null ? (
            <span className="muted">—</span>
          ) : (
            <div className="af-stack">
              <span className={`af-bearing ${buy ? "buy" : sell ? "sell" : ""}`}>
                <span className="ar">{buy ? "▲" : sell ? "▼" : "•"}</span>
                {buy ? "BUY" : sell ? "SELL" : p.lastSide} {p.lastSize === null ? "" : formatNumber(p.lastSize)}
              </span>
              <span className="sub">@ {p.lastPrice === null ? "—" : formatPrice(p.lastPrice)}</span>
            </div>
          )}
        </td>
        <td className="af-avg">
          <div className="af-stack">
            <span className="lead">{avgLead}</span>
            <span className="sub">{avgSub}</span>
          </div>
        </td>
        <td className="af-pos">
          <div className="af-stack">
            <span className="lead">{posLead}</span>
            <span className="sub">{posSub}</span>
          </div>
        </td>
        <td className="af-time" title={p.latestTradedAt}>
          <div className="af-stack">
            <span className="lead" suppressHydrationWarning>
              {elapsedFrom(p.latestTradedAt)}
            </span>
            {grouped ? (
              <span className="chev">
                FILLS
                <svg viewBox="0 0 16 16" fill="none" aria-hidden>
                  <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
            ) : (
              <span className="chev empty" />
            )}
          </div>
        </td>
      </tr>
      {grouped ? (
        <tr className={`af-detail ${open ? "open" : ""}`}>
          <td colSpan={6}>
            <div className="af-ledger-wrap">
              <div className="af-ledger">
                <div className="lhead">
                  <span>Fill ledger · newest first</span>
                  <span className="line" />
                  <span>
                    {formatNumber(p.boughtSize)} bought · {formatNumber(p.soldSize)} sold
                  </span>
                </div>
                {p.fills.map((f, i) => {
                  const fbuy = (f.side ?? "").toUpperCase() === "BUY";
                  const ra = runAvgs[i] ?? null;
                  return (
                    <div className={`af-fill ${fbuy ? "is-buy" : "is-sell"}`} key={`${f.tradedAt}-${i}`}>
                      <span className="node" />
                      <span className={`side ${fbuy ? "buy" : "sell"}`}>{fbuy ? "▲ BUY" : "▼ SELL"}</span>
                      <span className="dtl">
                        <b>{f.size === null ? "—" : formatNumber(f.size)}</b> sh @ <b>{f.price === null ? "—" : formatPrice(f.price)}</b>
                      </span>
                      <span className="running">
                        avg after → <b>{ra === null ? "—" : formatPrice(ra)}</b>
                      </span>
                      <span className="ts" suppressHydrationWarning>
                        {clockFrom(f.tradedAt)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

export default function RecentTradesFeed({ initialPositions, initialTraderCount }: RecentTradesFeedProps) {
  const [positions, setPositions] = useState(initialPositions);
  const [traderCount, setTraderCount] = useState(initialTraderCount);
  const [locked, setLocked] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);

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
            setPositions(feed.positions);
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

  // Toggle the top/bottom scroll-edge fades so they hide at the extremes.
  useEffect(() => {
    const log = logRef.current;
    const shell = shellRef.current;
    if (!log || !shell) return;
    const update = (): void => {
      shell.classList.toggle("at-top", log.scrollTop <= 2);
      shell.classList.toggle("at-bottom", log.scrollTop + log.clientHeight >= log.scrollHeight - 2);
    };
    update();
    log.addEventListener("scroll", update);
    return () => log.removeEventListener("scroll", update);
  }, [positions]);

  const fillCount = positions.reduce((sum, p) => sum + p.fills.length, 0);

  return (
    <>
      <div className="panel act-scope-strip">
        <div className="meta"><div className="k">Intercepts · 24h</div><div className="v">{fillCount}</div></div>
        <div className="meta"><div className="k">Positions</div><div className="v">{positions.length}</div></div>
        <div className="meta"><div className="k">Active Contacts</div><div className="v">{traderCount}</div></div>
        <Oscilloscope />
      </div>

      <section className="act-feed">
        <div className="act-feed-head">
          <h2>Acoustic <span className="g">Log</span></h2>
          <span className={`af-scroll-state ${locked ? "locked" : ""}`}>
            <span className="pip" />
            {locked ? "Feed scroll · log locked" : "Page scroll · hover log to lock"}
          </span>
        </div>
        <div className="panel af-log-shell at-top" ref={shellRef}>
          <div
            className={`af-log ${locked ? "hovered" : ""}`}
            ref={logRef}
            onMouseEnter={() => setLocked(true)}
            onMouseLeave={() => setLocked(false)}
          >
            <table>
              <thead>
                <tr>
                  <th>Contact</th>
                  <th>Market</th>
                  <th className="r">Last Fill</th>
                  <th className="r">Avg Entry</th>
                  <th className="r">Position</th>
                  <th className="r">Time</th>
                </tr>
              </thead>
              <tbody>
                {positions.length === 0 ? (
                  <tr><td colSpan={6} className="muted" style={{ padding: 36, textAlign: "center" }}>No intercepts from board contacts in the last 24 hours.</td></tr>
                ) : (
                  positions.map((p) => <PositionRow key={positionId(p)} p={p} />)
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </>
  );
}
