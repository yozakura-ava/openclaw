// Workboard claim reaper (card 7decbc47-2073-49df-945d-73f7f35ef9fa)
//
// Composes with the STABLE isWorkboardClaimReclaimable API in store-constants.ts
// to identify cards whose claims have expired and reap them. Defaults to
// review-status cards because the bounded dispatch pass already reaps running
// cards via store.ts:479; review/done-adjacent cards are the gap.
//
// The reaper is intentionally a separate module so:
//   - the reaper's tests do not need to run the full workboard vitest suite
//     (HR5: targeted only), and
//   - changes to the reaper cannot accidentally mutate the STABLE API.
//
// Caller supplies the store and a clock; this module performs no I/O of its
// own beyond what the store surfaces (save a comment, update metadata).

import { randomUUID } from "node:crypto";
import type { WorkboardCard } from "@openclaw/workboard-contract";
import { MAX_CARD_COMMENTS, MAX_CARD_NOTIFICATIONS } from "./store-constants.js";
import { isWorkboardClaimReclaimable } from "./store-constants.js";
import type { WorkboardStore } from "./store.js";

export type ReapEligibleStatus =
  | "review"
  | "running"
  | "ready"
  | "todo"
  | "backlog"
  | "blocked"
  | "scheduled"
  | "triage"
  | "done";

export type SelectExpiredClaimsOptions = {
  /** Statuses the reaper is allowed to touch. Default: ["review"]. */
  eligibleStatuses?: ReadonlyArray<ReapEligibleStatus>;
  /** When false, archived cards are also eligible. Default: false (skip archived). */
  includeArchived?: boolean;
};

export type ReapCandidate = {
  card: WorkboardCard;
  reason: "expired_claim" | "sentinel_claim";
};

export type ReapExpiredClaimsOnCardsOptions = SelectExpiredClaimsOptions & {
  /** Audit trail comment body. Default: "reaper: expired claim reaped". */
  auditComment?: string;
  /** When false, skip audit comment. Default: true. */
  addAuditComment?: boolean;
  /** When false, do not write to the store (dry-run). Default: false. */
  dryRun?: boolean;
};

export type ReapResult = {
  reaped: WorkboardCard[];
  skipped: Array<{ card: WorkboardCard; reason: string }>;
  candidates: ReapCandidate[];
};

/**
 * Pure selector: given a list of cards and a clock, return the subset whose
 * claims should be reaped by the reaper. Does not mutate inputs.
 *
 * A card qualifies when:
 *   - its status is in `eligibleStatuses` (default: ["review"]),
 *   - it has a `metadata.claim` set,
 *   - `isWorkboardClaimReclaimable(claim, now)` returns true (uses the
 *     STABLE API; honors the dispatcher release-sentinel expiresAt=0).
 *
 * The "reason" field distinguishes sentinel claims (expiresAt=0) from
 * ordinary expired claims so callers can log/audit them differently.
 */
export function selectExpiredClaimsForReaping(
  cards: ReadonlyArray<WorkboardCard>,
  now: number,
  options: SelectExpiredClaimsOptions = {},
): ReapCandidate[] {
  const eligible = new Set<ReapEligibleStatus>(
    options.eligibleStatuses ?? (["review"] as ReapEligibleStatus[]),
  );
  const includeArchived = options.includeArchived === true;
  const out: ReapCandidate[] = [];
  for (const card of cards) {
    if (!includeArchived && card.metadata?.archivedAt) {
      continue;
    }
    if (!eligible.has(card.status as ReapEligibleStatus)) {
      continue;
    }
    const claim = card.metadata?.claim;
    if (!claim) {
      continue;
    }
    if (!isWorkboardClaimReclaimable(claim, now)) {
      continue;
    }
    out.push({
      card,
      reason: claim.expiresAt === 0 ? "sentinel_claim" : "expired_claim",
    });
  }
  return out;
}

/**
 * Apply the reap: clear `metadata.claim` on each selected card and record
 * an audit comment. Returns the reaped cards in store-mutation order.
 *
 * - Does NOT touch running cards (the bounded dispatch pass already handles
 *   those via store.ts:479). `eligibleStatuses` defaults to ["review"].
 * - Composes with `isWorkboardClaimReclaimable`; never overrides it.
 * - When `dryRun` is true, returns the same `candidates` without writing.
 */
export async function reapExpiredClaimsOnCards(
  store: WorkboardStore,
  cards: ReadonlyArray<WorkboardCard>,
  now: number,
  options: ReapExpiredClaimsOnCardsOptions = {},
): Promise<ReapResult> {
  const addAuditComment = options.addAuditComment !== false;
  const auditComment = options.auditComment ?? "reaper: expired claim reaped (no active worker).";
  const dryRun = options.dryRun === true;
  const candidates = selectExpiredClaimsForReaping(cards, now, options);
  const reaped: WorkboardCard[] = [];
  const skipped: Array<{ card: WorkboardCard; reason: string }> = [];
  if (dryRun) {
    return { candidates, reaped, skipped };
  }
  for (const candidate of candidates) {
    const existing = await store.get(candidate.card.id);
    if (!existing) {
      skipped.push({ card: candidate.card, reason: "missing" });
      continue;
    }
    // Re-validate after re-reading in case the claim was refreshed
    // between selection and apply.
    const liveClaim = existing.metadata?.claim;
    if (!liveClaim || !isWorkboardClaimReclaimable(liveClaim, now)) {
      skipped.push({ card: existing, reason: "claim_refreshed_before_write" });
      continue;
    }
    const nextMetadata = { ...existing.metadata, claim: undefined };
    if (addAuditComment) {
      nextMetadata.comments = [
        ...(nextMetadata.comments ?? []),
        { id: randomUUID(), body: auditComment, createdAt: now },
      ].slice(-MAX_CARD_COMMENTS);
    }
    const updated = await store.updateCard(existing.id, {
      metadata: nextMetadata,
    });
    reaped.push(updated);
  }
  return { candidates, reaped, skipped };
}

/**
 * High-level convenience: list all cards on the board, filter to the
 * reaper's eligible statuses, and reap their expired claims.
 */
export async function reapExpiredClaims(
  store: WorkboardStore,
  now: number,
  options: ReapExpiredClaimsOnCardsOptions = {},
): Promise<ReapResult> {
  const cards = await store.list({});
  return await reapExpiredClaimsOnCards(store, cards, now, options);
}

// Internal helper retained for callers that want a stable import surface
// without reaching into store-constants directly.
export { isWorkboardClaimReclaimable };
// Re-export MAX_CARD_NOTIFICATIONS so reaper audit consumers don't need to
// import from store-constants directly (defensive: keeps the reaper's
// surface area small if the constant moves).
export { MAX_CARD_NOTIFICATIONS };
