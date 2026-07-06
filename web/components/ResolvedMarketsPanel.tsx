"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { formatNumber, formatPercent, formatPrice, formatUsd, shortenAddress } from "@/lib/format";
import type { ResolvedMarket, ResolvedParticipant } from "@/lib/types";
import { groupResolvedByEvent, type ResolvedEventGroup } from "@/lib/resolvedMarkets";
import { useScrollLog } from "./useScrollLog";

interface ResolvedMarketsPanelProps {
  rows: ResolvedMarket[];
}

const POLL_INTERVAL_MS = 60_000;

// Relative time since resolution (within a 7-day window).
function resolvedAgo(iso: string): string {
  if (!iso) return "—";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  const m = Math.max(0, Math.floor(ms / 60000));
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, "0")}m ago`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h ago`;
}

function PlPill({ pnl, pct }: { pnl: number | null; pct: number | null }) {
  if (pnl === null) return <span className="af-pl na">P/L n/a</span>;
  const up = pnl >= 0;
  return (
    <span className={`af-pl ${up ? "up" : "dn"}`}>
      {up ? "+" : ""}
      {formatUsd(pnl)}
      {pct !== null ? <span className="rm-pct"> {formatPercent(pct, true)}</span> : null}
    </span>
  );
}

function ParticipantTable({ participants }: { participants: ResolvedParticipant[] }) {
  return (
    <table className="rm-ptable">
      <thead>
        <tr>
          <th>Contact</th>
          <th>Side</th>
          <th className="r">Avg Entry</th>
          <th className="r">Size</th>
          <th>Result</th>
          <th className="r">Realized P/L</th>
        </tr>
      </thead>
      <tbody>
        {participants.map((p, i) => {
          const label = p.handle ? `@${p.handle}` : shortenAddress(p.address);
          return (
            <tr key={`${p.address}:${p.outcomeIndex}:${i}`} className="rm-prow">
              <td className="rm-contact">
                <Link
                  href={`/wallet/${p.address}`}
                  className="rm-name"
                  title={p.handle ? `@${p.handle}` : p.address}
                  onClick={(e) => e.stopPropagation()}
                >
                  {p.handle ? (
                    <>
                      <span className="at">@</span>
                      {p.handle}
                    </>
                  ) : label}
                </Link>
                <div className="rm-psub">
                  <span className="rm-prank">{p.rank === null ? "Unranked" : `Rank #${p.rank}`}</span>
                  {p.skillScore !== null ? (
                    <span className="rm-pskill">{p.skillScore.toFixed(1)} SIG</span>
                  ) : null}
                </div>
              </td>
              <td>
                <span className={`rm-side ${p.side === "YES" ? "yes" : p.side === "NO" ? "no" : ""}`}>
                  {p.side}
                </span>
              </td>
              <td className="rm-num">{p.avgEntry === null ? "—" : formatPrice(p.avgEntry)}</td>
              <td className="rm-num">{formatNumber(p.size)}</td>
              <td>
                <span className={`rm-result ${p.won ? "won" : "lost"}`}>
                  {p.won ? "Won" : "Lost"}
                </span>
              </td>
              <td className="rm-num">
                <PlPill pnl={p.realizedPnl} pct={p.realizedPct} />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function MarketRow({ market }: { market: ResolvedMarket }) {
  const [open, setOpen] = useState(false);
  const pnlUp = market.totalRealizedPnl >= 0;

  return (
    <div className={`rm-mrow ${open ? "open" : ""}`}>
      <div
        className="rm-mhead"
        onClick={() => setOpen((v) => !v)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setOpen((v) => !v); }}
      >
        <span className="rm-caret">{open ? "▾" : "▸"}</span>
        <Link
          href={`/market/${encodeURIComponent(market.conditionId)}`}
          className="rm-q"
          title="Open market analytics"
          onClick={(e) => e.stopPropagation()}
        >
          {market.market || "—"}
        </Link>
        <div className="rm-chips">
          <span className={`rm-outcome ${market.winningSide === "YES" ? "yes" : "no"}`}>
            {market.winningSide} won
          </span>
          <span className="rm-contacts">{market.traderCount} contact{market.traderCount !== 1 ? "s" : ""}</span>
          <span className="rm-wl">{market.winners}W / {market.losers}L</span>
          <span className={`af-pl ${pnlUp ? "up" : "dn"}`}>
            {pnlUp ? "+" : ""}{formatUsd(market.totalRealizedPnl)}
          </span>
          <span className="rm-ago" title={market.resolvedAt} suppressHydrationWarning>
            resolved {resolvedAgo(market.resolvedAt)}
          </span>
        </div>
      </div>
      {open ? (
        <div className="rm-mbody">
          <ParticipantTable participants={market.participants} />
        </div>
      ) : null}
    </div>
  );
}

// A match/event with several resolved markets, condensed into one collapsible header. Expands to the
// individual market rows (each of which further expands to its participants).
function EventGroup({ group }: { group: ResolvedEventGroup }) {
  const [open, setOpen] = useState(false);
  const pnlUp = group.totalRealizedPnl >= 0;

  return (
    <div className={`rm-mrow rm-group ${open ? "open" : ""}`}>
      <div
        className="rm-mhead"
        onClick={() => setOpen((v) => !v)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setOpen((v) => !v); }}
      >
        <span className="rm-caret">{open ? "▾" : "▸"}</span>
        <span className="rm-q rm-group-q" title={group.title}>{group.title}</span>
        <div className="rm-chips">
          <span className="rm-mkts">{group.markets.length} markets</span>
          <span className="rm-contacts">{group.traderCount} contact{group.traderCount !== 1 ? "s" : ""}</span>
          <span className="rm-wl">{group.winners}W / {group.losers}L</span>
          <span className={`af-pl ${pnlUp ? "up" : "dn"}`}>
            {pnlUp ? "+" : ""}{formatUsd(group.totalRealizedPnl)}
          </span>
          <span className="rm-ago" title={group.resolvedAt} suppressHydrationWarning>
            resolved {resolvedAgo(group.resolvedAt)}
          </span>
        </div>
      </div>
      {open ? (
        <div className="rm-gbody">
          {group.markets.map((market) => (
            <MarketRow key={market.conditionId} market={market} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default function ResolvedMarketsPanel({ rows: initialRows }: ResolvedMarketsPanelProps) {
  const [rows, setRows] = useState(initialRows);
  const { locked, shellRef, logRef, hoverProps } = useScrollLog(rows);

  // Self-heal empty/stale SSR data (e.g. a cold-Supabase-connection timeout baked into the ISR
  // cache) the same way RecentTradesFeed does, instead of relying solely on the SSR snapshot.
  useEffect(() => {
    let active = true;
    const poll = (): void => {
      if (document.hidden) return;
      fetch("/api/resolved-markets")
        .then((response) => (response.ok ? (response.json() as Promise<ResolvedMarket[]>) : Promise.reject(new Error("Resolved markets request failed"))))
        .then((data) => {
          if (active) setRows(data);
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
    <section className="act-feed rm-feed">
      <div className="act-feed-head">
        <h2>Resolved <span className="g">Markets</span></h2>
        <span className="meta">markets resolved in the last 7 days · click to expand</span>
      </div>
      <div className="panel af-log-shell at-top" ref={shellRef}>
        <div className={`af-log rm-log ${locked ? "hovered" : ""}`} ref={logRef} {...hoverProps}>
          {rows.length === 0 ? (
            <p className="muted" style={{ padding: "36px", textAlign: "center", margin: 0 }}>
              No resolved markets from board contacts in the last 7 days.
            </p>
          ) : (
            groupResolvedByEvent(rows).map((group) =>
              group.markets.length > 1 ? (
                <EventGroup key={group.key} group={group} />
              ) : (
                <MarketRow key={group.key} market={group.markets[0]!} />
              )
            )
          )}
        </div>
      </div>
    </section>
  );
}
