import type { AgentRunTerminalReplySnapshot } from "../../agent-run-terminal-reply.js";
import type { SubagentRunOutcome } from "../announce/subagent-announce-output.js";
/**
 * Pure helper for fork issue #106 (Ask #1) — early-settle guard.
 *
 * A spawned mode=run child whose run ends on a normal stop WITHOUT a final
 * answer must NOT settle as completed. Surface the distinct `exited-early`
 * outcome + reason so requester drain and post-mortem surfaces can tell
 * an early stop apart from `ok`/`error`.
 *
 * Sibling mode=session behavior is preserved: when expectsCompletionMessage
 * is true and there is no terminal reply, fall through to the existing
 * `MISSING_REQUIRED_FINAL_REPLY_ERROR` branch (the caller is responsible for
 * applying that branch separately).
 *
 * Kept side-effect-free so it can be unit-tested without mocking the full
 * registry / lifecycle / session-effect chain.
 */
import type { SpawnSubagentMode } from "../spawn/subagent-spawn.types.js";
import {
  SUBAGENT_ENDED_OUTCOME_EXITED_EARLY,
  SUBAGENT_ENDED_REASON_EXITED_EARLY,
  SUBAGENT_ENDED_REASON_KILLED,
  type SubagentLifecycleEndedReason,
} from "./subagent-lifecycle-events.js";

export type SubagentEarlySettleInputs = {
  spawnMode?: SpawnSubagentMode;
  completionOutcome: SubagentRunOutcome;
  completionReason: SubagentLifecycleEndedReason;
  terminalReply?: AgentRunTerminalReplySnapshot;
};

export type SubagentEarlySettleResolution = {
  completionOutcome: SubagentRunOutcome;
  completionReason: SubagentLifecycleEndedReason;
  /** True iff the resolver replaced the outcome with `exited-early`. */
  appliedEarlySettle: boolean;
};

/** True when the terminal reply carries a non-empty visible assistant text. */
export function hasVisibleFinalAnswer(terminalReply?: AgentRunTerminalReplySnapshot): boolean {
  return (
    terminalReply?.disposition === "visible" &&
    typeof terminalReply.text === "string" &&
    terminalReply.text.trim().length > 0
  );
}

/**
 * Resolve the (outcome, reason) pair that `completeSubagentRunAttempt`
 * should commit. The early-settle guard fires only for mode=run children
 * with no visible final answer; everything else is passed through
 * unchanged so existing behavior is preserved exactly.
 */
export function resolveSubagentCompletionOutcomeReason(
  inputs: SubagentEarlySettleInputs,
): SubagentEarlySettleResolution {
  const { spawnMode, completionOutcome, completionReason, terminalReply } = inputs;
  if (
    spawnMode === "run" &&
    completionOutcome.status === "ok" &&
    completionReason !== SUBAGENT_ENDED_REASON_KILLED &&
    !hasVisibleFinalAnswer(terminalReply)
  ) {
    return {
      completionOutcome: { status: SUBAGENT_ENDED_OUTCOME_EXITED_EARLY },
      completionReason: SUBAGENT_ENDED_REASON_EXITED_EARLY,
      appliedEarlySettle: true,
    };
  }
  return {
    completionOutcome,
    completionReason,
    appliedEarlySettle: false,
  };
}
