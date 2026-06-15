"use client";

import { useEffect, useState } from "react";
import { formatCompactUsd } from "@/lib/format";
import type { CrowdTimelinePoint } from "@/lib/types";

interface ConvergenceChartProps {
  timeline: CrowdTimelinePoint[];
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

// UTC-based so SSR and client agree (no locale/hydration drift).
function tickLabel(ms: number): string {
  const d = new Date(ms);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

export default function ConvergenceChart({ timeline }: ConvergenceChartProps) {
  const [drawn, setDrawn] = useState(false);

  useEffect(() => {
    setDrawn(false);
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setDrawn(true)));
    return () => cancelAnimationFrame(id);
  }, [timeline]);

  if (timeline.length === 0) {
    return (
      <div className="cv-chartbox empty">
        <span className="muted">No tracked position history for this market.</span>
      </div>
    );
  }

  const W = 920;
  const H = 320;
  const padL = 8;
  const padR = 8;
  const padT = 18;
  const padB = 26;

  const times = timeline.map((p) => Date.parse(`${p.ts}T00:00:00.000Z`));
  const startMs = times[0] ?? 0;
  const endMs = times[times.length - 1] ?? startMs + 1;
  const tspan = endMs - startMs || 1;

  const maxCost = Math.max(1, ...timeline.map((p) => Math.max(p.yesCostUsd, p.noCostUsd)));
  const hasPrice = timeline.some((p) => p.price !== null);

  const nx = (ms: number): number => {
    const x = padL + ((ms - startMs) / tspan) * (W - padL - padR);
    return Math.min(W - padR, Math.max(padL, x));
  };
  const nyCost = (v: number): number => padT + (1 - v / maxCost) * (H - padT - padB);
  const nyPrice = (v: number): number => padT + (1 - v) * (H - padT - padB); // price in [0,1]

  const buildLine = (accessor: (p: CrowdTimelinePoint) => number, ny: (v: number) => number): string =>
    timeline
      .map((p, i) => `${i ? "L" : "M"}${nx(times[i] ?? 0).toFixed(1)} ${ny(accessor(p)).toFixed(1)}`)
      .join(" ");

  const yesLine = buildLine((p) => p.yesCostUsd, nyCost);
  const noLine = buildLine((p) => p.noCostUsd, nyCost);
  const yesArea = `${yesLine} L${nx(endMs).toFixed(1)} ${nyCost(0).toFixed(1)} L${nx(startMs).toFixed(1)} ${nyCost(0).toFixed(1)} Z`;
  const noArea = `${noLine} L${nx(endMs).toFixed(1)} ${nyCost(0).toFixed(1)} L${nx(startMs).toFixed(1)} ${nyCost(0).toFixed(1)} Z`;

  // Price line skips null points (carry-forward is applied upstream, so nulls only lead the series).
  let priceLine = "";
  if (hasPrice) {
    let started = false;
    timeline.forEach((p, i) => {
      if (p.price === null) return;
      priceLine += `${started ? "L" : "M"}${nx(times[i] ?? 0).toFixed(1)} ${nyPrice(p.price).toFixed(1)} `;
      started = true;
    });
  }

  const gridlines = Array.from({ length: 5 }, (_, g) => {
    const y = padT + (g / 4) * (H - padT - padB);
    const val = maxCost - (g / 4) * maxCost;
    return { y, val };
  });
  // Evenly-spaced ticks, but drop duplicate day labels (a sub-week span otherwise repeats e.g.
  // "Jun 13" several times).
  const seenTicks = new Set<string>();
  const xticks = Array.from({ length: 4 }, (_, k) => {
    const ms = startMs + (k / 3) * (endMs - startMs);
    const anchor: "start" | "middle" | "end" = k === 0 ? "start" : k === 3 ? "end" : "middle";
    return { x: nx(ms), label: tickLabel(ms), anchor };
  }).filter((t) => {
    if (seenTicks.has(t.label)) return false;
    seenTicks.add(t.label);
    return true;
  });

  return (
    <div className="cv-chartbox">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden>
        <defs>
          <linearGradient id="cvYes" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(54,236,208,0.26)" />
            <stop offset="100%" stopColor="rgba(54,236,208,0)" />
          </linearGradient>
          <linearGradient id="cvNo" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(255,122,89,0.22)" />
            <stop offset="100%" stopColor="rgba(255,122,89,0)" />
          </linearGradient>
        </defs>
        {gridlines.map((g, i) => (
          <g key={i}>
            <line x1={padL} y1={g.y} x2={W - padR} y2={g.y} stroke="rgba(54,236,208,0.08)" />
            <text className="cv-axis" x={padL + 2} y={g.y - 4}>{formatCompactUsd(g.val)}</text>
          </g>
        ))}
        {xticks.map((t, i) => (
          <text key={i} className="cv-axis" x={t.x} y={H - 6} textAnchor={t.anchor}>{t.label}</text>
        ))}

        <path d={yesArea} fill="url(#cvYes)" style={{ opacity: drawn ? 1 : 0, transition: "opacity 1.2s ease .3s" }} />
        <path d={noArea} fill="url(#cvNo)" style={{ opacity: drawn ? 1 : 0, transition: "opacity 1.2s ease .3s" }} />
        <path d={noLine} fill="none" stroke="#ff7a59" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" style={{ opacity: drawn ? 0.95 : 0, transition: "opacity 1s ease" }} />
        <path d={yesLine} fill="none" stroke="#36ecd0" strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round" style={{ filter: "drop-shadow(0 0 5px rgba(54,236,208,0.5))", opacity: drawn ? 1 : 0, transition: "opacity 1s ease" }} />
        {hasPrice ? (
          <path d={priceLine} fill="none" stroke="rgba(220,230,255,0.55)" strokeWidth="1.4" strokeDasharray="4 4" style={{ opacity: drawn ? 1 : 0, transition: "opacity 1.2s ease .5s" }} />
        ) : null}
      </svg>
    </div>
  );
}
