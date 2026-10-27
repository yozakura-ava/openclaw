import type {
  WorkboardCard,
  WorkboardClaim,
  WorkboardExecution,
  WorkboardMetadata,
} from "@openclaw/workboard-contract";
import {
  isFutureDateTimestampMs,
  MAX_DATE_TIMESTAMP_MS,
  resolveExpiresAtMsFromDurationMs,
} from "openclaw/plugin-sdk/number-runtime";

export const POSITION_STEP = 1000;
export const MAX_CARDS = 2000;
export const MAX_CARD_EVENTS = 50;
export const MAX_CARD_ATTEMPTS = 30;
export const MAX_CARD_COMMENTS = 50;
export const MAX_CARD_LINKS = 50;
export const MAX_CARD_PROOF = 40;
export const MAX_CARD_ARTIFACTS = 40;
export const MAX_CARD_ATTACHMENTS = 20;
export const MAX_CARD_WORKER_LOGS = 40;
export const MAX_WORKER_CONTEXT_PARENTS = 6;
export const MAX_WORKER_CONTEXT_RECENT_CARDS = 5;
export const MAX_ATTACHMENT_BYTES = 256 * 1024;
export const MAX_CARD_DIAGNOSTICS = 12;
export const MAX_CARD_NOTIFICATIONS = 20;
export const MAX_RUN_ID_LENGTH = 512;
export const MAX_CARD_METADATA_BYTES = 24 * 1024;
export const MAX_COMMENT_BODY_LENGTH = 4096;
/**
 * Card-notes budget. Raised from the implicit 4000 (card b21ff3c9): the s4
 * manifest-repair footer (8d9c4b48 pattern) did not fit in 4000 chars, so the
 * audit split between notes and comments and notes-only gates lost context.
 * 12000 keeps a full repair section + standard notes inside one notes field
 * while staying well under the 24 KiB card-metadata budget.
 */
export const MAX_NOTES_LENGTH = 12_000;
/**
 * Attribution used when a comment/proof write carries no actor (card
 * 9dd79ad6): the write still happened, via the workboard system itself, so it
 * is attributed to the system writer instead of landing anonymous. Historical
 * NULL rows are tolerated (never backfilled — they predate attribution and
 * cannot be truthfully attributed).
 */
export const WORKBOARD_SYSTEM_ACTOR_ID = "workboard-system";
export const WORKBOARD_SYSTEM_ACTOR_KIND = "system";
export const DEFAULT_CLAIM_TTL_MS = 30 * 60 * 1000;
export const DEFAULT_WORKBOARD_DISPATCH_OWNER = "workboard-dispatcher";
// Maximum concurrent Workboard claims a single owner may hold. Reclaimable
// (expired) claims do not consume a slot — only active or heartbeat-grace
// claims count. Both the store-layer claimIfOwnerAvailable and the dispatcher
// selectStartableCards threshold read this constant; do not inline a literal.
export const MAX_OWNER_CLAIMS = 3;
export const READY_STRANDED_MS = 60 * 60 * 1000;
export const RUNNING_HEARTBEAT_STALE_MS = 20 * 60 * 1000;
export const BLOCKED_TOO_LONG_MS = 24 * 60 * 60 * 1000;
const CLAIM_RECLAIM_MS = 5 * 60 * 1000;

export function isWorkboardClaimReclaimable(
  claim: WorkboardClaim | undefined,
  now: number,
): boolean {
  return Boolean(claim?.expiresAt && now - claim.expiresAt > CLAIM_RECLAIM_MS);
}

type WorkboardOwnerSlotCard = Pick<WorkboardCard, "status" | "agentId"> & {
  execution?: Pick<WorkboardExecution, "status">;
  metadata?: Pick<WorkboardMetadata, "claim" | "archivedAt">;
};

export function workboardCardConsumesOwnerSlot(card: WorkboardOwnerSlotCard, now: number): boolean {
  const claim = card.metadata?.claim;
  const activeClaim = claim && isFutureDateTimestampMs(claim.expiresAt, { nowMs: now });
  return (
    !card.metadata?.archivedAt &&
    !isWorkboardClaimReclaimable(claim, now) &&
    (card.status === "running" ||
      (card.status !== "done" && activeClaim) ||
      card.execution?.status === "running")
  );
}

export function workboardCardSlotOwner(card: WorkboardOwnerSlotCard, now?: number): string {
  const claim = card.metadata?.claim;
  // Ready candidates pass now to ignore expired claims. Occupied slots omit it
  // so the claim owner keeps its slot through the heartbeat-reclaim grace period.
  return (
    (claim && (now === undefined || isFutureDateTimestampMs(claim.expiresAt, { nowMs: now }))
      ? claim.ownerId
      : undefined) ||
    card.agentId ||
    DEFAULT_WORKBOARD_DISPATCH_OWNER
  );
}

export function secondsToDurationMs(seconds: number): number {
  const ms = Math.trunc(seconds) * 1000;
  return Number.isFinite(ms)
    ? Math.min(MAX_DATE_TIMESTAMP_MS, Math.max(1, ms))
    : MAX_DATE_TIMESTAMP_MS;
}

export function addWorkboardDurationMs(now: number, durationMs: number): number {
  return resolveExpiresAtMsFromDurationMs(durationMs, { nowMs: now }) ?? MAX_DATE_TIMESTAMP_MS;
}
