import Link from "next/link";
import { notFound } from "next/navigation";
import WalletActivity from "@/components/WalletActivity";
import WalletDossier from "@/components/WalletDossier";
import WalletTelemetry from "@/components/WalletTelemetry";
import { getWalletProfile, withTimeout } from "@/lib/supabase";
import { HORIZONS } from "@/lib/types";
import type { HorizonDays } from "@/lib/types";

export const revalidate = 300;

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

  // A Supabase failure (free-tier cold-start 57014 timeout, etc.) must not throw a server-side
  // exception. This page is fully server-rendered with no client poll, so on a read error we show a
  // distinct "temporarily unavailable" panel (vs the "not indexed" state for a genuinely absent
  // wallet) and let the visitor retry.
  let profile: Awaited<ReturnType<typeof getWalletProfile>>;
  try {
    profile = await withTimeout(getWalletProfile(address), 7000, null);
  } catch {
    return (
      <main className="page">
        <Link href="/leaderboard" className="wl-back">← Return to Contact Log</Link>
        <section className="panel" style={{ marginTop: 16, padding: 28 }}>
          <h1 className="brand">Sonar temporarily down</h1>
          <p className="subtitle">We couldn&apos;t reach the contact archive just now. Refresh in a moment to try again.</p>
        </section>
      </main>
    );
  }

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
