import Link from "next/link";
import { notFound } from "next/navigation";
import { Copy } from "lucide-react";
import EquityCurveChart from "@/components/EquityCurveChart";
import MetricsCard from "@/components/MetricsCard";
import { formatPercent, shortenAddress } from "@/lib/format";
import { getWalletProfile } from "@/lib/supabase";
import { HORIZONS } from "@/lib/types";

export const dynamic = "force-dynamic";

interface WalletPageProps {
  params: {
    address: string;
  };
}

export default async function WalletPage({ params }: WalletPageProps) {
  const address = params.address.toLowerCase();

  if (!address.startsWith("0x") || address.length !== 42) {
    notFound();
  }

  const profile = await getWalletProfile(address);

  if (!profile) {
    return (
      <main className="page">
        <Link href="/" className="mono muted">BACK TO LEADERBOARD</Link>
        <section className="panel" style={{ marginTop: 24, padding: 28 }}>
          <h1 className="brand">Wallet not indexed</h1>
          <p className="subtitle">This wallet hasn&apos;t been indexed yet.</p>
          <button
            type="button"
            disabled
            style={{
              marginTop: 20,
              border: "1px solid var(--line)",
              background: "#151922",
              color: "var(--muted)",
              padding: "10px 12px"
            }}
          >
            Request indexing
          </button>
        </section>
      </main>
    );
  }

  const bestMetric = profile.metrics.find((metric) => metric.horizonDays === 90) ?? profile.metrics[0];

  return (
    <main className="page">
      <Link href="/" className="mono muted">BACK TO LEADERBOARD</Link>
      <header className="topbar" style={{ marginTop: 24 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <h1 className="brand mono">{profile.handle ? `@${profile.handle}` : shortenAddress(profile.address)}</h1>
            <button
              type="button"
              aria-label="Copy wallet address"
              title="Copy wallet address"
              style={{
                border: "1px solid var(--line)",
                background: "var(--panel)",
                color: "var(--text)",
                width: 34,
                height: 34
              }}
            >
              <Copy size={16} />
            </button>
          </div>
          <p className="subtitle mono">{profile.address}</p>
          {profile.bio ? <p className="subtitle">{profile.bio}</p> : null}
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
          {profile.badges.map((badge) => (
            <span key={badge.label} className="mono" style={{ border: "1px solid var(--green)", color: "var(--green)", padding: "6px 8px" }}>
              {badge.label}
            </span>
          ))}
          {profile.isBotSuspected ? (
            <span className="mono" style={{ border: "1px solid var(--red)", color: "var(--red)", padding: "6px 8px" }}>
              BOT RISK
            </span>
          ) : null}
        </div>
      </header>

      {bestMetric ? (
        <div className="panel" style={{ padding: 14, marginBottom: 18 }}>
          <span className="mono muted">90D RETURN </span>
          <span className={bestMetric.pctReturn >= 0 ? "mono positive" : "mono negative"}>
            {formatPercent(bestMetric.pctReturn, true)}
          </span>
        </div>
      ) : null}

      <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 14, marginBottom: 18 }}>
        {HORIZONS.map((horizon) => (
          <MetricsCard
            key={horizon}
            horizonDays={horizon}
            metrics={profile.metrics.find((metric) => metric.horizonDays === horizon) ?? null}
          />
        ))}
      </section>

      <EquityCurveChart equityCurves={profile.equityCurves} />
    </main>
  );
}
