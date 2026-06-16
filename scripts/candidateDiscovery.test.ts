import assert from "node:assert/strict";
import { test } from "node:test";
import {
  selectCandidateBatch,
  shouldPromote,
  shouldRetire,
  nextConsecutiveBelow,
  computeScoringOutcome,
  bestSkillScore,
  filterNewCandidates,
  type CandidateWallet,
  type CandidateStatus
} from "./candidateDiscovery.js";

// ── Fixtures ───────────────────────────────────────────────────────────────────────────

const NOW_MS = Date.parse("2026-06-01T12:00:00Z");
const NOW_ISO = new Date(NOW_MS).toISOString();
const RESCORE_MS = 30 * 86400 * 1000; // 30 days in ms

function mkCandidate(overrides: Partial<CandidateWallet> = {}): CandidateWallet {
  return {
    address: "0xabc",
    discoverySource: "leaderboard_pnl_all",
    status: "candidate",
    firstSeenAt: "2026-01-01T00:00:00Z",
    lastScoredAt: null,
    skillScore: null,
    timesScored: 0,
    consecutiveBelowThreshold: 0,
    promotedAt: null,
    retiredAt: null,
    ...overrides
  };
}

const CONFIG = {
  promotionThreshold: 4.0,
  retirementThreshold: 3.0,
  retirementConsecutive: 3
};

// ── selectCandidateBatch ───────────────────────────────────────────────────────────────

test("never-scored candidates are always eligible regardless of rescore interval", () => {
  const never = mkCandidate({ address: "0xnever", lastScoredAt: null });
  const recent = mkCandidate({ address: "0xrecent", lastScoredAt: new Date(NOW_MS - 1000).toISOString() });
  const batch = selectCandidateBatch([recent, never], 10, NOW_MS, RESCORE_MS);
  // 'recent' is within the rescore window — excluded. 'never' is always eligible.
  assert.equal(batch.length, 1);
  assert.equal(batch[0]?.address, "0xnever");
});

test("candidates outside the rescore window are eligible", () => {
  const old = mkCandidate({
    address: "0xold",
    lastScoredAt: new Date(NOW_MS - RESCORE_MS - 1).toISOString() // just past the cutoff
  });
  const batch = selectCandidateBatch([old], 10, NOW_MS, RESCORE_MS);
  assert.equal(batch.length, 1);
});

test("candidates inside the rescore window are skipped", () => {
  const fresh = mkCandidate({
    address: "0xfresh",
    lastScoredAt: new Date(NOW_MS - RESCORE_MS + 1000).toISOString() // still inside window
  });
  const batch = selectCandidateBatch([fresh], 10, NOW_MS, RESCORE_MS);
  assert.equal(batch.length, 0);
});

test("never-scored sort before older-scored, older-scored before newer-scored", () => {
  const old = mkCandidate({ address: "0xold", lastScoredAt: "2026-01-01T00:00:00Z" });
  const newer = mkCandidate({ address: "0xnewer", lastScoredAt: "2026-02-01T00:00:00Z" });
  const never = mkCandidate({ address: "0xnever", lastScoredAt: null });
  const batch = selectCandidateBatch([newer, old, never], 10, NOW_MS, RESCORE_MS);
  assert.deepEqual(batch.map((c) => c.address), ["0xnever", "0xold", "0xnewer"]);
});

test("batchSize cap is honoured", () => {
  const candidates = Array.from({ length: 10 }, (_, i) =>
    mkCandidate({ address: `0x${i.toString().padStart(40, "0")}`, lastScoredAt: null })
  );
  const batch = selectCandidateBatch(candidates, 3, NOW_MS, RESCORE_MS);
  assert.equal(batch.length, 3);
});

test("returns empty when all candidates are within the rescore window", () => {
  const c = mkCandidate({ lastScoredAt: new Date(NOW_MS - 1000).toISOString() });
  assert.deepEqual(selectCandidateBatch([c], 10, NOW_MS, RESCORE_MS), []);
});

test("returns empty for empty input", () => {
  assert.deepEqual(selectCandidateBatch([], 10, NOW_MS, RESCORE_MS), []);
});

// ── shouldPromote ──────────────────────────────────────────────────────────────────────

test("shouldPromote: null score → false", () => {
  assert.equal(shouldPromote(null, 4.0), false);
});

test("shouldPromote: score exactly at threshold → true", () => {
  assert.equal(shouldPromote(4.0, 4.0), true);
});

test("shouldPromote: score above threshold → true", () => {
  assert.equal(shouldPromote(7.5, 4.0), true);
});

test("shouldPromote: score below threshold → false", () => {
  assert.equal(shouldPromote(3.9, 4.0), false);
});

test("shouldPromote: score of 0 → false", () => {
  assert.equal(shouldPromote(0, 4.0), false);
});

