/**
 * Durable dropped-delivery marker for abandoned requester settle wake batches.
 *
 * When the requester settle wake transport exhausts its bounded retry,
 * deferral, or attempt budget, the wake module calls
 * `recordRequesterSettleWakeDeliveryDropped` to write a queryable marker on the
 * parent (requester) session. The marker lives alongside `pendingFinalDelivery`
 * and `pendingDeliveryNotice` but is intentionally distinct: a normal
 * completion handoff must never overwrite a dropped-delivery record and a
 * dropped-delivery write must never be silently swallowed by a later happy
 * path. The marker is the durable surface for fork issue #106 (Ask #2)
 * and mirrors the bounded terminal behavior asserted by
 * `subagent-registry.requester-wake.e2e.test.ts`.
 *
 * The helper is intentionally side-effect-only — call sites control the
 * ordering (write the marker, then complete the batch) so any future
 * delivery-recovery loop can read the marker and decide whether to retry
 * without losing the abandonment signal.
 */
import { patchSessionEntryWithKey } from "../../../config/sessions/session-accessor.js";
import type { RequesterSettleWakeDroppedDeliveryState } from "../../../config/sessions/types.js";

/** Cause labels distinguish which bounded budget fired. */
export type RequesterSettleWakeDroppedDeliveryCause =
  RequesterSettleWakeDroppedDeliveryState["cause"];

export type RecordRequesterSettleWakeDeliveryDroppedParams = {
  requesterSessionKey: string;
  childRunIds: readonly string[];
  deferralCount: number;
  reason: string;
  cap: number;
  cause: RequesterSettleWakeDroppedDeliveryCause;
  /** Override for tests; defaults to `Date.now()`. */
  droppedAt?: number;
};

const MAX_REASON_CHARS = 1_024;

/**
 * Persist a `requesterSettleWakeDroppedDelivery` marker on the parent session.
 *
 * Best-effort by design: a failed patch must not stop the wake module from
 * completing the abandoned batch (its primary obligation). A failure is logged
 * through the standard session-accessor logging path; callers can observe the
 * return value if they need to assert success in tests.
 */
export async function recordRequesterSettleWakeDeliveryDropped(
  params: RecordRequesterSettleWakeDeliveryDroppedParams,
): Promise<RequesterSettleWakeDroppedDeliveryState | undefined> {
  const requesterSessionKey = params.requesterSessionKey.trim();
  if (!requesterSessionKey) {
    return undefined;
  }
  const childRunIds = [...new Set(params.childRunIds.filter((id) => Boolean(id)))].toSorted();
  if (childRunIds.length === 0) {
    return undefined;
  }
  const droppedAt = params.droppedAt ?? Date.now();
  const marker: RequesterSettleWakeDroppedDeliveryState = {
    droppedAt,
    requesterSessionKey,
    childRunIds,
    deferralCount: Math.max(0, params.deferralCount | 0),
    reason: truncateReason(params.reason),
    cap: Math.max(0, params.cap | 0),
    cause: params.cause,
  };
  try {
    await patchSessionEntryWithKey({ sessionKey: requesterSessionKey }, () => ({
      requesterSettleWakeDroppedDelivery: marker,
    }));
    return marker;
  } catch {
    // The wake module still owns the abandoned batch; surfacing the patch
    // failure here would mask the original transport error.
    return undefined;
  }
}

function truncateReason(reason: string): string {
  if (reason.length <= MAX_REASON_CHARS) {
    return reason;
  }
  return `${reason.slice(0, MAX_REASON_CHARS)}\n[reason truncated]`;
}
