"use client";

import Link from "next/link";
import { formatNumber, formatPercent, formatPrice, formatUsd, shortenAddress } from "@/lib/format";
import type { ClosedTrade } from "@/lib/types";
import { useScrollLog } from "./useScrollLog";

interface ClosedTradesFeedProps {
  trades: ClosedTrade[];
  traderCount: number;
}

// Binary Polymarket markets index outcome 0 = YES, 1 = NO. Anything else gets no chip.
function outcomeLabel(index: number | null): "YES" | "NO" | null {
  if (index === 0) return "YES";
  if (index === 1) return "NO";
  return null;
}

// Relative time since close (everything here is within the 24h window). Render-time only, so the cell
// is marked suppressHydrationWarning to avoid an SSR/client mismatch.
function closedAgo(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  const m = Math.max(0, Math.floor(ms / 60000));
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m ago`;
}

// Realized $ P/L pill (with % when the basis is known); neutral "P/L n/a" when the cache had no
// realized figure. Reuses the Acoustic Log's pill styling for visual parity.
function PlCell({ pnl, pct }: { pnl: number | null; pct: number | null }) {
  if (pnl === null) {
    return <span className="af-pl na">P/L n/a</span>;
  }
  const up = pnl >= 0;
  return (
    <span className={`af-pl ${up ? "up" : "dn"}`}>
      {up ? "+" : ""}
      {formatUsd(pnl)}
      {pct !== null ? <span className="ct-pct"> {formatPercent(pct, true)}</span> : null}
    </span>
  );
}

export default function ClosedTradesFeed({ trades, traderCount }: ClosedTradesFeedProps) {
  const { locked, shellRef, logRef, hoverProps } = useScrollLog(trades);

  return (
    <section className="act-feed ct-feed">
      <div className="act-feed-head">
        <h2>Closed <span className="g">Trades</span></h2>
        <span className="meta">{traderCount} contacts · positions closed or resolved in the last 24h</span>
      </div>
      <div className="panel af-log-shell at-top" ref={shellRef}>
        <div className={`af-log ct-log ${locked ? "hovered" : ""}`} ref={logRef} {...hoverProps}>
          <table>
            <thead>
              <tr>
                <th>Contact</th>
                <th>Market</th>
                <th>Side</th>
                <th className="r">Avg Entry</th>
                <th className="r">Size</th>
                <th className="r">Realized P/L</th>
                <th className="r">Closed</th>
              </tr>
            </thead>
            <tbody>
              {trades.length === 0 ? (
                <tr>
                  <td colSpan={7} className="muted" style={{ padding: 36, textAlign: "center" }}>
                    No closed or resolved positions from board contacts in the last 24 hours.
                  </td>
                </tr>
              ) : (
                trades.map((t, i) => {
                  const out = outcomeLabel(t.outcomeIndex);
                  return (
                    <tr key={`${t.address}:${t.conditionId}:${t.outcomeIndex}:${i}`} className="af-row">
                      <td className="af-contact">
                        <Link href={`/wallet/${t.address}`} className="name" title={t.handle ? `@${t.handle}` : t.address}>
                          {t.handle ? (
                            <>
                              <span className="at">@</span>
                              {t.handle}
                            </>
                          ) : (
                            shortenAddress(t.address)
                          )}
                        </Link>
                        <div className="skl">
                          <span className="sigchip">{t.rank === null ? "Unranked" : `Rank #${t.rank}`}</span>
                        </div>
                      </td>
                      <td className="af-market">
                        <span className="q" title={t.market ?? ""}>
                          {t.market || "—"}
                        </span>
                      </td>
                      <td className="ct-side">
                        {out ? <span className={`af-out ${out === "YES" ? "yes" : "no"}`}>{out}</span> : <span className="muted">—</span>}
                      </td>
                      <td className="ct-num">{t.avgEntry === null ? "—" : formatPrice(t.avgEntry)}</td>
                      <td className="ct-num">{t.size === null ? "—" : formatNumber(t.size)}</td>
                      <td className="ct-num">
                        <PlCell pnl={t.realizedPnl} pct={t.realizedPct} />
                      </td>
                      <td className="ct-date" title={t.closeTime} suppressHydrationWarning>
                        {closedAgo(t.closeTime)}
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
  );
}
