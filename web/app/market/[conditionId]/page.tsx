import Link from "next/link";
import { ExternalLink } from "lucide-react";
import ConvergenceChart from "@/components/ConvergenceChart";
import CrowdParticipants from "@/components/CrowdParticipants";
import PriceChart from "@/components/PriceChart";
import WhaleFeed from "@/components/WhaleFeed";
import ConcentrationChart from "@/components/ConcentrationChart";
import PnlHistogram from "@/components/PnlHistogram";
import MetricCard from "@/components/MetricCard";
import { formatCompactUsd } from "@/lib/format";
import { getMarketAnalytics, withTimeout } from "@/lib/supabase";
import {
  buildPriceSeries,
  concentration,
  detectWhaleTrades,
  marketResolution,
  pnlDistribution,
  PRICE_LINE_COLORS,
  smartMoneyLean,
  summarizeWhaleMoves
} from "@/lib/marketAnalytics";
import type { CSSProperties } from "react";

export const dynamic = "force-dynamic";

interface MarketPageProps {
  params: { conditionId: string };
}

// Sets the legend swatch color via a CSS variable the `.ma-leg::before` reads.
function legColor(color: string): CSSProperties {
  return { ["--leg-color" as string]: color } as CSSProperties;
}

function cents(v: number | null): string {
  return v === null ? "—" : `${(v * 100).toFixed(1)}¢`;
}

function signedCents(v: number | null): string {
  if (v === null) return "—";
  const c = v * 100;
  return `${c > 0 ? "+" : ""}${c.toFixed(1)}¢`;
}

