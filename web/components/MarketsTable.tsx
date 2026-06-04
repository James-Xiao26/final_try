"use client";

import { ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
import { formatCompactUsd, formatPercent } from "@/lib/format";
import type { MarketRow, MarketSort } from "@/lib/types";

interface MarketsTableProps {
  initialRows: MarketRow[];
  initialSort: MarketSort;
}

// The right-aligned numeric columns are server-sortable; clicking the header sorts by that column.
// MARKET and PRICE have no server ordering, so they stay plain.
const SORT_COLUMNS: { label: string; column: MarketSort; title: string }[] = [
  { label: "LIQUIDITY", column: "liquidity", title: "Sort by liquidity" },
  { label: "24H VOL", column: "volume_24hr", title: "Sort by 24-hour volume" },
  { label: "VOLUME", column: "volume", title: "Sort by total volume" },
  { label: "24H CHANGE", column: "change", title: "Leading outcome's price change over 24h. Click to sort." }
];

function SortableHeader({
  label,
  active,
  onSort,
  title
}: {
  label: string;
  active: boolean;
  onSort: () => void;
  title: string;
}) {
  return (
    <th style={{ padding: 0, textAlign: "right" }} aria-sort={active ? "descending" : "none"}>
      <button
        type="button"
        onClick={onSort}
        title={title}
        className="mono"
        style={{
          width: "100%",
          display: "flex",
          justifyContent: "flex-end",
          alignItems: "center",
          gap: 4,
          padding: "12px",
          background: "transparent",
          border: 0,
          fontSize: 12,
          color: active ? "var(--text)" : "var(--muted)",
          cursor: "pointer"
        }}
      >
        {label}
        <span aria-hidden style={{ visibility: active ? "visible" : "hidden", fontSize: 9 }}>▼</span>
      </button>
    </th>
  );
}

function SkeletonRows() {
  return (
    <>
      {Array.from({ length: 8 }).map((_, index) => (
        <tr key={index}>
          {Array.from({ length: 6 }).map((__, cell) => (
            <td key={cell} style={{ padding: "14px 12px", borderTop: "1px solid var(--line)" }}>
              <div className="skeleton" style={{ height: 14, width: cell === 0 ? 220 : 64 }} />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

// Current price of an event's leading outcome, e.g. "Spain 17.0%" (or "Yes 64.0%" for a binary
// market). Em dash when the event has no derivable price.
function formatCurrentPrice(price: number | null, outcome: string | null): string {
  if (price === null) {
    return "—";
  }
  const pct = formatPercent(price);
  return outcome ? `${outcome} ${pct}` : pct;
}

// Poll a little more often than the markets ingest refreshes (~20 min) so the tab catches a new
// batch within a minute without hammering the API route.
const POLL_INTERVAL_MS = 60_000;

export default function MarketsTable({ initialRows, initialSort }: MarketsTableProps) {
  const [sort, setSort] = useState<MarketSort>(initialSort);
  const [rows, setRows] = useState(initialRows);
  const [loading, setLoading] = useState(false);

  // Sort is a server concern (a different ordering of the top set), so it refetches.
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
        if (active) {
          setRows(nextRows);
        }
      })
      .catch(() => {
        if (active) {
          setRows([]);
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [sort, initialSort, initialRows]);

  // Background poll of the current sort so the tab stays fresh without a reload. Silent (no loading
  // skeleton), and paused on a hidden tab — refreshes on re-focus.
  useEffect(() => {
    let active = true;
    const poll = (): void => {
      if (document.hidden) {
        return;
      }
      fetch(`/api/markets?sort=${sort}`)
        .then((response) => (response.ok ? (response.json() as Promise<MarketRow[]>) : Promise.reject(new Error("Markets request failed"))))
        .then((nextRows) => {
          if (active) {
            setRows(nextRows);
          }
        })
        .catch(() => {
          // Keep showing the last good data on a transient failure.
        });
    };

    const intervalId = setInterval(poll, POLL_INTERVAL_MS);
    const onVisibility = (): void => {
      if (!document.hidden) {
        poll();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      active = false;
      clearInterval(intervalId);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [sort]);

  return (
    <section className="panel">
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 820 }}>
          <thead>
            <tr className="mono muted" style={{ textAlign: "left", fontSize: 12 }}>
              <th style={{ padding: "12px" }}>MARKET</th>
              <th style={{ padding: "12px" }}>PRICE</th>
              {SORT_COLUMNS.map(({ label, column, title }) => (
                <SortableHeader
                  key={column}
                  label={label}
                  title={title}
                  active={sort === column}
                  onSort={() => setSort(column)}
                />
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? <SkeletonRows /> : null}
            {!loading && rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="muted" style={{ padding: 28, textAlign: "center", borderTop: "1px solid var(--line)" }}>
                  No markets for this view.
                </td>
              </tr>
            ) : null}
            {!loading &&
              rows.map((row) => (
                <tr key={row.id} style={{ borderTop: "1px solid var(--line)" }}>
                  <td style={{ padding: "12px", maxWidth: 420 }}>
                    {row.slug ? (
                      <a
                        href={`https://polymarket.com/event/${row.slug}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ color: "var(--text)", display: "inline-flex", alignItems: "center", gap: 6 }}
                      >
                        {row.question}
                        <ExternalLink size={12} style={{ color: "var(--muted)", flexShrink: 0 }} />
                      </a>
                    ) : (
                      <span style={{ color: "var(--text)" }}>{row.question}</span>
                    )}
                  </td>
                  <td className="mono" style={{ padding: "12px" }}>{formatCurrentPrice(row.currentPrice, row.topOutcome)}</td>
                  <td className="mono" style={{ padding: "12px", textAlign: "right" }}>{formatCompactUsd(row.liquidityUsd)}</td>
                  <td className="mono" style={{ padding: "12px", textAlign: "right" }}>{formatCompactUsd(row.volume24hrUsd)}</td>
                  <td className="mono" style={{ padding: "12px", textAlign: "right" }}>{formatCompactUsd(row.volumeUsd)}</td>
                  <td className="mono" style={{ padding: "12px", textAlign: "right" }}>
                    {row.oneDayPriceChange === null ? (
                      <span className="muted">—</span>
                    ) : (
                      <span className={row.oneDayPriceChange >= 0 ? "positive" : "negative"}>
                        {formatPercent(row.oneDayPriceChange, true)}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
