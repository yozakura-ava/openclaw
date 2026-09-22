// PATCH workboard-claim-conflict-history (issue #24, partial: closes the
// remaining gap from Ken's triage comment 2026-09-07): bounded in-memory
// ring buffer for takeover / claim-conflict events. Records the prior owner,
// prior expiry, attempted owner, and timestamp at the moment the claim
// fence fires. Operators query this surface for "who took over card X?"
// forensics without exposing runtime configuration paths in the public
// per-card diagnostic channel.
//
// Module-scoped (single source of truth for the process), capped at
// CLAIM_CONFLICT_HISTORY_CAP entries (FIFO). NOT persisted: restarts clear
// the buffer. This is intentional and matches the issue scope ("Keep
// diagnostic history bounded").
//
// Sibling of store-card-helpers.ts: extracted 2026-09-20 to satisfy the
// line-cap ratchet on store-card-helpers.ts. Backward-compat re-exports
// remain in store-card-helpers.ts so existing importers do not break.

const CLAIM_CONFLICT_HISTORY_CAP = 64;

type WorkboardClaimConflictKind =
  | "takeover" // foreign expired claim replaced (recorded just before rejection, prior owner kept in event)
  | "claim_on_done" // claim attempt on a card in "done" status (rejected)
  | "claim_on_archived"; // claim attempt on an archived card (rejected)

export interface WorkboardClaimConflictEvent {
  kind: WorkboardClaimConflictKind;
  cardId: string;
  attemptedOwnerId: string;
  priorOwnerId?: string;
  priorExpiresAt?: number;
  at: number;
}

const claimConflictHistory: WorkboardClaimConflictEvent[] = [];

export function recordClaimConflict(event: WorkboardClaimConflictEvent): void {
  claimConflictHistory.push(event);
  if (claimConflictHistory.length > CLAIM_CONFLICT_HISTORY_CAP) {
    claimConflictHistory.splice(0, claimConflictHistory.length - CLAIM_CONFLICT_HISTORY_CAP);
  }
}

export function snapshotClaimConflictHistory(): readonly WorkboardClaimConflictEvent[] {
  return claimConflictHistory.slice();
}

function clearClaimConflictHistory(): void {
  claimConflictHistory.length = 0;
}

export { clearClaimConflictHistory };
