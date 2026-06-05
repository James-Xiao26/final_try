"use client";

import type { HorizonDays } from "@/lib/types";
import { HORIZONS } from "@/lib/types";

interface HorizonToggleProps {
  value: HorizonDays;
  onChange: (value: HorizonDays) => void;
  horizons?: readonly HorizonDays[];
}

export default function HorizonToggle({ value, onChange, horizons = HORIZONS }: HorizonToggleProps) {
  const lastHorizon = horizons[horizons.length - 1];
  return (
    <div role="tablist" aria-label="Leaderboard horizon" style={{ display: "flex", border: "1px solid var(--line)", borderRadius: 3, overflow: "hidden" }}>
      {horizons.map((horizon) => (
        <button
          key={horizon}
          type="button"
          role="tab"
          aria-selected={value === horizon}
          onClick={() => onChange(horizon)}
          className="mono"
          style={{
            border: 0,
            borderRight: horizon === lastHorizon ? 0 : "1px solid var(--line)",
            background: value === horizon ? "var(--green)" : "transparent",
            color: value === horizon ? "#03141d" : "var(--text)",
            boxShadow: value === horizon ? "0 0 18px rgba(54,236,208,0.5)" : "none",
            padding: "10px 12px",
            minWidth: 68,
            fontWeight: 700
          }}
        >
          {horizon}D
        </button>
      ))}
    </div>
  );
}
