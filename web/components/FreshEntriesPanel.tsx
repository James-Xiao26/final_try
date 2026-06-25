"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { formatCompactUsd } from "@/lib/format";
import type { FreshEntrySummary } from "@/lib/types";
import { useUser } from "@/lib/supabaseBrowser";
import LockedPanel from "./LockedPanel";
import { useScrollLog } from "./useScrollLog";

interface FreshEntriesPanelProps {
  initialRows?: FreshEntrySummary[];
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

// Lean = which side the new entrants tilt toward (by headcount).
function lean(row: FreshEntrySummary): { label: string; cls: string } {
  if (row.yesEntrants > row.noEntrants) return { label: "YES", cls: "yes" };
  if (row.noEntrants > row.yesEntrants) return { label: "NO", cls: "no" };
  return { label: "SPLIT", cls: "split" };
}

function FreshEntryRow({ row }: { row: FreshEntrySummary }) {
  const total = Math.max(1, row.yesEntrants + row.noEntrants);
  const yesPct = (row.yesEntrants / total) * 100;
  const l = lean(row);

  return (
    <Link className="cv-row" href={`/market/${encodeURIComponent(row.conditionId)}`} title="Open market analytics">
      <div className="cv-rank-cell">
        <span className="cv-contacts">{row.entrantCount}</span>
        <span className="cv-contacts-lbl">new buyers</span>
      </div>
      <div className="cv-market-cell">
        <span className="cv-q" title={row.market ?? ""}>{row.market || "—"}</span>
        <div className="cv-meta">
          {row.topRank !== null ? <span className="cv-toprank">Top contact #{row.topRank}</span> : null}
          <span className="cv-last">first ping {elapsedFrom(row.lastEntryAt)}</span>
        </div>
      </div>
      <div className="cv-split-cell">
        <div className="cv-splitbar">
          <span className="cv-splitbar-yes" style={{ width: `${yesPct}%` }} />
          <span className="cv-splitbar-no" style={{ width: `${100 - yesPct}%` }} />
        </div>
        <div className="cv-splitlabels">
          <span className="yes">{row.yesEntrants} YES</span>
          <span className="no">{row.noEntrants} NO</span>
        </div>
      </div>
      <div className="cv-num-cell">
        <span className="cv-num">{formatCompactUsd(row.committedUsd)}</span>
        <span className="cv-num-lbl">fresh capital</span>
      </div>
      <div className="cv-lean-cell">
        <span className={`cv-lean ${l.cls}`}>{l.label}</span>
      </div>
    </Link>
  );
}

export default function FreshEntriesPanel({ initialRows = [] }: FreshEntriesPanelProps) {
  const { loading, signedIn } = useUser();
  const [rows, setRows] = useState(initialRows);
  const { locked, shellRef, logRef, hoverProps } = useScrollLog(rows);

  useEffect(() => {
    if (!signedIn) return; // gated: only signed-in users fetch the real data
    let active = true;
    const poll = (): void => {
      if (document.hidden) return;
      fetch("/api/fresh-entries")
        .then((response) => (response.ok ? (response.json() as Promise<{ markets: FreshEntrySummary[] }>) : Promise.reject(new Error("request failed"))))
        .then((data) => {
          if (active) setRows(data.markets);
        })
        .catch(() => {
          /* keep last good data */
        });
    };
    const id = setInterval(poll, POLL_INTERVAL_MS);
    poll(); // fetch immediately so empty SSR data hydrates without waiting 60 s
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [signedIn]);

  if (loading) return <section className="cv-section" aria-busy="true" style={{ minHeight: 120 }} />;
  if (!signedIn) {
    return (
      <LockedPanel
        title="Fresh"
        accent="Contacts"
        blurb="See new wallets breaking onto the board — the fresh positions tracked contacts just opened. Sign in with Google to unlock."
      />
    );
  }

  return (
    <section className="cv-section">
      <div className="cv-head">
        <h2>Fresh <span className="g">Contacts</span></h2>
        <span className="cv-sub">Newly surfaced — markets tracked contacts just opened a fresh position in (last 24h)</span>
      </div>
      <div className="panel cv-list log-shell at-top" ref={shellRef}>
        <div className={`cv-scroll log-scroll ${locked ? "hovered" : ""}`} ref={logRef} {...hoverProps}>
          {rows.length === 0 ? (
            <p className="muted" style={{ padding: 36, textAlign: "center", margin: 0 }}>
              No fresh entries yet — no tracked contact has opened a new position in the last 24h.
            </p>
          ) : (
            rows.map((row) => <FreshEntryRow key={row.conditionId} row={row} />)
          )}
        </div>
      </div>
    </section>
  );
}
