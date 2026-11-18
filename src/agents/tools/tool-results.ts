import type { AgentToolResult } from "../../../packages/agent-core/src/types.js";

export function textResult<TDetails>(text: string, details: TDetails): AgentToolResult<TDetails> {
  return {
    content: [{ type: "text", text }],
    details,
  };
}

export function jsonResult<TDetails>(payload: TDetails): AgentToolResult<TDetails> {
  return textResult(JSON.stringify(payload, null, 2), payload);
}

/**
 * Slim mutation echo result (card 609ef9bd). Carries `ok: true` explicitly:
 * card payloads legitimately contain `status: "blocked"`, which the host
 * tool-failure contract (isToolResultError) would otherwise misread as a
 * failed tool call. Explicit success keeps blocked-card mutations out of the
 * host failure contract while preserving the slim {id,status,changed} echo.
 */
export function cardMutationResult<TDetails extends { status?: unknown }>(
  payload: TDetails,
): AgentToolResult<TDetails> {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    details: { ...payload, ok: true },
  };
}
