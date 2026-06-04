"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import SkillScoreBadge from "@/components/SkillScoreBadge";
import { formatDateTime, formatPrice, formatUsd, shortenAddress } from "@/lib/format";
import type { RecentTrade, RecentTradesFeed as RecentTradesFeedData } from "@/lib/types";

interface RecentTradesFeedProps {
  initialTrades: RecentTrade[];
  initialTraderCount: number;
}

// Poll a little more often than the server-side feed refreshes (every ~10 min), so the UI catches a
// new batch within a minute of it landing without hammering the API route.
const POLL_INTERVAL_MS = 60_000;

function sideColor(side: string | null): string {
  if (side === "BUY") {
    return "var(--green)";
  }
  if (side === "SELL") {
    return "var(--red)";
  }
  return "var(--muted)";
}

// Long handles blow out the TRADER column and push every column after it to the right; cap the
// displayed length (the cell also hard-clips with an ellipsis, and the full value is on hover).
const MAX_HANDLE_LENGTH = 16;
function traderLabel(handle: string | null, address: string): string {
  if (!handle) {
    return shortenAddress(address);
  }
  const label = `@${handle}`;
  return label.length > MAX_HANDLE_LENGTH ? `${label.slice(0, MAX_HANDLE_LENGTH - 1)}…` : label;
}

export default function RecentTradesFeed({ initialTrades, initialTraderCount }: RecentTradesFeedProps) {
  const [trades, setTrades] = useState(initialTrades);
  const [traderCount, setTraderCount] = useState(initialTraderCount);

  useEffect(() => {
    let active = true;

    const poll = (): void => {
      // Don't poll a backgrounded tab; it refreshes on visibility change instead.
      if (document.hidden) {
        return;
      }
      fetch("/api/recent-trades")
        .then((response) =>
          response.ok
            ? (response.json() as Promise<RecentTradesFeedData>)
            : Promise.reject(new Error("Recent trades request failed"))
        )
        .then((feed) => {
          if (active) {
            setTrades(feed.trades);
            setTraderCount(feed.traderCount);
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
  }, []);

  return (
    <section className="panel">
      <div className="toolbar">
        <span className="mono muted">
          LAST 24H · {traderCount} {traderCount === 1 ? "TRADER" : "TRADERS"} · {trades.length}{" "}
          {trades.length === 1 ? "FILL" : "FILLS"}
        </span>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 860 }}>
          <thead>
            <tr className="mono muted" style={{ textAlign: "left", fontSize: 12 }}>
              <th style={{ padding: "12px" }}>TRADER</th>
              <th style={{ padding: "12px" }}>SKILL</th>
              <th style={{ padding: "12px" }}>MARKET</th>
              <th style={{ padding: "12px" }}>SIDE</th>
              <th style={{ padding: "12px" }}>PRICE</th>
              <th style={{ padding: "12px" }}>AMOUNT</th>
              <th style={{ padding: "12px" }}>TIME</th>
            </tr>
          </thead>
          <tbody>
            {trades.length === 0 ? (
              <tr>
                <td colSpan={7} className="muted" style={{ padding: 28, textAlign: "center", borderTop: "1px solid var(--line)" }}>
                  No trades from leaderboard wallets in the last 24 hours.
                </td>
              </tr>
            ) : null}
            {trades.map((trade, index) => (
              <tr key={`${trade.address}-${trade.tradedAt}-${index}`} style={{ borderTop: "1px solid var(--line)" }}>
                <td style={{ padding: "12px", maxWidth: 170 }}>
                  <Link
                    href={`/wallet/${trade.address}`}
                    className="mono"
                    title={trade.handle ? `@${trade.handle}` : trade.address}
                    style={{ color: "var(--text)", display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                  >
                    {traderLabel(trade.handle, trade.address)}
                  </Link>
                </td>
                <td style={{ padding: "12px" }}>
                  <SkillScoreBadge score={trade.skillScore} />
                </td>
                <td style={{ padding: "12px", maxWidth: 320 }}>
                  <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={trade.market ?? ""}>
                    {trade.market || "—"}
                  </span>
                </td>
                <td className="mono" style={{ padding: "12px", color: sideColor(trade.side), fontWeight: 700 }}>
                  {trade.side ?? "—"}
                </td>
                <td className="mono" style={{ padding: "12px" }}>
                  {trade.price === null ? "—" : formatPrice(trade.price)}
                </td>
                <td className="mono" style={{ padding: "12px" }}>
                  {trade.usdcSize === null ? "—" : formatUsd(trade.usdcSize)}
                </td>
                <td className="mono muted" style={{ padding: "12px" }} title={trade.tradedAt} suppressHydrationWarning>
                  {formatDateTime(trade.tradedAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