function resolutionLabel(iso: string | null): string {
  if (!iso) return "open-ended";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "open-ended";
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

// A two-toned consensus bar comparing a YES vs NO magnitude (headcount, capital, or skill weight).
function LeanBar({ label, yes, no, hint }: { label: string; yes: number; no: number; hint: string }) {
  const total = Math.max(1e-9, yes + no);
  const yesPct = Math.round((yes / total) * 100);
  return (
    <div className="ma-lean-row">
      <div className="ma-lean-head">
        <span className="ma-lean-lbl">{label}</span>
        <span className="ma-lean-split"><span className="yes">{yesPct}%</span> / <span className="no">{100 - yesPct}%</span></span>
      </div>
      <div className="ma-lean-bar">
        <span className="yes" style={{ width: `${yesPct}%` }} />
        <span className="no" style={{ width: `${100 - yesPct}%` }} />
      </div>
      <div className="ma-lean-hint muted">{hint}</div>
    </div>
  );
}

export default async function MarketPage({ params }: MarketPageProps) {
  const conditionId = decodeURIComponent(params.conditionId);

  // getMarketAnalytics reads Supabase and falls back to the live Polymarket API; either can fail
  // (DB cold-start 57014, an upstream timeout). Catch it so the page degrades to a friendly panel
  // instead of throwing a server-side exception.
  let analytics: Awaited<ReturnType<typeof getMarketAnalytics>> | null = null;
  try {
    analytics = await withTimeout(getMarketAnalytics(conditionId), 9000, null);
  } catch {
    analytics = null;
  }

  if (!analytics || (!analytics.meta && !analytics.detail)) {
    return (
      <main className="page">
        <Link href="/markets" className="wl-back">← Back to Markets</Link>
        <section className="panel" style={{ marginTop: 16, padding: 28 }}>
          <h1 className="brand">Market not tracked</h1>
          <p className="subtitle">We have no data on this market — it isn’t in the markets index and no tracked wallet holds a position in it.</p>
        </section>
      </main>
    );
  }

  const { meta, detail } = analytics;

  const title = meta?.question ?? detail?.market ?? "Untitled market";
  const series = buildPriceSeries(analytics.priceRows);
  const whales = detectWhaleTrades(analytics.whaleFills);
  const whaleSummary = summarizeWhaleMoves(whales);
  const participants = detail?.participants ?? [];
  const conc = concentration(participants);
  const pnl = pnlDistribution(participants);
  const lean = smartMoneyLean(participants);

  // Current YES price: prefer the tracked daily series, then the convergence mark, then the markets row.
  const currentPrice = series.latest ?? detail?.curPrice ?? meta?.lastTradePrice ?? null;
  const traderCount = detail?.traderCount ?? 0;
  const hasSmartMoney = traderCount > 0;

  // If the market has resolved, decode the winning side and judge whether the skill-weighted smart
  // money called it — the on-brand "did the sharp money have edge here?" readout.
  const resolution = marketResolution(meta, currentPrice);
  // Only judge the sharp money when the winner maps to a YES/NO side (binary market) and the lean
  // isn't a tie — a 3+ outcome market resolves to a non-YES/NO leg, so there's no YES/NO verdict.
  const smartCalledIt =
    resolution && hasSmartMoney && lean.label !== "SPLIT" && resolution.winnerSide !== "—"
      ? lean.label === resolution.winnerSide
      : null;

  return (
    <main className="page ma-page">
      <Link href="/markets" className="wl-back">← Back to Markets</Link>

      {/* ── Header ─────────────────────────────────────────────── */}
      <section className="panel ma-head">
        <div className="ma-head-top">
          {meta?.image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img className="ma-head-img" src={meta.image} alt="" />
          ) : null}
          <div className="ma-head-text">
            <div className="ma-head-tags">
              {meta?.category ? <span className="ma-tag">{meta.category}</span> : null}
              <span className={`ma-tag ${meta?.closed ? "closed" : "live"}`}>{meta?.closed ? "Resolved" : "Live"}</span>
              {!meta?.closed ? <span className="ma-tag muted">Resolves {resolutionLabel(meta?.endDate ?? null)}</span> : null}
            </div>
            <h1 className="ma-title">{title}</h1>
            {meta?.slug ? (
              <a className="ma-ext" href={`https://polymarket.com/event/${meta.slug}`} target="_blank" rel="noopener noreferrer">
                View on Polymarket <ExternalLink size={12} />
              </a>
            ) : null}
          </div>
        </div>
        {resolution ? (
          <div className={`ma-resolution ${resolution.winnerSide === "YES" ? "yes" : resolution.winnerSide === "NO" ? "no" : ""}`}>
            <span className="ma-res-badge">Resolved</span>
            <span className="ma-res-outcome">{resolution.winnerLabel} won</span>
            {smartCalledIt !== null ? (
              <span className={`ma-res-verdict ${smartCalledIt ? "right" : "wrong"}`}>
                {smartCalledIt ? "Sharp money called it ✓" : "Sharp money missed ✗"}
              </span>
            ) : null}
          </div>
        ) : null}
      </section>

      {/* ── Headline metrics ──────────────────────────────────── */}
      <section className="ma-metrics">
        <MetricCard label="YES Price" value={cents(currentPrice)} sub="implied probability" tone="neutral" />
        <MetricCard
          label="24h Drift"
          value={signedCents(series.change24h)}
          sub="day-over-day"
          tone={series.change24h === null ? "neutral" : series.change24h >= 0 ? "pos" : "neg"}
        />
        <MetricCard
          label="Volatility"
          value={series.volatility === null ? "—" : `${(series.volatility * 100).toFixed(1)}¢`}
          sub="daily price swing (σ)"
          tone="neutral"
          title="Standard deviation of day-over-day YES price moves"
        />
        <MetricCard label="Liquidity" value={meta ? formatCompactUsd(meta.liquidityUsd) : "—"} sub="order-book depth" />
        <MetricCard label="24h Volume" value={meta ? formatCompactUsd(meta.volume24hrUsd) : "—"} sub="traded last day" />
        <MetricCard
          label="Smart $ Net"
          value={hasSmartMoney ? formatCompactUsd(whales.netUsd) : "—"}
          sub="tracked buy − sell"
          tone={!hasSmartMoney ? "neutral" : whales.netUsd >= 0 ? "pos" : "neg"}
        />
        <MetricCard label="Tracked Wallets" value={hasSmartMoney ? traderCount : "—"} sub={`${detail?.yesTraders ?? 0} YES · ${detail?.noTraders ?? 0} NO`} />
        <MetricCard
          label="Top Holder"
          value={conc.count > 0 ? `${(conc.top1Share * 100).toFixed(0)}%` : "—"}
          sub="of tracked capital"
          title="Share of tracked committed capital held by the single largest wallet"
        />
      </section>

      {/* ── Price history + whale overlay ─────────────────────── */}
      <section className="panel ma-section">
        <div className="ma-section-head">
          <h2>Price <span className="g">History</span></h2>
          <div className="ma-legend">
            {analytics.extraLines.length > 0 ? (
              <>
                <span className="ma-leg" style={legColor(PRICE_LINE_COLORS[0] ?? "#36ecd0")}>{analytics.primaryLabel ?? "YES"}</span>
                {analytics.extraLines.map((l, i) => (
                  <span key={l.label} className="ma-leg" style={legColor(PRICE_LINE_COLORS[(i + 1) % PRICE_LINE_COLORS.length] ?? "#36ecd0")}>
                    {l.label}
                  </span>
                ))}
              </>
            ) : (
              <span className="ma-leg price">YES price</span>
            )}
            <span className="ma-leg buy">Whale buy</span>
            <span className="ma-leg sell">Whale sell</span>
            {series.regimeShifts.length > 0 ? <span className="ma-leg regime">Regime shift</span> : null}
          </div>
        </div>
        <PriceChart series={series} whales={whales.trades} extraLines={analytics.extraLines} />
        <p className="ma-caption">
          YES implied probability over time (intraday resolution), with tracked whale trades overlaid at
          their YES-equivalent price so buys/sells sit on the line (marker size ∝ trade value).
          {series.regimeShifts.length > 0
            ? ` ${series.regimeShifts.length} regime shift${series.regimeShifts.length === 1 ? "" : "s"} flagged — days where the consensus moved more than 2.5σ (likely news shocks).`
            : ""}
        </p>
      </section>

      {/* ── Whale activity ────────────────────────────────────── */}
      <section className="panel ma-section">
        <div className="ma-section-head">
          <h2>Whale <span className="g">Activity</span></h2>
          <span className="meta">{whales.count} tracked fill{whales.count === 1 ? "" : "s"}</span>
        </div>
        <WhaleFeed activity={whales} summary={whaleSummary} />
      </section>

      {/* ── Advanced analytics grid ───────────────────────────── */}
      <div className="ma-grid">
        <section className="panel ma-section">
          <div className="ma-section-head"><h2>Holder <span className="g">Concentration</span></h2></div>
          <ConcentrationChart data={conc} />
          <p className="ma-caption">
            How committed capital is distributed. Top-5 wallets hold {conc.count > 0 ? `${(conc.top5Share * 100).toFixed(0)}%` : "—"} of
            tracked capital (HHI {conc.count > 0 ? conc.hhi.toFixed(2) : "—"}). A high HHI means a few big convictions drive this market.
          </p>
        </section>

        <section className="panel ma-section">
          <div className="ma-section-head"><h2>Participant <span className="g">P/L</span></h2></div>
          <PnlHistogram data={pnl} />
          <p className="ma-caption">
            Distribution of tracked wallets’ P/L in this market.{" "}
            {pnl.sampled > 0
              ? `${pnl.winners} winning, ${pnl.losers} losing (win rate ${pnl.winRate === null ? "—" : `${Math.round(pnl.winRate * 100)}%`}); net ${formatCompactUsd(pnl.totalPnl)} across ${pnl.sampled} wallets.`
              : "No P/L data available."}
          </p>
        </section>

        <section className="panel ma-section">
          <div className="ma-section-head"><h2>Smart-Money <span className="g">Lean</span></h2></div>
          {hasSmartMoney ? (
            <div className="ma-lean">
              <LeanBar label="By headcount" yes={detail?.yesTraders ?? 0} no={detail?.noTraders ?? 0} hint="one wallet, one vote" />
              <LeanBar label="By capital" yes={lean.yesCapital} no={lean.noCapital} hint="weighted by committed $" />
              <LeanBar label="By skill" yes={lean.yesWeight} no={lean.noWeight} hint="weighted by skill score — where the sharpest money sits" />
            </div>
          ) : (
            <div className="ma-empty muted">No tracked wallets in this market, so there is no smart-money signal to weigh.</div>
          )}
          <p className="ma-caption">
            Three views of which side tracked traders favor. When the skill-weighted lean diverges from the headcount, the most
            proven wallets disagree with the crowd.
          </p>
        </section>

        <section className="panel ma-section">
          <div className="ma-section-head">
            <h2>Position <span className="g">Flow</span></h2>
            <div className="ma-legend">
              <span className="ma-leg buy">YES committed</span>
              <span className="ma-leg sell">NO committed</span>
            </div>
          </div>
          <ConvergenceChart timeline={detail?.timeline ?? []} />
          <p className="ma-caption">Cumulative net leaderboard cost basis on each side, reconstructed from tracked fills.</p>
        </section>
      </div>

      {/* ── Participants ledger ───────────────────────────────── */}
      {hasSmartMoney ? (
        <CrowdParticipants participants={participants} />
      ) : (
        <section className="panel ma-section">
          <div className="ma-empty muted">No tracked wallets hold a position here — user-level insights become available once a leaderboard wallet trades this market.</div>
        </section>
      )}
    </main>
  );
}
