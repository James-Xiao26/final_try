"use client";

import Link from "next/link";
import { Fragment, useState } from "react";
import { formatNumber, formatPercent, formatPrice, formatUsd, shortenAddress } from "@/lib/format";
import type { CrowdFill, CrowdParticipant } from "@/lib/types";
import { useScrollLog } from "./useScrollLog";

interface CrowdParticipantsProps {
  participants: CrowdParticipant[];
}

function sideClass(side: string | null): string {
  const upper = (side ?? "").toUpperCase();
  return upper === "BUY" ? "buy" : upper === "SELL" ? "sell" : "";
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function PlCell({ pnl, pct }: { pnl: number | null; pct: number | null }) {
  if (pnl === null) return <span className="muted">—</span>;
  const up = pnl >= 0;
  return (
    <span className={up ? "pos" : "neg"}>
      {up ? "+" : ""}{formatUsd(pnl)}
      {pct !== null ? <span className="cp-pct"> {formatPercent(pct, true)}</span> : null}
    </span>
  );
}

function FillLedger({ fills }: { fills: CrowdFill[] }) {
  return (
    <table className="cp-fills">
      <thead>
        <tr>
          <th>Side</th>
          <th className="r">Price</th>
          <th className="r">Size</th>
          <th className="r">Value</th>
          <th className="r">Date</th>
        </tr>
      </thead>
      <tbody>
        {fills.map((fill, index) => (
          <tr key={`${fill.tradedAt}-${index}`}>
            <td><span className={`cp-fillside ${sideClass(fill.side)}`}>{fill.side ?? "—"}</span></td>
            <td className="r">{fill.price === null ? "—" : formatPrice(fill.price)}</td>
            <td className="r">{fill.size === null ? "—" : formatNumber(fill.size)}</td>
            <td className="r">{fill.usdcSize === null ? "—" : formatUsd(fill.usdcSize)}</td>
            <td className="r" title={fill.tradedAt}>{formatDate(fill.tradedAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ParticipantRow({ p }: { p: CrowdParticipant }) {
  const [open, setOpen] = useState(false);
  const hasFills = p.fills.length > 0;
  const label = p.handle ? `@${p.handle}` : shortenAddress(p.address);

  return (
    <Fragment>
      <tr className={`cp-row ${open ? "open" : ""}`} onClick={hasFills ? () => setOpen((v) => !v) : undefined} style={{ cursor: hasFills ? "pointer" : "default" }}>
        <td className="cp-caret">{hasFills ? (open ? "▾" : "▸") : ""}</td>
        <td className="cp-contact">
          <Link href={`/wallet/${p.address}`} className="cp-name" title={p.address} onClick={(e) => e.stopPropagation()}>
            {label}
          </Link>
          <div className="cp-sub">
            <span className="cp-rank">{p.rank === null ? "Unranked" : `Rank #${p.rank}`}</span>
            {p.skillScore !== null ? <span className="cp-skill">{p.skillScore.toFixed(1)} SIG</span> : null}
          </div>
        </td>
        <td><span className={`cp-side ${p.side === "YES" ? "yes" : p.side === "NO" ? "no" : ""}`}>{p.side}</span></td>
        <td><span className={`cp-state ${p.state}`}>{p.state}</span></td>
        <td className="r">{formatNumber(p.size)}</td>
        <td className="r">{p.avgEntry === null ? "—" : formatPrice(p.avgEntry)}</td>
        <td className="r">{p.value === null ? "—" : formatUsd(p.value)}</td>
        <td className="r"><PlCell pnl={p.pnl} pct={p.pnlPct} /></td>
        <td className="r" title={p.firstTradedAt ?? ""}>{formatDate(p.firstTradedAt)}</td>
        <td className="r" title={p.lastTradedAt ?? ""}>{formatDate(p.lastTradedAt)}</td>
      </tr>
      {open && hasFills ? (
        <tr className="cp-fillsrow">
          <td colSpan={10}><FillLedger fills={p.fills} /></td>
        </tr>
      ) : null}
    </Fragment>
  );
}

export default function CrowdParticipants({ participants }: CrowdParticipantsProps) {
  const { locked, shellRef, logRef, hoverProps } = useScrollLog(participants);

  return (
    <section className="panel cp-section">
      <div className="cp-head">
        <h2>Contacts <span className="g">on Station</span></h2>
        <span className="meta">leaderboard wallets in this market · click a row for fills</span>
      </div>
      {participants.length === 0 ? (
        <p className="muted" style={{ padding: 24, margin: 0 }}>No participants on record.</p>
      ) : (
        <div className="log-shell at-top" ref={shellRef}>
          <div className={`cp-tablewrap log-scroll ${locked ? "hovered" : ""}`} ref={logRef} {...hoverProps}>
            <table className="cp-table">
            <thead>
              <tr>
                <th />
                <th>Contact</th>
                <th>Side</th>
                <th>State</th>
                <th className="r">Size</th>
                <th className="r">Avg Entry</th>
                <th className="r">Value</th>
                <th className="r">P/L</th>
                <th className="r">First Buy</th>
                <th className="r">Last Trade</th>
              </tr>
            </thead>
            <tbody>
              {participants.map((p) => <ParticipantRow key={p.address} p={p} />)}
            </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}
