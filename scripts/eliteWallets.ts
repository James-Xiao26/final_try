// Elite-wallet selection for the copy list — "who is actually worth copying".
//
// The leaderboard Skill Score is a fine coarse gate, but for picking the TOP few markets to mirror we
// want a stricter, more robust cut. This reads the deep, never-pruned closed_positions_archive (~1yr,
// migration 031) and keeps only wallets whose forecasting edge is BOTH strong AND consistent over time:
//   - strong      : family-collapsed, Bayesian-shrunk per-share edge (outcome − entry price) over a
//                   min sample of distinct market families — same math family as the Skill Score, so a
//                   wallet grinding one recurring series can't fake it.
//   - consistent  : that edge is POSITIVE in BOTH the first and second half of the wallet's history
//                   (median close-time split). A one-lucky-streak wallet fails this; a repeatably-right
//                   one passes. (This is the time-persistence signal from ALPHA_RESEARCH_LOG §9 — for
//                   *selecting* wallets, consistency-over-time is exactly the right practical filter.)
//
// NOTE (honesty): this is still an in-sample, survivorship-selected pool (the archive is board wallets,
// picked because they won). It is the best available *ranking* of who to copy, NOT proof of future edge
// — the forward test is the arbiter. Raw (not de-biased) edge is used on purpose: it is the actual
// per-share profit a copier captures over the entry price, and it separates wallets (de-biased edge
// collapses to ~0 for everyone — §9), so it's the right money signal for ranking.
import { CONFIG } from "./config.js";
import { isScorableMarket, marketFamilyKey } from "./metrics.js";

const K = CONFIG.EDGE_SHRINKAGE_K;

export interface ArchiveRow {
  address: string;
  market: string | null;
  avg_price: number | null;
  outcome: number | null;
  close_time: string | null;
  event_slug: string | null;
}

export interface WalletQuality {
  address: string;
  edge: number; // overall family-collapsed shrunk per-share edge
  families: number; // distinct resolved market families (sample size)
  firstHalfEdge: number;
  secondHalfEdge: number;
}

// Family-collapsed, Bayesian-shrunk per-share edge over a set of resolved positions, plus the distinct
// family count. Correlated date/number variants of one series count once (marketFamilyKey), same as the
// Skill Score. Returns { edge: 0, families: 0 } for an empty/unscorable set.
function shrunkFamilyEdge(rows: ArchiveRow[]): { edge: number; families: number } {
  const fam = new Map<string, { sum: number; n: number }>();
  for (const r of rows) {
    if (r.outcome === null || r.avg_price === null || !r.market || !isScorableMarket(r.market)) continue;
    const key = marketFamilyKey(r.market);
    const e = fam.get(key) ?? { sum: 0, n: 0 };
    e.sum += r.outcome - r.avg_price;
    e.n += 1;
    fam.set(key, e);
  }
  const familyEdges = [...fam.values()].map((e) => e.sum / e.n);
  if (familyEdges.length === 0) return { edge: 0, families: 0 };
  const total = familyEdges.reduce((a, b) => a + b, 0);
  return { edge: total / (familyEdges.length + K), families: familyEdges.length };
}

export interface RankOpts {
  minFamilies: number; // overall distinct-family floor
  minHalfFamilies: number; // per-half distinct-family floor for the consistency check
  minEdge: number; // overall shrunk-edge floor (per-share profit over entry)
}

export interface WalletEval extends Omit<WalletQuality, "address"> {
  firstHalfFamilies: number;
  secondHalfFamilies: number;
}

// The raw quality of ONE wallet's resolved positions: overall shrunk family-edge + family count, plus the
// same edge AND family count for each time-half (median close-time split) for the consistency check. No
// gating — callers apply their own thresholds via `passesGate`. Exported so the sports scout can vet
// discovered (off-leaderboard) wallets with exactly the math the board-elite ranking uses.
export function walletQuality(rows: ArchiveRow[]): WalletEval {
  const overall = shrunkFamilyEdge(rows);
  const dated = rows.filter((r) => r.close_time).sort((a, b) => Date.parse(a.close_time!) - Date.parse(b.close_time!));
  const mid = Math.floor(dated.length / 2);
  const first = shrunkFamilyEdge(dated.slice(0, mid));
  const second = shrunkFamilyEdge(dated.slice(mid));
  return { edge: overall.edge, families: overall.families, firstHalfEdge: first.edge, secondHalfEdge: second.edge, firstHalfFamilies: first.families, secondHalfFamilies: second.families };
}

// Elite gate: strong enough overall, enough sample in each half, and POSITIVE edge in both halves
// (consistency). Shared by the board ranking and the sports scout so both mean the same thing by "elite".
export function passesGate(q: WalletEval, opts: RankOpts): boolean {
  return (
    q.families >= opts.minFamilies &&
    q.edge >= opts.minEdge &&
    q.firstHalfFamilies >= opts.minHalfFamilies &&
    q.secondHalfFamilies >= opts.minHalfFamilies &&
    q.firstHalfEdge > 0 &&
    q.secondHalfEdge > 0
  );
}

// Rank wallets: keep only those clearing the sample + edge floors AND positive in BOTH time halves,
// sorted best edge first. Pure — unit-tested below.
export function rankWallets(rows: ArchiveRow[], opts: RankOpts): WalletQuality[] {
  const byWallet = new Map<string, ArchiveRow[]>();
  for (const r of rows) (byWallet.get(r.address) ?? byWallet.set(r.address, []).get(r.address)!).push(r);

  const out: WalletQuality[] = [];
  for (const [address, wr] of byWallet) {
    const q = walletQuality(wr);
    if (passesGate(q, opts)) out.push({ address, edge: q.edge, families: q.families, firstHalfEdge: q.firstHalfEdge, secondHalfEdge: q.secondHalfEdge });
  }
  return out.sort((a, b) => b.edge - a.edge);
}

// Load the archive (paged) and return the elite wallets as address -> quality. An optional `rowFilter`
// restricts which resolved positions count toward a wallet's edge — pass an isSportsText gate to rank
// wallets purely on their SPORTS history, i.e. select the best sports bettors (see copyList.ts).
export async function loadEliteWallets(
  supabase: { from: (t: string) => any },
  opts: RankOpts,
  rowFilter?: (row: ArchiveRow) => boolean
): Promise<Map<string, WalletQuality>> {
  const rows: ArchiveRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("closed_positions_archive")
      .select("address, market, avg_price, outcome, close_time, event_slug")
      .not("outcome", "is", null)
      .range(from, from + 999);
    if (error) throw error;
    const batch = (data ?? []) as ArchiveRow[];
    rows.push(...batch);
    if (batch.length < 1000) break;
  }
  const scoped = rowFilter ? rows.filter(rowFilter) : rows;
  const map = new Map<string, WalletQuality>();
  for (const w of rankWallets(scoped, opts)) map.set(w.address, w);
  return map;
}
