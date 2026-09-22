import type {
  WorkboardCard,
  WorkboardEvent,
  WorkboardMetadata,
  WorkboardReviewVerdict,
  WorkboardStatus,
} from "@openclaw/workboard-contract";
import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

export type WorkboardUpdateCardOptions = {
  allowAutomationLaunch?: boolean;
  allowGovernedCompletion?: boolean;
  allowReviewVerdict?: boolean;
  allowMetadataDependencyLinks?: boolean;
  enforceStatusHolds?: boolean;
  event?: Omit<WorkboardEvent, "id" | "at">;
  eventAt?: number;
  expectedUpdatedAt?: number;
  ownerSlot?: { ownerId: string; now: number };
  preserveProofId?: string;
};

export type WorkboardMetadataUpdateOptions = Pick<
  WorkboardUpdateCardOptions,
  "allowReviewVerdict" | "preserveProofId" | "expectedUpdatedAt"
>;

export type WorkboardMetadataNormalizationOptions = {
  allowDependencyLinks?: boolean;
  allowArchivedAt?: boolean;
  allowAutomationLaunch?: boolean;
  allowReviewRequired?: boolean;
  allowReviewVerdict?: boolean;
  preserveProofId?: string;
};

type WorkboardReviewNormalizationOptions = {
  allowReviewRequired?: boolean;
  allowReviewVerdict?: boolean;
};

export function normalizeReviewMetadata(
  record: Record<string, unknown>,
  fallback: WorkboardMetadata,
  options: WorkboardReviewNormalizationOptions,
): Pick<WorkboardMetadata, "reviewRequired" | "reviewVerdict"> {
  return {
    reviewRequired:
      options.allowReviewRequired && typeof record.reviewRequired === "boolean"
        ? record.reviewRequired
        : fallback.reviewRequired,
    reviewVerdict: options.allowReviewVerdict
      ? normalizeReviewVerdict(record.reviewVerdict, fallback.reviewVerdict)
      : fallback.reviewVerdict,
  };
}

function normalizeReviewVerdict(
  value: unknown,
  fallback?: WorkboardReviewVerdict,
): WorkboardReviewVerdict | undefined {
  if (!isRecord(value) || typeof value.verified !== "boolean") {
    return fallback;
  }
  const reviewerId = normalizeOptionalString(value.reviewerId);
  if (!reviewerId || reviewerId.length > 120) {
    return fallback;
  }
  const summary = normalizeOptionalString(value.summary);
  return {
    verified: value.verified,
    reviewerId,
    reviewedAt:
      typeof value.reviewedAt === "number" && Number.isFinite(value.reviewedAt)
        ? Math.max(0, Math.trunc(value.reviewedAt))
        : Date.now(),
    ...(summary && summary.length <= 1000 ? { summary } : {}),
  };
}

export function assertGovernedCompletionAllowed(
  card: WorkboardCard,
  status: WorkboardStatus,
  allowGovernedCompletion?: boolean,
): void {
  if (
    status === "done" &&
    card.metadata?.reviewRequired === true &&
    !allowGovernedCompletion &&
    (card.status !== "review" || card.metadata.reviewVerdict?.verified !== true)
  ) {
    throw new Error("card requires a verified review verdict before completion.");
  }
}

export function stripUnprivilegedReviewVerdict(
  metadata: WorkboardMetadata,
  allowReviewVerdict?: boolean,
): WorkboardMetadata {
  return !allowReviewVerdict && metadata.reviewVerdict
    ? { ...metadata, reviewVerdict: undefined }
    : metadata;
}

export function removeUndefinedReviewMetadataFields(
  metadata: WorkboardMetadata,
): WorkboardMetadata {
  const next = { ...metadata };
  if (next.reviewRequired === undefined) {
    delete next.reviewRequired;
  }
  if (next.reviewVerdict === undefined) {
    delete next.reviewVerdict;
  }
  return next;
}
