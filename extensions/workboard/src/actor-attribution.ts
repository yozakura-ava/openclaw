/** Fail-closed author attribution for Workboard comments and proof. */
import { WORKBOARD_SYSTEM_ACTOR_ID, WORKBOARD_SYSTEM_ACTOR_KIND } from "./store-constants.js";

export type WorkboardActorKind = "agent" | "system";
export type WorkboardActor = { actorId: string; actorKind: WorkboardActorKind };

/**
 * The attribution stamped on writes that carry no actor (card 9dd79ad6).
 * Pair value — a backfilled/absent actorId must never land with a mismatched
 * actorKind.
 */
export const SYSTEM_FALLBACK_ACTOR: WorkboardActor = {
  actorId: WORKBOARD_SYSTEM_ACTOR_ID,
  actorKind: WORKBOARD_SYSTEM_ACTOR_KIND,
};

const MAX_ACTOR_ID_LENGTH = 160;
const ACTOR_KINDS = ["agent", "system"] as const;

export function normalizeActor(input: {
  actorId?: unknown;
  actorKind?: unknown;
}): WorkboardActor | undefined {
  const actorId =
    typeof input.actorId === "string" ? input.actorId.trim().slice(0, MAX_ACTOR_ID_LENGTH) : "";
  const actorKind = ACTOR_KINDS.find((kind) => kind === input.actorKind);
  return actorId && actorKind ? { actorId, actorKind } : undefined;
}
