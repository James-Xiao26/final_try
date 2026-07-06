import type { CrowdMarketDetail, CrowdParticipant } from "./types";

// Read-time analytics for a single market (one binary condition_id). Pure functions only — the
// supabase reader assembles the raw rows (price history, tracked fills, crowd participants) and these
// derive every chart/metric the Market Analytics page renders. Kept side-effect-free and unit-tested,
// mirroring the marketCrowd.ts pattern.

// ── Price series ────────────────────────────────────────────────────────────────

export interface PricePoint {
  ts: string;    // ISO timestamp (intraday) or "YYYY-MM-DD"
  price: number; // YES probability in [0,1]
}

export interface PriceSeries {
  points: PricePoint[]; // intraday line points, sorted ascending by ts
  latest: number | null;
  first: number | null;
  changeAbs: number | null;   // latest − first, in probability points
  change24h: number | null;   // last day-over-day move
  change7d: number | null;
  min: number | null;
  max: number | null;
  // Daily realized volatility: stdev of day-over-day price changes (probability points). A rough
  // "how jumpy is this market" gauge — higher means the consensus is unsettled.
  volatility: number | null;
}

function dayOf(ts: string): string {
  return ts.slice(0, "YYYY-MM-DD".length);
}

function stdev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

// Keep the raw (intraday) price points for an accurate line, sorted ascending, and derive the headline
// stats from a day-over-day collapse (so "24h drift" / "daily swing" stay daily, while the chart line
// itself captures every intraday move).
export function buildPriceSeries(rows: PricePoint[]): PriceSeries {
  const points = rows
    .filter((r) => typeof r.price === "number" && !Number.isNaN(r.price))
    .slice()
    .sort((a, b) => a.ts.localeCompare(b.ts));

  if (points.length === 0) {
    return {
      points: [],
      latest: null,
      first: null,
      changeAbs: null,
      change24h: null,
      change7d: null,
      min: null,
      max: null,
      volatility: null,
    };
  }

  const allPrices = points.map((p) => p.price);
  const latest = allPrices[allPrices.length - 1] ?? null; // most recent intraday price
  const first = allPrices[0] ?? null;
  const min = Math.min(...allPrices);
  const max = Math.max(...allPrices);

  // Daily closes (last point of each UTC day) for the day-over-day stats.
  const byDay = new Map<string, number>();
  for (const p of points) byDay.set(dayOf(p.ts), p.price);
  const dailyPoints = [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([ts, price]) => ({ ts, price }));

  const deltas: number[] = [];
  for (let i = 1; i < dailyPoints.length; i += 1) {
    deltas.push((dailyPoints[i]?.price ?? 0) - (dailyPoints[i - 1]?.price ?? 0));
  }
  const volatility = deltas.length ? stdev(deltas) : 0;
  const lastDelta = deltas.length ? deltas[deltas.length - 1] ?? null : null;
  const sevenAgo = dailyPoints[Math.max(0, dailyPoints.length - 8)]?.price ?? first;
  const change7d = latest !== null && sevenAgo !== null ? latest - sevenAgo : null;

  return {
    points,
    latest,
    first,
    changeAbs: latest !== null && first !== null ? latest - first : null,
    change24h: lastDelta,
    change7d,
    min,
    max,
    volatility,
  };
}

// ── Whale activity ──────────────────────────────────────────────────────────────

// One tracked fill, joined with the wallet's leaderboard identity. The reader maps wallet_trades +
// leaderboard_cache/wallets into these; outcomeIndex 0 = YES, 1 = NO.
export interface WhaleFillInput {
  address: string;
  handle: string | null;
  rank: number | null;
  skillScore: number | null;
  outcomeIndex: number | null;
  side: string | null;        // "BUY" | "SELL"
  price: number | null;
  size: number | null;
  usdcSize: number | null;
  tradedAt: string;
}