// ── shouldRetire ───────────────────────────────────────────────────────────────────────

test("shouldRetire: below limit → false", () => {
  assert.equal(shouldRetire(2, 3), false);
});

test("shouldRetire: exactly at limit → true", () => {
  assert.equal(shouldRetire(3, 3), true);
});

test("shouldRetire: above limit → true", () => {
  assert.equal(shouldRetire(5, 3), true);
});

test("shouldRetire: 0 consecutive → false", () => {
  assert.equal(shouldRetire(0, 3), false);
});

// ── nextConsecutiveBelow ───────────────────────────────────────────────────────────────

test("nextConsecutiveBelow: score at threshold → resets to 0", () => {
  assert.equal(nextConsecutiveBelow(3.0, 3.0, 2), 0);
});

test("nextConsecutiveBelow: score above threshold → resets to 0", () => {
  assert.equal(nextConsecutiveBelow(7.0, 3.0, 5), 0);
});

test("nextConsecutiveBelow: null score → increments", () => {
  assert.equal(nextConsecutiveBelow(null, 3.0, 1), 2);
});

test("nextConsecutiveBelow: score below threshold → increments", () => {
  assert.equal(nextConsecutiveBelow(2.9, 3.0, 1), 2);
});

test("nextConsecutiveBelow: score of 0 → increments from 0", () => {
  assert.equal(nextConsecutiveBelow(0, 3.0, 0), 1);
});

test("nextConsecutiveBelow: score just below threshold increments each run until retirement", () => {
  let counter = 0;
  for (let i = 0; i < 3; i++) {
    counter = nextConsecutiveBelow(2.5, 3.0, counter);
  }
  assert.equal(counter, 3);
  assert.equal(shouldRetire(counter, 3), true);
});

// ── computeScoringOutcome ──────────────────────────────────────────────────────────────

test("candidate promoted when score >= threshold", () => {
  const wallet = mkCandidate({ status: "candidate" });
  const outcome = computeScoringOutcome(wallet, 5.0, NOW_ISO, CONFIG);
  assert.equal(outcome.newStatus, "tracked");
  assert.equal(outcome.promotedAt, NOW_ISO);
  assert.equal(outcome.skillScore, 5.0);
  assert.equal(outcome.timesScored, 1);
  assert.equal(outcome.consecutiveBelowThreshold, 0); // 5.0 >= 3.0 threshold → reset
});

test("candidate stays candidate when score below promotion threshold", () => {
  const wallet = mkCandidate({ status: "candidate" });
  const outcome = computeScoringOutcome(wallet, 3.5, NOW_ISO, CONFIG);
  assert.equal(outcome.newStatus, "candidate");
  assert.equal(outcome.promotedAt, null);
  assert.equal(outcome.skillScore, 3.5);
  assert.equal(outcome.consecutiveBelowThreshold, 0); // 3.5 >= 3.0 threshold → reset
});

test("candidate stays candidate when score is null (ineligible)", () => {
  const wallet = mkCandidate({ status: "candidate" });
  const outcome = computeScoringOutcome(wallet, null, NOW_ISO, CONFIG);
  assert.equal(outcome.newStatus, "candidate");
  assert.equal(outcome.promotedAt, null);
  assert.equal(outcome.skillScore, null);
  assert.equal(outcome.consecutiveBelowThreshold, 1);
});

test("candidate timesScored increments even on null score", () => {
  const wallet = mkCandidate({ timesScored: 3 });
  const outcome = computeScoringOutcome(wallet, null, NOW_ISO, CONFIG);
  assert.equal(outcome.timesScored, 4);
});

test("tracked wallet stays tracked when streak below retirement limit", () => {
  const wallet = mkCandidate({ status: "tracked", consecutiveBelowThreshold: 1, promotedAt: "2026-01-10T00:00:00Z" });
  const outcome = computeScoringOutcome(wallet, 2.0, NOW_ISO, CONFIG); // below retirementThreshold
  assert.equal(outcome.newStatus, "tracked");
  assert.equal(outcome.consecutiveBelowThreshold, 2);
  assert.equal(outcome.retiredAt, null);
});

test("tracked wallet retires when streak reaches the limit", () => {
  const wallet = mkCandidate({
    status: "tracked",
    consecutiveBelowThreshold: 2, // one away from limit
    promotedAt: "2026-01-10T00:00:00Z"
  });
  const outcome = computeScoringOutcome(wallet, null, NOW_ISO, CONFIG); // null → increments to 3
  assert.equal(outcome.newStatus, "retired");
  assert.equal(outcome.retiredAt, NOW_ISO);
  assert.equal(outcome.consecutiveBelowThreshold, 3);
});

