"use client";

import { ExternalLink } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import MarketSortToggle from "@/components/MarketSortToggle";
import { formatCompactUsd, formatPercent } from "@/lib/format";
import type { MarketRow, MarketSort } from "@/lib/types";

interface MarketsTableProps {
  initialRows: MarketRow[];
  initialSort: MarketSort;
}

const ALL_CATEGORIES = "__all__";

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

// spread/prices are 0–1 fractions; render as a percentage, or an em dash when absent.
function formatFraction(value: number | null): string {
  return value === null ? "—" : formatPercent(value);
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

export default function MarketsTable({ initialRows, initialSort }: MarketsTableProps) {
  const [sort, setSort] = useState<MarketSort>(initialSort);
  const [rows, setRows] = useState(initialRows);
  const [category, setCategory] = useState<string>(ALL_CATEGORIES);
  const [loading, setLoading] = useState(false);

  // Sort is a server concern (different ordering of the top set), so it refetches; category is a
  // client-side filter over the loaded rows, mirroring the leaderboard's horizon-vs-search split.
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

  const categories = useMemo(() => {
    const set = new Set<string>();
    rows.forEach((row) => {
      if (row.category) {
        set.add(row.category);
      }
    });
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [rows]);

  const filteredRows = useMemo(() => {
    if (category === ALL_CATEGORIES) {
      return rows;
    }
    return rows.filter((row) => row.category === category);
  }, [category, rows]);

  return (
    <section className="panel">
      <div className="toolbar">
        <MarketSortToggle value={sort} onChange={setSort} />
        <select
          aria-label="Filter by category"
          value={category}
          onChange={(event) => setCategory(event.target.value)}
          className="mono"
          style={{
            border: "1px solid var(--line)",
            background: "#0D0F14",
            color: "var(--text)",
            padding: "10px 12px",
            outline: "none"
          }}
        >
          <option value={ALL_CATEGORIES}>All categories</option>
          {categories.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 820 }}>
          <thead>
            <tr className="mono muted" style={{ textAlign: "left", fontSize: 12 }}>
              <th style={{ padding: "12px" }}>MARKET</th>
              <th style={{ padding: "12px" }}>PRICE</th>
              <th style={{ padding: "12px", textAlign: "right" }}>LIQUIDITY</th>
              <th style={{ padding: "12px", textAlign: "right" }}>24H VOL</th>
              <th style={{ padding: "12px", textAlign: "right" }}>VOLUME</th>
              <th style={{ padding: "12px", textAlign: "right" }}>VOLATILITY</th>
            </tr>
          </thead>
          <tbody>
            {loading ? <SkeletonRows /> : null}
            {!loading && filteredRows.length === 0 ? (
              <tr>
                <td colSpan={6} className="muted" style={{ padding: 28, textAlign: "center", borderTop: "1px solid var(--line)" }}>
                  No markets for this view.
                </td>
              </tr>
            ) : null}
            {!loading &&
              filteredRows.map((row) => (
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
                  <td className="mono muted" style={{ padding: "12px", textAlign: "right" }} title="Bid/ask spread — a volatility proxy">
                    {formatFraction(row.spread)}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
