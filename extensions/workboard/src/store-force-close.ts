import { createHash, randomUUID } from "node:crypto";
import type {
  WorkboardCard,
  WorkboardMetadata,
  WorkboardNotification,
} from "@openclaw/workboard-contract";
import type { WorkboardForceCloseAuditEntry } from "./force-close-audit.js";
import {
  assertCanMutateClaimedCard,
  cardRunId,
  cardSessionKey,
  latestRunningAttempt,
} from "./store-card-helpers.js";
import {
  MAX_CARD_COMMENTS,
  MAX_CARD_NOTIFICATIONS,
  WORKBOARD_FORCE_CLOSE_EXPLANATION_MAX_LENGTH,
  WORKBOARD_FORCE_CLOSE_EXPLANATION_MIN_LENGTH,
  WORKBOARD_FORCE_CLOSE_REASON_CODES,
} from "./store-constants.js";
import type { WorkboardCardPatch, WorkboardForceCloseInput } from "./store-inputs.js";
import { WorkboardForceCloseValidationError } from "./store-inputs.js";
import {
  capText,
  clearDiagnostics,
  normalizeBoundedString,
  trimMetadataToBudget,
} from "./store-normalizers.js";

type ForceCloseHost = {
  enqueueMutation<T>(run: () => Promise<T>): Promise<T>;
  withCardCompensation<T>(run: () => Promise<T>): Promise<T>;
  get(id: string): Promise<WorkboardCard | undefined>;
  list(): Promise<WorkboardCard[]>;
  updateCard(
    id: string,
    patch: WorkboardCardPatch,
    options?: { enforceStatusHolds?: boolean },
  ): Promise<WorkboardCard>;
  nextNotificationSequence(now: number): number;
  recordForceCloseAudit(entry: WorkboardForceCloseAuditEntry): Promise<void>;
  readonly forceCloseAllowedAgents: ReadonlySet<string>;
  readonly forceCloseOperatorIds: ReadonlySet<string>;
  readonly activeRunLookup?: (cardId: string, queue?: string) => Promise<string | undefined>;
};

const MAX_FORCE_CLOSE_CASCADE_DEPTH = 64;
const MAX_FORCE_CLOSE_CASCADE_DESCENDANTS = 1_000;

type ForceCloseDescendantGraph = {
  cardsById: Map<string, WorkboardCard>;
  descendants: Array<{ card: WorkboardCard; depth: number }>;
  malformedIds: string[];
  cycleIds: string[];
};

async function descendantGraph(
  card: WorkboardCard,
  host: Pick<ForceCloseHost, "list">,
): Promise<ForceCloseDescendantGraph> {
  const cards = await host.list();
  const cardsById = new Map(cards.map((candidate) => [candidate.id, candidate]));
  const childrenByParent = new Map<string, string[]>();
  const malformedIds = new Set<string>();

  const addEdge = (parentId: string, childId: string, ownerId: string) => {
    const children = childrenByParent.get(parentId) ?? [];
    if (!children.includes(childId)) {
      children.push(childId);
    }
    childrenByParent.set(parentId, children);
    if (!cardsById.has(parentId) || !cardsById.has(childId)) {
      malformedIds.add(ownerId);
    }
  };

  for (const candidate of cards) {
    for (const link of candidate.metadata?.links ?? []) {
      if (link.type !== "parent" && link.type !== "child") {
        continue;
      }
      const targetId = typeof link.targetCardId === "string" ? link.targetCardId.trim() : "";
      if (!targetId) {
        malformedIds.add(candidate.id);
        continue;
      }
      if (link.type === "parent") {
        addEdge(targetId, candidate.id, candidate.id);
      } else {
        addEdge(candidate.id, targetId, candidate.id);
      }
    }
  }

  const depthById = new Map<string, number>();
  const queue: Array<{ id: string; depth: number }> = (childrenByParent.get(card.id) ?? []).map(
    (id) => ({ id, depth: 1 }),
  );
  const descendants: Array<{ card: WorkboardCard; depth: number }> = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth > MAX_FORCE_CLOSE_CASCADE_DEPTH) {
      malformedIds.add(current.id);
      continue;
    }
    const previousDepth = depthById.get(current.id);
    if (previousDepth !== undefined && previousDepth <= current.depth) {
      continue;
    }
    depthById.set(current.id, current.depth);
    const child = cardsById.get(current.id);
    if (!child) {
      malformedIds.add(current.id);
      continue;
    }
    descendants.push({ card: child, depth: current.depth });
    if (descendants.length > MAX_FORCE_CLOSE_CASCADE_DESCENDANTS) {
      malformedIds.add(card.id);
      break;
    }
    for (const childId of childrenByParent.get(child.id) ?? []) {
      queue.push({ id: childId, depth: current.depth + 1 });
    }
  }

  const cycleIds = new Set<string>();
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (candidateId: string, ancestry: string[]) => {
    if (visiting.has(candidateId)) {
      cycleIds.add(candidateId);
      for (const ancestor of ancestry) {
        cycleIds.add(ancestor);
      }
      return;
    }
    if (visited.has(candidateId)) {
      return;
    }
    visiting.add(candidateId);
    for (const childId of childrenByParent.get(candidateId) ?? []) {
      visit(childId, [...ancestry, candidateId]);
    }
    visiting.delete(candidateId);
    visited.add(candidateId);
  };
  visit(card.id, []);

  return {
    cardsById,
    descendants: descendants
      .filter(({ card: descendant }, index, all) => {
        const first = all.findIndex((entry) => entry.card.id === descendant.id);
        return first === index;
      })
      .toSorted(
        (left, right) => right.depth - left.depth || left.card.id.localeCompare(right.card.id),
      ),
    malformedIds: [...malformedIds].toSorted(),
    cycleIds: [...cycleIds].toSorted(),
  };
}

