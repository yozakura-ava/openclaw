/**
 * Comment/proof authorship attribution.
 *
 * Card 202183c5: workboard records previously carried no actor, so every
 * comment on a card was indistinguishable from every other one. This module
 * carries the writer's identity alongside the record.
 *
 * FAIL-CLOSED CONTRACT: attribution is only ever recorded when a real caller
 * identity was resolved. An absent/unknown identity produces NO actor fields
 * (NULL columns), never a fabricated placeholder. Two half-populated rows
 * (`actor_id` set, `actor_kind` missing) are treated as unattributed — a
 * partially-known identity is not evidence of anything.
 */
import type { WorkboardComment, WorkboardProof } from "@openclaw/workboard-contract";

/** Mirrors the bounded-string rule used by store-normalizers (160 chars). */
const MAX_ACTOR_ID_LENGTH = 160;

/**
 * `agent` — written through the plugin tool surface (a live agent session).
 * `system` — written by an out-of-band writer (cron bot, bridge script) that
 * talks to the sqlite file directly and bypasses the plugin entirely.
 */
export type WorkboardActorKind = "agent" | "system";

const WORKBOARD_ACTOR_KINDS: readonly WorkboardActorKind[] = ["agent", "system"];

/** A fully-resolved identity. Both fields are present or the record has none. */
export type WorkboardActor = {
  actorId: string;
  actorKind: WorkboardActorKind;
};

/**
 * Attribution-bearing record shapes. The contract package types
 * `WorkboardComment`/`WorkboardProof` without actor fields; these local
 * intersections carry them through the store without widening the shared
 * contract (card scope is `extensions/workboard/**` only).
 */
export type AttributedWorkboardComment = WorkboardComment & {
  actorId?: string;
  actorKind?: WorkboardActorKind;
};

export type AttributedWorkboardProof = WorkboardProof & {
  actorId?: string;
  actorKind?: WorkboardActorKind;
};

/** Spreads onto a record, or spreads nothing when identity is unresolved. */
export function actorFields(actor: WorkboardActor | undefined): {
  actorId?: string;
  actorKind?: WorkboardActorKind;
} {
  return actor ? { actorId: actor.actorId, actorKind: actor.actorKind } : {};
}

/**
 * Normalize an actor out of untrusted input (tool params / store input / a
 * freshly-read row).
 *
 * Returns `undefined` unless BOTH a bounded actor id and a known kind are
 * present, so a caller cannot smuggle a partial or unknown-kind identity onto
 * a record. Applied on the read path too: a corrupt row drops its attribution
 * rather than echoing unvalidated values back out.
 *
 * Deliberately self-contained (no import of store-normalizers) so the
 * normalizer can consume it without an import cycle.
 */
export function normalizeActor(
  input: { actorId?: unknown; actorKind?: unknown } | undefined,
): WorkboardActor | undefined {
  const raw = input?.actorId;
  const actorId = typeof raw === "string" ? raw.trim().slice(0, MAX_ACTOR_ID_LENGTH) : "";
  const actorKind = WORKBOARD_ACTOR_KINDS.find((kind) => kind === input?.actorKind);
  if (!actorId || !actorKind) {
    return undefined;
  }
  return { actorId, actorKind };
}
