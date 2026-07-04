"use client";

import { useEffect, useState, type MouseEvent } from "react";
import { windowedCurve } from "@/lib/equityCurve";
import { formatCompactPercent, formatCompactUsd, formatEdge, formatNumber, formatPercent, formatPrice, formatUsd } from "@/lib/format";
import type { ClosedTrade, EquityPoint, HorizonDays, WalletMetrics } from "@/lib/types";

interface WalletTelemetryProps {
  metrics: WalletMetrics[];
  equityCurves: Record<HorizonDays, EquityPoint[]>;
  closedTrades: ClosedTrade[];
}

// Outcome side label for a step trade — Polymarket's real label, else binary Yes/No from the index.
function tradeOutcome(label: string | null, index: number | null): string {
  if (label) return label;
  if (index === 0) return "Yes";
  if (index === 1) return "No";
  return "";
}

const DRAW_LEN = 4000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

// UTC-based so SSR and client agree (no locale/hydration drift).
function tickLabel(ms: number): string {
  const d = new Date(ms);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

function DiveProfile({
  points,
  horizon,
  tradesByDay
}: {
  points: EquityPoint[];
  horizon: HorizonDays;
  tradesByDay: Map<string, ClosedTrade[]>;
}) {
  const [drawn, setDrawn] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  // `hover` is the transient pointer (drives the crosshair + tiny tooltip, clears on mouse-leave);
  // `selected` is sticky (drives the Settlement Log below the chart + a persistent step marker), so the
  // log stays readable after the cursor leaves. Null until the user scrubs → falls back to the most
  // recent settlement day so the log shows something meaningful on load.
  const [selected, setSelected] = useState<number | null>(null);

  useEffect(() => {
    setDrawn(false);
    setHover(null);
    setSelected(null);
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
  // curve carries its own window-start baseline (the $100 stake) as its first point.
  const { points: pts, startMs, endMs } = windowedCurve(points, horizon);
  // cumulativePnl stores a dollar balance starting at the $100 stake; show it as % return vs that stake.
  const stake = pts[0]?.cumulativePnl || 100; // || guards against a 0 first point (never a real stake)
  const pct = (v: number): number => (v / stake - 1) * 100;
  const pcts = pts.map((p) => pct(p.cumulativePnl));
  // Fit the y-axis to the data with a little headroom — don't force breakeven (0%) into view, so a
  // curve that never loses money still fills the chart instead of hugging the top.
  const dataMin = Math.min(...pcts);
  const dataMax = Math.max(...pcts);
  const pad = (dataMax - dataMin) * 0.08 || 1; // flat curve → a ±1% window so it isn't a hairline
  const min = dataMin - pad;
  const max = dataMax + pad;
  const span = max - min || 1;
  const tspan = endMs - startMs || 1;
  const nx = (tsMs: number): number => {
    const x = padL + ((tsMs - startMs) / tspan) * (W - padL - padR);
    return Math.min(W - padR, Math.max(padL, x)); // clamp for boundary rounding
  };
  const ny = (v: number): number => padT + (1 - (v - min) / span) * (H - padT - padB);
  // Breakeven (0%) reference line — drawn only when it actually falls inside the fitted range.
  const showBreakeven = min <= 0 && max >= 0;
  const breakevenY = ny(0);
  const xs = pts.map((p) => nx(Date.parse(p.ts)));
  const ys = pcts.map((v) => ny(v));
  const lastIdx = pts.length - 1;

  // Stepped interior (balance holds flat between trades, then jumps on a trade's close date) with a
  // diagonal final leg to the "today" point (which folds in open positions' mark-to-market).
  let line = `M${xs[0]?.toFixed(1)} ${(ys[0] ?? 0).toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) {
    const x = (xs[i] ?? 0).toFixed(1);
    const yPrev = (ys[i - 1] ?? 0).toFixed(1);
    const yCur = (ys[i] ?? 0).toFixed(1);
    line += i === lastIdx ? ` L${x} ${yCur}` : ` L${x} ${yPrev} L${x} ${yCur}`;
  }
  const firstX = (xs[0] ?? padL).toFixed(1);
  const lastX = xs[lastIdx] ?? W - padR;
  const lastY = ys[lastIdx] ?? 0;
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

  // Map the pointer (anywhere over the chart) to the nearest data point by x. The SVG stretches with
  // preserveAspectRatio="none", so work in viewBox units off the container's pixel width.
  const onMove = (e: MouseEvent<HTMLDivElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width === 0) return;
    const viewX = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)) * W;
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < xs.length; i++) {
      const d = Math.abs((xs[i] ?? 0) - viewX);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    setHover(best);
    setSelected(best);
  };

  const hx = hover !== null ? xs[hover] ?? 0 : 0;
  const hy = hover !== null ? ys[hover] ?? 0 : 0;
  const hoverPoint = hover !== null ? pts[hover] : undefined;
  const hoverPct = hover !== null ? pcts[hover] ?? 0 : 0;

  // Sticky selection for the Settlement Log: the scrubbed step, falling back to the most recent day
  // that actually settled markets (so the log isn't empty on load). The curve steps on each closed
  // position's close date, so a step's day keys directly into tradesByDay.
  let defaultSel = lastIdx;
  for (let i = lastIdx; i >= 0; i--) {
    if ((tradesByDay.get(pts[i]?.ts.slice(0, 10) ?? "")?.length ?? 0) > 0) {
      defaultSel = i;
      break;
    }
  }
  const sel = selected ?? defaultSel;
  const selPoint = pts[sel];
  const selTrades = selPoint ? tradesByDay.get(selPoint.ts.slice(0, 10)) ?? [] : [];
  const selPct = pcts[sel] ?? 0;
  // Forecasting tally for the day: how many calls landed vs missed (size-independent, by % sign).
  const wins = selTrades.filter((t) => t.pctReturn !== null && t.pctReturn >= 0).length;
  const losses = selTrades.filter((t) => t.pctReturn !== null && t.pctReturn < 0).length;
  const sx = xs[sel] ?? 0;
  const sy = ys[sel] ?? 0;
  // Keep the tooltip box inside the chart horizontally (it's centered on the point otherwise).
  const tipLeft = Math.min(88, Math.max(12, (hx / W) * 100));

  // Best calls first — sort by % return descending (the strongest forecasts top the log), nulls last.
  const selTradesSorted = [...selTrades].sort((a, b) => {
    if (a.pctReturn === null) return 1;
    if (b.pctReturn === null) return -1;
    return b.pctReturn - a.pctReturn;
  });

  return (
    <>
    <div
      className="wl-chartbox"
      style={{ position: "relative" }}
      onMouseMove={onMove}
      onMouseLeave={() => setHover(null)}
    >
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
            <text className="wl-axis" x={padL + 2} y={g.y - 4}>{formatCompactPercent(g.val)}</text>
          </g>
        ))}
        {/* Breakeven (0%) reference line — only when it falls within the fitted range. */}
        {showBreakeven && (
          <>
            <line x1={padL} y1={breakevenY} x2={W - padR} y2={breakevenY} stroke="rgba(255,122,89,0.6)" strokeWidth="1.25" />
            <text className="wl-axis" x={W - padR - 2} y={breakevenY - 4} textAnchor="end" style={{ fill: "rgba(255,122,89,0.75)" }}>0%</text>
          </>
        )}
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
        {/* Persistent marker on the selected step — keeps the curve tied to the Settlement Log below. */}
        {selPoint && sel !== lastIdx && (
          <circle cx={sx} cy={sy} r="4" fill="#36ecd0" style={{ filter: "drop-shadow(0 0 5px rgba(54,236,208,0.7))" }} />
        )}
        {hover !== null && (
          <>
            <line x1={hx} y1={padT} x2={hx} y2={H - padB} stroke="rgba(54,236,208,0.45)" strokeWidth="1" strokeDasharray="4 4" />
            <circle cx={hx} cy={hy} r="4.5" fill="#0b1a20" stroke="#36ecd0" strokeWidth="2" />
          </>
        )}
      </svg>
      {hoverPoint && (
        <div
          style={{
            position: "absolute",
            left: `${tipLeft}%`,
            top: `${(hy / H) * 100}%`,
            transform: "translate(-50%, calc(-100% - 12px))",
            pointerEvents: "none",
            background: "rgba(6,20,28,0.96)",
            border: "1px solid rgba(54,236,208,0.4)",
            borderRadius: 6,
            padding: "5px 9px",
            fontSize: 11.5,
            lineHeight: 1.4,
            whiteSpace: "nowrap",
            color: "#cfeee9",
            zIndex: 5
          }}
        >
          <div style={{ opacity: 0.65 }}>{tickLabel(Date.parse(hoverPoint.ts))}</div>
          <div style={{ fontWeight: 600 }}>
            {formatUsd(hoverPoint.cumulativePnl)}{" "}
            <span style={{ color: hoverPct >= 0 ? "var(--green)" : "var(--red)" }}>{formatCompactPercent(hoverPct)}</span>
          </div>
        </div>
      )}
    </div>

    {/* Settlement Log — the per-step detail, pulled out of the cramped on-graph tooltip into a roomy
        readout band. Scrubbing the curve (or its persistent marker) drives which day this shows. */}
    <div className="wl-slog">
      <div className="wl-slog-head">
        <div className="wl-slog-when">
          <span className="lbl">Settlement Log</span>
          <span className="day">{selPoint ? tickLabel(Date.parse(selPoint.ts)) : "—"}</span>
        </div>
        <div className="wl-slog-sum">
          {selTrades.length > 0 ? (
            <>
              <span className="tally"><span className="pos">{wins}W</span> · <span className="neg">{losses}L</span></span>
              <span className="cnt">{selTrades.length} {selTrades.length === 1 ? "market" : "markets"}</span>
            </>
          ) : (
            <span className={`net ${selPct >= 0 ? "pos" : "neg"}`}>{formatCompactPercent(selPct)}</span>
          )}
        </div>
      </div>
      {selTrades.length > 0 && (
        <div className="wl-slog-cols">
          <span className="sp" />
          <span className="mkt">Market</span>
          <span className="px">Entry → Exit</span>
          <span className="pct">Return</span>
        </div>
      )}
      <div className="wl-slog-body">
        {selTradesSorted.length > 0 ? (
          selTradesSorted.map((t, i) => {
            const side = tradeOutcome(t.outcomeLabel, t.outcomeIndex);
            const tone = t.pctReturn === null ? "neu" : t.pctReturn >= 0 ? "pos" : "neg";
            return (
              <div className="wl-slog-row" key={i}>
                <span className={`dot ${tone}`} />
                <span className="mkt">{t.market ?? "—"}{side && <span className="side"> · {side}</span>}</span>
                <span className="px">
                  {t.avgEntry !== null ? formatPrice(t.avgEntry) : "—"}
                  <span className="arr"> → </span>
                  {t.avgExit !== null ? formatPrice(t.avgExit) : "—"}
                </span>
                <span className={`pct ${tone}`}>
                  {t.pctReturn !== null ? formatCompactPercent(t.pctReturn * 100) : "—"}
                </span>
              </div>
            );
          })
        ) : (
          <div className="wl-slog-empty">
            {sel === lastIdx
              ? "Open positions marked to today’s prices — no markets settled this day."
              : "No markets settled — balance held flat."}
          </div>
        )}
      </div>
    </div>
    </>
  );
}

export default function WalletTelemetry({ metrics, equityCurves, closedTrades }: WalletTelemetryProps) {
  // Single 90-day window (the leaderboard consolidated to one horizon). Kept as a const so the chart
  // window + labels below read from one place; the pipeline still computes 30-day data, just unshown.
  const horizon: HorizonDays = 90;
  const points = equityCurves[horizon] ?? [];
  const m90 = metrics.find((metric) => metric.horizonDays === 90);
  // Group closed positions by UTC close-day so the chart can look up a step's trades by its date.
  // Horizon-independent (the day key is the same across windows), so build it once for the wallet.
  const tradesByDay = new Map<string, ClosedTrade[]>();
  for (const trade of closedTrades) {
    const day = trade.closeTime.slice(0, 10);
    const list = tradesByDay.get(day) ?? [];
    list.push(trade);
    tradesByDay.set(day, list);
  }
  // Final return % of the $100-stake copy-trade simulation, vs the window-start stake (empty curve → 0%).
  const stake = points[0]?.cumulativePnl || 100;
  const finalPct = ((points[points.length - 1]?.cumulativePnl ?? stake) / stake - 1) * 100;

  return (
    <>
      <div className="wl-metrics">
        <div className="panel wl-mcard">
          <div className="mh">
            <span className="hz">90-Day Window</span>
            <span className="sk">{m90 && m90.skillScore !== null ? m90.skillScore.toFixed(1) : "N/A"} <small>SIG</small></span>
          </div>
          {m90 ? (
            <dl>
              <dt>Edge / share</dt>
              <dd className={m90.avgEdgePerShare >= 0 ? "pos" : "neg"}>{formatEdge(m90.avgEdgePerShare)} <span className="sub">· {formatNumber(m90.nResolved)} resolved</span></dd>
              <dt>Hit rate</dt>
              <dd>{formatPercent(m90.winRate)}</dd>
              <dt>Net P/L · Vol</dt>
              <dd>{formatCompactUsd(m90.totalPnlUsd)} <span className="sub">/ {formatCompactUsd(m90.totalVolumeUsd)}</span></dd>
              <dt>% return</dt>
              <dd className={m90.pctReturn >= 0 ? "pos" : "neg"}>{formatPercent(m90.pctReturn, true)}</dd>
              <dt>Observations</dt>
              <dd>{formatNumber(m90.nTrades)}</dd>
            </dl>
          ) : (
            <p className="muted" style={{ margin: "22px 0 0", fontSize: 13 }}>No telemetry for this window.</p>
          )}
        </div>
      </div>

      <section className="panel wl-dive">
        <div className="dive-head">
          <h2>Dive <span className="g">Profile</span></h2>
          <div className="now">
            <div className="k">Return · {horizon}D</div>
            <div className="v" style={{ color: finalPct >= 0 ? "var(--green)" : "var(--red)" }}>{formatCompactPercent(finalPct)}</div>
          </div>
        </div>
        <p className="muted" style={{ margin: "0 0 14px", fontSize: 12.5, lineHeight: 1.45, maxWidth: 560 }}>
          Hypothetical return if you’d copied every trade this wallet made starting from $100, staking 1% of your
          running balance on each — shown as % gain/loss vs that $100. Scrub the curve to read the markets
          that settled on any step in the Settlement Log below.
        </p>
        <DiveProfile points={points} horizon={horizon} tradesByDay={tradesByDay} />
        <div className="dive-foot"><span>% return · $100 start · 1% per trade</span><span>{horizon}-day trace</span></div>
      </section>
    </>
  );
}

