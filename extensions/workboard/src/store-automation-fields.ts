import type { WorkboardAutomation } from "@openclaw/workboard-contract";

export function removeUndefinedAutomationFields(
  automation: WorkboardAutomation,
): WorkboardAutomation {
  const next = { ...automation };
  for (const key of [
    "tenant",
    "boardId",
    "createdByCardId",
    "idempotencyKey",
    "skills",
    "workspace",
    "workspaceAccess",
    "maxRuntimeSeconds",
    "maxRetries",
    "scheduledAt",
    "summary",
    "createdCardIds",
    "dispatchCount",
    "lastDispatchAt",
    "launch",
  ] as const) {
    const value = next[key];
    if (
      value === undefined ||
      (Array.isArray(value) && value.length === 0) ||
      (typeof value === "object" && value !== null && Object.keys(value).length === 0)
    ) {
      delete next[key];
    }
  }
  return next;
}
