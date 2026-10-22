/** Fail-closed author attribution for Workboard comments and proof. */
export type WorkboardActorKind = "agent" | "system";
export type WorkboardActor = { actorId: string; actorKind: WorkboardActorKind };

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
