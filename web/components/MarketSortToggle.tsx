"use client";

import { MARKET_SORTS, type MarketSort } from "@/lib/types";

interface MarketSortToggleProps {
  value: MarketSort;
  onChange: (value: MarketSort) => void;
}

const LABELS: Record<MarketSort, string> = {
  liquidity: "Liquidity",
  volume: "Volume",
  volume_24hr: "24h",
  volatility: "Volatility"
};

export default function MarketSortToggle({ value, onChange }: MarketSortToggleProps) {
  const lastSort = MARKET_SORTS[MARKET_SORTS.length - 1];

  return (
    <div role="tablist" aria-label="Sort markets" style={{ display: "flex", border: "1px solid var(--line)" }}>
      {MARKET_SORTS.map((sort) => (
        <button
          key={sort}
          type="button"
          role="tab"
          aria-selected={value === sort}
          onClick={() => onChange(sort)}
          className="mono"
          style={{
            border: 0,
            borderRight: sort === lastSort ? 0 : "1px solid var(--line)",
            background: value === sort ? "var(--green)" : "transparent",
            color: value === sort ? "#06100B" : "var(--text)",
            padding: "10px 12px",
            minWidth: 68,
            fontWeight: 700
          }}
        >
          {LABELS[sort]}
        </button>
      ))}
    </div>
  );
}
