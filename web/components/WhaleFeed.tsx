import Link from "next/link";
import type { WhaleActivity } from "@/lib/marketAnalytics";
import { formatCompactUsd, shortenAddress } from "@/lib/format";

interface WhaleFeedProps {
  activity: WhaleActivity;
  summary: string;
  limit?: number;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

function whenLabel(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  const d = new Date(ms);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

// Textual smart-money summary + the largest tracked fills (buy/sell, side, size, who, when).
export default function WhaleFeed({ activity, summary, limit = 10 }: WhaleFeedProps) {
  return (
    <div className="ma-whale">
      <p className="ma-whale-summary">{summary}</p>
      {activity.trades.length > 0 ? (
        <ul className="ma-whale-list">
          {activity.trades.slice(0, limit).map((t, i) => (
            <li className="ma-whale-item" key={`${t.address}-${t.ts}-${i}`}>
              <span className={`ma-whale-side ${t.side === "BUY" ? "buy" : "sell"}`}>{t.side}</span>
              <span className={`ma-whale-out ${t.outcome === "NO" ? "no" : "yes"}`}>{t.outcome}</span>
              <Link href={`/wallet/${t.address}`} className="ma-whale-who" title={t.address}>
                {t.handle ?? shortenAddress(t.address)}
                {t.rank !== null ? <span className="ma-rank">#{t.rank}</span> : null}
              </Link>
              <span className="ma-whale-px">{t.price !== null ? `${Math.round(t.price * 100)}¢` : "—"}</span>
              <span className="ma-whale-usd">{formatCompactUsd(t.usdc)}</span>
              <span className="ma-whale-when">{whenLabel(t.ts)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
