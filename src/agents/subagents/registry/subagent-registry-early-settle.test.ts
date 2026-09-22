import { describe, expect, it } from "vitest";
import type { SubagentRunOutcome } from "../subagent-run-outcome.types.js";
import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_EXITED_EARLY,
} from "./subagent-lifecycle-events.js";
import {
  resolveFinalizedSubagentTaskState,
  resolveLifecycleOutcomeFromRunOutcome,
} from "./subagent-registry-completion.js";
import {
  resolveSubagentCompletionOutcomeReason,
  type SubagentEarlySettleInputs,
} from "./subagent-registry-early-settle.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { resolveSubagentSessionStatus } from "./subagent-session-metrics.js";

const okOutcome: SubagentRunOutcome = { status: "ok" };

function resolve(overrides: Partial<SubagentEarlySettleInputs> = {}) {
  return resolveSubagentCompletionOutcomeReason({
    spawnMode: "run",
    expectsCompletionMessage: true,
    completionOutcome: okOutcome,
    completionReason: SUBAGENT_ENDED_REASON_COMPLETE,
    ...overrides,
  });
}

describe("run-mode early-settle classification", () => {
  it("reports exited-early when a required run ends without a visible final reply", () => {
    const result = resolve();

    expect(result).toMatchObject({
      completionOutcome: { status: "exited-early" },
      completionReason: SUBAGENT_ENDED_REASON_EXITED_EARLY,
      appliedEarlySettle: true,
    });
  });

  it.each([
    ["a visible final reply", { terminalReply: { disposition: "visible", text: "done" } }],
    ["session mode", { spawnMode: "session" }],
    ["collect mode", { collect: true }],
    ["an optional completion", { expectsCompletionMessage: false }],
    ["an explicit error", { completionOutcome: { status: "error", error: "provider" } }],
    ["a timeout", { completionOutcome: { status: "timeout" } }],
    ["a non-complete lifecycle reason", { completionReason: "subagent-error" }],
  ] as const)("preserves %s", (_label, overrides) => {
    const result = resolve(overrides);

    expect(result.appliedEarlySettle).toBe(false);
    expect(result.completionOutcome).toBe(
      "completionOutcome" in overrides ? overrides.completionOutcome : okOutcome,
    );
  });
});

describe("exited-early projections", () => {
  const entry = {
    runId: "run-early",
    childSessionKey: "agent:main:subagent:early",
    requesterSessionKey: "agent:main:main",
    task: "produce a final answer",
    cleanup: "keep",
    createdAt: 1,
    expectsCompletionMessage: true,
    execution: {
      status: "terminal",
      endedAt: 10,
      outcome: { status: "exited-early" },
    },
    completion: { required: true, capturedAt: 10, resultText: undefined },
  } as SubagentRunRecord;

  it("projects a failed task with a specific reason", () => {
    expect(resolveFinalizedSubagentTaskState(entry)).toMatchObject({
      status: "failed",
      error: "subagent run exited before producing a final reply",
    });
  });

  it("survives lifecycle and session status projections as a failure", () => {
    expect(resolveLifecycleOutcomeFromRunOutcome({ status: "exited-early" })).toBe("exited-early");
    expect(resolveSubagentSessionStatus(entry)).toBe("failed");
  });
});
