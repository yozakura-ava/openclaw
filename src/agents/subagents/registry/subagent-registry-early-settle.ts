import type { AgentRunTerminalReplySnapshot } from "../../agent-run-terminal-reply.types.js";
import type { SpawnSubagentMode } from "../spawn/subagent-spawn.types.js";
import type { SubagentRunOutcome } from "../subagent-run-outcome.types.js";
import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_EXITED_EARLY,
  SUBAGENT_ENDED_OUTCOME_EXITED_EARLY,
  type SubagentLifecycleEndedReason,
} from "./subagent-lifecycle-events.js";

export type SubagentEarlySettleInputs = {
  spawnMode?: SpawnSubagentMode;
  expectsCompletionMessage?: boolean;
  collect?: boolean;
  completionOutcome: SubagentRunOutcome;
  completionReason: SubagentLifecycleEndedReason;
  terminalReply?: AgentRunTerminalReplySnapshot;
};

export type SubagentEarlySettleResolution = {
  completionOutcome: SubagentRunOutcome;
  completionReason: SubagentLifecycleEndedReason;
  appliedEarlySettle: boolean;
};

/** A terminal reply is visible only when it contains non-empty assistant text. */
function hasVisibleFinalAnswer(terminalReply?: AgentRunTerminalReplySnapshot): boolean {
  return (
    terminalReply?.disposition === "visible" &&
    typeof terminalReply.text === "string" &&
    terminalReply.text.trim().length > 0
  );
}

/** Classifies the one successful lifecycle shape that is actually an early exit. */
export function resolveSubagentCompletionOutcomeReason(
  inputs: SubagentEarlySettleInputs,
): SubagentEarlySettleResolution {
  if (
    inputs.spawnMode === "run" &&
    inputs.expectsCompletionMessage === true &&
    inputs.collect !== true &&
    inputs.completionOutcome.status === "ok" &&
    inputs.completionReason === SUBAGENT_ENDED_REASON_COMPLETE &&
    !hasVisibleFinalAnswer(inputs.terminalReply)
  ) {
    return {
      completionOutcome: { status: SUBAGENT_ENDED_OUTCOME_EXITED_EARLY },
      completionReason: SUBAGENT_ENDED_REASON_EXITED_EARLY,
      appliedEarlySettle: true,
    };
  }
  return {
    completionOutcome: inputs.completionOutcome,
    completionReason: inputs.completionReason,
    appliedEarlySettle: false,
  };
}
