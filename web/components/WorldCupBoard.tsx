"use client";

import { Copy } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { formatEdge, formatNumber, formatPercent, formatUsd, shortenAddress } from "@/lib/format";
import type { WorldCupRow } from "@/lib/types";

// The 2026 FIFA World Cup final (MetLife Stadium). Drives the "limited time" countdown.
const FINAL_KICKOFF = new Date("2026-07-19T19:00:00Z");

// Score tier → soccer-flavored caps title. Pure presentation, derived from the WC skill score.
function capsTitle(score: number): string {
  if (score >= 8) return "Golden Boot";
  if (score >= 7) return "Playmaker";
  if (score >= 6) return "Striker";
  if (score >= 5) return "Midfielder";
  if (score >= 4) return "Defender";
  return "Substitute";
}

function displayName(row: WorldCupRow): string {
  return row.handle ? `@${row.handle}` : shortenAddress(row.address);
}

function Countdown() {
  // Render only after mount: the live value differs from SSR, so gate it to avoid a hydration mismatch.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  if (now === null) {
    return <div className="wc-count" aria-hidden />;
  }
  const ms = FINAL_KICKOFF.getTime() - now;
  if (ms <= 0) {
    return <div className="wc-count"><span className="wc-count-final">FULL TIME · CHAMPIONS CROWNED</span></div>;
  }
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor((ms % 86_400_000) / 3_600_000);
  const mins = Math.floor((ms % 3_600_000) / 60_000);
  const secs = Math.floor((ms % 60_000) / 1000);
  const cells: Array<[number, string]> = [[days, "DAYS"], [hours, "HRS"], [mins, "MIN"], [secs, "SEC"]];
  return (
    <div className="wc-count">
      {cells.map(([value, label]) => (
        <div key={label} className="wc-count-cell">
          <span className="n">{String(value).padStart(2, "0")}</span>
          <span className="l">{label}</span>
        </div>
      ))}
    </div>
  );
}

function Conviction({ row }: { row: WorldCupRow }) {
  if (row.openBets === 0 || !row.topMarket) {
    return <span className="wc-conv-none">—</span>;
  }
  return (
    <div className="wc-conv">
      <span className={`wc-side ${row.topSide === "NO" ? "no" : "yes"}`}>{row.topSide ?? "—"}</span>
      <span className="wc-conv-mkt" title={row.topMarket}>{row.topMarket}</span>
      {row.openBets > 1 ? <span className="wc-conv-more">+{row.openBets - 1}</span> : null}
    </div>
  );
}

