import type { AdmissionEnvelope, ExecutionIdentityInput } from "@openclaw/execution-contract";

export type DbosWorkflowInput = ExecutionIdentityInput & {
  attemptId: string;
  idempotencyKey: string;
  ownerEpoch: string;
  now?: number;
};

export type DbosReceipt = {
  workflowId: string;
  idempotencyKey: string;
  cardId: string;
  queue: string;
  runId: string;
  attemptId: string;
  ownerEpoch: string;
  acknowledgedAt: number;
  operationKey?: string;
  state?: "admitted";
  serverTimestamp?: number;
  sdkWorkflowId?: string;
};

export type DbosAuthority = {
  admit(
    input: DbosWorkflowInput & { envelope?: AdmissionEnvelope },
  ): DbosReceipt | Promise<DbosReceipt>;
  start(workflowId: string, ownerEpoch: string): unknown;
  fail?(workflowId: string, detail: string): unknown;
  complete?(workflowId: string, evidence: unknown): unknown;
};