export interface WhaleTrade {
  address: string;
  handle: string | null;
  rank: number | null;
  skillScore: number | null;
  side: "BUY" | "SELL";
  outcome: "YES" | "NO" | "—";
  outcomeIndex: number | null;
  price: number | null;     // the traded outcome's price (what the wallet paid, for display)
  yesPrice: number | null;  // YES-equivalent price for chart placement (NO → 1 − price)
  usdc: number;
  tradedAt: string;
  ts: number; // epoch ms, for chart placement
}

export interface WhaleActivity {
  trades: WhaleTrade[];     // notable fills, largest first
  buyUsd: number;           // total YES-equivalent conviction inflow
  sellUsd: number;
  netUsd: number;           // buyUsd − sellUsd
  yesBuyUsd: number;
  noBuyUsd: number;
  biggest: WhaleTrade | null;
  count: number;
}

function usdcOf(f: { usdcSize: number | null; price: number | null; size: number | null }): number {
  if (f.usdcSize !== null) return Math.abs(f.usdcSize);
  if (f.price !== null && f.size !== null) return Math.abs(f.price * f.size);
  return 0;
}

function sideOf(side: string | null): "BUY" | "SELL" {
  return (side ?? "").toUpperCase() === "SELL" ? "SELL" : "BUY";
}

function outcomeOf(index: number | null): "YES" | "NO" | "—" {
  if (index === 0) return "YES";
  if (index === 1) return "NO";
  return "—";
}

// Flag the notable fills: any fill at/above `minUsd`, but always keep at least the `topN` largest so a
// quiet market still surfaces its biggest moves. Returns them largest-first plus directional totals.
export function detectWhaleTrades(
  fills: WhaleFillInput[],
  opts: { minUsd?: number; topN?: number; limit?: number } = {}
): WhaleActivity {
  const minUsd = opts.minUsd ?? 1000;
  const topN = opts.topN ?? 8;
  const limit = opts.limit ?? 25;

  const annotated: WhaleTrade[] = fills.map((f) => ({
    address: f.address,
    handle: f.handle,
    rank: f.rank,
    skillScore: f.skillScore,
    side: sideOf(f.side),
    outcome: outcomeOf(f.outcomeIndex),
    outcomeIndex: f.outcomeIndex,
    price: f.price,
    // On a YES-probability chart a NO fill sits at its complement (a NO buy at 47¢ is YES 53¢).
    yesPrice: f.price === null ? null : f.outcomeIndex === 1 ? 1 - f.price : f.price,
    usdc: usdcOf(f),
    tradedAt: f.tradedAt,
    ts: Date.parse(f.tradedAt)
  }));

  let buyUsd = 0;
  let sellUsd = 0;
  let yesBuyUsd = 0;
  let noBuyUsd = 0;
  for (const t of annotated) {
    if (t.side === "BUY") {
      buyUsd += t.usdc;
      if (t.outcome === "YES") yesBuyUsd += t.usdc;
      else if (t.outcome === "NO") noBuyUsd += t.usdc;
    } else {
      sellUsd += t.usdc;
    }
  }

  const bySize = [...annotated].sort((a, b) => b.usdc - a.usdc);
  const notable = bySize.filter((t, i) => t.usdc >= minUsd || i < topN).slice(0, limit);

  return {
    trades: notable,
    buyUsd,
    sellUsd,
    netUsd: buyUsd - sellUsd,
    yesBuyUsd,
    noBuyUsd,
    biggest: bySize[0] ?? null,
    count: annotated.length
  };
}

function compactUsd(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${Math.round(n)}`;
}

function whaleName(t: WhaleTrade): string {
  if (t.handle) return t.handle;
  if (t.rank !== null) return `a rank-#${t.rank} wallet`;
  return "a tracked wallet";
}

