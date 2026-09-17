// Staged recovery policy for blocked_tool_call stalls (issue #84-H2).
//
// When a tool call is blocked for an extended period with no progress, the
// session-attention classifier emits a `blocked_tool_call` event. Without
// a recovery policy the run sits forever (current `recoveryEligible: false`
// semantics). The staged policy lifts that limit by:
//
//   1. nudge     — emit a low-severity audit event so the owner/cron can see
//                  the stall before it gets serious
//   2. auto-kill — abort the active tool/run via the existing recovery gate
//   3. escalate  — surface to the configured escalation target (operator)
//                  once auto-kill has not unstuck the session
//
// Thresholds default to 60s/180s/300s but are operator-overridable per
// config so a slow provider does not get killed prematurely. The policy
// is intentionally additive: callers continue to receive the existing
// classification result, plus a recovery stage and audit event kind.
import type { OpenClawConfig } from "../config/types.openclaw.js";

/**
 * Stage progression for blocked_tool_call stall recovery. Listed in the
 * order the policy advances so log tables can sort lexicographically.
 */
export type BlockedToolCallRecoveryStage = "none" | "nudge" | "autoKill" | "escalate";

/**
 * Resolved policy for the current blocked_tool_call stall. All thresholds
 * are in milliseconds, monotonic, and bounded so misconfiguration cannot
 * produce a non-progressing state.
 */
export type BlockedToolCallRecoveryPolicy = {
  /** Active-tool age at which the policy fires a `nudge` audit event. */
  nudgeAfterMs: number;
  /** Active-tool age at which the policy auto-kills the active tool/run. */
  autoKillAfterMs: number;
  /** Active-tool age at which the policy escalates beyond auto-kill. */
  escalateAfterMs: number;
  /** When false, the policy is read-only (stages resolve but no actions fire). */
  enabled: boolean;
};

export const BLOCKED_TOOL_CALL_RECOVERY_DEFAULTS: Readonly<BlockedToolCallRecoveryPolicy> =
  Object.freeze({
    nudgeAfterMs: 60_000,
    autoKillAfterMs: 180_000,
    escalateAfterMs: 300_000,
    enabled: true,
  });

export const BLOCKED_TOOL_CALL_RECOVERY_MIN_THRESHOLD_MS = 5_000;

function clampThresholdMs(value: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(BLOCKED_TOOL_CALL_RECOVERY_MIN_THRESHOLD_MS, Math.floor(value));
}

/**
 * Resolves the blocked_tool_call recovery policy for a session. Looks up
 * `agents.defaults.blockedToolCallRecovery` on the config and falls back
 * to {@link BLOCKED_TOOL_CALL_RECOVERY_DEFAULTS} when unset or invalid.
 * The returned policy is monotonic: nudge < autoKill < escalate.
 */
export function resolveBlockedToolCallRecoveryPolicy(
  config?: OpenClawConfig,
): BlockedToolCallRecoveryPolicy {
  const configured = config?.agents?.defaults?.blockedToolCallRecovery;
  const defaults = BLOCKED_TOOL_CALL_RECOVERY_DEFAULTS;
  const rawNudge = clampThresholdMs(
    configured?.nudgeAfterMs ?? defaults.nudgeAfterMs,
    defaults.nudgeAfterMs,
  );
  const rawAutoKill = clampThresholdMs(
    configured?.autoKillAfterMs ?? defaults.autoKillAfterMs,
    defaults.autoKillAfterMs,
  );
  const rawEscalate = clampThresholdMs(
    configured?.escalateAfterMs ?? defaults.escalateAfterMs,
    defaults.escalateAfterMs,
  );
  const nudge = rawNudge;
  const autoKill = Math.max(nudge + 1_000, rawAutoKill);
  const escalate = Math.max(autoKill + 1_000, rawEscalate);
  return {
    nudgeAfterMs: nudge,
    autoKillAfterMs: autoKill,
    escalateAfterMs: escalate,
    enabled: configured?.enabled ?? defaults.enabled,
  };
}

/**
 * Maps an active-tool age (ms) to the recovery stage the policy prescribes.
 * `activeToolAgeMs < 0` is treated as 0 to keep the resolver stable across
 * callers that report age defensively. Unknown / future stages are clamped
 * to the strongest configured action.
 */
export function resolveBlockedToolCallRecoveryStage(params: {
  activeToolAgeMs: number;
  policy: BlockedToolCallRecoveryPolicy;
}): BlockedToolCallRecoveryStage {
  const age = Math.max(0, params.activeToolAgeMs);
  if (!params.policy.enabled) {
    return "none";
  }
  if (age >= params.policy.escalateAfterMs) {
    return "escalate";
  }
  if (age >= params.policy.autoKillAfterMs) {
    return "autoKill";
  }
  if (age >= params.policy.nudgeAfterMs) {
    return "nudge";
  }
  return "none";
}

/**
 * Returns the audit-event name a caller should emit when entering the
 * given stage. Kept as a separate helper so the audit log and the
 * classification table can be regenerated together without touching
 * the resolver.
 */
export function blockedToolCallStageAuditEvent(
  stage: BlockedToolCallRecoveryStage,
): string | undefined {
  switch (stage) {
    case "nudge":
      return "blocked_tool_call.recovery.nudge";
    case "autoKill":
      return "blocked_tool_call.recovery.auto_kill";
    case "escalate":
      return "blocked_tool_call.recovery.escalate";
    case "none":
      return undefined;
  }
}
