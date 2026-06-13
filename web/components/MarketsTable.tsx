"use client";

import { ExternalLink } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatCompactUsd, formatPercent } from "@/lib/format";
import type { MarketRow, MarketSort } from "@/lib/types";

interface MarketsTableProps {
  initialRows: MarketRow[];
  initialSort: MarketSort;
}

const SORT_COLUMNS: { label: string; column: MarketSort; title: string }[] = [
  { label: "Volume", column: "volume", title: "Sort by total volume" },
  { label: "24h Volume", column: "volume_24hr", title: "Sort by 24-hour volume" },
  { label: "Liquidity", column: "liquidity", title: "Sort by liquidity" },
  { label: "24h Drift", column: "change", title: "Leading outcome's price change over 24h. Click to sort." }
];

const SORT_META: Record<MarketSort, string> = {
  liquidity: "liquidity",
  volume_24hr: "24h volume",
  volume: "total volume",
  change: "24h drift"
};

const POLL_INTERVAL_MS = 60_000;

export default function MarketsTable({ initialRows, initialSort }: MarketsTableProps) {
  const [sort, setSort] = useState<MarketSort>(initialSort);
  const [rows, setRows] = useState(initialRows);
  const [loading, setLoading] = useState(false);
  const [fill, setFill] = useState(false);
  const [locked, setLocked] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setFill(true);
  }, []);

  useEffect(() => {
    if (sort === initialSort) {
      setRows(initialRows);
      return;
    }
    let active = true;
    setLoading(true);
    fetch(`/api/markets?sort=${sort}`)
      .then((response) => (response.ok ? (response.json() as Promise<MarketRow[]>) : Promise.reject(new Error("Markets request failed"))))
      .then((nextRows) => {
        if (active) setRows(nextRows);
      })
      .catch(() => {
        if (active) setRows([]);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [sort, initialSort, initialRows]);

  useEffect(() => {
    let active = true;
    const poll = (): void => {
      if (document.hidden) return;
      fetch(`/api/markets?sort=${sort}`)
        .then((response) => (response.ok ? (response.json() as Promise<MarketRow[]>) : Promise.reject(new Error("Markets request failed"))))
        .then((nextRows) => {
          if (active) setRows(nextRows);
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
  }, [sort]);

  const agg = useMemo(() => {
    const liq = rows.reduce((a, m) => a + m.liquidityUsd, 0);
    const v24 = rows.reduce((a, m) => a + m.volume24hrUsd, 0);
    const top = rows.reduce<MarketRow | null>((a, m) => {
      if (m.oneDayPriceChange === null) return a;
      if (a === null || a.oneDayPriceChange === null) return m;
      return Math.abs(m.oneDayPriceChange) > Math.abs(a.oneDayPriceChange) ? m : a;
    }, null);
    return { liq, v24, top };
  }, [rows]);

  // Edge fades: hide the top/bottom gradient at the scroll extremes (mirrors the Activity log).
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
  }, [rows, loading]);

  return (
    <>
      <div className="mkt-readouts">
        <div className="panel ro"><div className="k">Open Markets</div><div className="v">{rows.length}</div><div className="s">sounded this scan</div></div>
        <div className="panel ro"><div className="k">Total Depth</div><div className="v">{formatCompactUsd(agg.liq)}</div><div className="s">aggregate liquidity</div></div>
        <div className="panel ro alt"><div className="k">24h Current</div><div className="v">{formatCompactUsd(agg.v24)}</div><div className="s">volume traded</div></div>
        <div className="panel ro alt"><div className="k">Strongest Drift</div>
          {agg.top && agg.top.oneDayPriceChange !== null ? (
            <>
              <div className="v" style={{ color: agg.top.oneDayPriceChange >= 0 ? "var(--green)" : "var(--red)" }}>{formatPercent(agg.top.oneDayPriceChange, true)}</div>
              <div className="s">{agg.top.topOutcome ? `${agg.top.topOutcome} · ` : ""}{agg.top.question.slice(0, 28)}{agg.top.question.length > 28 ? "…" : ""}</div>
            </>
          ) : (
            <><div className="v" style={{ color: "var(--muted)" }}>—</div><div className="s">favored outcome</div></>
          )}
        </div>
      </div>

      <section className="mkt-grid">
        <div className="mkt-grid-head">
          <h2>Sounding <span className="g">Chart</span></h2>
          <span className="log-head-right">
            <span className="meta">sorted by {SORT_META[sort]}</span>
            <span className={`af-scroll-state ${locked ? "locked" : ""}`}>
              <span className="pip" />
              {locked ? "Chart scroll · locked" : "Page scroll · hover chart to lock"}
            </span>
          </span>
        </div>
        <div className="panel log-shell at-top" ref={shellRef}>
          <div
            className={`mkt-panel log-scroll ${locked ? "hovered" : ""}`}
            ref={logRef}
            onMouseEnter={() => setLocked(true)}
            onMouseLeave={() => setLocked(false)}
          >
            <table>
            <thead>
              <tr>
                <th><span className="lbl">Market</span></th>
                <th><span className="lbl">Favored</span></th>
                {SORT_COLUMNS.map(({ label, column, title }) => (
                  <th key={column} className={`sortable${sort === column ? " active" : ""}`} aria-sort={sort === column ? "descending" : "none"}>
                    <button type="button" onClick={() => setSort(column)} title={title}>
                      {label} <span className="ar" aria-hidden>▼</span>
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                Array.from({ length: 8 }).map((_, i) => (
                  <tr key={i}>{Array.from({ length: 6 }).map((__, c) => (
                    <td key={c}><div className="skeleton" style={{ height: 16, width: c === 0 ? 240 : 64 }} /></td>
                  ))}</tr>
                ))
              ) : rows.length === 0 ? (
                <tr><td colSpan={6} className="muted" style={{ padding: 36, textAlign: "center" }}>No markets for this view.</td></tr>
              ) : (
                rows.map((m) => {
                  const chg = m.oneDayPriceChange;
                  return (
                    <tr key={m.id}>
                      <td className="mkt-q">
                        <div className="q">
                          {m.slug ? (
                            <a href={`https://polymarket.com/event/${m.slug}`} target="_blank" rel="noopener noreferrer">
                              {m.question}<ExternalLink className="ext" size={12} />
                            </a>
                          ) : (
                            <span>{m.question}</span>
                          )}
                        </div>
                        {m.category ? <div className="cat">{m.category}</div> : null}
                      </td>
                      <td className="mkt-fav">
                        {m.currentPrice === null ? (
                          <span className="muted">—</span>
                        ) : (
                          <>
                            <div className="top">
                              <span className="out">{m.topOutcome ?? "—"}</span>
                              <span className="pct">{formatPercent(m.currentPrice)}</span>
                            </div>
                            <div className="probar"><i style={{ width: fill ? `${(m.currentPrice * 100).toFixed(0)}%` : 0 }} /></div>
                          </>
                        )}
                      </td>
                      <td className="mkt-num vol">{formatCompactUsd(m.volumeUsd)}</td>
                      <td className="mkt-num">{formatCompactUsd(m.volume24hrUsd)}</td>
                      <td className="mkt-num">{formatCompactUsd(m.liquidityUsd)}</td>
                      <td className="mkt-chg">
                        {chg === null ? <span className="muted">—</span> : <span className={chg >= 0 ? "up" : "dn"}>{formatPercent(chg, true)}</span>}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
          </div>
        </div>
      </section>
    </>
  );
}