function shortDay(ts: string): string {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const d = new Date(`${ts.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return "";
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

// One- or two-sentence plain-language readout of the smart-money flow, for the whale panel. Degrades
// to a "no notable moves" line when the market has no tracked fills.
export function summarizeWhaleMoves(activity: WhaleActivity): string {
  if (activity.trades.length === 0) {
    return "No tracked whale trades in this market yet.";
  }
  const net = activity.netUsd;
  const dir = net >= 0 ? "net buying" : "net selling";
  const lean = activity.yesBuyUsd >= activity.noBuyUsd ? "YES" : "NO";
  const flow = `Tracked smart money is ${dir} (${compactUsd(Math.abs(net))} net), leaning ${lean}.`;

  const b = activity.biggest;
  if (!b) return flow;
  const priceTxt = b.price !== null ? ` at ${Math.round(b.price * 100)}¢` : "";
  const dayTxt = shortDay(b.tradedAt);
  const biggest = ` Largest single move: ${whaleName(b)} ${b.side === "BUY" ? "bought" : "sold"} ${compactUsd(
    b.usdc
  )} ${b.outcome}${priceTxt}${dayTxt ? ` on ${dayTxt}` : ""}.`;
  return flow + biggest;
}

// ── Holder concentration ────────────────────────────────────────────────────────

export interface HolderSlice {
  address: string;
  handle: string | null;
  rank: number | null;
  side: "YES" | "NO" | "—";
  committed: number; // USD cost basis
  share: number;     // fraction of total committed
}

export interface Concentration {
  holders: HolderSlice[]; // descending by committed (top holders)
  total: number;
  top1Share: number;
  top5Share: number;
  hhi: number;            // Herfindahl index (Σ share²): 1 = one wallet, ~0 = perfectly spread
  count: number;
}

export function committedOf(p: CrowdParticipant): number {
  if (p.avgEntry !== null && p.size > 0) return p.avgEntry * p.size;
  if (p.value !== null) return Math.abs(p.value);
  return 0;
}

// Rank participants by committed capital and measure how lopsided the book is (top-1 / top-5 share,
// HHI). Surfaces "is this a few big convictions or a broad crowd?".
export function concentration(participants: CrowdParticipant[]): Concentration {
  const sized = participants
    .map((p) => ({
      address: p.address,
      handle: p.handle,
      rank: p.rank,
      side: p.side,
      committed: committedOf(p)
    }))
    .filter((h) => h.committed > 0)
    .sort((a, b) => b.committed - a.committed);

  const total = sized.reduce((a, h) => a + h.committed, 0);
  const holders: HolderSlice[] = sized.map((h) => ({ ...h, share: total > 0 ? h.committed / total : 0 }));
  const top1Share = holders[0]?.share ?? 0;
  const top5Share = holders.slice(0, 5).reduce((a, h) => a + h.share, 0);
  const hhi = holders.reduce((a, h) => a + h.share ** 2, 0);

  return { holders, total, top1Share, top5Share, hhi, count: holders.length };
}

// ── Participant P/L distribution ────────────────────────────────────────────────

export interface PnlBucket {
  label: string;
  count: number;
  from: number; // inclusive lower bound (USD)
  to: number;   // exclusive upper bound (USD)
}

export interface PnlDistribution {
  buckets: PnlBucket[];
  winners: number;
  losers: number;
  flat: number;
  winRate: number | null; // winners / (winners + losers)
  totalPnl: number;
  avgPnl: number | null;
  best: number | null;
  worst: number | null;
  sampled: number;        // participants with a known P/L
}

// Bucket participant P/L into fixed semantic bands (big loss → big gain). Threshold defaults treat
// |P/L| < $100 as "flat". Gives the user-level "who's winning here, and by how much" histogram.
export function pnlDistribution(participants: CrowdParticipant[], flatBand = 100): PnlDistribution {
  const pnls = participants.map((p) => p.pnl).filter((v): v is number => v !== null);
  const buckets: PnlBucket[] = [
    { label: "≤ −$5K", count: 0, from: -Infinity, to: -5000 },
    { label: "−$5K…−$1K", count: 0, from: -5000, to: -1000 },
    { label: "−$1K…−$100", count: 0, from: -1000, to: -flatBand },
    { label: "≈ flat", count: 0, from: -flatBand, to: flatBand },
    { label: "$100…$1K", count: 0, from: flatBand, to: 1000 },
    { label: "$1K…$5K", count: 0, from: 1000, to: 5000 },
    { label: "≥ $5K", count: 0, from: 5000, to: Infinity }
  ];

  let winners = 0;
  let losers = 0;
  let flat = 0;
  let totalPnl = 0;
  for (const v of pnls) {
    totalPnl += v;
    if (v > flatBand) winners += 1;
    else if (v < -flatBand) losers += 1;
    else flat += 1;
    const bucket = buckets.find((b) => v >= b.from && v < b.to);
    if (bucket) bucket.count += 1;
  }

  const decided = winners + losers;
  return {
    buckets,
    winners,
    losers,
    flat,
    winRate: decided > 0 ? winners / decided : null,
    totalPnl,
    avgPnl: pnls.length ? totalPnl / pnls.length : null,
    best: pnls.length ? Math.max(...pnls) : null,
    worst: pnls.length ? Math.min(...pnls) : null,
    sampled: pnls.length
  };
}

// ── Smart-money lean ─────────────────────────────────────────────────────────────

export interface SmartMoneyLean {
  yesWeight: number;
  noWeight: number;
  yesPct: number | null;   // skill-weighted YES share of conviction
  label: "YES" | "NO" | "SPLIT";
  // Capital-weighted (cost-basis) version for comparison with the headcount split.
  yesCapital: number;
  noCapital: number;
}

// Weight each participant's side by skill score (a proven-edge wallet's lean counts more than a
// marginal one), and separately by committed capital. Answers "where is the *sharp* money?".
export function smartMoneyLean(participants: CrowdParticipant[], baseWeight = 1): SmartMoneyLean {
  let yesWeight = 0;
  let noWeight = 0;
  let yesCapital = 0;
  let noCapital = 0;
  for (const p of participants) {
    const w = baseWeight + Math.max(0, p.skillScore ?? 0);
    const cap = committedOf(p);
    if (p.outcomeIndex === 0) {
      yesWeight += w;
      yesCapital += cap;
    } else if (p.outcomeIndex === 1) {
      noWeight += w;
      noCapital += cap;
    }
  }
  const totalW = yesWeight + noWeight;
  const yesPct = totalW > 0 ? yesWeight / totalW : null;
  let label: "YES" | "NO" | "SPLIT" = "SPLIT";
  if (yesWeight > noWeight) label = "YES";
  else if (noWeight > yesWeight) label = "NO";
  return { yesWeight, noWeight, yesPct, label, yesCapital, noCapital };
}

// ── Market resolution ───────────────────────────────────────────────────────────

export interface MarketResolution {
  winnerIndex: number;   // 0 = YES, 1 = NO (or the leading candidate index)
  winnerLabel: string;   // human label, e.g. "Yes" / "Hurricanes"
  winnerSide: "YES" | "NO" | "—";
}

// Decode the resolved outcome of a closed market. Prefers explicit `outcomePrices` (a winner settles
// at ~1, losers at 0); falls back to the settled YES price (`latestYes`) for the common case where the
// cached `markets` row carries no outcome prices but the price series already shows the binary settling
// at ~1 (YES won) or ~0 (NO won). Returns null for open or ambiguous/void resolutions.
export function marketResolution(meta: MarketMeta | null, latestYes?: number | null): MarketResolution | null {
  if (!meta || !meta.closed) return null;
  const label = (i: number): string => meta.outcomes?.[i] ?? (i === 0 ? "Yes" : i === 1 ? "No" : `Outcome ${i}`);

  const prices = meta.outcomePrices;
  if (prices && prices.length > 0) {
    let winnerIndex = -1;
    let best = 0.5;
    prices.forEach((p, i) => {
      if (typeof p === "number" && p > best) {
        best = p;
        winnerIndex = i;
      }
    });
    if (winnerIndex >= 0) {
      const winnerSide = winnerIndex === 0 ? "YES" : winnerIndex === 1 ? "NO" : "—";
      return { winnerIndex, winnerLabel: label(winnerIndex), winnerSide };
    }
  }

  // Fallback: infer the binary winner from where the YES price settled.
  if (typeof latestYes === "number") {
    if (latestYes >= 0.98) return { winnerIndex: 0, winnerLabel: label(0), winnerSide: "YES" };
    if (latestYes <= 0.02) return { winnerIndex: 1, winnerLabel: label(1), winnerSide: "NO" };
  }
  return null;
}

// ── Side payout ranking ─────────────────────────────────────────────────────────

// One holder currently in the market, on one side, with the $ they'd be paid if that side wins.
// payout = shares held (each winning share settles at $1) = cost / entry price, so this is inherently
// "based on their payout using their entry price".
export interface SidePayoutHolder {
  address: string;
  handle: string | null;
  rank: number | null;
  payout: number; // shares held = USD payout if this side wins
}

export interface SidePayouts {
  yes: SidePayoutHolder[]; // top holders on YES, descending by payout
  no: SidePayoutHolder[];  // top holders on NO, descending by payout
  yesTotal: number;        // total payout-if-wins committed across all YES holders
  noTotal: number;
  max: number;             // largest single-holder payout across both sides (bar scaling)
}

interface RawHolder {
  address: string;
  handle: string | null;
  rank: number | null;
  side: "YES" | "NO";
  payout: number;
}

function rankSides(holders: RawHolder[], topN: number): SidePayouts {
  const bySide = (side: "YES" | "NO"): RawHolder[] =>
    holders.filter((h) => h.side === side && h.payout > 0).sort((a, b) => b.payout - a.payout);
  const yes = bySide("YES");
  const no = bySide("NO");
  return {
    yes: yes.slice(0, topN),
    no: no.slice(0, topN),
    yesTotal: yes.reduce((a, h) => a + h.payout, 0),
    noTotal: no.reduce((a, h) => a + h.payout, 0),
    max: Math.max(0, ...[...yes, ...no].map((h) => h.payout))
  };
}

// Rank the currently-open holders on each side by their payout-if-their-side-wins. Uses the
// authoritative open-position size. This is "who is holding right now" — for a resolved market use
// sidePayoutsAt instead (there are no open positions left).
export function sidePayouts(participants: CrowdParticipant[], topN = 8): SidePayouts {
  const holders = participants
    .filter((p) => p.state === "open" && p.size > 0 && (p.side === "YES" || p.side === "NO"))
    .map((p) => ({ address: p.address, handle: p.handle, rank: p.rank, side: p.side as "YES" | "NO", payout: p.size }));
  return rankSides(holders, topN);
}

// Reconstruct each wallet's net holdings on each side as of `cutoffMs`, from its tracked fills (BUY
// adds shares, SELL removes). For a resolved market, pass (resolution time − 24h) to answer "who was
// holding a day before it settled". payout = net shares held = $1/share at resolution.
export function sidePayoutsAt(participants: CrowdParticipant[], cutoffMs: number, topN = 8): SidePayouts {
  const holders: RawHolder[] = [];
  for (const p of participants) {
    let yesNet = 0;
    let noNet = 0;
    for (const f of p.fills) {
      if (Date.parse(f.tradedAt) > cutoffMs) continue; // only fills up to the cutoff
      const signed = (f.side ?? "").toUpperCase() === "SELL" ? -(f.size ?? 0) : f.size ?? 0;
      if (f.outcomeIndex === 0) yesNet += signed;
      else if (f.outcomeIndex === 1) noNet += signed;
    }
    const ident = { address: p.address, handle: p.handle, rank: p.rank };
    if (yesNet > 0) holders.push({ ...ident, side: "YES", payout: yesNet });
    if (noNet > 0) holders.push({ ...ident, side: "NO", payout: noNet });
  }
  return rankSides(holders, topN);
}

// ── Multi-outcome candidates ──────────────────────────────────────────────────────

interface RawEventMarket {
  groupItemTitle?: unknown;
  conditionId?: unknown;
  clobTokenIds?: unknown; // JSON-string array [yesToken, noToken]
  outcomePrices?: unknown; // JSON-string array
  lastTradePrice?: unknown;
}

export interface EventCandidate {
  label: string;
  conditionId: string;
  yesTokenId: string;
  price: number; // current implied YES probability
}

// Gamma encodes several array fields as JSON strings (outcomePrices, clobTokenIds, …). Tolerate both
// the already-parsed array and the string form.
export function parseJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const p = JSON.parse(value);
      return Array.isArray(p) ? p : [];
    } catch {
      return [];
    }
  }
  return [];
}

// Pure: roll an event's candidate markets into ranked EventCandidates (favored first). Each candidate
// is a binary market with a groupItemTitle and a YES (outcome-0) token. Returns [] when the event isn't
// a multi-candidate group (0/1 candidates).
export function parseEventCandidates(eventMarkets: RawEventMarket[]): EventCandidate[] {
  const out: EventCandidate[] = [];
  for (const m of eventMarkets) {
    const label = typeof m.groupItemTitle === "string" && m.groupItemTitle.length > 0 ? m.groupItemTitle : null;
    const conditionId = typeof m.conditionId === "string" && m.conditionId.length > 0 ? m.conditionId : null;
    const yesTokenId = parseJsonArray(m.clobTokenIds).map(String)[0] ?? null;
    if (!label || !conditionId || !yesTokenId) continue;
    const prices = parseJsonArray(m.outcomePrices)
      .map((x) => Number(x))
      .filter((x) => Number.isFinite(x));
    const last = typeof m.lastTradePrice === "number" ? m.lastTradePrice : null;
    const price = prices[0] ?? last ?? 0;
    out.push({ label, conditionId, yesTokenId, price });
  }
  if (out.length <= 1) return [];
  return out.sort((a, b) => b.price - a.price);
}

// ── Page-level aggregate ─────────────────────────────────────────────────────────

// Market-level snapshot from the `markets` table (one grouped Polymarket event). Present even when no
// leaderboard wallet has touched the market; `detail` is what's null in that case.
export interface MarketMeta {
  question: string;
  slug: string | null;
  category: string | null;
  image: string | null;
  endDate: string | null;
  liquidityUsd: number;
  volumeUsd: number;
  volume24hrUsd: number;
  volume1wkUsd: number;
  spread: number | null;
  lastTradePrice: number | null;
  topOutcome: string | null;
  oneDayPriceChange: number | null;
  outcomes: string[] | null;
  outcomePrices: number[] | null;
  active: boolean;
  closed: boolean;
}

// Everything the Market Analytics page needs, assembled by the supabase reader. `detail` (leaderboard
// participation) and `meta` (the markets-table row) are independently nullable so the page degrades
// gracefully: a market with smart-money flow but no markets row, or a listed market with no tracked
// wallets, both still render what they can. The page runs the pure derivations above over `priceRows`
// and `whaleFills`.
// One selectable sibling market in a grouped event (for the market-switch dropdown).
export interface EventMarketOption {
  label: string;       // candidate name, e.g. "Spain"
  conditionId: string; // its own market page
}

export interface MarketAnalytics {
  conditionId: string;
  meta: MarketMeta | null;
  detail: CrowdMarketDetail | null;
  priceRows: PricePoint[];
  whaleFills: WhaleFillInput[];
  // For a grouped event (e.g. "World Cup Winner"): the sibling candidate markets, so the page can offer
  // a dropdown to switch between them. Empty for a plain standalone Yes/No market.
  eventMarkets: EventMarketOption[];
}
