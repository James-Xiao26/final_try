import Link from "next/link";
import type { SidePayoutHolder, SidePayouts } from "@/lib/marketAnalytics";
import { formatCompactUsd, shortenAddress } from "@/lib/format";

interface SidePayoutChartProps {
  data: SidePayouts;
}

function Column({
  side,
  holders,
  total,
  max
}: {
  side: "YES" | "NO";
  holders: SidePayoutHolder[];
  total: number;
  max: number;
}) {
  return (
    <div className="ma-sp-col">
      <div className="ma-sp-head">
        <span className={`ma-sp-side ${side === "NO" ? "no" : "yes"}`}>{side}</span>
        <span className="ma-sp-total">{formatCompactUsd(total)}</span>
      </div>
      {holders.length === 0 ? (
        <div className="ma-empty muted">No open {side} holders.</div>
      ) : (
        holders.map((h) => (
          <div className="ma-sp-row" key={h.address}>
            <Link href={`/wallet/${h.address}`} className="ma-sp-name" title={h.address}>
              {h.handle ?? shortenAddress(h.address)}
              {h.rank !== null ? <span className="ma-rank">#{h.rank}</span> : null}
            </Link>
            <div className="ma-sp-bar">
              <i className={side === "NO" ? "no" : "yes"} style={{ width: `${max > 0 ? (h.payout / max) * 100 : 0}%` }} />
            </div>
            <span className="ma-sp-val">{formatCompactUsd(h.payout)}</span>
          </div>
        ))
      )}
    </div>
  );
}

// Two-sided ranking of the largest current holders by their payout-if-their-side-wins (shares held =
// $1/share at resolution). Left column YES, right column NO; bar width ∝ each holder's payout vs the
// single largest holder across both sides, so the two sides are directly comparable.
export default function SidePayoutChart({ data }: SidePayoutChartProps) {
  if (data.yes.length === 0 && data.no.length === 0) {
    return <div className="ma-empty muted">No open positions to rank.</div>;
  }
  return (
    <div className="ma-sp">
      <Column side="YES" holders={data.yes} total={data.yesTotal} max={data.max} />
      <Column side="NO" holders={data.no} total={data.noTotal} max={data.max} />
    </div>
  );
}
