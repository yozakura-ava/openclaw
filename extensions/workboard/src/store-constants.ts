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
export const DEFAULT_CLAIM_TTL_MS = 30 * 60 * 1000;
export const DEFAULT_MAX_CONCURRENT_CLAIMS_PER_OWNER = 10;
export const DEFAULT_WORKBOARD_DISPATCH_OWNER = "workboard-dispatcher";
export const READY_STRANDED_MS = 60 * 60 * 1000;
export const RUNNING_HEARTBEAT_STALE_MS = 20 * 60 * 1000;
export const BLOCKED_TOO_LONG_MS = 24 * 60 * 60 * 1000;
const CLAIM_RECLAIM_MS = 5 * 60 * 1000;

// workboard_force_close tool (card 32d1c50d, restored from commit
// a0cf0f66c72 / branch canonical-bqes-dbos-cutover, validated 173/173 in the
// 2026-08-24 session). The reason-code enum is closed: completion-shaped
// reasons ("built", "verified", etc.) are deliberately NOT in this list so
// the override can never become a general completion bypass. Reference card
// is required for superseded/duplicate; cancelled/invalid accept a free
// explanation without one.
export const WORKBOARD_FORCE_CLOSE_REASON_CODES = [
  "superseded",
  "duplicate",
  "cancelled",
  "invalid",
] as const;
export type WorkboardForceCloseReasonCode = (typeof WORKBOARD_FORCE_CLOSE_REASON_CODES)[number];

// Default orchestrator agents allowed to invoke workboard_force_close. The
// store constructor accepts a forceCloseAllowedAgents override which
// REPLACES this default (does NOT extend it) — operators wanting to grant
// additional agents should pass them via the env-driven wiring in
// `readConfiguredForceCloseAgents()` rather than editing this default.
export const DEFAULT_FORCE_CLOSE_AGENTS = ["ava"];

// Operators (Craig and his operator:*/agent:* aliases) are always allowed
// regardless of the configured agent allowlist. This matches the runbook
// "operator is always allowed" clause and gives Craig a hard-coded escape
// hatch even if the agent allowlist is misconfigured.
export const DEFAULT_FORCE_CLOSE_OPERATORS = ["craig", "operator:craig", "agent:craig"];

// Append-only audit log for force-close actions. The directory is created
// (mode 0700) on first write; the file is chmod 0600 on every append so
// later permission drift cannot silently widen read access.
export const DEFAULT_WORKBOARD_FORCE_CLOSE_AUDIT_PATH =
  "/root/.openclaw/workspace/data/workboard/force-closes.jsonl";

// Bounded by the same comment cap (4000 chars) so a runaway orchestrator
// cannot append megabytes to a single force-close comment / audit entry.
export const WORKBOARD_FORCE_CLOSE_EXPLANATION_MIN_LENGTH = 20;
export const WORKBOARD_FORCE_CLOSE_EXPLANATION_MAX_LENGTH = 4000;

export function isWorkboardClaimReclaimable(
  claim: WorkboardClaim | undefined,
  now: number,
): boolean {
  return Boolean(claim?.expiresAt && now - claim.expiresAt > CLAIM_RECLAIM_MS);
}

// R4 multi-card concurrency (card f88f4ec9): configurable per-owner claim
// limit. Falls back to the default on any invalid value so a config typo can
// never produce an accidental 0 (total lockout) or an unlimited board.
export function normalizeMaxConcurrentClaimsPerOwner(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 1) {
    return value;
  }
  return DEFAULT_MAX_CONCURRENT_CLAIMS_PER_OWNER;
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
