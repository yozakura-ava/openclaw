import type { WorkboardCard, WorkboardClaim } from "@openclaw/workboard-contract";
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
export const MAX_ATTACHMENT_BYTES = 256 * 1024;
export const MAX_CARD_DIAGNOSTICS = 12;
export const MAX_CARD_NOTIFICATIONS = 20;
export const MAX_CARD_METADATA_BYTES = 24 * 1024;
export const MAX_COMMENT_BODY_LENGTH = 4096;
export const DEFAULT_CLAIM_TTL_MS = 30 * 60 * 1000;
export const DEFAULT_WORKBOARD_DISPATCH_OWNER = "workboard-dispatcher";
export const READY_STRANDED_MS = 60 * 60 * 1000;
export const RUNNING_HEARTBEAT_STALE_MS = 20 * 60 * 1000;
export const BLOCKED_TOO_LONG_MS = 24 * 60 * 60 * 1000;
// PATCH workboard-bounded-multi-claim (card a2deceee, issue #52/#96):
// bounded concurrent claim slots per owner lane. DEFAULT = 2 to match the
// sprint target range ("configurable default 2-3"); operators can raise via
// WorkboardStore.setClaimConfig() or env OPENCLAW_WORKBOARD_MAX_CLAIMS_PER_OWNER.
export const DEFAULT_MAX_CLAIMS_PER_OWNER = 2;
// Lane-aware means the slot counter groups owners by the substring before
// the first ":" (e.g. "reina:review-abc" and "reina:sprint-xyz" share
// lane "reina"). Disable for legacy single-claim-per-full-ownerId semantics.
export const DEFAULT_LANE_AWARE_CLAIMS = true;
const CLAIM_RECLAIM_MS = 5 * 60 * 1000;

// PATCH workboard-bounded-multi-claim (card a2deceee, issue #52/#96):
// Resolve the lane prefix from a session-scoped owner id. The lane is the
// substring before the first ":" — "reina:review-abc123" → "reina". Bare
// agent ids ("reina") resolve to themselves so a legacy single-token agent
// still has a single lane. Empty/whitespace input collapses to "" so
// call sites that miss owner validation produce a deterministic lane key.
export function deriveOwnerLane(ownerId: string | undefined | null): string {
  if (typeof ownerId !== "string") return "";
  const trimmed = ownerId.trim();
  if (!trimmed) return "";
  const colonIdx = trimmed.indexOf(":");
  return colonIdx > 0 ? trimmed.slice(0, colonIdx) : trimmed;
}

export function isWorkboardClaimReclaimable(
  claim: WorkboardClaim | undefined,
  now: number,
): boolean {
  return Boolean(claim?.expiresAt && now - claim.expiresAt > CLAIM_RECLAIM_MS);
}

export function workboardCardConsumesOwnerSlot(card: WorkboardCard, now: number): boolean {
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

export function workboardCardSlotOwner(card: WorkboardCard, now?: number): string {
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
