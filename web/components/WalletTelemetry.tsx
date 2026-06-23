"use client";

import { useEffect, useState } from "react";
import HorizonToggle from "@/components/HorizonToggle";
import { windowedCurve } from "@/lib/equityCurve";
import { formatCompactUsd, formatEdge, formatNumber, formatPercent, formatUsd } from "@/lib/format";
import { HORIZONS } from "@/lib/types";
import type { EquityPoint, HorizonDays, WalletMetrics } from "@/lib/types";

interface WalletTelemetryProps {
  metrics: WalletMetrics[];
  equityCurves: Record<HorizonDays, EquityPoint[]>;
  initialHorizon: HorizonDays;
}

const DRAW_LEN = 4000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

// UTC-based so SSR and client agree (no locale/hydration drift).
function tickLabel(ms: number): string {
  const d = new Date(ms);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

function DiveProfile({ points, horizon }: { points: EquityPoint[]; horizon: HorizonDays }) {
  const [drawn, setDrawn] = useState(false);

  useEffect(() => {
    setDrawn(false);
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setDrawn(true)));
    return () => cancelAnimationFrame(id);
  }, [horizon, points]);

  if (points.length === 0) {
    return <div className="skeleton" style={{ height: 300 }} />;
  }

  const W = 920;
  const H = 300;
  const padL = 8;
  const padR = 8;
  const padT = 18;
  const padB = 24;

  // Anchor to a fixed [today - horizon, today] window so x reflects real elapsed time. The copy-trade
  // curve already carries its own window-start baseline (the $100 stake), so no $0 prepend happens.
  const { points: pts, startMs, endMs } = windowedCurve(points, horizon);
  const values = pts.map((p) => p.cumulativePnl);
  // The curve is a $100-stake copy-trade balance (cumulativePnl now stores a dollar balance, not a
  // P/L delta). The first point is the window-start baseline = the starting stake; anchor the chart's
  // reference line and value range to it so the line begins at "$100" on the left edge.
  const baseline = pts[0]?.cumulativePnl ?? 100;
  const min = Math.min(...values, baseline);
  const max = Math.max(...values, baseline);
  const span = max - min || 1;
  const tspan = endMs - startMs || 1;
  const nx = (tsMs: number): number => {
    const x = padL + ((tsMs - startMs) / tspan) * (W - padL - padR);
    return Math.min(W - padR, Math.max(padL, x)); // clamp for boundary rounding
  };
  const ny = (v: number): number => padT + (1 - (v - min) / span) * (H - padT - padB);
  const baseY = ny(baseline);
  const xs = pts.map((p) => nx(Date.parse(p.ts)));
  const lastIdx = pts.length - 1;

  // Stepped interior (balance holds flat between trades, then jumps on a trade's close date) with a
  // diagonal final leg to the "today" point (which folds in open positions' mark-to-market).
  let line = `M${xs[0]?.toFixed(1)} ${ny(pts[0]?.cumulativePnl ?? 0).toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) {
    const x = (xs[i] ?? 0).toFixed(1);
    const yPrev = ny(pts[i - 1]?.cumulativePnl ?? 0).toFixed(1);
    const yCur = ny(pts[i]?.cumulativePnl ?? 0).toFixed(1);
    line += i === lastIdx ? ` L${x} ${yCur}` : ` L${x} ${yPrev} L${x} ${yCur}`;
  }
  const firstX = (xs[0] ?? padL).toFixed(1);
  const lastX = xs[lastIdx] ?? W - padR;
  const lastY = ny(pts[lastIdx]?.cumulativePnl ?? 0);
  const area = `${line} L${lastX.toFixed(1)} ${ny(min).toFixed(1)} L${firstX} ${ny(min).toFixed(1)} Z`;

  const gridlines = Array.from({ length: 5 }, (_, g) => {
    const y = padT + (g / 4) * (H - padT - padB);
    const val = max - (g / 4) * span;
    return { y, val };
  });

  const xticks = Array.from({ length: 4 }, (_, k) => {
    const ms = startMs + (k / 3) * (endMs - startMs);
    const anchor: "start" | "middle" | "end" = k === 0 ? "start" : k === 3 ? "end" : "middle";
    return { x: nx(ms), label: tickLabel(ms), anchor };
  });

  return (
    <div className="wl-chartbox">
      <svg viewBox="0 0 920 300" preserveAspectRatio="none" aria-hidden>
        <defs>
          <linearGradient id="wlDive" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(54,236,208,0.28)" />
            <stop offset="100%" stopColor="rgba(54,236,208,0)" />
          </linearGradient>
        </defs>
        {gridlines.map((g, i) => (
          <g key={i}>
            <line x1={padL} y1={g.y} x2={W - padR} y2={g.y} stroke="rgba(54,236,208,0.08)" />
            <text className="wl-axis" x={padL + 2} y={g.y - 4}>{formatCompactUsd(g.val)}</text>
          </g>
        ))}
        {/* Starting-stake baseline — always drawn (min/max bracket it) and kept clearly visible above the grid. */}
        <line x1={padL} y1={baseY} x2={W - padR} y2={baseY} stroke="rgba(255,122,89,0.6)" strokeWidth="1.25" />
        <text className="wl-axis" x={W - padR - 2} y={baseY - 4} textAnchor="end" style={{ fill: "rgba(255,122,89,0.75)" }}>{formatCompactUsd(baseline)}</text>
        {xticks.map((t, i) => (
          <text key={i} className="wl-axis" x={t.x} y={H - 6} textAnchor={t.anchor}>{t.label}</text>
        ))}
        <path d={area} fill="url(#wlDive)" style={{ opacity: drawn ? 1 : 0, transition: "opacity 1.4s ease .4s" }} />
        <path
          d={line}
          fill="none"
          stroke="#36ecd0"
          strokeWidth="2.2"
          strokeLinejoin="round"
          strokeLinecap="round"
          style={{ filter: "drop-shadow(0 0 5px rgba(54,236,208,0.6))", strokeDasharray: DRAW_LEN, strokeDashoffset: drawn ? 0 : DRAW_LEN, transition: "stroke-dashoffset 1.6s ease" }}
        />
        <circle cx={lastX} cy={lastY} r="5" fill="#36ecd0" style={{ filter: "drop-shadow(0 0 6px #36ecd0)" }} />
        <circle cx={lastX} cy={lastY} r="5" fill="none" stroke="#36ecd0" opacity="0.6">
          <animate attributeName="r" from="5" to="16" dur="2.2s" repeatCount="indefinite" />
          <animate attributeName="opacity" from="0.6" to="0" dur="2.2s" repeatCount="indefinite" />
        </circle>
      </svg>
    </div>
  );
}

export default function WalletTelemetry({ metrics, equityCurves, initialHorizon }: WalletTelemetryProps) {
  const [horizon, setHorizon] = useState<HorizonDays>(initialHorizon);
  const points = equityCurves[horizon] ?? [];
  // Final balance of the $100-stake copy-trade simulation (empty curve → untouched $100 stake).
  const finalBalance = points[points.length - 1]?.cumulativePnl ?? 100;

  return (
    <>
      <div className="wl-tele-bar">
        <div className="lbl">Telemetry Window</div>
        <HorizonToggle value={horizon} onChange={setHorizon} />
      </div>

      <div className="wl-metrics">
        {HORIZONS.map((h) => {
          const m = metrics.find((metric) => metric.horizonDays === h);
          return (
            <div key={h} className="panel wl-mcard">
              <div className="mh">
                <span className="hz">{h}-Day Window</span>
                <span className="sk">{m && m.skillScore !== null ? m.skillScore.toFixed(1) : "N/A"} <small>SIG</small></span>
              </div>
              {m ? (
                <dl>
                  <dt>Edge / share</dt>
                  <dd className={m.avgEdgePerShare >= 0 ? "pos" : "neg"}>{formatEdge(m.avgEdgePerShare)} <span className="sub">· {formatNumber(m.nResolved)} resolved</span></dd>
                  <dt>Hit rate</dt>
                  <dd>{formatPercent(m.winRate)}</dd>
                  <dt>Net P/L · Vol</dt>
                  <dd>{formatCompactUsd(m.totalPnlUsd)} <span className="sub">/ {formatCompactUsd(m.totalVolumeUsd)}</span></dd>
                  <dt>% return</dt>
                  <dd className={m.pctReturn >= 0 ? "pos" : "neg"}>{formatPercent(m.pctReturn, true)}</dd>
                  <dt>Observations</dt>
                  <dd>{formatNumber(m.nTrades)}</dd>
                </dl>
              ) : (
                <p className="muted" style={{ margin: "22px 0 0", fontSize: 13 }}>No telemetry for this window.</p>
              )}
            </div>
          );
        })}
      </div>

      <section className="panel wl-dive">
        <div className="dive-head">
          <h2>Dive <span className="g">Profile</span></h2>
          <div className="now">
            <div className="k">Balance · {horizon}D</div>
            <div className="v" style={{ color: finalBalance >= 100 ? "var(--green)" : "var(--red)" }}>{formatUsd(finalBalance)}</div>
          </div>
        </div>
        <DiveProfile points={points} horizon={horizon} />
        <div className="dive-foot"><span>$100 start · 1% per trade</span><span>{horizon}-day trace</span></div>
      </section>
    </>
  );
}

