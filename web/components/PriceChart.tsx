"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { PriceLine, PricePoint, PriceSeries, WhaleTrade } from "@/lib/marketAnalytics";
import { PRICE_LINE_COLORS } from "@/lib/marketAnalytics";
import { formatCompactUsd, shortenAddress } from "@/lib/format";

interface PriceChartProps {
  series: PriceSeries;
  whales: WhaleTrade[];
  // Other top-favored candidate lines to overlay (multi-outcome events). The primary line is `series`.
  extraLines?: PriceLine[];
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const DAY_MS = 86_400_000;

// UTC-based so SSR and client agree (no hydration drift).
function tickLabel(ms: number): string {
  const d = new Date(ms);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

// Full date + time for the whale tooltip (hover-only, so no SSR; UTC to match the axis).
function whenLabel(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${hh}:${mm} UTC`;
}

function tms(ts: string): number {
  return Date.parse(ts);
}

const H = 320;
const padL = 38;
const padR = 14;
const padT = 16;
const padB = 26;

// null = "All" (since creation). Others window the series to the last N days.
type Horizon = number | null;
const HORIZON_OPTIONS: { label: string; value: Horizon }[] = [
  { label: "7D", value: 7 },
  { label: "30D", value: 30 },
  { label: "90D", value: 90 },
  { label: "All", value: null }
];

export default function PriceChart({ series, whales, extraLines = [] }: PriceChartProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(920);
  const [hoverX, setHoverX] = useState<number | null>(null);
  const [hoverWhale, setHoverWhale] = useState<number | null>(null);
  const [drawn, setDrawn] = useState(false);
  const [horizon, setHorizon] = useState<Horizon>(null); // default: full history since creation

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = (): void => setWidth(Math.max(320, el.clientWidth));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The series' own span (days between first and last point) decides which windows are meaningful —
  // no point offering "90D" on a 12-day-old market.
  const spanDays = useMemo(() => {
    const pts = series.points;
    if (pts.length < 2) return 0;
    const first = tms(pts[0]?.ts ?? "");
    const last = tms(pts[pts.length - 1]?.ts ?? "");
    return Math.round((last - first) / DAY_MS);
  }, [series.points]);

  const options = useMemo(() => HORIZON_OPTIONS.filter((o) => o.value === null || o.value < spanDays), [spanDays]);

  // Window the points / whales / extra lines to the selected horizon (relative to the last point).
  const view = useMemo(() => {
    const pts = series.points;
    if (pts.length === 0) {
      return { points: [] as PricePoint[], whales: [] as WhaleTrade[], extras: [] as PriceLine[] };
    }
    if (horizon === null) {
      return { points: pts, whales, extras: extraLines };
    }
    const lastMs = tms(pts[pts.length - 1]?.ts ?? "");
    const cutoff = lastMs - horizon * DAY_MS;
    return {
      points: pts.filter((p) => tms(p.ts) >= cutoff),
      whales: whales.filter((w) => w.ts >= cutoff),
      extras: extraLines.map((l) => ({ label: l.label, points: l.points.filter((p) => tms(p.ts) >= cutoff) }))
    };
  }, [series.points, whales, extraLines, horizon]);

  useEffect(() => {
    setDrawn(false);
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setDrawn(true)));
    return () => cancelAnimationFrame(id);
  }, [view, width]);

  const points = view.points;

  const model = useMemo(() => {
    if (points.length === 0) return null;
    const extras = view.extras.filter((l) => l.points.length > 0);
    const times = points.map((p) => tms(p.ts));
    // Domain spans the primary line, every extra candidate line, and the whale timestamps.
    const allTimes = [...times, ...extras.flatMap((l) => l.points.map((p) => tms(p.ts)))];
    const startMs = Math.min(...allTimes);
    const endMs = Math.max(Math.max(...allTimes), ...view.whales.map((w) => w.ts).filter(Number.isFinite));
    const tspan = endMs - startMs || 1;

    // y-axis padded a little around the visible range (primary + extra lines) so nothing is clipped.
    const allPrices = [...points.map((p) => p.price), ...extras.flatMap((l) => l.points.map((p) => p.price))];
    const vMin = Math.min(...allPrices);
    const vMax = Math.max(...allPrices);
    const lo = Math.max(0, vMin - 0.03);
    const hi = Math.min(1, vMax + 0.03);
    const pspan = hi - lo || 1;

    const nx = (ms: number): number => padL + ((ms - startMs) / tspan) * (width - padL - padR);
    const ny = (v: number): number => padT + (1 - (v - lo) / pspan) * (H - padT - padB);

    const pathOf = (pts: PricePoint[]): string =>
      pts.map((p, i) => `${i ? "L" : "M"}${nx(tms(p.ts)).toFixed(1)} ${ny(p.price).toFixed(1)}`).join(" ");

    // Carry the last price flat to the right edge when an intraday whale trade is the freshest event,
    // so the line doesn't stop short of the area fill / markers.
    const lastTime = times[times.length - 1] ?? startMs;
    const lastPrice = points[points.length - 1]?.price ?? lo;
    let line = pathOf(points);
    if (endMs > lastTime) line += ` L${nx(endMs).toFixed(1)} ${ny(lastPrice).toFixed(1)}`;
    const area = `${line} L${nx(endMs).toFixed(1)} ${ny(lo).toFixed(1)} L${nx(startMs).toFixed(1)} ${ny(lo).toFixed(1)} Z`;
    const extraPaths = extras.map((l, i) => ({ label: l.label, d: pathOf(l.points), color: PRICE_LINE_COLORS[(i + 1) % PRICE_LINE_COLORS.length] }));

    const ticksSeen = new Set<string>();
    const xticks = Array.from({ length: 4 }, (_, k) => {
      const ms = startMs + (k / 3) * (endMs - startMs);
      const anchor: "start" | "middle" | "end" = k === 0 ? "start" : k === 3 ? "end" : "middle";
      return { x: nx(ms), label: tickLabel(ms), anchor };
    }).filter((t) => {
      // Drop duplicate day labels (a sub-week span otherwise repeats the same date).
      if (ticksSeen.has(t.label)) return false;
      ticksSeen.add(t.label);
      return true;
    });
    const yticks = Array.from({ length: 5 }, (_, g) => {
      const v = lo + (g / 4) * pspan;
      return { y: ny(v), label: `${Math.round(v * 100)}¢` };
    });

    const maxUsd = Math.max(1, ...view.whales.map((w) => w.usdc));
    const markers = view.whales
      .filter((w) => Number.isFinite(w.ts))
      .map((w) => {
        const r = 3 + 7 * Math.sqrt(Math.min(1, w.usdc / maxUsd));
        // Plot at the YES-equivalent price (a NO fill at 47¢ → YES 53¢) so markers sit on the line.
        const py = w.yesPrice === null ? ny(lastPrice) : ny(w.yesPrice);
        return { w, x: nx(w.ts), y: py, r };
      });

    return { times, startMs, endMs, nx, ny, line, area, extraPaths, xticks, yticks, markers };
  }, [points, view.whales, view.extras, width]);

  // Nearest point to the hovered x (in px), for the crosshair readout.
  let hover: { x: number; y: number; ts: number; price: number } | null = null;
  if (hoverX !== null && model) {
    let best = 0;
    let bestDist = Infinity;
    model.times.forEach((t, i) => {
      const d = Math.abs(model.nx(t) - hoverX);
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

  const toggle =
    options.length > 1 ? (
      <div className="ma-hz" role="group" aria-label="Price history range">
        {options.map((o) => (
          <button
            key={o.label}
            type="button"
            className={horizon === o.value ? "active" : ""}
            onClick={() => setHorizon(o.value)}
            aria-pressed={horizon === o.value}
          >
            {o.label}
          </button>
        ))}
      </div>
    ) : null;

  if (!model) {
    return (
      <div className="ma-chartbox empty" ref={wrapRef}>
        <span className="muted">No tracked price history for this market yet.</span>
      </div>
    );
  }

  return (
    <div className="ma-chartbox" ref={wrapRef}>
      {toggle}
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

        <path d={model.area} fill="url(#maPrice)" style={{ opacity: drawn ? 1 : 0, transition: "opacity 1s ease .2s" }} />

        {/* Other top-favored candidate lines (multi-outcome events), drawn behind the primary line */}
        {model.extraPaths.map((e, i) => (
          <path
            key={`ex${i}`}
            d={e.d}
            fill="none"
            stroke={e.color}
            strokeWidth="1.6"
            strokeLinejoin="round"
            strokeLinecap="round"
            style={{ opacity: drawn ? 0.85 : 0, transition: "opacity .9s ease" }}
          />
        ))}

        <path
          d={model.line}
          fill="none"
          stroke="#36ecd0"
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
          style={{ filter: "drop-shadow(0 0 5px rgba(54,236,208,0.45))", opacity: drawn ? 1 : 0, transition: "opacity .9s ease" }}
        />

        {/* Whale markers: BUY filled aqua, SELL hollow coral; radius ∝ √USDC; placed at YES-equiv price */}
        {model.markers.map((m, i) => {
          const who = m.w.handle ?? shortenAddress(m.w.address);
          const active = hoverWhale === i;
          return (
            <circle
              key={`wm${i}`}
              cx={m.x}
              cy={m.y}
              r={active ? m.r + 2 : m.r}
              fill={m.w.side === "BUY" ? "rgba(54,236,208,0.5)" : "none"}
              stroke={m.w.side === "BUY" ? "#36ecd0" : "#ff7a59"}
              strokeWidth={active ? 2.5 : 1.5}
              style={{ cursor: "pointer", opacity: drawn ? 0.95 : 0, transition: `opacity .6s ease ${0.3 + (i % 8) * 0.04}s` }}
              onMouseEnter={() => setHoverWhale(i)}
              onMouseLeave={() => setHoverWhale((h) => (h === i ? null : h))}
            >
              <title>{`${m.w.side} ${m.w.outcome} · ${who}`}</title>
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

      {hoverWhale !== null && model.markers[hoverWhale] ? (() => {
        const m = model.markers[hoverWhale];
        const w = m.w;
        const who = w.handle ?? shortenAddress(w.address);
        const right = m.x > width * 0.7;
        return (
          <div
            className="ma-whale-tip"
            style={{ left: `${(m.x / width) * 100}%`, top: m.y, transform: `translate(${right ? "-100%" : "0"}, calc(-100% - 12px))` }}
          >
            <div className="wt-head">
              <span className="wt-who">{who}</span>
              {w.rank !== null ? <span className="wt-rank">#{w.rank}</span> : null}
            </div>
            <div className={`wt-side ${w.side === "BUY" ? "buy" : "sell"}`}>{w.side} {w.outcome}</div>
            <div className="wt-row"><span>Size</span><span>{formatCompactUsd(w.usdc)}{w.price !== null ? ` @ ${Math.round(w.price * 100)}¢` : ""}</span></div>
            {w.skillScore !== null ? <div className="wt-row"><span>Skill</span><span>{w.skillScore.toFixed(1)}</span></div> : null}
            <div className="wt-row"><span>When</span><span>{whenLabel(w.ts)}</span></div>
          </div>
        );
      })() : null}
    </div>
  );
}
