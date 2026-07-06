import Link from "next/link";
import type { TopHolders } from "@/lib/marketAnalytics";
import { formatCompactUsd, shortenAddress } from "@/lib/format";

interface TopHoldersChartProps {
  data: TopHolders;
}

// Single combined ranking of the biggest holders across both sides. One horizontal bar per holder, bar
// width ∝ their dollar amount vs the largest holder; bar color says which side they're on (YES green,
// NO coral). Reads top-down as "who has the most money on this market, and where".
export default function TopHoldersChart({ data }: TopHoldersChartProps) {
  if (data.bars.length === 0) {
    return <div className="ma-empty muted">No positions to rank.</div>;
  }
  return (
    <div className="ma-th">
      {data.bars.map((h) => (
        <div className="ma-th-row" key={`${h.address}-${h.side}`}>
          <Link href={`/wallet/${h.address}`} className="ma-th-name" title={h.address}>
            {h.handle ?? shortenAddress(h.address)}
            {h.rank !== null ? <span className="ma-rank">#{h.rank}</span> : null}
          </Link>
          <div className="ma-th-bar">
            <i className={h.side === "NO" ? "no" : "yes"} style={{ width: `${data.max > 0 ? (h.amount / data.max) * 100 : 0}%` }} />
          </div>
          <div className="ma-th-val">
            <span className={`ma-th-side ${h.side === "NO" ? "no" : "yes"}`}>{h.side}</span>
            <span className="amt">{formatCompactUsd(h.amount)}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
