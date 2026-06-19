"use client";

import { ExternalLink } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { formatCompactUsd, formatPrice, isValidAddress, shortenAddress } from "@/lib/format";
import type {
  ConfidenceLevel,
  DecisionEngineResult,
  DecisionSignalResult,
  SmartMoneyHolder,
  TradeRecommendation,
} from "@/lib/types";

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 min — matches server revalidation

// ── Targeting reticle animation ───────────────────────────────────────────────
// A sweeping sonar pulse rendered in SVG, mirroring the oscilloscope on the Activity page.
function TargetingReticle() {
  const sweepRef = useRef<SVGGElement>(null);
  const pingRef = useRef<SVGCircleElement>(null);
  useEffect(() => {
    const sweep = sweepRef.current;
    if (!sweep) return;
    let angle = 0;
    let raf = 0;
    const frame = (): void => {
      angle = (angle + 0.8) % 360;
      sweep.setAttribute("transform", `rotate(${angle.toFixed(1)}, 37, 37)`);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="de-reticle">
      <svg viewBox="0 0 74 74" aria-hidden>
        {/* concentric rings */}
        {[28, 20, 12, 5].map((r) => (
          <circle key={r} cx="37" cy="37" r={r} fill="none" stroke="rgba(54,236,208,0.15)" strokeWidth="1" />
        ))}
        {/* crosshairs */}
        <line x1="37" y1="9" x2="37" y2="65" stroke="rgba(54,236,208,0.12)" strokeWidth="1" />
        <line x1="9" y1="37" x2="65" y2="37" stroke="rgba(54,236,208,0.12)" strokeWidth="1" />
        {/* sweep arm */}
        <g ref={sweepRef}>
          <line
            x1="37" y1="37" x2="37" y2="9"
            stroke="rgba(54,236,208,0.70)"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
          <path
            d="M37,37 L37,9 A28,28 0 0,1 64.6,46.4 Z"
            fill="rgba(54,236,208,0.06)"
          />
        </g>
        {/* center blip */}
        <circle ref={pingRef} cx="37" cy="37" r="3" fill="var(--green)" />
      </svg>
    </div>
  );
}

// ── Universe stats strip ──────────────────────────────────────────────────────
function UniverseStrip({ result }: { result: DecisionEngineResult }) {
  const { universeSummary: u, recommendations: recs } = result;
  return (
    <div className="panel de-universe-strip">
      <div className="de-uni-meta">
        <div className="k">Markets Scanned</div>
        <div className="v">{u.marketsScanned}</div>
      </div>
      <div className="de-uni-meta">
        <div className="k">Smart Money Signals</div>
        <div className="v">{u.marketsWithSmartMoney}</div>
      </div>
      <div className="de-uni-meta">
        <div className="k">Solutions Found</div>
        <div className="v" style={{ color: recs.length > 0 ? "var(--green)" : "var(--muted)" }}>
          {recs.length}
        </div>
      </div>
      <div className="de-uni-meta">
        <div className="k">Board Contacts</div>
        <div className="v">{u.totalLeaderboardHolders}</div>
      </div>
      <TargetingReticle />
    </div>
  );
}

// ── Disclaimer banner ─────────────────────────────────────────────────────────
function Disclaimer({ text }: { text: string }) {
  return (
    <div className="de-disclaimer panel">
      <span className="de-disc-label">RISK NOTICE</span>
      <span className="de-disc-text">{text}</span>
    </div>
  );
}

// ── Signal bars (6 segments, each lit by signal.fired) ───────────────────────
function SignalBars({ signals }: { signals: DecisionSignalResult[] }) {
  return (
    <div className="de-sig-bars">
      {signals.map((s, i) => (
        <div
          key={i}
          className={`de-sig-bar ${s.fired ? `on ${s.strength}` : "off"}`}
          title={`${s.name}: ${s.value}`}
        />
      ))}
    </div>
  );
}

// ── Confidence badge ──────────────────────────────────────────────────────────
const CONFIDENCE_LABELS: Record<ConfidenceLevel, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  very_high: "Very High",
};

function ConfidenceBadge({ level, range }: { level: ConfidenceLevel; range: [number, number] }) {
  return (
    <span className={`de-conf-badge ${level}`}>
      {CONFIDENCE_LABELS[level]} · {(range[0] * 100).toFixed(0)}–{(range[1] * 100).toFixed(0)}%
    </span>
  );
}

// ── Signal checklist ──────────────────────────────────────────────────────────
function SignalChecklist({ signals }: { signals: DecisionSignalResult[] }) {
  return (
    <div className="de-checklist">
      {signals.map((s, i) => (
        <div key={i} className={`de-check-row ${s.fired ? "fired" : "dark"}`}>
          <span className="de-check-icon">{s.fired ? "◆" : "◇"}</span>
          <span className="de-check-name">{s.name}</span>
          <span className="de-check-val">{s.value}</span>
        </div>
      ))}
    </div>
  );
}

// ── Top holders strip ─────────────────────────────────────────────────────────
// A handle counts as a real username only if it isn't just the wallet address
// (Polymarket defaults unnamed wallets' handle to their 0x… address) and isn't
// excessively long. Otherwise we fall back to the compact 0x1234…abcd form.
function holderLabel(h: SmartMoneyHolder): string {
  const handle = h.handle?.trim();
  if (handle && handle.toLowerCase() !== h.address.toLowerCase() && !isValidAddress(handle)) {
    return `@${handle.length > 18 ? `${handle.slice(0, 17)}…` : handle}`;
  }
  return shortenAddress(h.address);
}

function HolderChip({ h }: { h: SmartMoneyHolder }) {
  const label = holderLabel(h);
  return (
    <Link href={`/wallet/${h.address}`} className="de-holder-chip" title={`${label} · Rank #${h.rank ?? "?"} · ${h.skillScore.toFixed(1)}/10`}>
      <span className="de-holder-rank">#{h.rank ?? "?"}</span>
      <span className="de-holder-name">{label}</span>
      <span className="de-holder-entry">{formatPrice(h.avgEntry)}</span>
    </Link>
  );
}

// ── One recommendation card ───────────────────────────────────────────────────
function RecommendationCard({ rec, index }: { rec: TradeRecommendation; index: number }) {
  const [expanded, setExpanded] = useState(false);
  const isYes = rec.side === "YES";
  const poly = rec.slug
    ? `https://polymarket.com/event/${rec.slug}`
    : `https://polymarket.com`;

  const edgePctDisplay = (rec.edgePct * 100).toFixed(1);
  const maxEntryDisplay = (rec.maxEntryPrice * 100).toFixed(1);
  const currentDisplay = (rec.currentPrice * 100).toFixed(1);
  const smartDisplay = (rec.smartMoneyPrice * 100).toFixed(1);

  return (
    <article className="panel de-card">
      {/* ── card header ── */}
      <div className="de-card-head">
        <div className="de-card-head-left">
          <span className="de-solution-num">
            {(index + 1).toString().padStart(2, "0")}
          </span>
          <span className={`de-side-badge ${isYes ? "yes" : "no"}`}>
            {isYes ? "▲ BUY YES" : "▼ BUY NO"}
          </span>
          <ConfidenceBadge level={rec.confidenceLevel} range={rec.confidenceRange} />
          {rec.personalizedBoost && (
            <span className="de-personalized" title="Boosted: matches your historical strong categories">
              ✦ PERSONALIZED
            </span>
          )}
        </div>
        <div className="de-card-head-right">
          {rec.category && <span className="de-cat">{rec.category}</span>}
          {rec.daysToExpiry !== null && (
            <span className={`de-expiry ${rec.daysToExpiry < 14 ? "urgent" : ""}`}>
              {rec.daysToExpiry}d to expiry
            </span>
          )}
        </div>
      </div>

      {/* ── market title ── */}
      <div className="de-card-title">
        {rec.conditionId ? (
          <Link href={`/market/${encodeURIComponent(rec.conditionId)}`} className="de-market-link">
            {rec.market}
          </Link>
        ) : (
          <span>{rec.market}</span>
        )}
        <a
          href={poly}
          target="_blank"
          rel="noopener noreferrer"
          className="de-ext-link"
          title="View on Polymarket"
        >
          <ExternalLink size={13} />
        </a>
      </div>

      {/* ── price and edge row ── */}
      <div className="de-price-row">
        <div className="de-price-block">
          <div className="de-price-label">Current price</div>
          <div className="de-price-val muted">{currentDisplay}¢</div>
        </div>
        <div className="de-price-arrow">→</div>
        <div className="de-price-block accent">
          <div className="de-price-label">Max entry</div>
          <div className="de-price-val">{maxEntryDisplay}¢</div>
        </div>
        <div className="de-price-arrow">→</div>
        <div className="de-price-block">
          <div className="de-price-label">Smart money avg</div>
          <div className="de-price-val dim">{smartDisplay}¢</div>
        </div>

        <div className="de-edge-block">
          <div className="de-edge-num">+{rec.edgeCents.toFixed(1)}¢</div>
          <div className="de-edge-sub">estimated edge · {edgePctDisplay}%</div>
        </div>
      </div>

      {/* ── signal bars + confidence ── */}
      <div className="de-signals-row">
        <div className="de-signals-left">
          <SignalBars signals={rec.signals} />
          <span className="de-sig-count">
            {rec.signalsFired}/{rec.totalSignals} signals
          </span>
        </div>
        <span className="de-liq">
          {formatCompactUsd(rec.liquidityUsd)} depth
        </span>
      </div>

      {/* ── holders strip ── */}
      <div className="de-holders">
        {rec.topHolders.map((h) => (
          <HolderChip key={h.address} h={h} />
        ))}
        {rec.holderCount > rec.topHolders.length && (
          <span className="de-holder-more">
            +{rec.holderCount - rec.topHolders.length} more
          </span>
        )}
        <span className="de-committed">
          {formatCompactUsd(rec.totalCommittedUsd)} committed
        </span>
      </div>

      {/* ── explanation ── */}
      <p className="de-explanation">{rec.explanation}</p>

      {/* ── warnings ── */}
      {rec.warnings.length > 0 && (
        <ul className="de-warnings">
          {rec.warnings.map((w, i) => (
            <li key={i}>⚠ {w}</li>
          ))}
        </ul>
      )}

      {/* ── expandable signal detail ── */}
      <button
        type="button"
        className="de-expand-btn"
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="de-expand-label">
          {expanded ? "Hide" : "Show"} signal detail
        </span>
        <svg viewBox="0 0 16 16" fill="none" aria-hidden className={`de-expand-chev ${expanded ? "open" : ""}`}>
          <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {expanded && (
        <div className="de-detail-panel">
          <SignalChecklist signals={rec.signals} />
        </div>
      )}
    </article>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────
function EmptyState() {
  return (
    <div className="panel de-empty">
      <div className="de-empty-reticle">
        <svg viewBox="0 0 74 74" aria-hidden>
          {[28, 20, 12, 5].map((r) => (
            <circle key={r} cx="37" cy="37" r={r} fill="none" stroke="rgba(54,236,208,0.12)" strokeWidth="1" />
          ))}
          <line x1="37" y1="9" x2="37" y2="65" stroke="rgba(54,236,208,0.08)" strokeWidth="1" />
          <line x1="9" y1="37" x2="65" y2="37" stroke="rgba(54,236,208,0.08)" strokeWidth="1" />
          <circle cx="37" cy="37" r="3" fill="rgba(54,236,208,0.3)" />
        </svg>
      </div>
      <div className="de-empty-text">
        <div className="de-empty-title">No targets acquired</div>
        <div className="de-empty-sub">
          The leaderboard&apos;s open positions may be fully priced in, or a fresh ingest is
          pending. Check back shortly.
        </div>
      </div>
    </div>
  );
}

// ── Loading skeleton ──────────────────────────────────────────────────────────
function LoadingState() {
  return (
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
        <div className="de-empty-sub">Contacting database — this may take a moment on first load.</div>
      </div>
    </div>
  );
}

// ── Root component ────────────────────────────────────────────────────────────
interface DecisionFeedProps {
  initialResult: DecisionEngineResult | null;
}

export default function DecisionFeed({ initialResult }: DecisionFeedProps) {
  const [result, setResult] = useState<DecisionEngineResult | null>(initialResult);
  const inflightRef = useRef(false);

  useEffect(() => {
    let active = true;

    const fetchData = (): void => {
      if (document.hidden || inflightRef.current) return;
      inflightRef.current = true;
      fetch("/api/decision-engine")
        .then((res) =>
          res.ok
            ? (res.json() as Promise<DecisionEngineResult>)
            : Promise.reject(new Error("Decision engine request failed"))
        )
        .then((next) => {
          inflightRef.current = false;
          if (active) setResult(next);
        })
        .catch(() => {
          inflightRef.current = false;
        });
    };

    // Interval ids — start with a fast retry (30s) if we have no data, normal poll (5min) otherwise.
    // After a successful fetch, the component re-renders but this effect's closure keeps the old
    // interval. That's fine: if we get data quickly (warm DB), one extra 30s tick is harmless.
    const RETRY_INTERVAL_MS = 30_000;
    const intervalMs = initialResult === null ? RETRY_INTERVAL_MS : POLL_INTERVAL_MS;

    // If SSR couldn't load data (DB cold/unavailable), fetch immediately on mount.
    if (initialResult === null) fetchData();

    const id = setInterval(fetchData, intervalMs);
    const onVisibility = (): void => { if (!document.hidden) fetchData(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      active = false;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  // initialResult is only used on mount to decide whether to trigger an immediate fetch.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (result === null) {
    return (
      <>
        <LoadingState />
        <section className="de-feed">
          <div className="de-feed-head">
            <h2>Target <span className="g">Solutions</span></h2>
            <span className="de-feed-meta">connecting…</span>
          </div>
        </section>
      </>
    );
  }

  const { recommendations, disclaimer } = result;

  return (
    <>
      <UniverseStrip result={result} />

      <Disclaimer text={disclaimer} />

      <section className="de-feed">
        <div className="de-feed-head">
          <h2>
            Target <span className="g">Solutions</span>
          </h2>
          <span className="de-feed-meta">
            {recommendations.length === 0
              ? "no signals"
              : `${recommendations.length} ranked by edge × confidence × depth`}
          </span>
        </div>

        {recommendations.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="de-cards">
            {recommendations.map((rec, i) => (
              <RecommendationCard key={rec.conditionId} rec={rec} index={i} />
            ))}
          </div>
        )}
      </section>
    </>
  );
}
