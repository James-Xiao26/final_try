import type { CrowdLookups } from "./marketCrowd";
import type { ResolvedMarket, ResolvedParticipant } from "./types";

// Re-export the type so callers can import it from here if needed.
export type { CrowdLookups };

// Input shape — local only; the supabase reader maps its rows into this.
interface ResolvedClosedInput {
  address: string;
  conditionId: string | null;
  market: string | null;
  eventSlug: string | null;
  outcomeIndex: number | null;
  avgPrice: number;
  size: number;
  realizedPnl: number | null;
  closeTime: string | null;
  firstTradedAt: string | null;
}

// Binary outcome label: outcome 0 = YES, outcome 1 = NO.
function sideLabel(index: number | null): "YES" | "NO" | "—" {
  if (index === 0) return "YES";
  if (index === 1) return "NO";
  return "—";
}

// exitValue = avgPrice + realizedPnl / size  (undefined → null if inputs missing)
// ≈ 1 means the holder won (sold at full resolution value)
// ≈ 0 means the holder lost
// Mid-range → sold early (not a resolution confirmation)
const RESOLVE_EPSILON = 0.03;

function computeExitValue(avgPrice: number, size: number, realizedPnl: number | null): number | null {
  if (size <= 0 || realizedPnl === null) return null;
  return avgPrice + realizedPnl / size;
}

function isWon(exitValue: number): boolean {
  return exitValue >= 1 - RESOLVE_EPSILON;
}

function isLost(exitValue: number): boolean {
  return exitValue <= RESOLVE_EPSILON;
}

function isConfirmed(exitValue: number): boolean {
  return isWon(exitValue) || isLost(exitValue);
}

// Aggregate resolved markets from a flat array of closed-position rows (already board-scoped).
// Returns up to `limit` markets, sorted newest-resolved-first.
export function summarizeResolvedMarkets(
  closed: ResolvedClosedInput[],
  lookups: CrowdLookups,
  limit = 40
): ResolvedMarket[] {
  // Group rows by conditionId (skip null).
  const byCondition = new Map<string, ResolvedClosedInput[]>();
  for (const row of closed) {
    if (!row.conditionId) continue;
    let group = byCondition.get(row.conditionId);
    if (!group) {
      group = [];
      byCondition.set(row.conditionId, group);
    }
    group.push(row);
  }

  const results: ResolvedMarket[] = [];

  for (const [conditionId, rows] of byCondition) {
    // Tally winner votes: a participant with exitValue≈1 votes its own outcomeIndex;
    // one with exitValue≈0 votes 1 − outcomeIndex.
    const voteCounts = new Map<number, number>();

    for (const row of rows) {
      const ev = computeExitValue(row.avgPrice, row.size, row.realizedPnl);
      if (ev === null || !isConfirmed(ev)) continue;
      const outcomeIndex = row.outcomeIndex;
      if (outcomeIndex === null) continue;
      const vote = isWon(ev) ? outcomeIndex : 1 - outcomeIndex;
      voteCounts.set(vote, (voteCounts.get(vote) ?? 0) + 1);
    }

    // Drop markets with zero votes (unconfirmed).
    if (voteCounts.size === 0) continue;

    // winningOutcomeIndex = majority vote; tie-break by picking the higher count (already unique
    // when tied — pick the one with the higher vote count; if exactly equal, the first iterated).
    let winningOutcomeIndex = 0;
    let bestCount = -1;
    for (const [outcome, count] of voteCounts) {
      if (count > bestCount) {
        bestCount = count;
        winningOutcomeIndex = outcome;
      }
    }

    const winningSide = sideLabel(winningOutcomeIndex);
    const market = rows.find((r) => r.market !== null)?.market ?? null;
    const eventSlug = rows.find((r) => r.eventSlug)?.eventSlug ?? null;

    // Build per-participant rows. Every row gets won = (outcomeIndex === winningOutcomeIndex).
    const participants: ResolvedParticipant[] = [];
    let winners = 0;
    let losers = 0;
    let totalRealizedPnl = 0;
    let resolvedAtMs = -Infinity;

    for (const row of rows) {
      // Only include wallets currently on the leaderboard.
      if (!lookups.rankByAddress.has(row.address)) continue;

      const won = row.outcomeIndex === winningOutcomeIndex;
      if (won) winners += 1;
      else losers += 1;

      const pnl = row.realizedPnl;
      if (pnl !== null) totalRealizedPnl += pnl;

      const basis = row.avgPrice * row.size;
      const realizedPct = pnl !== null && basis > 0 ? pnl / basis : null;

      const closeMs = row.closeTime ? Date.parse(row.closeTime) : NaN;
      if (Number.isFinite(closeMs) && closeMs > resolvedAtMs) {
        resolvedAtMs = closeMs;
      }

      participants.push({
        address: row.address,
        handle: lookups.handleByAddress.get(row.address) ?? null,
        rank: lookups.rankByAddress.get(row.address) ?? null,
        skillScore: lookups.skillByAddress.get(row.address) ?? null,
        outcomeIndex: row.outcomeIndex,
        side: sideLabel(row.outcomeIndex),
        won,
        avgEntry: row.avgPrice,
        size: row.size,
        realizedPnl: pnl,
        realizedPct,
        closeTime: row.closeTime,
        firstTradedAt: row.firstTradedAt
      });
    }

    // Drop markets where no leaderboard wallet participated.
    if (participants.length === 0) continue;

    // Drop noise: a lone participant who staked < $10 and lost.
    if (participants.length === 1) {
      const p = participants[0]!;
      if (!p.won && (p.avgEntry ?? 0) * p.size < 10) continue;
    }

    // Sort participants by realizedPnl desc (nulls last).
    participants.sort((a, b) => {
      const pa = a.realizedPnl;
      const pb = b.realizedPnl;
      if (pa === null && pb === null) return 0;
      if (pa === null) return 1;
      if (pb === null) return -1;
      return pb - pa;
    });

    const resolvedAt = Number.isFinite(resolvedAtMs) ? new Date(resolvedAtMs).toISOString() : "";

    results.push({
      conditionId,
      market,
      eventSlug,
      winningOutcomeIndex,
      winningSide: winningSide === "—" ? "YES" : winningSide,
      resolvedAt,
      traderCount: participants.length,
      winners,
      losers,
      totalRealizedPnl,
      participants
    });
  }

  // Sort markets by resolvedAt desc (newest first).
  results.sort((a, b) => b.resolvedAt.localeCompare(a.resolvedAt));

  return results.slice(0, limit);
}

