import { isDeepStrictEqual } from "node:util";
import type { WorkboardCard } from "@openclaw/workboard-contract";
import { cardMutationResult, readStringParam } from "openclaw/plugin-sdk/core";
import { safeEqualSecret } from "openclaw/plugin-sdk/security-runtime";
import { asRecord, readStringValue } from "openclaw/plugin-sdk/string-coerce-runtime";
import { Type, type TProperties } from "typebox";
import { redactClaimToken } from "./card-redaction.js";
import type { WorkboardMutationScope } from "./store-inputs.js";
import type { WorkboardStore } from "./store.js";

type WorkboardCardMutation = (
  id: string,
  record: Record<string, unknown>,
  scope: WorkboardMutationScope,
) => Promise<WorkboardCard>;

const CARD_DIFF_IGNORED_KEYS = new Set(["updatedAt"]);

/**
 * Top-level field names that differ between two card versions, plus shallow
 * metadata keys. Session-audit 2026-11-16 echo-slimming (card 609ef9bd):
 * mutation echoes report what changed instead of echoing the full card JSON.
 */
export function changedCardFields(before: WorkboardCard, after: WorkboardCard): string[] {
  const changed: string[] = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (CARD_DIFF_IGNORED_KEYS.has(key)) {
      continue;
    }
    if (key === "metadata") {
      const beforeMeta = before.metadata ?? {};
      const afterMeta = after.metadata ?? {};
      for (const metaKey of new Set([...Object.keys(beforeMeta), ...Object.keys(afterMeta)])) {
        if (!isDeepStrictEqual(beforeMeta[metaKey], afterMeta[metaKey])) {
          changed.push(`metadata.${metaKey}`);
        }
      }
      continue;
    }
    if (!isDeepStrictEqual(before[key], after[key])) {
      changed.push(key);
    }
  }
  return changed.toSorted();
}

/**
 * Slim mutation echo (card 609ef9bd): {id, status, changed fields, token when
 * the caller's claim was created or refreshed}. Full card stays available via
 * workboard_read; change events were already revision-only.
 */
export function slimCardEcho(
  before: WorkboardCard,
  after: WorkboardCard,
  options: { includeToken?: boolean } = {},
) {
  const echo: Record<string, unknown> = {
    id: after.id,
    status: after.status,
    changed: changedCardFields(before, after),
  };
  if (options.includeToken && after.metadata?.claim) {
    const tokenChanged = before.metadata?.claim?.token !== after.metadata.claim.token;
    const callerHoldsClaim =
      after.metadata.claim.ownerId === before.metadata?.claim?.ownerId ||
      before.metadata?.claim === undefined;
    if (tokenChanged && callerHoldsClaim) {
      echo.token = after.metadata.claim.token;
    }
  }
  return echo;
}

export function createWorkboardCardMutations(store: WorkboardStore, ownerId: string) {
  const readParams = async (rawParams: unknown, requireClaim = false) => {
    const record = asRecord(rawParams);
    const id = readStringParam(record, "id", { required: true });
    const token = readStringValue(record.token);
    const card = await store.get(id);
    if (!card) {
      throw new Error(`card not found: ${id}`);
    }
    const claim = card.metadata?.claim;
    if (claim && claim.ownerId !== ownerId && !safeEqualSecret(token, claim.token)) {
      throw new Error(`card is claimed by ${claim.ownerId ?? "another agent"}.`);
    }
    if (requireClaim && !claim) {
      throw new Error("card must be claimed before lifecycle completion.");
    }
    return { record, id, scope: { ownerId, token } };
  };
  const cardMutation =
    (mutate: WorkboardCardMutation, requireClaim = false) =>
    async (_toolCallId: string, rawParams: unknown) => {
      const { record, id, scope } = await readParams(rawParams, requireClaim);
      const before = await store.get(id);
      const after = await mutate(id, record, scope);
      // Slim echo (card 609ef9bd): mutations report {id, status, changed,
      // token-if-claim} instead of the full 10-20KB card JSON. Full card via
      // workboard_read.
      return cardMutationResult(slimCardEcho(before ?? after, after, { includeToken: true }));
    };
  return {
    readScopedCardToolParams: (rawParams: unknown) => readParams(rawParams),
    scopedCardMutation: cardMutation,
    claimedCardMutation: (mutate: WorkboardCardMutation) => cardMutation(mutate, true),
  };
}

export function consumerSurfaceEvidenceField() {
  return Type.Optional(
    Type.Object(
      {
        kind: Type.String({
          description: 'Evidence class: "code", "skill", or "research".',
        }),
        repoPath: Type.Optional(
          Type.String({ description: "kind=code: repository containing commitSha." }),
        ),
        commitSha: Type.Optional(
          Type.String({ description: "kind=code: commit SHA verified via git." }),
        ),
        filePath: Type.Optional(
          Type.String({
            description:
              "Verified file: optional for code, SKILL.md for skill, non-empty artifact for research.",
          }),
        ),
        consumerId: Type.Optional(
          Type.String({ description: "Optional stable consumer identifier." }),
        ),
      },
      {
        additionalProperties: false,
        description:
          "Required for [BUILD]/[INFRA] cards. Verified independently by the store; caller proof text is never trusted.",
      },
    ),
  );
}

export function cardIdField() {
  return Type.String({ description: "Workboard card id." });
}

export function claimTokenField(description = "Claim token returned by workboard_claim.") {
  return Type.Optional(Type.String({ description }));
}

export function strictObject<const Properties extends TProperties>(properties: Properties) {
  return Type.Object(properties, { additionalProperties: false });
}

export function workspaceField() {
  return Type.Optional(
    strictObject({
      kind: Type.String({ description: "scratch, dir, or worktree." }),
      path: Type.Optional(Type.String({ description: "Absolute dir/worktree path." })),
      branch: Type.Optional(
        Type.String({
          description:
            "Optional worktree source base ref. Re-dispatch reuses a retained checkout; use a new card for a different base ref.",
        }),
      ),
    }),
  );
}