function normalizeForceCloseReasonCode(
  value: unknown,
): (typeof WORKBOARD_FORCE_CLOSE_REASON_CODES)[number] {
  if (
    typeof value === "string" &&
    (WORKBOARD_FORCE_CLOSE_REASON_CODES as readonly string[]).includes(value)
  ) {
    return value as (typeof WORKBOARD_FORCE_CLOSE_REASON_CODES)[number];
  }
  throw new Error(
    `force-close reason_code must be one of: ${WORKBOARD_FORCE_CLOSE_REASON_CODES.join(", ")}.`,
  );
}

function forceCloseReasonRequiresReference(
  reasonCode: (typeof WORKBOARD_FORCE_CLOSE_REASON_CODES)[number],
): boolean {
  return reasonCode === "superseded" || reasonCode === "duplicate";
}

export async function executeForceClose(
  host: ForceCloseHost,
  id: string,
  input: WorkboardForceCloseInput | undefined,
  agentId: string | undefined,
): Promise<WorkboardCard> {
  return await host.enqueueMutation(
    async () =>
      await host.withCardCompensation(async () => {
        const forceCloseInput = input ?? {};
        const normalizedAgentId = normalizeOptionalAgentId(agentId);
        if (
          !normalizedAgentId ||
          (!host.forceCloseAllowedAgents.has(normalizedAgentId) &&
            !host.forceCloseOperatorIds.has(normalizedAgentId))
        ) {
          throw new Error("force-close is orchestrator-only");
        }

        const cardId = normalizeBoundedString(id, undefined, 120, "card id");
        if (!cardId) {
          throw new Error("card id is required.");
        }
        const existing = await host.get(cardId);
        if (!existing) {
          throw new Error(`card not found: ${cardId}`);
        }

        const reasonCode = normalizeForceCloseReasonCode(forceCloseInput.reasonCode);
        const explanation = normalizeBoundedString(
          forceCloseInput.explanation,
          undefined,
          WORKBOARD_FORCE_CLOSE_EXPLANATION_MAX_LENGTH,
          "force-close explanation",
        );
        if (!explanation || explanation.length < WORKBOARD_FORCE_CLOSE_EXPLANATION_MIN_LENGTH) {
          throw new Error(
            `force-close explanation must be at least ${WORKBOARD_FORCE_CLOSE_EXPLANATION_MIN_LENGTH} characters.`,
          );
        }
        const cascadeDescendants =
          forceCloseInput.cascadeDescendants === undefined
            ? false
            : forceCloseInput.cascadeDescendants === true
              ? true
              : (() => {
                  throw new Error("cascadeDescendants must be a boolean.");
                })();
        const referenceCardId = normalizeBoundedString(
          forceCloseInput.referenceCardId,
          undefined,
          120,
          "reference card id",
        );
        if (forceCloseReasonRequiresReference(reasonCode) && !referenceCardId) {
          throw new Error(`force-close reason ${reasonCode} requires reference_card_id.`);
        }
        if (referenceCardId) {
          const reference = await host.get(referenceCardId);
          if (!reference) {
            throw new Error(`reference card not found: ${referenceCardId}`);
          }
          if (reference.id === existing.id) {
            throw new WorkboardForceCloseValidationError(
              "force-close reference card cannot be the card being closed",
              [existing.id],
            );
          }
          if (reference.metadata?.closureType === "force_close") {
            throw new Error(`reference card is force-closed: ${referenceCardId}`);
          }
        }

        const graph = await descendantGraph(existing, host);
        const openDescendants = graph.descendants
          .map(({ card }) => card)
          .filter((card) => card.status !== "done")
          .map((card) => card.id)
          .toSorted();
        const graphProblems = [...graph.malformedIds, ...graph.cycleIds].filter(
          (candidateId, index, ids) => ids.indexOf(candidateId) === index,
        );
        if (!cascadeDescendants && openDescendants.length > 0) {
          throw new WorkboardForceCloseValidationError(
            `card has open descendants; retry with cascadeDescendants after validating active runs and claims (card has open descendants: ${openDescendants.join(", ")})`,
            openDescendants,
          );
        }
        if (cascadeDescendants && graphProblems.length > 0) {
          throw new WorkboardForceCloseValidationError(
            `force-close cascade blocked by malformed or cyclic descendant links: ${graphProblems.join(", ")}`,
            graphProblems,
          );
        }
        if (
          cascadeDescendants &&
          referenceCardId &&
          graph.descendants.some(({ card }) => card.id === referenceCardId)
        ) {
          throw new WorkboardForceCloseValidationError(
            "force-close reference card cannot be a descendant of the card being closed",
            [referenceCardId],
          );
        }

        const operationId =
          normalizeBoundedString(forceCloseInput.operationId, undefined, 200, "operation id") ??
          createHash("sha256")
            .update("openclaw:workboard-force-close:v1\0")
            .update(cardId)
            .update("\0")
            .update(reasonCode)
            .update("\0")
            .update(explanation)
            .update("\0")
            .update(referenceCardId ?? "")
            .update("\0")
            .update(openDescendants.join(","))
            .digest("hex");

        if (existing.status === "done") {
          if (
            existing.metadata?.closureType === "force_close" &&
            existing.metadata.closureOperationId === operationId
          ) {
            return existing;
          }
          if (existing.metadata?.closureType === "force_close") {
            throw new Error(`card is already force-closed: ${cardId}`);
          }
          throw new Error(`card is already done: ${cardId}`);
        }

        const token = normalizeBoundedString(forceCloseInput.token, undefined, 160, "claim token");
        const claim = existing.metadata?.claim;
        if (claim) {
          if (claim.ownerId !== normalizedAgentId) {
            throw new Error(`card is claimed by ${claim.ownerId}.`);
          }
          if (!token) {
            throw new Error("force-close requires the claim token for a claimed card.");
          }
          if (claim.token !== token) {
            throw new Error("claim token does not match.");
          }
        }
        assertCanMutateClaimedCard(existing, { ownerId: normalizedAgentId, token });

        const localActiveRunId =
          existing.execution?.status === "running"
            ? cardRunId(existing)
            : latestRunningAttempt(existing)?.runId;
        const durableActiveRunId = await host.activeRunLookup?.(
          existing.id,
          existing.metadata?.automation?.queue,
        );
        const activeRunId = localActiveRunId ?? durableActiveRunId;
        if (
          activeRunId ||
          existing.execution?.status === "running" ||
          latestRunningAttempt(existing)
        ) {
          throw new Error(
            `active DBOS run exists for card ${existing.id}: ${activeRunId ?? "unknown"}`,
          );
        }

        const cardsToClose = cascadeDescendants
          ? [
              ...graph.descendants
                .filter(({ card }) => card.status !== "done")
                .map(({ card }) => card),
              existing,
            ]
          : [existing];
        const blockingIds: string[] = [];
        if (cascadeDescendants) {
          for (const candidate of cardsToClose.slice(0, -1)) {
            if (candidate.metadata?.claim) {
              blockingIds.push(candidate.id);
            }
            const localRunId =
              candidate.execution?.status === "running"
                ? cardRunId(candidate)
                : latestRunningAttempt(candidate)?.runId;
            const durableRunId = await host.activeRunLookup?.(
              candidate.id,
              candidate.metadata?.automation?.queue,
            );
            if (
              localRunId ||
              durableRunId ||
              candidate.execution?.status === "running" ||
              latestRunningAttempt(candidate)
            ) {
              blockingIds.push(candidate.id);
            }
          }
        }
        const uniqueBlockingIds = blockingIds.filter(
          (candidateId, index, ids) => ids.indexOf(candidateId) === index,
        );
        if (uniqueBlockingIds.length > 0) {
          throw new WorkboardForceCloseValidationError(
            `force-close cascade blocked by active runs or unresolved claims: ${uniqueBlockingIds.join(", ")}`,
            uniqueBlockingIds,
          );
        }

        const now = Date.now();
        const closed: WorkboardCard[] = [];
        const auditRecords: WorkboardForceCloseAuditEntry[] = [];
        const aggregateAudit: WorkboardForceCloseAuditEntry | undefined = cascadeDescendants
          ? {
              ts: new Date(now).toISOString(),
              agent_id: normalizedAgentId,
              card_id: existing.id,
              reason_code: reasonCode,
              explanation,
              reference_card_id: referenceCardId ?? null,
              prior_status: existing.status,
              dbos_run_id: null,
              outcome: "accepted",
              operation_id: operationId,
              aggregate: true,
              card_ids: cardsToClose.map((candidate) => candidate.id),
            }
          : undefined;
        try {
          if (aggregateAudit) {
            await host.recordForceCloseAudit(aggregateAudit);
            auditRecords.push(aggregateAudit);
          }
          for (const candidate of cardsToClose) {
            const audit: WorkboardForceCloseAuditEntry = {
              ts: new Date(now).toISOString(),
              agent_id: normalizedAgentId,
              card_id: candidate.id,
              reason_code: reasonCode,
              explanation,
              reference_card_id: referenceCardId ?? null,
              prior_status: candidate.status,
              dbos_run_id: null,
              outcome: "accepted",
              operation_id: operationId,
            };
            await host.recordForceCloseAudit(audit);
            auditRecords.push(audit);
            const comment = `[FORCE-CLOSE] ${reasonCode}: ${explanation}`;
            const notification: WorkboardNotification = {
              id: randomUUID(),
              kind: "completed",
              createdAt: now,
              sequence: host.nextNotificationSequence(now),
              message: capText(comment, 240) ?? "Workboard card force-closed.",
              ...(cardSessionKey(candidate) ? { sessionKey: cardSessionKey(candidate) } : {}),
            };
            const metadata: WorkboardMetadata = trimMetadataToBudget({
              ...clearDiagnostics(candidate.metadata, ["missing_proof"]),
              claim: undefined,
              closureType: "force_close",
              closureOperationId: operationId,
              comments: [
                ...(candidate.metadata?.comments ?? []),
                { id: randomUUID(), body: comment, createdAt: now },
              ].slice(-MAX_CARD_COMMENTS),
              notifications: [...(candidate.metadata?.notifications ?? []), notification].slice(
                -MAX_CARD_NOTIFICATIONS,
              ),
            });
            const updated = await host.updateCard(
              candidate.id,
              { status: "done", metadata },
              { enforceStatusHolds: !cascadeDescendants },
            );
            closed.push(updated);
            await host.recordForceCloseAudit({ ...audit, outcome: "applied" });
          }
          if (aggregateAudit) {
            await host.recordForceCloseAudit({
              ...aggregateAudit,
              outcome: "applied",
              card_ids: closed.map((card) => card.id),
            });
          }
          return closed.at(-1)!;
        } catch (error) {
          await Promise.all(
            auditRecords.map(async (audit) => {
              try {
                await host.recordForceCloseAudit({ ...audit, outcome: "storage_failed" });
              } catch {
                // Preserve the original mutation or audit failure. A durable accepted intent remains available for replay.
              }
            }),
          );
          throw error;
        }
      }),
  );
}

function normalizeOptionalAgentId(agentId: string | undefined): string | undefined {
  return normalizeBoundedString(agentId, undefined, 120, "agent id")?.toLowerCase();
}
