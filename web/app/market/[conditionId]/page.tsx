import Link from "next/link";
import ConvergenceChart from "@/components/ConvergenceChart";
import CrowdParticipants from "@/components/CrowdParticipants";
import { formatCompactUsd, formatPrice } from "@/lib/format";
import { getCrowdMarketDetail } from "@/lib/supabase";

export const dynamic = "force-dynamic";

interface MarketPageProps {
  params: {
    conditionId: string;
  };
}

export default async function MarketPage({ params }: MarketPageProps) {
  const conditionId = decodeURIComponent(params.conditionId);
  const detail = await getCrowdMarketDetail(conditionId);

  if (!detail) {
    return (
      <main className="page">
        <Link href="/" className="wl-back">← Return to Convergence</Link>
        <section className="panel" style={{ marginTop: 16, padding: 28 }}>
          <h1 className="brand">Market not tracked</h1>
          <p className="subtitle">No leaderboard contacts hold a position in this market.</p>
        </section>
      </main>
    );
  }

  const total = Math.max(1, detail.yesTraders + detail.noTraders);
  const yesPct = Math.round((detail.yesTraders / total) * 100);

  return (
    <main className="page">
      <Link href="/" className="wl-back">← Return to Convergence</Link>

      <section className="panel cv-detail-head">
        <span className="cv-ribbon">◆ Convergence Zone</span>
        <h1 className="cv-title">{detail.market || "Untitled market"}</h1>
        <div className="cv-stats">
          <div className="cv-stat">
            <div className="k">Contacts</div>
            <div className="v">{detail.traderCount}</div>
          </div>
          <div className="cv-stat">
            <div className="k">YES / NO</div>
            <div className="v"><span className="yes">{detail.yesTraders}</span> / <span className="no">{detail.noTraders}</span></div>
          </div>
          <div className="cv-stat">
            <div className="k">Tracked Vol</div>
            <div className="v">{formatCompactUsd(detail.totalVolumeUsd)}</div>
          </div>
          <div className="cv-stat">
            <div className="k">YES Price</div>
            <div className="v">{detail.curPrice === null ? "—" : formatPrice(detail.curPrice)}</div>
          </div>
        </div>
        <div className="cv-consensus">
          <div className="cv-consensus-bar">
            <span className="yes" style={{ width: `${yesPct}%` }} />
            <span className="no" style={{ width: `${100 - yesPct}%` }} />
          </div>
          <div className="cv-consensus-lbl">
            <span className="yes">{yesPct}% lean YES</span>
            <span className="no">{100 - yesPct}% lean NO</span>
          </div>
        </div>
      </section>

      <section className="panel cv-chart-section">
        <div className="cv-chart-head">
          <h2>Position <span className="g">Flow</span></h2>
          <div className="cv-legend">
            <span className="cv-leg yes">YES committed</span>
            <span className="cv-leg no">NO committed</span>
            <span className="cv-leg price">YES price</span>
          </div>
        </div>
        <ConvergenceChart timeline={detail.timeline} />
        <div className="cv-chart-foot">
          <span>Cumulative net leaderboard cost basis per side</span>
          <span>Reconstructed from tracked fills</span>
        </div>
      </section>

      <CrowdParticipants participants={detail.participants} />
    </main>
  );
}
