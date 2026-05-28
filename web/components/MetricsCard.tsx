import SkillScoreBadge from "@/components/SkillScoreBadge";
import { formatNumber, formatPercent, formatUsd } from "@/lib/format";
import type { WalletMetrics } from "@/lib/types";

interface MetricsCardProps {
  horizonDays: number;
  metrics: WalletMetrics | null;
}

export default function MetricsCard({ horizonDays, metrics }: MetricsCardProps) {
  if (!metrics) {
    return (
      <article className="panel" style={{ padding: 16, minHeight: 178 }}>
        <div className="mono muted">{horizonDays}D</div>
        <div className="skeleton" style={{ height: 24, marginTop: 18, width: "55%" }} />
        <div className="skeleton" style={{ height: 12, marginTop: 18, width: "90%" }} />
        <div className="skeleton" style={{ height: 12, marginTop: 10, width: "70%" }} />
      </article>
    );
  }

  return (
    <article className="panel" style={{ padding: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
        <div className="mono muted">{horizonDays}D</div>
        <SkillScoreBadge score={metrics.skillScore} />
      </div>
      <dl style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: "10px 12px", margin: "18px 0 0" }}>
        <dt className="muted">Return</dt>
        <dd className={metrics.pctReturn >= 0 ? "mono positive" : "mono negative"} style={{ margin: 0 }}>
          {formatPercent(metrics.pctReturn, true)}
        </dd>
        <dt className="muted">Win Rate</dt>
        <dd className="mono" style={{ margin: 0 }}>{formatPercent(metrics.winRate)}</dd>
        <dt className="muted">MDD</dt>
        <dd className="mono negative" style={{ margin: 0 }}>{formatPercent(metrics.maxDrawdown)}</dd>
        <dt className="muted">PnL / Volume</dt>
        <dd className="mono" style={{ margin: 0 }}>{formatUsd(metrics.totalPnlUsd)} / {formatUsd(metrics.totalVolumeUsd)}</dd>
        <dt className="muted">N</dt>
        <dd className="mono" style={{ margin: 0 }}>{formatNumber(metrics.nTrades)}</dd>
      </dl>
    </article>
  );
}
