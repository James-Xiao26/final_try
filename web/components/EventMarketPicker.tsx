"use client";

import { useRouter } from "next/navigation";
import type { EventMarketOption } from "@/lib/marketAnalytics";

// Native <select> to switch between the sibling markets of a grouped event. Navigates to the picked
// market's own analytics page. ponytail: native select over a custom dropdown — keyboard/a11y for free.
export default function EventMarketPicker({
  markets,
  current
}: {
  markets: EventMarketOption[];
  current: string;
}) {
  const router = useRouter();
  const lc = current.toLowerCase();
  return (
    <label className="ma-picker">
      <span className="ma-picker-lbl">Market</span>
      <select
        value={markets.find((m) => m.conditionId.toLowerCase() === lc)?.conditionId ?? markets[0]?.conditionId ?? ""}
        onChange={(e) => {
          if (e.target.value) router.push(`/market/${e.target.value}`);
        }}
      >
        {markets.map((m) => (
          <option key={m.conditionId} value={m.conditionId}>
            {m.label}
          </option>
        ))}
      </select>
    </label>
  );
}
