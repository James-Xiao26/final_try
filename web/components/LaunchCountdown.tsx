"use client";

import { useEffect, useState } from "react";

// "Surfacing in" — a live countdown to launch, styled as a hydrophone instrument readout. The target
// is an explicit instant (June 12, 2026, 00:00 US Eastern) so the day count is unambiguous regardless
// of the viewer's timezone. Ticking happens client-side only; first paint renders placeholders so
// server and client markup match (no hydration mismatch from Date.now()).
const LAUNCH_MS = new Date("2026-06-12T00:00:00-04:00").getTime();

interface Parts {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
  done: boolean;
}

function compute(): Parts {
  const diff = LAUNCH_MS - Date.now();
  if (diff <= 0) return { days: 0, hours: 0, minutes: 0, seconds: 0, done: true };
  const s = Math.floor(diff / 1000);
  return {
    days: Math.floor(s / 86400),
    hours: Math.floor((s % 86400) / 3600),
    minutes: Math.floor((s % 3600) / 60),
    seconds: s % 60,
    done: false
  };
}

const pad = (n: number) => String(n).padStart(2, "0");

export default function LaunchCountdown() {
  const [parts, setParts] = useState<Parts | null>(null);

  useEffect(() => {
    setParts(compute());
    const id = setInterval(() => setParts(compute()), 1000);
    return () => clearInterval(id);
  }, []);

  if (parts?.done) {
    return (
      <div className="ea-cd ea-cd-done">
        <div className="ea-cd-head">
          <span className="orn">◇</span>
          <span className="ea-cd-title">Surfaced</span>
          <span className="ea-cd-meta">Launch window · now boarding</span>
        </div>
        <div className="ea-cd-doneline">We&apos;ve broken the surface — access is opening now.</div>
      </div>
    );
  }

  const units: Array<{ key: string; value: number; label: string }> = [
    { key: "d", value: parts?.days ?? 0, label: "Days" },
    { key: "h", value: parts?.hours ?? 0, label: "Hrs" },
    { key: "m", value: parts?.minutes ?? 0, label: "Min" },
    { key: "s", value: parts?.seconds ?? 0, label: "Sec" }
  ];

  return (
    <div className="ea-cd">
      <div className="ea-cd-head">
        <span className="orn">◇</span>
        <span className="ea-cd-title">Surfacing in</span>
        <span className="ea-cd-meta">Launch window · 06 · 12 · 2026</span>
      </div>
      <div className="ea-cd-grid" role="timer" aria-label="Time until launch">
        {units.map((u, i) => (
          <div className="ea-cd-unit" key={u.key}>
            <div className="ea-cd-cell">
              {/* keyed by value so the digit remounts and replays the flip on each change */}
              <span className="ea-cd-num" key={parts ? u.value : "x"}>
                {parts ? pad(u.value) : "--"}
              </span>
              <span className="ea-cd-lbl">{u.label}</span>
            </div>
            {i < units.length - 1 && <span className="ea-cd-sep" aria-hidden>:</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
