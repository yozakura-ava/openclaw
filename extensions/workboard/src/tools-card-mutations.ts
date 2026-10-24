import type { WorkboardCard } from "@openclaw/workboard-contract";
import { jsonResult } from "openclaw/plugin-sdk/core";
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

export function createWorkboardCardMutations(store: WorkboardStore, ownerId: string) {
  const readParams = async (rawParams: unknown, requireClaim = false) => {
    const record = asRecord(rawParams);
    const id =
      typeof record.id === "string" && record.id.trim() !== ""
        ? record.id
        : typeof record.cardId === "string" && record.cardId.trim() !== ""
          ? record.cardId
          : (() => {
              throw new Error("card id is required (provide `id` or `cardId`).");
            })();
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
      // Nest cards so their status cannot be mistaken for the tool result's status.
      return jsonResult({ card: redactClaimToken(await mutate(id, record, scope)) });
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
