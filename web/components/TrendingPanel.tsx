"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { formatCompactUsd, formatPercent } from "@/lib/format";
import { isSportsCategory } from "@/lib/trendingMarkets";
import type { TrendingMarket } from "@/lib/types";

interface TrendingPanelProps {
  rows: TrendingMarket[];
}

const POLL_INTERVAL_MS = 60_000;

// Relative time to a future resolution date (no window cap — a market can resolve months out).
function resolvesIn(iso: string | null): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const d = Math.floor(ms / 86_400_000);
  if (d < 1) return "resolves today";
  if (d === 1) return "resolves in 1d";
  return `resolves in ${d}d`;
}

// Relative time to a future scheduled game start (sports/esports only) — hour-granularity, since
// these are always near-term when they show up at all.
function startsIn(iso: string | null): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const h = Math.floor(ms / 3_600_000);
  if (h < 1) return "starts <1h";
  if (h === 1) return "starts in 1h";
  if (h < 24) return `starts in ${h}h`;
  return `starts in ${Math.floor(h / 24)}d`;
}

function LeanBar({ lean }: { lean: NonNullable<TrendingMarket["lean"]> }) {
  const total = lean.yesCapital + lean.noCapital;
  const yesShare = total > 0 ? (lean.yesCapital / total) * 100 : 50;

  return (
    <div className="tr-lean">
      <div className="tr-lean-head">
        <span className={`tr-lean-label ${lean.label === "YES" ? "yes" : lean.label === "NO" ? "no" : ""}`}>
          {lean.label === "SPLIT" ? "SPLIT" : `${lean.label} leaning`}
        </span>
        {lean.topRank !== null ? <span className="tr-lean-rank">Rank #{lean.topRank}</span> : null}
      </div>
      <div className="tr-lean-bar">
        <i style={{ width: `${yesShare.toFixed(0)}%` }} />
      </div>
      <div className="tr-lean-amounts">
        <span className="yes">{formatCompactUsd(lean.yesCapital)} YES</span>
        <span className="no">{formatCompactUsd(lean.noCapital)} NO</span>
      </div>
      <span className="tr-lean-count">{lean.positionedCount} contact{lean.positionedCount !== 1 ? "s" : ""} positioned</span>
    </div>
  );
}

function TrendingCard({ row }: { row: TrendingMarket }) {
  const body = (
    <>
      {row.image ? <img className="tr-img" src={row.image} alt="" /> : null}
      <div className="tr-cardhead">
        {row.category ? <span className="tr-cat">{row.category}</span> : null}
        <span className="tr-timing">
          {(isSportsCategory(row.category) ? startsIn(row.gameStartTime) : null) ?? resolvesIn(row.endDate)}
        </span>
      </div>
      <div className="tr-q">{row.market ?? "—"}</div>
      {row.currentPrice !== null ? (
        <div className="tr-price-row">
          <span className="tr-outcome">{row.topOutcome ?? "—"}</span>
          <span className="tr-pct">{formatPercent(row.currentPrice)}</span>
          <div className="tr-probar"><i style={{ width: `${(row.currentPrice * 100).toFixed(0)}%` }} /></div>
        </div>
      ) : null}
      <div className="tr-vol">{row.volume24hrUsd !== null ? `${formatCompactUsd(row.volume24hrUsd)} vol · 24h` : null}</div>
      {row.lean ? <LeanBar lean={row.lean} /> : <div className="tr-nolean muted">No tracked positioning yet</div>}
    </>
  );

  return (
    <div className="panel tr-card">
      {row.conditionId ? (
        <Link href={`/market/${encodeURIComponent(row.conditionId)}`} className="tr-card-link">
          {body}
        </Link>
      ) : (
        <div className="tr-card-link">{body}</div>
      )}
    </div>
  );
}

export default function TrendingPanel({ rows: initialRows }: TrendingPanelProps) {
  const [rows, setRows] = useState(initialRows);
  const [loaded, setLoaded] = useState(initialRows.length > 0);

  // Self-heal empty/stale SSR data (e.g. a cold-Supabase-connection timeout baked into the ISR
  // cache), same pattern as RecentTradesFeed/ResolvedMarketsPanel.
  useEffect(() => {
    let active = true;
    const poll = (): void => {
      if (document.hidden) return;
      fetch("/api/trending")
        .then((response) => (response.ok ? (response.json() as Promise<TrendingMarket[]>) : Promise.reject(new Error("Trending request failed"))))
        .then((data) => {
          if (active) {
            setRows(data);
            setLoaded(true);
          }
        })
        .catch(() => {
          /* keep last good data */
        });
    };
    const intervalId = setInterval(poll, POLL_INTERVAL_MS);
    poll();
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
    <section className="act-feed tr-feed">
      <div className="act-feed-head">
        <h2>Trending <span className="g">Markets</span></h2>
        <span className="meta">5+ board contacts · ranked by timing &amp; entry proximity</span>
      </div>
      {rows.length === 0 ? (
        <p className="muted tr-empty">
          {loaded
            ? "No markets currently clear the 5+ leaderboard-participant bar — check back soon."
            : "Loading trending markets…"}
        </p>
      ) : (
        <div className="tr-strip">
          {rows.map((row, i) => (
            <TrendingCard key={row.conditionId ?? `${row.market}-${i}`} row={row} />
          ))}
        </div>
      )}
    </section>
  );
}
