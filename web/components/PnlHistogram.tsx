import type { PnlDistribution } from "@/lib/marketAnalytics";

interface PnlHistogramProps {
  data: PnlDistribution;
}

// Vertical histogram of participants' realized/unrealized P/L across semantic bands. Loss bands tint
// coral, gain bands aqua, the flat band neutral.
export default function PnlHistogram({ data }: PnlHistogramProps) {
  if (data.sampled === 0) {
    return <div className="ma-empty muted">No participant P/L is available for this market.</div>;
  }

  const maxCount = Math.max(1, ...data.buckets.map((b) => b.count));

  const tone = (label: string): "neg" | "pos" | "flat" => {
    if (label.startsWith("≈")) return "flat";
    return label.includes("−") ? "neg" : "pos";
  };

  return (
    <div className="ma-hist">
      <div className="ma-hist-bars">
        {data.buckets.map((b) => (
          <div className="ma-hist-col" key={b.label} title={`${b.count} wallet${b.count === 1 ? "" : "s"}`}>
            <div className="ma-hist-count">{b.count || ""}</div>
            <div className="ma-hist-track">
              <i className={tone(b.label)} style={{ height: `${(b.count / maxCount) * 100}%` }} />
            </div>
            <div className="ma-hist-lbl">{b.label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
