/**
 * Fork issue #106 (Ask #1) — targeted coverage for the early-settle guard.
 *
 * The guard is implemented as a pure helper
 * (`resolveSubagentCompletionOutcomeReason`) so it can be unit-tested without
 * mocking the full `completeSubagentRunAttempt` machinery. These tests pin
 * the contract:
 *   - mode=run + ok outcome + no visible final answer  → exited-early
 *   - mode=run + visible final answer                  → untouched
 *   - mode=session / undefined / killed                → untouched
 *
 * Ask #2 (durable dropped-delivery marker) is covered by
 * `subagent-announce.requester-settle-wake-dropped-marker.test.ts` and the
 * extended assertion in the existing
 * `subagent-registry.requester-wake.e2e.test.ts` (cap-10 path).
 *
 * Card: 9646d3cd-aa9a-4ff3-bd10-8d54bc1c513c
 * DELEG-REF: 9646d3cd-aa9a-4ff3-bd10-8d54bc1c513c
 */
import { describe, expect, it } from "vitest";
import {
  SUBAGENT_ENDED_OUTCOME_EXITED_EARLY,
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_ERROR,
  SUBAGENT_ENDED_REASON_EXITED_EARLY,
  SUBAGENT_ENDED_REASON_KILLED,
} from "./subagent-lifecycle-events.js";
import {
  hasVisibleFinalAnswer,
  resolveSubagentCompletionOutcomeReason,
} from "./subagent-registry-early-settle.js";

const OK_OUTCOME = { status: "ok" as const };

describe("fork #106 — hasVisibleFinalAnswer", () => {
  it("returns true for a visible disposition with non-empty text", () => {
    expect(hasVisibleFinalAnswer({ disposition: "visible", text: "hello" })).toBe(true);
  });
  it("returns false for an empty / whitespace-only text", () => {
    expect(hasVisibleFinalAnswer({ disposition: "visible", text: "   " })).toBe(false);
  });
  it("returns false for non-visible dispositions", () => {
    expect(hasVisibleFinalAnswer({ disposition: "silent" })).toBe(false);
    expect(hasVisibleFinalAnswer({ disposition: "empty" })).toBe(false);
  });
  it("returns false when terminalReply is undefined", () => {
    expect(hasVisibleFinalAnswer(undefined)).toBe(false);
  });
});

describe("fork #106 — resolveSubagentCompletionOutcomeReason", () => {
  it("surfaces exited-early for mode=run with no final answer", () => {
    const result = resolveSubagentCompletionOutcomeReason({
      spawnMode: "run",
      completionOutcome: OK_OUTCOME,
      completionReason: SUBAGENT_ENDED_REASON_COMPLETE,
    });
    expect(result.appliedEarlySettle).toBe(true);
    expect(result.completionOutcome.status).toBe(SUBAGENT_ENDED_OUTCOME_EXITED_EARLY);
    expect(result.completionReason).toBe(SUBAGENT_ENDED_REASON_EXITED_EARLY);
  });

  it("does NOT trigger exited-early when a visible final answer is present", () => {
    const result = resolveSubagentCompletionOutcomeReason({
      spawnMode: "run",
      completionOutcome: OK_OUTCOME,
      completionReason: SUBAGENT_ENDED_REASON_COMPLETE,
      terminalReply: { disposition: "visible", text: "here you go" },
    });
    expect(result.appliedEarlySettle).toBe(false);
    expect(result.completionOutcome).toBe(OK_OUTCOME);
    expect(result.completionReason).toBe(SUBAGENT_ENDED_REASON_COMPLETE);
  });

  it("preserves mode=session (no exited-early); MISSING_REQUIRED_FINAL_REPLY_ERROR branch runs separately", () => {
    const result = resolveSubagentCompletionOutcomeReason({
      spawnMode: "session",
      completionOutcome: OK_OUTCOME,
      completionReason: SUBAGENT_ENDED_REASON_COMPLETE,
    });
    expect(result.appliedEarlySettle).toBe(false);
    expect(result.completionOutcome).toBe(OK_OUTCOME);
    // The caller applies MISSING_REQUIRED_FINAL_REPLY_ERROR / ERROR reason
    // separately for mode=session; the helper leaves the inputs alone so
    // that branch fires unchanged.
  });

  it("preserves undefined spawnMode (legacy runs)", () => {
    const result = resolveSubagentCompletionOutcomeReason({
      completionOutcome: OK_OUTCOME,
      completionReason: SUBAGENT_ENDED_REASON_COMPLETE,
    });
    expect(result.appliedEarlySettle).toBe(false);
    expect(result.completionOutcome).toBe(OK_OUTCOME);
  });

  it("never overrides killed outcomes, even for mode=run", () => {
    const result = resolveSubagentCompletionOutcomeReason({
      spawnMode: "run",
      completionOutcome: { status: "error", error: "killed" },
      completionReason: SUBAGENT_ENDED_REASON_KILLED,
    });
    expect(result.appliedEarlySettle).toBe(false);
    expect(result.completionOutcome).toEqual({ status: "error", error: "killed" });
    expect(result.completionReason).toBe(SUBAGENT_ENDED_REASON_KILLED);
  });

  it("does not touch non-ok outcomes", () => {
    const errOutcome = { status: "error" as const, error: "boom" };
    const result = resolveSubagentCompletionOutcomeReason({
      spawnMode: "run",
      completionOutcome: errOutcome,
      completionReason: SUBAGENT_ENDED_REASON_ERROR,
    });
    expect(result.appliedEarlySettle).toBe(false);
    expect(result.completionOutcome).toBe(errOutcome);
  });
});
