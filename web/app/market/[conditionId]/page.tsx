import Link from "next/link";
import { Suspense } from "react";
import { ExternalLink } from "lucide-react";
import PassedMarketName from "@/components/PassedMarketName";
import CrowdParticipants from "@/components/CrowdParticipants";
import PriceChart from "@/components/PriceChart";
import WhaleFeed from "@/components/WhaleFeed";
import TopHoldersChart from "@/components/TopHoldersChart";
import EventMarketPicker from "@/components/EventMarketPicker";
import AutoRefresh from "@/components/AutoRefresh";
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
  topHoldersAt,
  topHoldersFromBook,
  smartMoneyLean,
  summarizeWhaleMoves
} from "@/lib/marketAnalytics";
import type { CrowdParticipant } from "@/lib/types";
import type { MarketMeta } from "@/lib/marketAnalytics";

const DAY_MS = 86_400_000;

// For a resolved market, the timestamp 24h before it settled — prefer the market's end date, else fall
// back to 24h before the last tracked fill in it.
function resolutionCutoffMs(meta: MarketMeta | null, participants: CrowdParticipant[]): number {
  const endMs = meta?.endDate ? Date.parse(meta.endDate) : NaN;
  if (Number.isFinite(endMs)) return endMs - DAY_MS;
  let last = 0;
  for (const p of participants) for (const f of p.fills) last = Math.max(last, Date.parse(f.tradedAt));
  return (last || Date.now()) - DAY_MS;
}

export const revalidate = 300;

interface MarketPageProps {
  params: { conditionId: string };
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
  // Budget is 8s, not 3s: a market outside the cached index needs a live multi-call Polymarket fetch
  // (Gamma meta + CLOB price history) that routinely exceeds 3s on the first hit, which surfaced the
  // misleading "Market not tracked" panel on real markets. The result is cached (revalidate=300) so
  // only the cold first view pays it. The DB path — the original reason for the cap — stays fast.
  let analytics: Awaited<ReturnType<typeof getMarketAnalytics>> | null = null;
  try {
    analytics = await withTimeout(getMarketAnalytics(conditionId), 8000, null);
  } catch {
    analytics = null;
  }

  if (!analytics || (!analytics.meta && !analytics.detail)) {
    // analytics === null means the lookup hit the time budget (or errored) before finishing — the data
    // very likely exists and a refresh will catch the now-cached result. A non-null analytics with no
    // meta/detail means the live Polymarket lookup genuinely returned nothing. We can't tell these apart
    // before the wait (the live lookup IS the slow step), only after — so the messaging splits here.
    const timedOut = analytics === null;
    return (
      <main className="page">
        {timedOut ? <AutoRefresh /> : null}
        <Link href="/markets" className="wl-back">← Back to Markets</Link>
        <section className="panel" style={{ marginTop: 16, padding: 28 }}>
          <h1 className="brand">{timedOut ? "Still loading this market…" : "Market analytics unavailable"}</h1>
          <Suspense fallback={null}>
            <PassedMarketName />
          </Suspense>
          <p className="subtitle">
            {timedOut
              ? "This market isn’t in our cache yet, so we’re fetching it live from Polymarket — this page will refresh itself automatically in a moment."
              : "We couldn’t pull a snapshot for this market and no tracked wallet currently holds a position in it."}
          </p>
          <a className="ma-ext" href="https://polymarket.com" target="_blank" rel="noopener noreferrer">
            View on Polymarket <ExternalLink size={12} />
          </a>
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

  // Top holders by dollar amount (single combined chart). Live market: the whole current book from
  // /holders, valued at the live price. Resolved market: reconstruct the tracked wallets' net amount bet
  // 24h before it settled. Fallback (live but empty book): tracked wallets' current net cost.
  const allHolders = !meta?.closed && analytics.holders.length > 0;
  const holders = meta?.closed
    ? topHoldersAt(participants, resolutionCutoffMs(meta, participants))
    : allHolders
      ? topHoldersFromBook(analytics.holders, currentPrice)
      : topHoldersAt(participants, Date.now());
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
            {analytics.eventMarkets.length > 1 ? (
              <EventMarketPicker markets={analytics.eventMarkets} current={conditionId} />
            ) : null}
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
            <span className="ma-leg price">YES price</span>
            <span className="ma-leg buy">Whale buy</span>
            <span className="ma-leg sell">Whale sell</span>
          </div>
        </div>
        <PriceChart series={series} whales={whales.trades} />
        <p className="ma-caption">
          YES implied probability over time (intraday resolution) for this market, with tracked whale
          trades overlaid at their YES-equivalent price so buys/sells sit on the line (marker size ∝ trade value).
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
          <div className="ma-section-head">
            <h2>Top <span className="g">Holders</span></h2>
            <div className="ma-legend">
              <span className="ma-leg th-yes">YES</span>
              <span className="ma-leg th-no">NO</span>
            </div>
          </div>
          <TopHoldersChart data={holders} />
          <p className="ma-caption">
            The biggest {allHolders ? "holders" : "tracked holders"} on this market, ranked by dollar amount and colored by
            the side they’re on{meta?.closed ? ", as of 24h before it resolved" : ""}.{" "}
            {allHolders
              ? "Amounts are each holder’s stake valued at the current price."
              : "Amounts are each wallet’s cost basis (what they bet)."}{" "}
            YES {formatCompactUsd(holders.yesTotal)} vs NO {formatCompactUsd(holders.noTotal)} across the top holders shown.
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
