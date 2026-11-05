import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { PreparedMessageToolCatalog } from "../../channels/plugins/message-action-discovery.js";
import type { ChannelMessageActionName } from "../../channels/plugins/types.public.js";
import { MessageActionDeniedError } from "../../infra/outbound/message-action-denial.js";
import {
  actionRequiresTarget,
  resolveActionDeliveryTargetAlias,
} from "../../infra/outbound/message-action-spec.js";
import { normalizeMessageChannel } from "../../utils/message-channel.js";
import { asToolParamsRecord, type AnyAgentTool, readToolStringParam } from "./common.js";
import { createMessageToolDecisionRecorder } from "./message-tool-decision.js";

type ExplicitMessageTargetContext = {
  currentChannelProvider?: string;
  preparedMessageToolCatalog?: PreparedMessageToolCatalog;
};

type ExplicitMessageTargetGuard = {
  prepareBeforeToolCallParams: NonNullable<AnyAgentTool["prepareBeforeToolCallParams"]>;
  finalizeBeforeToolCallParams: NonNullable<AnyAgentTool["finalizeBeforeToolCallParams"]>;
  require(params: Record<string, unknown>, action: ChannelMessageActionName): void;
};

function jsonTypeName(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}

// The deferred tool_call surface truncates the compact schema hint before the
// `target: string` annotation, so isolated automation runs emit numeric chat
// ids as bare JSON numbers (card 45db88cf: 54/54 cron failures carried a
// numeric target). Coerce the number to its string form IN PLACE so the params
// object identity is preserved (the finalize guard keys a WeakMap on it) and
// the strict Type.String() parameter schema still validates.
function normalizeExplicitTargetParams(params: Record<string, unknown>): void {
  if (typeof params.target === "number" && Number.isFinite(params.target)) {
    params.target = String(params.target);
  }
  const targets = params.targets;
  if (Array.isArray(targets)) {
    for (let index = 0; index < targets.length; index += 1) {
      const entry = targets[index];
      if (typeof entry === "number" && Number.isFinite(entry)) {
        targets[index] = String(entry);
      }
    }
  }
}

function describeExplicitTargetTypeProblem(params: Record<string, unknown>): string | undefined {
  for (const field of ["target", "to", "channelId"] as const) {
    const value = params[field];
    if (value !== undefined && typeof value !== "string") {
      return `${field} must be a string (received ${jsonTypeName(value)})`;
    }
  }
  if (params.targets !== undefined) {
    if (!Array.isArray(params.targets)) {
      return `targets must be an array of strings (received ${jsonTypeName(params.targets)})`;
    }
    const invalidEntry = params.targets.find((value) => typeof value !== "string");
    if (invalidEntry !== undefined) {
      return `targets must be an array of strings (received an array containing ${jsonTypeName(invalidEntry)})`;
    }
  }
  return undefined;
}

function requireExplicitMessageTarget(
  params: Record<string, unknown>,
  action: ChannelMessageActionName,
  context: ExplicitMessageTargetContext,
): void {
  if (action !== "broadcast" && !actionRequiresTarget(action)) {
    return;
  }
  const hasCanonicalTarget =
    (typeof params.target === "string" && params.target.trim().length > 0) ||
    (typeof params.to === "string" && params.to.trim().length > 0) ||
    (typeof params.channelId === "string" && params.channelId.trim().length > 0) ||
    (Array.isArray(params.targets) &&
      params.targets.some((value) => typeof value === "string" && value.trim().length > 0));
  if (hasCanonicalTarget) {
    return;
  }
  const channel =
    normalizeMessageChannel(normalizeOptionalString(params.channel)) ??
    normalizeMessageChannel(context.currentChannelProvider);
  const aliasSpec = channel
    ? context.preparedMessageToolCatalog?.getChannel(channel)?.actions
        ?.messageActionTargetAliases?.[action]
    : undefined;
  if (
    channel &&
    aliasSpec &&
    resolveActionDeliveryTargetAlias(action, params, { channel, aliasSpec })
  ) {
    return;
  }
  const typeProblem = describeExplicitTargetTypeProblem(params);
  if (typeProblem) {
    // A target WAS supplied but with an unusable type. Name the mismatch
    // instead of claiming the target is missing: the misleading "required"
    // denial is what drove the numeric-target retry storm (card 45db88cf).
    throw new MessageActionDeniedError(
      `Explicit message target was supplied with an unsupported type: ${typeProblem}. Re-send the target as a string.`,
      "message_target_invalid_type",
      "message-target:explicit",
    );
  }
  throw new MessageActionDeniedError(
    "Explicit message target required for this run. Provide target/targets (and channel when needed).",
    "message_target_missing",
    "message-target:explicit",
  );
}

export function createMessageToolExplicitTargetGuard(params: {
  currentChannelProvider?: string;
  preparedMessageToolCatalog?: PreparedMessageToolCatalog;
  decisionChannel?: string;
}): ExplicitMessageTargetGuard {
  const toolCallIds = new WeakMap<object, string>();
  const requireTarget = (actionParams: Record<string, unknown>, action: ChannelMessageActionName) =>
    requireExplicitMessageTarget(actionParams, action, params);

  return {
    prepareBeforeToolCallParams(rawParams, hookContext) {
      if (rawParams && typeof rawParams === "object") {
        normalizeExplicitTargetParams(rawParams as Record<string, unknown>);
        if (hookContext.toolCallId) {
          toolCallIds.set(rawParams, hookContext.toolCallId);
        }
      }
      return rawParams;
    },
    finalizeBeforeToolCallParams(rawParams, preparedParams) {
      const actionParams = asToolParamsRecord(rawParams);
      const actionId =
        preparedParams && typeof preparedParams === "object"
          ? toolCallIds.get(preparedParams)
          : undefined;
      const action = readToolStringParam(actionParams, "action", {
        required: true,
      }) as ChannelMessageActionName; // SAFETY: the message tool schema owns this closed vocabulary.
      if (!actionId) {
        requireTarget(actionParams, action);
        return rawParams;
      }
      createMessageToolDecisionRecorder({
        actionId,
        action,
        channel: params.decisionChannel,
      }).runBoundary(() => requireTarget(actionParams, action));
      return rawParams;
    },
    require: requireTarget,
  };
}
