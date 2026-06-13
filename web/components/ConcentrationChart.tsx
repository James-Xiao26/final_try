import Link from "next/link";
import type { Concentration } from "@/lib/marketAnalytics";
import { formatCompactUsd, shortenAddress } from "@/lib/format";

interface ConcentrationChartProps {
  data: Concentration;
  topN?: number;
}

// Horizontal bar ranking of the largest committed positions, with the remaining "long tail" folded
// into one row. Bar width ∝ each holder's share of total committed capital.
export default function ConcentrationChart({ data, topN = 8 }: ConcentrationChartProps) {
  if (data.count === 0) {
    return <div className="ma-empty muted">No sized positions to rank.</div>;
  }

  const top = data.holders.slice(0, topN);
  const tail = data.holders.slice(topN);
  const tailShare = tail.reduce((a, h) => a + h.share, 0);
  const tailUsd = tail.reduce((a, h) => a + h.committed, 0);
  const maxShare = top[0]?.share ?? 1;

  return (
    <div className="ma-conc">
      {top.map((h) => (
        <div className="ma-conc-row" key={h.address}>
          <Link href={`/wallet/${h.address}`} className="ma-conc-name" title={h.address}>
            {h.handle ?? shortenAddress(h.address)}
            {h.rank !== null ? <span className="ma-rank">#{h.rank}</span> : null}
          </Link>
          <div className="ma-conc-bar">
            <i
              className={h.side === "NO" ? "no" : "yes"}
              style={{ width: `${maxShare > 0 ? (h.share / maxShare) * 100 : 0}%` }}
            />
          </div>
          <div className="ma-conc-val">
            <span className="pct">{(h.share * 100).toFixed(1)}%</span>
            <span className="usd">{formatCompactUsd(h.committed)}</span>
          </div>
        </div>
      ))}
      {tail.length > 0 ? (
        <div className="ma-conc-row tail">
          <span className="ma-conc-name muted">+ {tail.length} more wallets</span>
          <div className="ma-conc-bar">
            <i className="tail" style={{ width: `${maxShare > 0 ? (tailShare / maxShare) * 100 : 0}%` }} />
          </div>
          <div className="ma-conc-val">
            <span className="pct">{(tailShare * 100).toFixed(1)}%</span>
            <span className="usd">{formatCompactUsd(tailUsd)}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
