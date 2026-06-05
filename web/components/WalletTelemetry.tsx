"use client";

import { useEffect, useState } from "react";
import HorizonToggle from "@/components/HorizonToggle";
import { formatCompactUsd, formatEdge, formatNumber, formatPercent, formatUsd } from "@/lib/format";
import { HORIZONS } from "@/lib/types";
import type { EquityPoint, HorizonDays, WalletMetrics } from "@/lib/types";

interface WalletTelemetryProps {
  metrics: WalletMetrics[];
  equityCurves: Record<HorizonDays, EquityPoint[]>;
  initialHorizon: HorizonDays;
}

const DRAW_LEN = 3000;

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
  const values = points.map((p) => p.cumulativePnl);
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 0);
  const span = max - min || 1;
  const nx = (i: number): number => padL + (i / (points.length - 1 || 1)) * (W - padL - padR);
  const ny = (v: number): number => padT + (1 - (v - min) / span) * (H - padT - padB);
  const zeroY = ny(0);
  const lastV = values[values.length - 1] ?? 0;

  const line = points.map((p, i) => `${i ? "L" : "M"}${nx(i).toFixed(1)} ${ny(p.cumulativePnl).toFixed(1)}`).join(" ");
  const area = `${line} L ${nx(points.length - 1).toFixed(1)} ${ny(min).toFixed(1)} L ${nx(0).toFixed(1)} ${ny(min).toFixed(1)} Z`;
  const lastX = nx(points.length - 1);
  const lastY = ny(lastV);

  const gridlines = Array.from({ length: 5 }, (_, g) => {
    const y = padT + (g / 4) * (H - padT - padB);
    const val = max - (g / 4) * span;
    return { y, val };
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
        <line x1={padL} y1={zeroY} x2={W - padR} y2={zeroY} stroke="rgba(255,122,89,0.35)" strokeDasharray="4 4" />
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
  const netCatch = points[points.length - 1]?.cumulativePnl ?? 0;

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
            <div className="k">Net Catch · {horizon}D</div>
            <div className="v" style={{ color: netCatch >= 0 ? "var(--green)" : "var(--red)" }}>{netCatch >= 0 ? "+" : ""}{formatUsd(netCatch)}</div>
          </div>
        </div>
        <DiveProfile points={points} horizon={horizon} />
        <div className="dive-foot"><span>Depth = cumulative realized P/L</span><span>{horizon}-day trace</span></div>
      </section>
    </>
  );
}

