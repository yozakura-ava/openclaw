// Tests the staged recovery policy for blocked_tool_call stalls (issue #84-H2).
import { describe, expect, it } from "vitest";
import {
  BLOCKED_TOOL_CALL_RECOVERY_DEFAULTS,
  blockedToolCallStageAuditEvent,
  resolveBlockedToolCallRecoveryPolicy,
  resolveBlockedToolCallRecoveryStage,
} from "./blocked-tool-call-recovery-policy.js";

describe("resolveBlockedToolCallRecoveryPolicy", () => {
  it("returns the documented defaults when no config is supplied", () => {
    expect(resolveBlockedToolCallRecoveryPolicy(undefined)).toEqual({
      nudgeAfterMs: 60_000,
      autoKillAfterMs: 180_000,
      escalateAfterMs: 300_000,
      enabled: true,
    });
  });

  it("clamps thresholds below the safety floor", () => {
    const policy = resolveBlockedToolCallRecoveryPolicy({
      // Build a fake config shape with the operator-supplied knobs.
      agents: {
        defaults: {
          blockedToolCallRecovery: {
            nudgeAfterMs: 100,
            autoKillAfterMs: 200,
            escalateAfterMs: 300,
          },
        },
      },
    } as never);
    expect(policy.nudgeAfterMs).toBe(5_000);
    expect(policy.autoKillAfterMs).toBeGreaterThan(policy.nudgeAfterMs);
    expect(policy.escalateAfterMs).toBeGreaterThan(policy.autoKillAfterMs);
  });

  it("honors operator overrides for non-monotonic inputs by re-sorting", () => {
    const policy = resolveBlockedToolCallRecoveryPolicy({
      agents: {
        defaults: {
          blockedToolCallRecovery: {
            nudgeAfterMs: 600_000,
            autoKillAfterMs: 60_000,
            escalateAfterMs: 300_000,
          },
        },
      },
    } as never);
    expect(policy.nudgeAfterMs).toBe(600_000);
    expect(policy.autoKillAfterMs).toBeGreaterThan(policy.nudgeAfterMs);
    expect(policy.escalateAfterMs).toBeGreaterThan(policy.autoKillAfterMs);
  });

  it("returns the canonical defaults reference", () => {
    expect(BLOCKED_TOOL_CALL_RECOVERY_DEFAULTS).toEqual({
      nudgeAfterMs: 60_000,
      autoKillAfterMs: 180_000,
      escalateAfterMs: 300_000,
      enabled: true,
    });
  });
});

describe("resolveBlockedToolCallRecoveryStage", () => {
  const policy = {
    nudgeAfterMs: 60_000,
    autoKillAfterMs: 180_000,
    escalateAfterMs: 300_000,
    enabled: true,
  };

  it("returns 'none' below the nudge threshold", () => {
    expect(resolveBlockedToolCallRecoveryStage({ activeToolAgeMs: 30_000, policy })).toBe("none");
  });

  it("returns 'nudge' at and above the nudge threshold", () => {
    expect(resolveBlockedToolCallRecoveryStage({ activeToolAgeMs: 60_000, policy })).toBe("nudge");
    expect(resolveBlockedToolCallRecoveryStage({ activeToolAgeMs: 120_000, policy })).toBe("nudge");
  });

  it("returns 'autoKill' at and above the autoKill threshold", () => {
    expect(resolveBlockedToolCallRecoveryStage({ activeToolAgeMs: 180_000, policy })).toBe(
      "autoKill",
    );
    expect(resolveBlockedToolCallRecoveryStage({ activeToolAgeMs: 250_000, policy })).toBe(
      "autoKill",
    );
  });

  it("returns 'escalate' at and above the escalate threshold", () => {
    expect(resolveBlockedToolCallRecoveryStage({ activeToolAgeMs: 300_000, policy })).toBe(
      "escalate",
    );
    expect(resolveBlockedToolCallRecoveryStage({ activeToolAgeMs: 600_000, policy })).toBe(
      "escalate",
    );
  });

  it("clamps negative ages to zero", () => {
    expect(resolveBlockedToolCallRecoveryStage({ activeToolAgeMs: -10_000, policy })).toBe("none");
  });

  it("returns 'none' when the policy is disabled", () => {
    expect(
      resolveBlockedToolCallRecoveryStage({
        activeToolAgeMs: 999_999,
        policy: { ...policy, enabled: false },
      }),
    ).toBe("none");
  });
});

describe("blockedToolCallStageAuditEvent", () => {
  it("returns no event for the 'none' stage", () => {
    expect(blockedToolCallStageAuditEvent("none")).toBeUndefined();
  });

  it("returns the stage-specific audit event names", () => {
    expect(blockedToolCallStageAuditEvent("nudge")).toBe("blocked_tool_call.recovery.nudge");
    expect(blockedToolCallStageAuditEvent("autoKill")).toBe("blocked_tool_call.recovery.auto_kill");
    expect(blockedToolCallStageAuditEvent("escalate")).toBe("blocked_tool_call.recovery.escalate");
  });
});
