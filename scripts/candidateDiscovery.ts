// candidateDiscovery.ts
//
// Pure functions for the candidate-wallet scoring and promotion pipeline. No I/O, no API
// calls, no Supabase — all side-effects live in ingest.ts. This keeps every decision
// unit-testable in isolation.
//
// Lifecycle:
//   candidate  → scored → if score >= CANDIDATE_PROMOTION_THRESHOLD  → tracked
//                       → if score <  CANDIDATE_PROMOTION_THRESHOLD  → candidate (rescored later)
//   tracked    → scored → if consecutive_below_threshold >= CANDIDATE_RETIREMENT_CONSECUTIVE → retired
//                       → else stays tracked (counter resets when score recovers)
//   retired    → no further scoring (wallet_stats rows kept for historical queries)

export type CandidateStatus = "candidate" | "tracked" | "retired";

export interface CandidateWallet {
  address: string;
  discoverySource: string;
  status: CandidateStatus;
  firstSeenAt: string;
  lastScoredAt: string | null;
  // Best skill_score across all horizons from the most recent scoring pass; null = never scored.
  skillScore: number | null;
  timesScored: number;
  // For tracked wallets: consecutive full-ingest runs with score below the retirement threshold.
  // Resets to 0 whenever the score recovers above the threshold.
  consecutiveBelowThreshold: number;
  promotedAt: string | null;
  retiredAt: string | null;
}

// The DB update payload after one scoring pass. All fields are written back to candidate_wallets.
export interface ScoringOutcome {
  address: string;
  newStatus: CandidateStatus;
  skillScore: number | null;
  timesScored: number;
  consecutiveBelowThreshold: number;
  lastScoredAt: string;
  promotedAt: string | null;
  retiredAt: string | null;
}

// ── Batch selection ────────────────────────────────────────────────────────────────────

// Select up to `batchSize` candidates to score this run.
//
// Selection priority (within the `status = 'candidate'` set):
//   1. Never scored (lastScoredAt === null) — always first in line.
//   2. Least-recently scored — spreads re-scoring evenly instead of hammering the same
//      wallets repeatedly.
//
// A candidate scored within `rescoringIntervalMs` is skipped so confirmed below-threshold
// wallets don't consume the batch before the rescore window expires. Never-scored wallets
// are always eligible regardless of the interval.
export function selectCandidateBatch(
  candidates: CandidateWallet[],
  batchSize: number,
  nowMs: number,
  rescoringIntervalMs: number
): CandidateWallet[] {
  const eligible = candidates.filter((c) => {
    if (c.lastScoredAt === null) {
      return true; // never scored → always eligible
    }
    return Date.parse(c.lastScoredAt) <= nowMs - rescoringIntervalMs;
  });

  // Sort so never-scored (-Infinity) come first, then oldest-scored ascending.
  eligible.sort((a, b) => {
    const aMs = a.lastScoredAt !== null ? Date.parse(a.lastScoredAt) : -Infinity;
    const bMs = b.lastScoredAt !== null ? Date.parse(b.lastScoredAt) : -Infinity;
    return aMs - bMs;
  });

  return eligible.slice(0, batchSize);
}

// ── Score predicates ───────────────────────────────────────────────────────────────────

// True when a candidate's score earns promotion to 'tracked' status.
// Any demonstrated positive forecasting edge (score >= SCORE_FLOOR) qualifies.
export function shouldPromote(skillScore: number | null, promotionThreshold: number): boolean {
  return skillScore !== null && skillScore >= promotionThreshold;
}

// True when a tracked wallet's below-threshold streak has reached the retirement limit.
export function shouldRetire(consecutiveBelowThreshold: number, retirementConsecutive: number): boolean {
  return consecutiveBelowThreshold >= retirementConsecutive;
}

// New consecutiveBelowThreshold after one scoring run.
// Resets to 0 when the score is at or above the threshold; increments otherwise.
// The threshold here is CANDIDATE_RETIREMENT_THRESHOLD (slightly below SCORE_FLOOR)
// so a wallet that fully loses its edge (score = 0) accumulates immediately, while a
// score hovering just at the floor (e.g. 4.0) doesn't trigger retirement.
export function nextConsecutiveBelow(
  newScore: number | null,
  retirementThreshold: number,
  current: number
): number {
  if (newScore !== null && newScore >= retirementThreshold) {
    return 0; // score recovered → reset the counter
  }
  return current + 1;
}

// ── Outcome computation ────────────────────────────────────────────────────────────────

// Compute the full ScoringOutcome for a wallet after one scoring pass, handling all
// status transitions. Encapsulates the decision logic so the caller only needs to
// pass the new score and timestamp.
//
// Transitions:
//   candidate + promoted        → tracked   (promotedAt set)
//   candidate + not promoted    → candidate (rescored later)
//   tracked   + streak >= limit → retired   (retiredAt set)
//   tracked   + streak < limit  → tracked   (consecutiveBelowThreshold updated)
//   retired                     → retired   (should not be in the scoring batch; no-op)
export function computeScoringOutcome(
  wallet: CandidateWallet,
  newScore: number | null,
  nowIso: string,
  config: {
    promotionThreshold: number;
    retirementThreshold: number;
    retirementConsecutive: number;
  }
): ScoringOutcome {
  const below = nextConsecutiveBelow(newScore, config.retirementThreshold, wallet.consecutiveBelowThreshold);

  let newStatus: CandidateStatus = wallet.status;
  let promotedAt = wallet.promotedAt;
  let retiredAt = wallet.retiredAt;

  if (wallet.status === "candidate") {
    if (shouldPromote(newScore, config.promotionThreshold)) {
      newStatus = "tracked";
      promotedAt = nowIso;
    }
    // Below threshold → stays 'candidate'; will re-enter the batch after RESCORE_DAYS.
  } else if (wallet.status === "tracked") {
    if (shouldRetire(below, config.retirementConsecutive)) {
      newStatus = "retired";
      retiredAt = nowIso;
    }
    // Streak not yet at limit → stays 'tracked' (consecutiveBelowThreshold updated above).
  }
  // 'retired' wallets should never reach the scoring batch; treat as a no-op.

  return {
    address: wallet.address,
    newStatus,
    skillScore: newScore,
    timesScored: wallet.timesScored + 1,
    consecutiveBelowThreshold: below,
    lastScoredAt: nowIso,
    promotedAt,
    retiredAt
  };
}

// ── Utility ────────────────────────────────────────────────────────────────────────────

// Best skill_score across all horizons. Returns null when every horizon yielded null
// (bot, ineligible, or error). Used to reduce per-horizon wallet_stats rows to a single
// promotion/retirement signal.
export function bestSkillScore(scores: Array<number | null>): number | null {
  let best: number | null = null;
  for (const s of scores) {
    if (s !== null && (best === null || s > best)) {
      best = s;
    }
  }
  return best;
}

// Merge newly discovered addresses into the set already known to the ingest. Returns only
// the genuinely new entries (those not in `existingAddresses`) so the insert path can use
// ignoreDuplicates without wasting batch space on no-ops.
export function filterNewCandidates(
  discovered: ReadonlyArray<{ address: string; discoverySource: string }>,
  existingAddresses: ReadonlySet<string>
): Array<{ address: string; discoverySource: string }> {
  return discovered.filter((d) => !existingAddresses.has(d.address));
}
