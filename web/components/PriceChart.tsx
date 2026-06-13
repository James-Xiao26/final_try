"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { PriceSeries, WhaleTrade } from "@/lib/marketAnalytics";
import { formatCompactUsd, shortenAddress } from "@/lib/format";

interface PriceChartProps {
  series: PriceSeries;
  whales: WhaleTrade[];
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

// UTC-based so SSR and client agree (no hydration drift).
function tickLabel(ms: number): string {
  const d = new Date(ms);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

function dayMs(ts: string): number {
  return Date.parse(`${ts}T00:00:00.000Z`);
}

const H = 320;
const padL = 38;
const padR = 14;
const padT = 16;
const padB = 26;

export default function PriceChart({ series, whales }: PriceChartProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(920);
  const [hoverX, setHoverX] = useState<number | null>(null);
  const [drawn, setDrawn] = useState(false);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = (): void => setWidth(Math.max(320, el.clientWidth));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    setDrawn(false);
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setDrawn(true)));
    return () => cancelAnimationFrame(id);
  }, [series]);

  const points = series.points;

  const model = useMemo(() => {
    if (points.length === 0) return null;
    const times = points.map((p) => dayMs(p.ts));
    const startMs = times[0] ?? 0;
    const endMs = Math.max(times[times.length - 1] ?? startMs + 1, ...whales.map((w) => w.ts).filter(Number.isFinite));
    const tspan = endMs - startMs || 1;

    // Price y-axis is padded a little around the observed range so the line isn't glued to the edges.
    const lo = Math.max(0, series.min === null ? 0 : series.min - 0.05);
    const hi = Math.min(1, series.max === null ? 1 : series.max + 0.05);
    const pspan = hi - lo || 1;

    const nx = (ms: number): number => padL + ((ms - startMs) / tspan) * (width - padL - padR);
    const ny = (v: number): number => padT + (1 - (v - lo) / pspan) * (H - padT - padB);

    const line = points.map((p, i) => `${i ? "L" : "M"}${nx(times[i] ?? 0).toFixed(1)} ${ny(p.price).toFixed(1)}`).join(" ");
    const area = `${line} L${nx(endMs).toFixed(1)} ${ny(lo).toFixed(1)} L${nx(startMs).toFixed(1)} ${ny(lo).toFixed(1)} Z`;

    const xticks = Array.from({ length: 4 }, (_, k) => {
      const ms = startMs + (k / 3) * (endMs - startMs);
      const anchor: "start" | "middle" | "end" = k === 0 ? "start" : k === 3 ? "end" : "middle";
      return { x: nx(ms), label: tickLabel(ms), anchor };
    });
    const yticks = Array.from({ length: 5 }, (_, g) => {
      const v = lo + (g / 4) * pspan;
      return { y: ny(v), label: `${Math.round(v * 100)}¢` };
    });

    // Whale markers sized by USDC on a sqrt scale (area ∝ value), clamped to a readable radius range.
    const maxUsd = Math.max(1, ...whales.map((w) => w.usdc));
    const markers = whales
      .filter((w) => Number.isFinite(w.ts))
      .map((w) => {
        const r = 3 + 7 * Math.sqrt(Math.min(1, w.usdc / maxUsd));
        const py = w.price === null ? ny((series.latest ?? 0.5)) : ny(w.price);
        return { w, x: nx(w.ts), y: py, r };
      });

    const regimes = series.regimeShifts.map((s) => ({ x: nx(dayMs(s.ts)), s }));

    return { times, startMs, endMs, tspan, nx, ny, line, area, xticks, yticks, markers, regimes, lo };
  }, [points, whales, width, series]);

  if (!model) {
    return (
      <div className="ma-chartbox empty" ref={wrapRef}>
        <span className="muted">No tracked price history for this market yet.</span>
      </div>
    );
  }

  // Nearest point to the hovered x (in px), for the crosshair readout.
  let hover: { x: number; y: number; ts: number; price: number } | null = null;
  if (hoverX !== null) {
    let best = 0;
    let bestDist = Infinity;
    model.times.forEach((t, i) => {
      const px = model.nx(t);
      const d = Math.abs(px - hoverX);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    });
    const p = points[best];
    if (p) hover = { x: model.nx(model.times[best] ?? 0), y: model.ny(p.price), ts: model.times[best] ?? 0, price: p.price };
  }

  const onMove = (e: React.MouseEvent<SVGSVGElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect();
    setHoverX(((e.clientX - rect.left) / rect.width) * width);
  };

  return (
    <div className="ma-chartbox" ref={wrapRef}>
      <svg
        width={width}
        height={H}
        viewBox={`0 0 ${width} ${H}`}
        onMouseMove={onMove}
        onMouseLeave={() => setHoverX(null)}
        role="img"
        aria-label="Market price history with whale trade overlay"
      >
        <defs>
          <linearGradient id="maPrice" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(54,236,208,0.30)" />
            <stop offset="100%" stopColor="rgba(54,236,208,0)" />
          </linearGradient>
        </defs>

        {model.yticks.map((t, i) => (
          <g key={i}>
            <line x1={padL} y1={t.y} x2={width - padR} y2={t.y} stroke="rgba(54,236,208,0.08)" />
            <text className="ma-axis" x={padL - 6} y={t.y + 3} textAnchor="end">{t.label}</text>
          </g>
        ))}
        {model.xticks.map((t, i) => (
          <text key={i} className="ma-axis" x={t.x} y={H - 6} textAnchor={t.anchor}>{t.label}</text>
        ))}

        {/* Regime-change markers: outsized daily moves (news shocks) */}
        {model.regimes.map((r, i) => (
          <line key={`rg${i}`} x1={r.x} y1={padT} x2={r.x} y2={H - padB} stroke="rgba(255,210,122,0.35)" strokeWidth="1" strokeDasharray="3 4" />
        ))}

        <path d={model.area} fill="url(#maPrice)" style={{ opacity: drawn ? 1 : 0, transition: "opacity 1s ease .2s" }} />
        <path
          d={model.line}
          fill="none"
          stroke="#36ecd0"
          strokeWidth="2.2"
          strokeLinejoin="round"
          strokeLinecap="round"
          style={{ filter: "drop-shadow(0 0 5px rgba(54,236,208,0.45))", opacity: drawn ? 1 : 0, transition: "opacity .9s ease" }}
        />

        {/* Whale markers: BUY filled aqua, SELL hollow coral; radius ∝ √USDC */}
        {model.markers.map((m, i) => {
          const priceTxt = m.w.price !== null ? ` @ ${Math.round(m.w.price * 100)}¢` : "";
          const rankTxt = m.w.rank !== null ? ` (#${m.w.rank})` : "";
          const who = m.w.handle ?? shortenAddress(m.w.address);
          const tip = `${m.w.side} ${m.w.outcome} · ${formatCompactUsd(m.w.usdc)}${priceTxt} · ${who}${rankTxt}`;
          return (
            <circle
              key={`wm${i}`}
              cx={m.x}
              cy={m.y}
              r={m.r}
              fill={m.w.side === "BUY" ? "rgba(54,236,208,0.5)" : "none"}
              stroke={m.w.side === "BUY" ? "#36ecd0" : "#ff7a59"}
              strokeWidth="1.5"
              style={{ opacity: drawn ? 0.95 : 0, transition: `opacity .6s ease ${0.3 + (i % 8) * 0.04}s` }}
            >
              <title>{tip}</title>
            </circle>
          );
        })}

        {hover ? (
          <g>
            <line x1={hover.x} y1={padT} x2={hover.x} y2={H - padB} stroke="rgba(212,243,240,0.25)" strokeWidth="1" />
            <circle cx={hover.x} cy={hover.y} r="3.5" fill="#03101a" stroke="#36ecd0" strokeWidth="2" />
          </g>
        ) : null}
      </svg>

      {hover ? (
        <div
          className="ma-tooltip"
          style={{ left: `${(hover.x / width) * 100}%`, transform: `translateX(${hover.x > width * 0.7 ? "-100%" : "0"})` }}
        >
          <span className="d">{tickLabel(hover.ts)}</span>
          <span className="p">{Math.round(hover.price * 100)}¢ YES</span>
        </div>
      ) : null}
    </div>
  );
}
