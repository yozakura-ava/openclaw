import { createHash } from "node:crypto";
import type { WorkboardStatus } from "@openclaw/workboard-contract";
import type { WorkboardForceCloseReasonCode } from "./store-constants.js";

type WorkboardForceCloseAuditOutcome = "accepted" | "applied" | "rejected" | "storage_failed";

export type WorkboardForceCloseAuditEntry = {
  ts: string;
  agent_id: string;
  card_id: string;
  reason_code: WorkboardForceCloseReasonCode;
  explanation: string;
  reference_card_id: string | null;
  prior_status: WorkboardStatus;
  dbos_run_id: null;
  outcome: WorkboardForceCloseAuditOutcome;
  operation_id: string;
  aggregate?: boolean;
  card_ids?: string[];
};

export type PersistedWorkboardForceCloseAudit = {
  version: 1;
  audit: WorkboardForceCloseAuditEntry;
};

export function forceCloseAuditKey(entry: WorkboardForceCloseAuditEntry): string {
  return createHash("sha256")
    .update("openclaw:workboard-force-close-audit:v1\0")
    .update(entry.operation_id)
    .update("\0")
    .update(entry.outcome)
    .update("\0")
    .update(entry.aggregate === true ? "aggregate" : entry.card_id)
    .digest("hex");
}
