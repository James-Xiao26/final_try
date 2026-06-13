import type { ReactNode } from "react";

interface MetricCardProps {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  // Tints the value: positive (aqua), negative (coral), neutral (default text).
  tone?: "pos" | "neg" | "neutral";
  title?: string;
}

// One readout tile on the analytics grid. Presentational + reusable across sections.
export default function MetricCard({ label, value, sub, tone = "neutral", title }: MetricCardProps) {
  return (
    <div className="panel ma-card" title={title}>
      <div className="ma-card-k">{label}</div>
      <div className={`ma-card-v ${tone}`}>{value}</div>
      {sub !== undefined ? <div className="ma-card-s">{sub}</div> : null}
    </div>
  );
}
