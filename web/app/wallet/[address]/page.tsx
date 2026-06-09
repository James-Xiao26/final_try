import Link from "next/link";
import { notFound } from "next/navigation";
import WalletActivity from "@/components/WalletActivity";
import WalletDossier from "@/components/WalletDossier";
import WalletTelemetry from "@/components/WalletTelemetry";
import { getWalletProfile } from "@/lib/supabase";
import { HORIZONS } from "@/lib/types";
import type { HorizonDays } from "@/lib/types";

export const dynamic = "force-dynamic";

interface WalletPageProps {
  params: {
    address: string;
  };
  searchParams: {
    horizon?: string;
  };
}

function parseHorizon(value: string | undefined): HorizonDays {
  const parsed = Number(value);
  return HORIZONS.includes(parsed as HorizonDays) ? (parsed as HorizonDays) : 90;
}

export default async function WalletPage({ params, searchParams }: WalletPageProps) {
  const address = params.address.toLowerCase();
  const initialHorizon = parseHorizon(searchParams.horizon);

  if (!address.startsWith("0x") || address.length !== 42) {
    notFound();
  }

  const profile = await getWalletProfile(address);

  if (!profile) {
    return (
      <main className="page">
        <Link href="/leaderboard" className="wl-back">← Return to Contact Log</Link>
        <section className="panel" style={{ marginTop: 16, padding: 28 }}>
          <h1 className="brand">Contact not indexed</h1>
          <p className="subtitle">This wallet hasn&apos;t surfaced on the hydrophone yet.</p>
        </section>
      </main>
    );
  }

  const m90 = profile.metrics.find((metric) => metric.horizonDays === 90) ?? profile.metrics[0];

  return (
    <main className="page">
      <Link href="/leaderboard" className="wl-back">← Return to Contact Log</Link>

      <WalletDossier
        address={profile.address}
        handle={profile.handle}
        bio={profile.bio}
        isBotSuspected={profile.isBotSuspected}
        badges={profile.badges}
        skill={m90?.skillScore ?? null}
        volume={m90?.totalVolumeUsd ?? null}
      />

      <WalletTelemetry
        metrics={profile.metrics}
        equityCurves={profile.equityCurves}
        initialHorizon={initialHorizon}
      />

      <WalletActivity positions={profile.positions} tradeGroups={profile.tradeGroups} />
    </main>
  );
}
