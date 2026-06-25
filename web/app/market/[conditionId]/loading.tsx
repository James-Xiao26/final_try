import Link from "next/link";

// Next wraps the market page in Suspense and streams this instantly while page.tsx fetches
// server-side — so a market that needs a live Polymarket lookup (up to the 8s budget) shows a
// loading state immediately instead of a blank screen or a misleading "not tracked" panel.
export default function MarketLoading() {
  return (
    <main className="page ma-page">
      <Link href="/markets" className="wl-back">← Back to Markets</Link>
      <section className="panel" style={{ marginTop: 16, padding: 28, display: "flex", alignItems: "center", gap: 14 }}>
        <span className="dot" />
        <div>
          <h1 className="brand" style={{ marginBottom: 4 }}>Loading market…</h1>
          <p className="subtitle" style={{ margin: 0 }}>
            Pulling the latest snapshot and price history. Markets we don&apos;t already cache are
            fetched live from Polymarket, which can take a few seconds the first time.
          </p>
        </div>
      </section>
    </main>
  );
}
