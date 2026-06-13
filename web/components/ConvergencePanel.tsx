"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { formatCompactUsd } from "@/lib/format";
import type { CrowdedMarketSummary } from "@/lib/types";
import { useScrollLog } from "./useScrollLog";

interface ConvergencePanelProps {
  initialRows: CrowdedMarketSummary[];
}

const POLL_INTERVAL_MS = 60_000;

function elapsedFrom(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

// Lean = which side the committed capital tilts toward. Returns a label + class.
function lean(row: CrowdedMarketSummary): { label: string; cls: string } {
  if (row.yesTraders > row.noTraders) return { label: "YES", cls: "yes" };
  if (row.noTraders > row.yesTraders) return { label: "NO", cls: "no" };
  return { label: "SPLIT", cls: "split" };
}

function ConvergenceRow({ row }: { row: CrowdedMarketSummary }) {
  const total = Math.max(1, row.yesTraders + row.noTraders);
  const yesPct = (row.yesTraders / total) * 100;
  const l = lean(row);

  return (
    <Link className="cv-row" href={`/market/${encodeURIComponent(row.conditionId)}`} title="Open market analytics">
      <div className="cv-rank-cell">
        <span className="cv-contacts">{row.traderCount}</span>
        <span className="cv-contacts-lbl">contacts</span>
      </div>
      <div className="cv-market-cell">
        <span className="cv-q" title={row.market ?? ""}>{row.market || "—"}</span>
        <div className="cv-meta">
          {row.topRank !== null ? <span className="cv-toprank">Top contact #{row.topRank}</span> : null}
          <span className="cv-last">last close {elapsedFrom(row.lastTradedAt)}</span>
        </div>
      </div>
      <div className="cv-split-cell">
        <div className="cv-splitbar">
          <span className="cv-splitbar-yes" style={{ width: `${yesPct}%` }} />
          <span className="cv-splitbar-no" style={{ width: `${100 - yesPct}%` }} />
        </div>
        <div className="cv-splitlabels">
          <span className="yes">{row.yesTraders} YES</span>
          <span className="no">{row.noTraders} NO</span>
        </div>
      </div>
      <div className="cv-num-cell">
        <span className="cv-num">{formatCompactUsd(row.committedUsd)}</span>
        <span className="cv-num-lbl">committed</span>
      </div>
      <div className="cv-lean-cell">
        <span className={`cv-lean ${l.cls}`}>{l.label}</span>
      </div>
    </Link>
  );
}

export default function ConvergencePanel({ initialRows }: ConvergencePanelProps) {
  const [rows, setRows] = useState(initialRows);
  const { locked, shellRef, logRef, hoverProps } = useScrollLog(rows);

  useEffect(() => {
    let active = true;
    const poll = (): void => {
      if (document.hidden) return;
      fetch("/api/crowded-markets")
        .then((response) => (response.ok ? (response.json() as Promise<{ markets: CrowdedMarketSummary[] }>) : Promise.reject(new Error("request failed"))))
        .then((data) => {
          if (active) setRows(data.markets);
        })
        .catch(() => {
          /* keep last good data */
        });
    };
    const id = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, []);

  return (
    <section className="cv-section">
      <div className="cv-head">
        <h2>Convergence <span className="g">Zones</span></h2>
        <span className="cv-sub">Where the pod is feeding — markets the most tracked contacts hold</span>
      </div>
      <div className="panel cv-list log-shell at-top" ref={shellRef}>
        <div className={`cv-scroll log-scroll ${locked ? "hovered" : ""}`} ref={logRef} {...hoverProps}>
          {rows.length === 0 ? (
            <p className="muted" style={{ padding: 36, textAlign: "center", margin: 0 }}>
              No converged markets yet — the board&apos;s positions haven&apos;t been ingested.
            </p>
          ) : (
            rows.map((row) => <ConvergenceRow key={row.conditionId} row={row} />)
          )}
        </div>
      </div>
    </section>
  );
}
