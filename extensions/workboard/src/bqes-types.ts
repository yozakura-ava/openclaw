import type { ExecutionIdentityInput } from "@openclaw/execution-contract";

export type BqesDbosReceipt = {
  workflowId: string;
  idempotencyKey: string;
  cardId: string;
  queue: string;
  runId: string;
  attemptId: string;
  ownerEpoch: string;
  acknowledgedAt: number;
};

type BqesState = "admitted" | "running" | "completed" | "failed" | "quarantined";
type BqesTerminalOwnership = "reaped" | "externally_handed_off";

export type BqesAdmissionInput = ExecutionIdentityInput & {
  attemptId: string;
  idempotencyKey: string;
  sourceIdentity: string;
  artifactIdentity: string;
  ownerEpoch: string;
  allowedFiles: string[];
  targetFiles?: string[];
  acceptanceCriteria: string[];
  verificationCommand: string;
  artifactPath?: string;
  buildArtifactPath?: string;
  documentedExemptPaths?: string[];
  now?: number;
};

export type BqesCompletionEvidence = {
  sourceIdentity: string;
  artifactIdentity: string;
  ownerEpoch: string;
  verification: { command: string; exitCode: number; outputHash: string };
  verificationProofHash: string;
  delivery: {
    idempotencyKey: string;
    acknowledged: true;
    acknowledgedAt: number;
  };
  ownership: {
    state: BqesTerminalOwnership;
    activeOwnedDescendants: number;
    openDescriptors: number;
    pendingCleanup: number;
  };
  provenance: {
    sourceSha: string;
    artifactDigest: string;
    buildIdentity: string;
  };
};

export type BqesVerificationPass = {
  proofHash: string;
  verifiedAt: number;
  reviewerPrincipal?: string;
  reviewerSession?: string;
  reviewerSessionIssuedAt?: number;
  reviewerSessionExpiresAt?: number;
};

export type BqesReviewer = {
  principal: string;
  session: string;
  issuedAt: number;
  expiresAt: number;
};

export type BqesAdmission = BqesAdmissionInput & {
  workflowId: string;
  dbosReceipt?: BqesDbosReceipt;
  state: BqesState;
  evidence?: BqesCompletionEvidence;
  verificationPass?: BqesVerificationPass;
  createdAt: number;
  updatedAt: number;
};

export type BqesFreezeReceipt = {
  token: string;
  reason: string;
  frozenAt: number;
};

export type ReceiptReconciliation = {
  outcome: "persisted" | "duplicate" | "replayed";
  admission: BqesAdmission;
};