// ── Event grouping ────────────────────────────────────────────────────────────
// A match (e.g. "Brazil vs. Norway") lists many markets — moneyline, totals, spreads — that all share
// one Polymarket event slug and clutter the resolved feed as separate rows. Group them under one header.

export interface ResolvedEventGroup {
  key: string;                 // eventSlug for a real group, else the single market's conditionId
  title: string;               // event header (common question prefix, else humanized slug)
  markets: ResolvedMarket[];   // >1 for a grouped event; exactly 1 for a standalone market
  traderCount: number;         // distinct participant wallets across the group
  winners: number;
  losers: number;
  totalRealizedPnl: number;
  resolvedAt: string;          // latest resolution in the group
}

// Pull an "A vs. B" matchup out of a market question (sports/esports). The questions embed the matchup
// in different ways — "Paraguay vs. France: O/U 2.5", "Will Brazil vs. Norway end in a draw?",
// "LoL: Hanwha Life Esports vs G2 Esports - Game 1 Winner" — so match it anywhere, bounded by a clean
// stop (":", "-", "(", "?", " end", " on", end-of-string). Returns null when the question has no matchup.
// \p{L} (any letter) so accented team names survive — "Côte d'Ivoire", not "te d'Ivoire".
const MATCHUP_RX =
  /([\p{L}][\p{L}\p{N}.'’&]*(?: [\p{L}\p{N}.'’&]+)*?)\s+vs\.?\s+([\p{L}\p{N}][\p{L}\p{N}.'’&]*(?: [\p{L}\p{N}.'’&]+)*?)(?=[:?]|\s*[-–]|\s+end\b|\s+on\b|\s*\(|$)/u;

function matchupOf(question: string): string | null {
  const q = question.replace(/^\s*will\s+/i, ""); // "Will Brazil vs. Norway…" → "Brazil vs. Norway…"
  const m = q.match(MATCHUP_RX);
  if (!m) return null;
  const a = m[1]!.trim();
  const b = m[2]!.trim();
  return a && b ? `${a} vs. ${b}` : null;
}

// A match lists its markets under several sibling slugs — "fifwc-par-fra-2026-07-04",
// "…-more-markets", "…-exact-score", "…-total-corners". Strip the decoration suffix so they share one
// match key, letting a matchup found under one slug title the others (whose own questions don't name
// the teams, e.g. "Exact Score: 2-1").
function matchKeyOf(slug: string): string {
  return slug.replace(/-(?:more-markets|exact-score|total-corners|player-props|total-goals|goalscorers|1st-half.*)$/, "");
}

// The matchup shared by the most market questions in the group — the clean event title for a match,
// even when some markets (spreads, "Team to Advance") don't name the teams.
function commonMatchup(markets: ResolvedMarket[]): string | null {
  const counts = new Map<string, number>();
  for (const m of markets) {
    const mm = m.market ? matchupOf(m.market) : null;
    if (mm) counts.set(mm, (counts.get(mm) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [name, count] of counts) {
    if (count > bestCount) {
      bestCount = count;
      best = name;
    }
  }
  return best;
}

// ponytail: heuristic titles (shared matchup, else humanized slug). Good enough; the market list under
// the header disambiguates. Upgrade path: cache the real event title during ingest keyed by event_slug.
// Drop 3-digit + long id/timestamp slug tokens (keep 1-2 digit days/rounds and 4-digit years), drop a
// leading "Will", and trim dangling trailing prepositions ("…Peace Deal By" → "…Peace Deal").
const TAIL_STOPWORDS = new Set(["By", "On", "In", "Of", "For", "To", "And", "At", "The", "A"]);
function humanizeSlug(slug: string): string {
  const words = slug
    .split("-")
    .filter((t) => t.length > 0 && !/^\d{3}$/.test(t) && !/^\d{5,}$/.test(t))
    .map((t) => t.charAt(0).toUpperCase() + t.slice(1));
  while (words.length > 0 && words[0] === "Will") words.shift();
  while (words.length > 1 && TAIL_STOPWORDS.has(words[words.length - 1]!)) words.pop();
  return words.join(" ");
}

// Group resolved markets by their Polymarket event slug. Markets with no slug, or whose slug appears
// only once, stay standalone (a one-market group). Groups are ordered newest-resolution-first, matching
// the flat feed. Pure — the component renders standalone groups as plain rows and multi-market groups
// as one collapsible header.
export function groupResolvedByEvent(markets: ResolvedMarket[]): ResolvedEventGroup[] {
  const bySlug = new Map<string, ResolvedMarket[]>();
  const standalone: ResolvedMarket[] = [];
  for (const m of markets) {
    if (!m.eventSlug) {
      standalone.push(m);
      continue;
    }
    const g = bySlug.get(m.eventSlug);
    if (g) g.push(m);
    else bySlug.set(m.eventSlug, [m]);
  }

  // Cross-reference matchups across a match's sibling slugs: a matchup found under any slug titles every
  // slug sharing its match key (so "…-exact-score", whose own questions don't name the teams, still
  // reads "Paraguay vs. France").
  const matchupByKey = new Map<string, string>();
  for (const [slug, group] of bySlug) {
    if (group.length <= 1) continue;
    const mm = commonMatchup(group);
    if (mm) {
      const k = matchKeyOf(slug);
      if (!matchupByKey.has(k)) matchupByKey.set(k, mm);
    }
  }

  const groups: ResolvedEventGroup[] = [];
  const pushGroup = (key: string, slug: string | null, group: ResolvedMarket[]): void => {
    const addresses = new Set<string>();
    let winners = 0;
    let losers = 0;
    let totalRealizedPnl = 0;
    let resolvedAt = "";
    for (const m of group) {
      winners += m.winners;
      losers += m.losers;
      totalRealizedPnl += m.totalRealizedPnl;
      if (m.resolvedAt > resolvedAt) resolvedAt = m.resolvedAt;
      for (const p of m.participants) addresses.add(p.address);
    }
    let title = group[0]?.market ?? "—";
    if (group.length > 1 && slug) {
      const matchup = commonMatchup(group) ?? matchupByKey.get(matchKeyOf(slug)) ?? null;
      title = matchup ?? (humanizeSlug(slug) || title);
    }
    groups.push({ key, title, markets: group, traderCount: addresses.size, winners, losers, totalRealizedPnl, resolvedAt });
  };

  for (const [slug, group] of bySlug) {
    if (group.length > 1) pushGroup(slug, slug, group);
    else standalone.push(group[0]!); // a lone market under a slug isn't a group
  }
  for (const m of standalone) pushGroup(m.conditionId, m.eventSlug, [m]);

  groups.sort((a, b) => b.resolvedAt.localeCompare(a.resolvedAt));
  return groups;
}