test("tracked wallet resets streak when score recovers above retirement threshold", () => {
  const wallet = mkCandidate({
    status: "tracked",
    consecutiveBelowThreshold: 2,
    promotedAt: "2026-01-10T00:00:00Z"
  });
  const outcome = computeScoringOutcome(wallet, 5.0, NOW_ISO, CONFIG); // above threshold → reset
  assert.equal(outcome.newStatus, "tracked");
  assert.equal(outcome.consecutiveBelowThreshold, 0);
  assert.equal(outcome.retiredAt, null);
});

test("retired wallet stays retired (no-op transition)", () => {
  const wallet = mkCandidate({ status: "retired", retiredAt: "2026-02-01T00:00:00Z" });
  const outcome = computeScoringOutcome(wallet, 8.0, NOW_ISO, CONFIG);
  // Retired wallets should not reach the scoring batch, but if they do the state is preserved.
  assert.equal(outcome.newStatus, "retired");
  assert.equal(outcome.retiredAt, "2026-02-01T00:00:00Z"); // unchanged from prior
});

test("lastScoredAt is always set to nowIso after scoring", () => {
  const wallet = mkCandidate({ lastScoredAt: null });
  const outcome = computeScoringOutcome(wallet, 5.0, NOW_ISO, CONFIG);
  assert.equal(outcome.lastScoredAt, NOW_ISO);
});

test("existing promotedAt is preserved when already tracked", () => {
  const promotedAt = "2026-01-10T00:00:00Z";
  const wallet = mkCandidate({ status: "tracked", promotedAt, consecutiveBelowThreshold: 0 });
  const outcome = computeScoringOutcome(wallet, 6.0, NOW_ISO, CONFIG);
  assert.equal(outcome.promotedAt, promotedAt); // unchanged
});

// ── Full lifecycle simulation ──────────────────────────────────────────────────────────

test("complete lifecycle: candidate → tracked → retirement streak → retired", () => {
  let wallet = mkCandidate({ address: "0xlifecycle", status: "candidate" });

  // Day 1: scored below threshold → stays candidate
  let outcome = computeScoringOutcome(wallet, 2.0, "2026-01-01T00:00:00Z", CONFIG);
  wallet = { ...wallet, ...{ status: outcome.newStatus as CandidateStatus, timesScored: outcome.timesScored, consecutiveBelowThreshold: outcome.consecutiveBelowThreshold, lastScoredAt: outcome.lastScoredAt, skillScore: outcome.skillScore, promotedAt: outcome.promotedAt, retiredAt: outcome.retiredAt } };
  assert.equal(wallet.status, "candidate");

  // Day 2: edge detected → promoted to tracked
  outcome = computeScoringOutcome(wallet, 5.5, "2026-01-02T00:00:00Z", CONFIG);
  wallet = { ...wallet, ...{ status: outcome.newStatus as CandidateStatus, timesScored: outcome.timesScored, consecutiveBelowThreshold: outcome.consecutiveBelowThreshold, lastScoredAt: outcome.lastScoredAt, skillScore: outcome.skillScore, promotedAt: outcome.promotedAt, retiredAt: outcome.retiredAt } };
  assert.equal(wallet.status, "tracked");
  assert.equal(wallet.consecutiveBelowThreshold, 0);

  // Day 3–5: three consecutive below-threshold runs → retire
  for (let day = 3; day <= 5; day++) {
    outcome = computeScoringOutcome(wallet, 0, `2026-01-0${day}T00:00:00Z`, CONFIG);
    wallet = { ...wallet, ...{ status: outcome.newStatus as CandidateStatus, timesScored: outcome.timesScored, consecutiveBelowThreshold: outcome.consecutiveBelowThreshold, lastScoredAt: outcome.lastScoredAt, skillScore: outcome.skillScore, promotedAt: outcome.promotedAt, retiredAt: outcome.retiredAt } };
  }
  assert.equal(wallet.status, "retired");
  assert.equal(wallet.timesScored, 5);
});

test("tracked wallet survives 2 bad runs then recovers", () => {
  let wallet = mkCandidate({ status: "tracked", promotedAt: "2026-01-01T00:00:00Z", consecutiveBelowThreshold: 0 });

  // Two bad runs
  let outcome = computeScoringOutcome(wallet, 0, "2026-01-02T00:00:00Z", CONFIG);
  wallet = { ...wallet, ...{ consecutiveBelowThreshold: outcome.consecutiveBelowThreshold, status: outcome.newStatus as CandidateStatus, lastScoredAt: outcome.lastScoredAt, skillScore: outcome.skillScore } };
  outcome = computeScoringOutcome(wallet, 0, "2026-01-03T00:00:00Z", CONFIG);
  wallet = { ...wallet, ...{ consecutiveBelowThreshold: outcome.consecutiveBelowThreshold, status: outcome.newStatus as CandidateStatus, lastScoredAt: outcome.lastScoredAt, skillScore: outcome.skillScore } };
  assert.equal(wallet.consecutiveBelowThreshold, 2);
  assert.equal(wallet.status, "tracked");

  // Recovery run — counter resets
  outcome = computeScoringOutcome(wallet, 5.0, "2026-01-04T00:00:00Z", CONFIG);
  wallet = { ...wallet, ...{ consecutiveBelowThreshold: outcome.consecutiveBelowThreshold, status: outcome.newStatus as CandidateStatus } };
  assert.equal(wallet.consecutiveBelowThreshold, 0);
  assert.equal(wallet.status, "tracked");
});

