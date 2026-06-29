import type { CrowdLookups } from "./marketCrowd";
import type { ResolvedMarket, ResolvedParticipant } from "./types";

// Re-export the type so callers can import it from here if needed.
export type { CrowdLookups };

// Input shape — local only; the supabase reader maps its rows into this.
interface ResolvedClosedInput {
  address: string;
  conditionId: string | null;
  market: string | null;
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
