"use client";

import type { HorizonDays } from "@/lib/types";
import { HORIZONS } from "@/lib/types";

interface HorizonToggleProps {
  value: HorizonDays;
  onChange: (value: HorizonDays) => void;
}

export default function HorizonToggle({ value, onChange }: HorizonToggleProps) {
  return (
    <div role="tablist" aria-label="Leaderboard horizon" style={{ display: "flex", border: "1px solid var(--line)" }}>
      {HORIZONS.map((horizon) => (
        <button
          key={horizon}
          type="button"
          role="tab"
          aria-selected={value === horizon}
          onClick={() => onChange(horizon)}
          className="mono"
          style={{
            border: 0,
            borderRight: horizon === 365 ? 0 : "1px solid var(--line)",
            background: value === horizon ? "var(--green)" : "transparent",
            color: value === horizon ? "#06100B" : "var(--text)",
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