// ── bestSkillScore ─────────────────────────────────────────────────────────────────────

test("bestSkillScore: picks the highest score across horizons", () => {
  assert.equal(bestSkillScore([3.0, 7.5, 5.0]), 7.5);
});

test("bestSkillScore: all null → null", () => {
  assert.equal(bestSkillScore([null, null]), null);
});

test("bestSkillScore: single non-null wins", () => {
  assert.equal(bestSkillScore([null, 4.0, null]), 4.0);
});

test("bestSkillScore: single element", () => {
  assert.equal(bestSkillScore([6.0]), 6.0);
});

test("bestSkillScore: empty array → null", () => {
  assert.equal(bestSkillScore([]), null);
});

test("bestSkillScore: 0 is a valid score (not null)", () => {
  assert.equal(bestSkillScore([0, null]), 0);
});

// ── filterNewCandidates ────────────────────────────────────────────────────────────────

test("filterNewCandidates: excludes addresses already in the known set", () => {
  const discovered = [
    { address: "0xnew", discoverySource: "trades_stream" },
    { address: "0xknown", discoverySource: "leaderboard_pnl_1m" }
  ];
  const existing = new Set(["0xknown"]);
  const result = filterNewCandidates(discovered, existing);
  assert.deepEqual(result, [{ address: "0xnew", discoverySource: "trades_stream" }]);
});

test("filterNewCandidates: all known → empty array", () => {
  const discovered = [{ address: "0xa", discoverySource: "x" }];
  assert.deepEqual(filterNewCandidates(discovered, new Set(["0xa"])), []);
});

test("filterNewCandidates: all new → all returned", () => {
  const discovered = [
    { address: "0xa", discoverySource: "x" },
    { address: "0xb", discoverySource: "y" }
  ];
  const result = filterNewCandidates(discovered, new Set());
  assert.equal(result.length, 2);
});

test("filterNewCandidates: empty input → empty output", () => {
  assert.deepEqual(filterNewCandidates([], new Set(["0xa"])), []);
});

test("filterNewCandidates: does not mutate the discovered array", () => {
  const discovered = [{ address: "0xnew", discoverySource: "x" }];
  const copy = [...discovered];
  filterNewCandidates(discovered, new Set());
  assert.deepEqual(discovered, copy);
});

// ── selectCandidateBatch edge cases ───────────────────────────────────────────────────

test("selectCandidateBatch: exact rescore boundary — scored at exactly cutoff is eligible", () => {
  const cutoffMs = NOW_MS - RESCORE_MS;
  const c = mkCandidate({ lastScoredAt: new Date(cutoffMs).toISOString() });
  const batch = selectCandidateBatch([c], 10, NOW_MS, RESCORE_MS);
  assert.equal(batch.length, 1);
});

test("selectCandidateBatch: one ms inside window → ineligible", () => {
  const insideMs = NOW_MS - RESCORE_MS + 1;
  const c = mkCandidate({ lastScoredAt: new Date(insideMs).toISOString() });
  const batch = selectCandidateBatch([c], 10, NOW_MS, RESCORE_MS);
  assert.equal(batch.length, 0);
});

test("selectCandidateBatch: batchSize 0 → always empty", () => {
  const c = mkCandidate({ lastScoredAt: null });
  assert.deepEqual(selectCandidateBatch([c], 0, NOW_MS, RESCORE_MS), []);
});

test("selectCandidateBatch: mix of eligible and ineligible; order preserved for eligible", () => {
  const t1 = mkCandidate({ address: "0x01", lastScoredAt: "2026-01-01T00:00:00Z" }); // old → eligible
  const t2 = mkCandidate({ address: "0x02", lastScoredAt: new Date(NOW_MS - 100).toISOString() }); // fresh → ineligible
  const t3 = mkCandidate({ address: "0x03", lastScoredAt: null }); // never → eligible first
  const t4 = mkCandidate({ address: "0x04", lastScoredAt: "2026-02-01T00:00:00Z" }); // newer but eligible
  const batch = selectCandidateBatch([t1, t2, t3, t4], 10, NOW_MS, RESCORE_MS);
  // t2 ineligible; rest sorted: never (t3), oldest (t1), then t4
  assert.deepEqual(batch.map((c) => c.address), ["0x03", "0x01", "0x04"]);
});
