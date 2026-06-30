"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { formatCompactUsd } from "@/lib/format";
import type { CrowdedMarketSummary } from "@/lib/types";
import { useUser } from "@/lib/supabaseBrowser";
import LockedPanel from "./LockedPanel";
import { useScrollLog } from "./useScrollLog";

interface ConvergencePanelProps {
  initialRows?: CrowdedMarketSummary[];
}

type SortMode = "consensus" | "recent" | "crowded";

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

function getConsensusPct(row: CrowdedMarketSummary): number {
  const total = row.yesTraders + row.noTraders;
  if (total === 0) return 0;
  return Math.abs(row.yesTraders - row.noTraders) / total;
}

function lean(row: CrowdedMarketSummary): { label: string; cls: string } {
  if (row.yesTraders > row.noTraders) return { label: "YES", cls: "yes" };
  if (row.noTraders > row.yesTraders) return { label: "NO", cls: "no" };
  return { label: "SPLIT", cls: "split" };
}

function consensusTier(pct: number): { label: string; cls: string } | null {
  if (pct === 1) return { label: "UNANIMOUS", cls: "t-unanimous" };
  if (pct >= 0.67) return { label: "STRONG", cls: "t-strong" };
  return null;
}

function ConvergenceRow({ row }: { row: CrowdedMarketSummary }) {
  const total = Math.max(1, row.yesTraders + row.noTraders);
  const yesPct = (row.yesTraders / total) * 100;
  const l = lean(row);
  const cpct = getConsensusPct(row);
  const tier = consensusTier(cpct);

  return (
    <Link className="cv-row" href={`/market/${encodeURIComponent(row.conditionId)}`} title="Open market analytics">
      <div className="cv-rank-cell">
        <span className="cv-contacts">{row.traderCount}</span>
        <span className="cv-contacts-lbl">contacts</span>
      </div>
      <div className="cv-market-cell">
        <div className="cv-q-row">
          <span className="cv-q" title={row.market ?? ""}>{row.market || "—"}</span>
          {tier ? <span className={`cv-tier ${tier.cls}`}>{tier.label}</span> : null}
        </div>
        <div className="cv-meta">
          {row.topRank !== null ? <span className="cv-toprank">Top contact #{row.topRank}</span> : null}
          <span className="cv-last">last trade {elapsedFrom(row.lastTradedAt)}</span>
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

const SORT_OPTS: { key: SortMode; label: string; desc: string }[] = [
  { key: "consensus", label: "CONSENSUS", desc: "Most one-sided first" },
  { key: "recent",    label: "RECENT",    desc: "Latest leaderboard entry" },
  { key: "crowded",   label: "CROWDED",   desc: "Most contacts" },
];

export default function ConvergencePanel({ initialRows = [] }: ConvergencePanelProps) {
  const { loading, signedIn } = useUser();
  const [rows, setRows] = useState(initialRows);
  const [sort, setSort] = useState<SortMode>("consensus");
  const { locked, shellRef, logRef, hoverProps } = useScrollLog(rows);

  const sorted = useMemo(() => {
    const r = [...rows];
    if (sort === "consensus") r.sort((a, b) => getConsensusPct(b) - getConsensusPct(a));
    else if (sort === "recent") r.sort((a, b) => (b.lastTradedAt ?? "").localeCompare(a.lastTradedAt ?? ""));
    // "crowded": keep server order (traderCount desc)
    return r;
  }, [rows, sort]);

  useEffect(() => {
    if (!signedIn) return;
    let active = true;
    const poll = (): void => {
      if (document.hidden) return;
      fetch("/api/crowded-markets")
        .then((r) => (r.ok ? (r.json() as Promise<{ markets: CrowdedMarketSummary[] }>) : Promise.reject(new Error("request failed"))))
        .then((data) => { if (active) setRows(data.markets); })
        .catch(() => { /* keep last good data */ });
    };
    const id = setInterval(poll, POLL_INTERVAL_MS);
    poll();
    return () => { active = false; clearInterval(id); };
  }, [signedIn]);

  if (loading) return <section className="sig-page" aria-busy="true" style={{ minHeight: 200 }} />;
  if (!signedIn) {
    return (
      <LockedPanel
        title="Convergence"
        accent="Zones"
        blurb="See which markets the most tracked contacts are converging on — the crowd's strongest positions. Sign in with Google to unlock."
      />
    );
  }

  return (
    <section className="sig-page">
      <header className="sig-hero">
        <div className="sig-eyebrow">
          <span className="sig-ping" aria-hidden="true" />
          SIGNALS — LIVE INTELLIGENCE
        </div>
        <div className="sig-title-row">
          <h1 className="sig-title">CONVERGENCE <em>ZONES</em></h1>
          {rows.length > 0 && <span className="sig-count">{rows.length} markets</span>}
        </div>
        <p className="sig-desc">
          Markets where the tracked pod is concentrating — where multiple leaderboard contacts are positioned.
        </p>
        <div className="sig-rule" aria-hidden="true" />
      </header>

      <div className="sig-filters" role="group" aria-label="Sort convergence zones">
        {SORT_OPTS.map((o) => (
          <button
            key={o.key}
            type="button"
            className={`sig-filt${sort === o.key ? " active" : ""}`}
            onClick={() => setSort(o.key)}
            aria-pressed={sort === o.key}
          >
            <span className="sig-filt-key">{o.label}</span>
            <span className="sig-filt-desc">{o.desc}</span>
          </button>
        ))}
      </div>

      <div className="panel cv-list log-shell at-top" ref={shellRef}>
        <div className={`cv-scroll log-scroll ${locked ? "hovered" : ""}`} ref={logRef} {...hoverProps}>
          {sorted.length === 0 ? (
            <p className="muted" style={{ padding: 36, textAlign: "center", margin: 0 }}>
              No converged markets yet — the board&apos;s positions haven&apos;t been ingested.
            </p>
          ) : (
            sorted.map((row) => <ConvergenceRow key={row.conditionId} row={row} />)
          )}
        </div>
      </div>
    </section>
  );
}
