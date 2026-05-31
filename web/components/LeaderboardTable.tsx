"use client";

import { Copy } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import HorizonToggle from "@/components/HorizonToggle";
import SkillScoreBadge from "@/components/SkillScoreBadge";
import WalletSearch from "@/components/WalletSearch";
import { formatEdge, formatNumber, formatPercent, shortenAddress } from "@/lib/format";
import type { HorizonDays, LeaderboardRow } from "@/lib/types";

interface LeaderboardTableProps {
  initialRows: LeaderboardRow[];
  initialHorizon: HorizonDays;
}

function rankColor(rank: number): string {
  if (rank === 1) {
    return "#FFD166";
  }
  if (rank === 2) {
    return "#C7D0D9";
  }
  if (rank === 3) {
    return "#C8915B";
  }

  return "var(--muted)";
}

function SkeletonRows() {
  return (
    <>
      {Array.from({ length: 8 }).map((_, index) => (
        <tr key={index}>
          {Array.from({ length: 7 }).map((__, cell) => (
            <td key={cell} style={{ padding: "14px 12px", borderTop: "1px solid var(--line)" }}>
              <div className="skeleton" style={{ height: 14, width: cell === 1 ? 148 : 68 }} />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

export default function LeaderboardTable({ initialRows, initialHorizon }: LeaderboardTableProps) {
  const [horizon, setHorizon] = useState<HorizonDays>(initialHorizon);
  const [rows, setRows] = useState(initialRows);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (horizon === initialHorizon) {
      setRows(initialRows);
      return;
    }

    let active = true;
    setLoading(true);
    fetch(`/api/leaderboard?horizon=${horizon}`)
      .then((response) => response.ok ? response.json() as Promise<LeaderboardRow[]> : Promise.reject(new Error("Leaderboard request failed")))
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
  }, [horizon, initialHorizon, initialRows]);

  const filteredRows = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) {
      return rows;
    }

    return rows.filter((row) =>
      row.address.toLowerCase().startsWith(normalized) ||
      (row.handle?.toLowerCase().includes(normalized) ?? false)
    );
  }, [query, rows]);

  return (
    <section className="panel">
      <div className="toolbar">
        <HorizonToggle value={horizon} onChange={setHorizon} />
        <WalletSearch value={query} onChange={setQuery} />
      </div>
      {horizon === 365 ? (
        <div
          role="status"
          className="mono"
          style={{
            margin: "0 12px 12px",
            padding: "10px 12px",
            borderLeft: "3px solid #FFD166",
            border: "1px solid var(--line)",
            color: "var(--muted)",
            fontSize: 12,
            lineHeight: 1.5
          }}
        >
          The 365-day leaderboard is outdated and under maintenance. These numbers are no longer being
          refreshed — use the 30D or 90D views for current rankings.
        </div>
      ) : null}
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 860 }}>
          <thead>
            <tr className="mono muted" style={{ textAlign: "left", fontSize: 12 }}>
              <th style={{ padding: "12px" }}>RANK</th>
              <th style={{ padding: "12px" }}>WALLET</th>
              <th style={{ padding: "12px" }}>SKILL</th>
              <th style={{ padding: "12px" }}>EDGE</th>
              <th style={{ padding: "12px" }}>WIN RATE</th>
              <th style={{ padding: "12px" }}>N</th>
            </tr>
          </thead>
          <tbody>
            {loading ? <SkeletonRows /> : null}
            {!loading && filteredRows.length === 0 ? (
              <tr>
                <td colSpan={7} className="muted" style={{ padding: 28, textAlign: "center", borderTop: "1px solid var(--line)" }}>
                  No ranked wallets for this view.
                </td>
              </tr>
            ) : null}
            {!loading && filteredRows.map((row) => (
              <tr key={row.address} style={{ borderTop: "1px solid var(--line)" }}>
                <td className="mono" style={{ padding: "12px", color: rankColor(row.rank), fontWeight: 700 }}>
                  #{row.rank}
                </td>
                <td style={{ padding: "12px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <Link href={`/wallet/${row.address}`} className="mono" style={{ color: "var(--text)" }}>
                      {row.handle ? `@${row.handle}` : shortenAddress(row.address)}
                    </Link>
                    <button
                      type="button"
                      title="Copy address"
                      aria-label={`Copy ${row.address}`}
                      onClick={(event) => {
                        event.preventDefault();
                        void navigator.clipboard.writeText(row.address);
                      }}
                      style={{
                        border: "1px solid var(--line)",
                        background: "transparent",
                        color: "var(--muted)",
                        width: 28,
                        height: 28
                      }}
                    >
                      <Copy size={13} />
                    </button>
                  </div>
                </td>
                <td style={{ padding: "12px" }}>
                  <SkillScoreBadge score={row.skillScore} />
                </td>
                <td
                  className={row.avgEdgePerShare >= 0 ? "mono positive" : "mono negative"}
                  style={{ padding: "12px" }}
                  title="Per-position mean edge: avg (resolution outcome − entry price) over resolved markets"
                >
                  {formatEdge(row.avgEdgePerShare)}
                </td>
                <td className="mono" style={{ padding: "12px" }}>{formatPercent(row.winRate)}</td>
                <td className="mono" style={{ padding: "12px" }}>{formatNumber(row.nTrades)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