export default function WorldCupBoard({ rows }: { rows: WorldCupRow[] }) {
  const podium = rows.slice(0, 3);
  const rest = rows.slice(3);

  return (
    <div className="wc">
      {/* hero — limited-time event banner */}
      <section className="wc-hero panel">
        <div className="wc-hero-glow" aria-hidden />
        <div className="wc-hero-top">
          <span className="wc-eyebrow"><span className="dot" /> LIMITED EVENT · 2026 FIFA WORLD CUP</span>
          <Countdown />
        </div>
        <h1 className="wc-title">
          <span className="trophy" aria-hidden>🏆</span>
          World Cup <span className="g">Forecasters</span>
        </h1>
        <p className="wc-sub">
          The whales ranked purely on their <strong>World Cup</strong> calls — forecasting edge on settled
          tournament markets, Bayesian-shrunk so a lucky bracket can&apos;t fake it. Live conviction shows
          where they&apos;re betting <em>now</em>. Vanishes when the final whistle blows.
        </p>
      </section>

      {rows.length === 0 ? (
        <div className="panel wc-empty">
          <span className="t">No qualifying forecasters yet</span>
          <span className="d">The board fills as World Cup markets resolve. Check back after the next round.</span>
        </div>
      ) : (
        <>
          {/* podium — top 3 */}
          {podium.length > 0 ? (
            <section className="wc-podium">
              {podium.map((row) => (
                <Link key={row.address} href={`/wallet/${row.address}?horizon=90`} className={`panel wc-pod wc-pod-${row.rank}`}>
                  <div className="wc-pod-rank">
                    <span className="medal" aria-hidden>{row.rank === 1 ? "🥇" : row.rank === 2 ? "🥈" : "🥉"}</span>
                    <span className="pos">#{row.rank}</span>
                  </div>
                  <div className="wc-pod-name">{displayName(row)}</div>
                  <div className="wc-pod-caps">{capsTitle(row.score)}</div>
                  <div className="wc-pod-score">
                    <span className="num">{row.score.toFixed(1)}</span>
                    <span className="of">/ 10 signal</span>
                  </div>
                  <div className="wc-pod-stats">
                    <span><i>Edge</i><b className={row.avgEdgePerShare >= 0 ? "pos" : "neg"}>{formatEdge(row.avgEdgePerShare)}</b></span>
                    <span><i>Win</i><b>{formatPercent(row.winRate)}</b></span>
                    <span><i>Bets</i><b>{formatNumber(row.nBets)}</b></span>
                  </div>
                </Link>
              ))}
            </section>
          ) : null}

          {/* full table */}
          <section className="wc-board panel">
            <div className="wc-board-head">
              <h2>Group <span className="g">Standings</span></h2>
              <span className="meta">{rows.length} qualified · ranked by World Cup signal</span>
            </div>
            <div className="wc-board-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Pos</th>
                    <th>Forecaster</th>
                    <th className="wc-hide">Caps</th>
                    <th>Signal</th>
                    <th>Edge / Share</th>
                    <th className="r wc-hide">Win</th>
                    <th className="r wc-hide">Bets</th>
                    <th className="r wc-hide-sm">P/L</th>
                    <th className="wc-live-col">Live Conviction</th>
                  </tr>
                </thead>
                <tbody>
                  {rest.length === 0 ? (
                    <tr><td colSpan={9} className="muted" style={{ padding: 28, textAlign: "center" }}>Only the podium has qualified so far.</td></tr>
                  ) : (
                    rest.map((row) => {
                      const seg = Math.round(row.score);
                      return (
                        <tr key={row.address}>
                          <td className="wc-pos"><span>#{row.rank}</span></td>
                          <td className="wc-trader">
                            <Link href={`/wallet/${row.address}?horizon=90`} className="name">
                              {row.handle ? <><span className="at">@</span>{row.handle}</> : shortenAddress(row.address)}
                            </Link>
                            <div className="meta">
                              {shortenAddress(row.address)}
                              <button type="button" aria-label={`Copy ${row.address}`} onClick={() => void navigator.clipboard.writeText(row.address)}>
                                <Copy size={11} />
                              </button>
                            </div>
                          </td>
                          <td className="wc-caps wc-hide"><span className="chip">{capsTitle(row.score)}</span></td>
                          <td className="wc-signal">
                            <span className="sig-num">{row.score.toFixed(1)}</span>
                            <span className="bars">
                              {Array.from({ length: 10 }).map((_, k) => (
                                <i key={k} className={k < seg ? "on" : ""} />
                              ))}
                            </span>
                          </td>
                          <td className="wc-edge"><span className={row.avgEdgePerShare >= 0 ? "pos" : "neg"}>{formatEdge(row.avgEdgePerShare)}</span></td>
                          <td className="wc-win r wc-hide">{formatPercent(row.winRate)}</td>
                          <td className="wc-bets r wc-hide">{formatNumber(row.nBets)}</td>
                          <td className={`wc-pnl r wc-hide-sm ${row.pnlUsd >= 0 ? "pos" : "neg"}`}>{formatUsd(row.pnlUsd)}</td>
                          <td className="wc-live"><Conviction row={row} /></td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      <p className="wc-foot mono">
        Signal = forecasting edge on World Cup soccer markets only (0–10), settled bets, Bayesian-shrunk.
        Open positions don&apos;t move the score — they ride along as live conviction. Updates daily.
      </p>
    </div>
  );
}
