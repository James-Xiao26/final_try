import Link from "next/link";
import SkillScoreBadge from "@/components/SkillScoreBadge";
import { formatPrice, formatTimeAgo, formatUsd, shortenAddress } from "@/lib/format";
import type { RecentTrade } from "@/lib/types";

interface RecentTradesFeedProps {
  trades: RecentTrade[];
}

function sideColor(side: string | null): string {
  if (side === "BUY") {
    return "var(--green)";
  }
  if (side === "SELL") {
    return "var(--red)";
  }
  return "var(--muted)";
}

export default function RecentTradesFeed({ trades }: RecentTradesFeedProps) {
  return (
    <section className="panel">
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 860 }}>
          <thead>
            <tr className="mono muted" style={{ textAlign: "left", fontSize: 12 }}>
              <th style={{ padding: "12px" }}>TRADER</th>
              <th style={{ padding: "12px" }}>SKILL</th>
              <th style={{ padding: "12px" }}>MARKET</th>
              <th style={{ padding: "12px" }}>SIDE</th>
              <th style={{ padding: "12px" }}>PRICE</th>
              <th style={{ padding: "12px" }}>AMOUNT</th>
              <th style={{ padding: "12px" }}>WHEN</th>
            </tr>
          </thead>
          <tbody>
            {trades.length === 0 ? (
              <tr>
                <td colSpan={7} className="muted" style={{ padding: 28, textAlign: "center", borderTop: "1px solid var(--line)" }}>
                  No trades from leaderboard wallets in the last 24 hours.
                </td>
              </tr>
            ) : null}
            {trades.map((trade, index) => (
              <tr key={`${trade.address}-${trade.tradedAt}-${index}`} style={{ borderTop: "1px solid var(--line)" }}>
                <td style={{ padding: "12px" }}>
                  <Link href={`/wallet/${trade.address}`} className="mono" style={{ color: "var(--text)" }}>
                    {trade.handle ? `@${trade.handle}` : shortenAddress(trade.address)}
                  </Link>
                </td>
                <td style={{ padding: "12px" }}>
                  <SkillScoreBadge score={trade.skillScore} />
                </td>
                <td style={{ padding: "12px", maxWidth: 320 }}>
                  <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={trade.market ?? ""}>
                    {trade.market || "—"}
                  </span>
                </td>
                <td className="mono" style={{ padding: "12px", color: sideColor(trade.side), fontWeight: 700 }}>
                  {trade.side ?? "—"}
                </td>
                <td className="mono" style={{ padding: "12px" }}>
                  {trade.price === null ? "—" : formatPrice(trade.price)}
                </td>
                <td className="mono" style={{ padding: "12px" }}>
                  {trade.usdcSize === null ? "—" : formatUsd(trade.usdcSize)}
                </td>
                <td className="mono muted" style={{ padding: "12px" }} title={trade.tradedAt}>
                  {formatTimeAgo(trade.tradedAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
