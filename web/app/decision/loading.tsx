// Next.js automatically wraps the /decision page in Suspense and shows this while
// page.tsx is fetching data server-side. This means the browser gets content immediately
// even when getDecisionEngineData() takes 10–15s on a cold Supabase connection.

export default function DecisionLoading() {
  return (
    <div className="page">
      <div className="topbar">
        <div>
          <h1 className="brand">
            Fire <span style={{ color: "var(--green)" }}>Control</span>
          </h1>
          <p className="subtitle">
            Markets where the leaderboard&apos;s verified-edge traders hold positions{" "}
            <em>above</em> current prices — ranked by the size and confidence of that discount.
            Not financial advice.
          </p>
        </div>
        <span className="act-live">
          <span className="dot" />
          SIGNAL ACTIVE
        </span>
      </div>

      <div className="panel de-empty" style={{ opacity: 0.6 }}>
        <div className="de-empty-reticle">
          <svg viewBox="0 0 74 74" aria-hidden>
            {[28, 20, 12, 5].map((r) => (
              <circle key={r} cx="37" cy="37" r={r} fill="none" stroke="rgba(54,236,208,0.12)" strokeWidth="1" />
            ))}
            <line x1="37" y1="9" x2="37" y2="65" stroke="rgba(54,236,208,0.08)" strokeWidth="1" />
            <line x1="9" y1="37" x2="65" y2="37" stroke="rgba(54,236,208,0.08)" strokeWidth="1" />
            <circle cx="37" cy="37" r="3" fill="rgba(54,236,208,0.4)" />
          </svg>
        </div>
        <div className="de-empty-text">
          <div className="de-empty-title">Acquiring targets…</div>
          <div className="de-empty-sub">Scanning leaderboard positions.</div>
        </div>
      </div>

      <section className="de-feed">
        <div className="de-feed-head">
          <h2>Target <span className="g">Solutions</span></h2>
          <span className="de-feed-meta">loading…</span>
        </div>
      </section>
    </div>
  );
}
