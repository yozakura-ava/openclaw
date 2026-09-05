import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  WorkboardArtifact,
  WorkboardCard,
  WorkboardClaim,
  WorkboardMetadata,
  WorkboardNotification,
  WorkboardRunAttempt,
} from "@openclaw/workboard-contract";
import { isFutureDateTimestampMs } from "openclaw/plugin-sdk/number-runtime";
import { safeEqualSecret } from "openclaw/plugin-sdk/security-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  assertCanMutateClaimedCard,
  cardBoardId,
  cardChildIds,
  cardParentIds,
  cardRunId,
  cardSessionKey,
  closeRunningAttempts,
  assertReviewIndependenceFromScope,
  diagnostic,
  latestRunningAttempt,
  retryBudgetExhausted,
} from "./store-card-helpers.js";
import {
  addWorkboardDurationMs,
  DEFAULT_CLAIM_TTL_MS,
  isWorkboardClaimReclaimable,
  MAX_CARD_ARTIFACTS,
  MAX_CARD_COMMENTS,
  MAX_CARD_NOTIFICATIONS,
  secondsToDurationMs,
  WORKBOARD_FORCE_CLOSE_EXPLANATION_MAX_LENGTH,
  WORKBOARD_FORCE_CLOSE_EXPLANATION_MIN_LENGTH,
  WORKBOARD_FORCE_CLOSE_REASON_CODES,
  normalizeWorkboardForceCloseActorId,
} from "./store-constants.js";
import type {
  WorkboardBlockInput,
  WorkboardCardPatch,
  WorkboardClaimInput,
  WorkboardClaimOptions,
  WorkboardCompleteInput,
  WorkboardDecomposeChildInput,
  WorkboardDecomposeInput,
  WorkboardForceCloseInput,
  WorkboardHeartbeatInput,
  WorkboardMutationScope,
  WorkboardProofInput,
  WorkboardReassignInput,
  WorkboardReclaimInput,
  WorkboardSpecifyInput,
} from "./store-inputs.js";
import {
  appendCompletionProof,
  capText,
  clearDiagnostics,
  deriveChildIdempotencyKey,
  normalizeArtifact,
  normalizeAutomation,
  normalizeBoundedString,
  normalizeProofInput,
  normalizeStatus,
  normalizeStringList,
  removeUndefinedMetadataFields,
  trimMetadataToBudget,
} from "./store-normalizers.js";
import { WorkboardPromoteStore } from "./store-promote.js";

// workboard_force_close helpers (card 32d1c50d).
// `normalizeForceCloseReasonCode` rejects every reason outside the closed
// enum so the override can never widen into a general completion bypass.
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

// `forceCloseReasonRequiresReference` encodes the design rule that
// superseded and duplicate closures must point at a surviving card so the
// audit trail is queryable for "where did the work land?". Cancelled and
// invalid closures are allowed without a reference.
function forceCloseReasonRequiresReference(
  reasonCode: (typeof WORKBOARD_FORCE_CLOSE_REASON_CODES)[number],
): boolean {
  return reasonCode === "superseded" || reasonCode === "duplicate";
}

// `collectOpenDescendantIds` walks the parent/child link tree from a seed
// card and returns every descendant whose status is not "done". Recursion
// is bounded by the card list (one row per descendant) and tolerates
// orphaned links — a missing link target is simply skipped, never
// re-thrown, because force-close must surface a stable set of open IDs
// even when the link graph is mid-edit.
async function collectOpenDescendantIds(
  cardId: string,
  store: { get: (id: string) => Promise<WorkboardCard | undefined> },
): Promise<string[]> {
  const open: string[] = [];
  const visited = new Set<string>();
  const queue: string[] = [];
  const directChildren = await (async () => {
    const seed = await store.get(cardId);
    return seed ? cardChildIds(seed) : [];
  })();
  queue.push(...directChildren);
  while (queue.length > 0) {
    const next = queue.shift();
    if (!next || visited.has(next)) {
      continue;
    }
    visited.add(next);
    const child = await store.get(next);
    if (!child) {
      continue;
    }
    if (child.status !== "done") {
      open.push(child.id);
    }
    queue.push(...cardChildIds(child));
  }
  return open.toSorted();
}

function assertClaimIdentity(claim: WorkboardClaim, input: WorkboardHeartbeatInput): void {
  const token = normalizeOptionalString(input.token);
  const ownerId = normalizeOptionalString(input.ownerId);
  // Owner-match takes precedence over token mismatch. Outbound tool args
  // can scrub a valid claim token to a masked placeholder (e.g. "***"), so
  // an invalid-but-present token must not reject when the caller proves
  // identity through the owner string. Fencing is preserved by the exact
  // string compare below; cross-owner token-less mutations still throw.
  // PATCH workboard-claim-token-authority-fix (card 3a911999, sprint
  // reina-2026-08-31-008).
  if (ownerId && ownerId === claim.ownerId) {
    return;
  }
  if (token) {
    if (!safeEqualSecret(token, claim.token)) {
      throw new Error("claim token does not match.");
    }
    return;
  }
  throw new Error("claim owner does not match.");
}

export class WorkboardWorkflowStore extends WorkboardPromoteStore {
  async claim(
    id: string,
    input: WorkboardClaimInput,
    options: WorkboardClaimOptions = {},
  ): Promise<{ card: WorkboardCard; token: string }> {
    const ownerId = normalizeBoundedString(input.ownerId, undefined, 120, "claim owner");
    if (!ownerId) {
      throw new Error("claim ownerId is required.");
    }
    const ttlSeconds =
      typeof input.ttlSeconds === "number" && Number.isFinite(input.ttlSeconds)
        ? Math.max(1, Math.trunc(input.ttlSeconds))
        : undefined;
    const token =
      normalizeBoundedString(input.token, undefined, 160, "claim token") ?? randomUUID();
    return await this.enqueueMutation(async () => {
      const now = Date.now();
      const expiresAt = addWorkboardDurationMs(
        now,
        ttlSeconds ? secondsToDurationMs(ttlSeconds) : DEFAULT_CLAIM_TTL_MS,
      );
      const guarded = await this.promoteDependencyReady(id, now);
      if (guarded.metadata?.archivedAt) {
        throw new Error("card is archived.");
      }
      const expectedAuthority = options.expectedAuthority;
      if (
        expectedAuthority &&
        (guarded.status !== expectedAuthority.status ||
          cardBoardId(guarded) !== expectedAuthority.boardId ||
          guarded.agentId !== expectedAuthority.agentId ||
          !isDeepStrictEqual(
            guarded.metadata?.automation?.workspace,
            expectedAuthority.workspace,
          ) ||
          !isDeepStrictEqual(
            guarded.metadata?.automation?.workspaceAccess,
            expectedAuthority.workspaceAccess,
          ))
      ) {
        throw new Error("card workspace authority changed before claim.");
      }
      const existingClaim = guarded.metadata?.claim;
      const activeClaim =
        existingClaim &&
        (isFutureDateTimestampMs(existingClaim.expiresAt, { nowMs: now }) ||
          // Direct claims must honor the same running-worker heartbeat grace
          // as dispatcher recovery; otherwise they silently steal live tokens.
          // PATCH workboard-reclaim-expiry-fix (card eb0ce23a): the grace
          // protects only OTHER owners — the claim's original owner may
          // reclaim immediately once expiresAt has passed (self-recovery).
          (guarded.status === "running" &&
            !isWorkboardClaimReclaimable(existingClaim, now) &&
            existingClaim.ownerId !== ownerId))
          ? existingClaim
          : undefined;
      if (!activeClaim && guarded.status !== "ready") {
        // PATCH workboard-claim-dep-gate (card bd165865): replace the buggy
        // `status !== "ready"` proxy with the actual every-parent-done
        // predicate (shared helper on WorkboardCoreStore). The old proxy
        // permanently trapped cards in review/running with expired claims
        // because it never consulted parent status. Error text now names
        // the unsatisfied parents so operators can see which link is open.
        const { satisfied, notDoneIds } = await this.dependenciesSatisfied(guarded);
        if (!satisfied) {
          throw new Error(
            `card dependencies are not done: parents ${notDoneIds.join(", ")} not done`,
          );
        }
      }
      if (guarded.status === "scheduled") {
        throw new Error("card is scheduled for later.");
      }
      if (retryBudgetExhausted(guarded)) {
        throw new Error("card exhausted its retry budget.");
      }
      if (activeClaim) {
        throw new Error(`card already claimed by ${activeClaim.ownerId}.`);
      }
      const metadata = clearDiagnostics(guarded.metadata, ["stranded_ready"]);
      const card = await this.updateCard(
        id,
        {
          status:
            guarded.status === "backlog" || guarded.status === "todo" || guarded.status === "ready"
              ? "running"
              : guarded.status,
          ...(options.adoptWorkspaceAccess && !guarded.metadata?.automation?.workspaceAccess
            ? { workspaceAccess: options.adoptWorkspaceAccess }
            : {}),
          metadata: {
            ...metadata,
            claim: { ownerId, token, claimedAt: now, lastHeartbeatAt: now, expiresAt },
          },
        },
        {
          expectedUpdatedAt: guarded.updatedAt,
          ownerSlot: { ownerId, now, maxConcurrentClaims: options.maxConcurrentClaimsPerOwner },
        },
      );
      return { card, token };
    });
  }

  async heartbeat(id: string, input: WorkboardHeartbeatInput): Promise<WorkboardCard> {
    const note = normalizeBoundedString(input.note, undefined, 400, "heartbeat note");
    const card = await this.updateMetadata(id, (existing) => {
      const claim = existing.metadata?.claim;
      if (!claim) {
        throw new Error("card is not claimed.");
      }
      const now = Math.max(Date.now(), claim.lastHeartbeatAt + 1);
      assertClaimIdentity(claim, input);
      const nextClaim = {
        ...claim,
        lastHeartbeatAt: now,
        expiresAt: claim.expiresAt
          ? addWorkboardDurationMs(
              now,
              Math.max(
                1,
                claim.expiresAt > claim.claimedAt
                  ? claim.expiresAt - claim.lastHeartbeatAt
                  : DEFAULT_CLAIM_TTL_MS,
              ),
            )
          : undefined,
      };
      const metadata = clearDiagnostics(existing.metadata, ["running_without_heartbeat"]);
      return {
        ...metadata,
        claim: removeUndefinedMetadataFields({ claim: nextClaim }).claim,
        comments: note
          ? [...(metadata.comments ?? []), { id: randomUUID(), body: note, createdAt: now }].slice(
              -MAX_CARD_COMMENTS,
            )
          : metadata.comments,
      };
    });
    return card;
  }

  async releaseClaim(
    id: string,
    input: WorkboardHeartbeatInput & { status?: unknown } = {},
  ): Promise<WorkboardCard> {
    return await this.enqueueMutation(async () => {
      const existing = await this.get(id);
      if (!existing) {
        throw new Error(`card not found: ${id}`);
      }
      const status =
        input.status === undefined
          ? existing.status
          : normalizeStatus(input.status, existing.status);
      const claim = existing.metadata?.claim;
      if (claim) {
        assertClaimIdentity(claim, input);
      }
      return await this.updateCard(
        id,
        {
          status,
          metadata: { ...existing.metadata, claim: undefined },
        },
        { enforceStatusHolds: input.status !== undefined },
      );
    });
  }

  async complete(
    id: string,
    input: WorkboardCompleteInput = {},
    scope: WorkboardMutationScope | null | undefined = input,
  ): Promise<WorkboardCard> {
    return await this.enqueueMutation(async () => await this.completeDirect(id, input, scope));
  }

  private async completeDirect(
    id: string,
    input: WorkboardCompleteInput = {},
    scope: WorkboardMutationScope | null | undefined = input,
  ): Promise<WorkboardCard> {
    const existing = await this.get(id);
    if (!existing) {
      throw new Error(`card not found: ${id}`);
    }
    assertCanMutateClaimedCard(existing, scope === null ? undefined : scope);
    const now = Date.now();
    const createdCardIds = normalizeStringList(input.createdCardIds, "created card ids", 120);
    const childIds = cardChildIds(existing);
    for (const createdCardId of createdCardIds) {
      const createdCard = await this.get(createdCardId);
      if (!createdCard) {
        throw new Error(`created card not found: ${createdCardId}`);
      }
      const linkedFromParent =
        childIds.includes(createdCardId) && cardParentIds(createdCard).includes(existing.id);
      if (!linkedFromParent) {
        throw new Error(`created card is not linked to this card: ${createdCardId}`);
      }
    }
    const summary = normalizeBoundedString(input.summary, undefined, 2000, "summary");
    const proofInput =
      input.proof && typeof input.proof === "object" && !Array.isArray(input.proof)
        ? (input.proof as WorkboardProofInput)
        : undefined;
    const proofId = normalizeBoundedString(input.proofId, undefined, 120, "proof id");
    if (input.proofId !== undefined && !proofId) {
      throw new Error("proofId must be a non-empty string.");
    }
    // PATCH proofid-only-fix: proofId may resolve a previously-attached proof
    // without an accompanying proof object — that is the canonical resolution
    // path. The stored proof is the completion proof as-is; the proof OBJECT
    // (with optional terminal status) is a legacy fallback that triggers
    // byte-match validation in appendCompletionProof.
    if (proofId && !proofInput) {
      const entries = [...(existing.metadata?.proof ?? [])];
      const pending = entries.find((entry) => entry && entry.id === proofId);
      if (!pending) {
        throw new Error(`proofId ${proofId} not found on card ${id}`);
      }
    }
    const proof = proofInput ? normalizeProofInput(proofInput, now) : undefined;
    // PATCH-d16f9796 (backport): enforce review-independence invariant on
    // completion-attached clearance (proof.status === "passed"). Reject
    // same-namespace reviewer before any metadata mutation.
    if (proof) {
      assertReviewIndependenceFromScope(existing, scope === null ? undefined : scope, proof);
    }
    const artifacts = Array.isArray(input.artifacts)
      ? input.artifacts
          .map((artifact) => normalizeArtifact({ ...artifact, createdAt: now }))
          .filter((artifact): artifact is WorkboardArtifact => artifact !== null)
          .slice(-MAX_CARD_ARTIFACTS)
      : [];
    const metadata = clearDiagnostics(existing.metadata, ["missing_proof"]);
    const notification: WorkboardNotification = {
      id: randomUUID(),
      kind: "completed",
      createdAt: now,
      sequence: this.nextNotificationSequence(now),
      message: capText(summary, 240) ?? "Workboard card completed.",
      ...(cardSessionKey(existing) ? { sessionKey: cardSessionKey(existing) } : {}),
      ...(cardRunId(existing) ? { runId: cardRunId(existing) } : {}),
    };
    const execution =
      existing.execution?.status === "running"
        ? { ...existing.execution, status: "done" as const, updatedAt: now }
        : existing.execution;
    return await this.updateCard(
      id,
      {
        status: "done",
        ...(execution ? { execution } : {}),
        metadata: {
          ...metadata,
          claim: undefined,
          attempts: closeRunningAttempts(metadata.attempts, now, "succeeded"),
          failureCount: 0,
          automation: normalizeAutomation(
            {
              ...metadata.automation,
              summary,
              createdCardIds,
            },
            metadata.automation,
          ),
          comments: summary
            ? [
                ...(metadata.comments ?? []),
                { id: randomUUID(), body: summary, createdAt: now },
              ].slice(-MAX_CARD_COMMENTS)
            : metadata.comments,
          proof: proof ? appendCompletionProof(metadata.proof, proof, proofId) : metadata.proof,
          artifacts: artifacts.length
            ? [...(metadata.artifacts ?? []), ...artifacts].slice(-MAX_CARD_ARTIFACTS)
            : metadata.artifacts,
          notifications: [...(metadata.notifications ?? []), notification].slice(
            -MAX_CARD_NOTIFICATIONS,
          ),
        },
      },
      {
        enforceStatusHolds: true,
        ...(proof ? { preserveProofId: proofId ?? proof.id } : {}),
      },
    );
  }

  /**
   * Orchestrator-only escape hatch for cards that will never receive a DBOS
   * run ID (superseded, duplicate, cancelled, invalid). The reason-code enum
   * is closed: completion-shaped reasons are deliberately NOT in the list so
   * this can never become a general completion bypass. Force-closed cards
   * carry `metadata.closureType = "force_close"` and are appended to
   * `data/workboard/force-closes.jsonl` before the terminal write so the
   * audit trail survives even if the SQLite write fails.
   *
   * Restored from commit a0cf0f66c72 (branch canonical-bqes-dbos-cutover,
   * validated 173/173 in the 2026-08-24 session) via card 32d1c50d. The
   * token-match guard that the 18:02 session flagged as the #7 discrepancy
   * is enforced explicitly here (the dist at 1155Z already includes it).
   *
   * Failure modes (all raise to the caller — no silent fallthrough):
   *   - non-allowlisted / non-operator agent
   *   - missing cardId or unknown card
   *   - card already done (force-closed or normally completed)
   *   - unknown reason code / explanation < 20 chars
   *   - superseded/duplicate without reference_card_id (or pointing at a
   *     missing / force-closed card)
   *   - open descendants (recursive walk lists IDs)
   *   - claim by another agent, missing claim token, or token mismatch
   *   - active DBOS / BQES run (local execution or durable lookup)
   */
  async forceClose(
    id: string,
    input: WorkboardForceCloseInput = {},
    agentId: string | undefined,
  ): Promise<WorkboardCard> {
    return await this.enqueueMutation(async () => {
      const normalizedAgentId = normalizeWorkboardForceCloseActorId(agentId);
      if (
        !normalizedAgentId ||
        (!this.forceCloseAllowedAgents.has(normalizedAgentId) &&
          !this.forceCloseOperatorIds.has(normalizedAgentId))
      ) {
        throw new Error("force-close is orchestrator-only");
      }

      const cardId = normalizeOptionalString(id);
      if (!cardId) {
        throw new Error("card id is required.");
      }

      const existing = await this.get(cardId);
      if (!existing) {
        throw new Error(`card not found: ${cardId}`);
      }
      if (existing.status === "done") {
        if (existing.metadata?.closureType === "force_close") {
          throw new Error(`card is already force-closed: ${cardId}`);
        }
        throw new Error(`card is already done: ${cardId}`);
      }

      const reasonCode = normalizeForceCloseReasonCode(input.reasonCode);
      const explanation = normalizeBoundedString(
        input.explanation,
        undefined,
        WORKBOARD_FORCE_CLOSE_EXPLANATION_MAX_LENGTH,
        "force-close explanation",
      );
      if (!explanation || explanation.length < WORKBOARD_FORCE_CLOSE_EXPLANATION_MIN_LENGTH) {
        throw new Error(
          `force-close explanation must be at least ${WORKBOARD_FORCE_CLOSE_EXPLANATION_MIN_LENGTH} characters.`,
        );
      }

      const referenceCardId = normalizeOptionalString(input.referenceCardId);
      if (forceCloseReasonRequiresReference(reasonCode) && !referenceCardId) {
        throw new Error(`force-close reason ${reasonCode} requires reference_card_id.`);
      }
      if (referenceCardId) {
        const reference = await this.get(referenceCardId);
        if (!reference) {
          throw new Error(`reference card not found: ${referenceCardId}`);
        }
        if (reference.metadata?.closureType === "force_close") {
          throw new Error(`reference card is force-closed: ${referenceCardId}`);
        }
      }

      const openDescendants = await collectOpenDescendantIds(cardId, this);
      if (openDescendants.length > 0) {
        throw new Error(`card has open descendants: ${openDescendants.join(", ")}`);
      }

      const token = normalizeOptionalString(input.token);
      const claim = existing.metadata?.claim;
      if (claim) {
        const normalizedClaimOwner =
          normalizeWorkboardForceCloseActorId(claim.ownerId) ?? claim.ownerId.toLowerCase();
        if (normalizedClaimOwner !== normalizedAgentId) {
          throw new Error(`card is claimed by ${claim.ownerId}.`);
        }
        if (!token) {
          throw new Error("force-close requires the claim token for a claimed card.");
        }
        if (claim.token !== token) {
          throw new Error("claim token does not match.");
        }
      }
      assertCanMutateClaimedCard(existing, {
        ownerId: normalizedAgentId,
        token,
      });

      const localActiveRunId =
        existing.execution?.status === "running"
          ? cardRunId(existing)
          : latestRunningAttempt(existing)?.runId;
      // Canonical WorkboardAutomation has no `queue` field; the queue name
      // would be a BQES-specific concern wired in via the gateway's
      // activeRunLookup adapter. Pass undefined so the lookup callback can
      // fall back to its own cardId-only resolution path.
      let durableActiveRunId: string | undefined;
      try {
        durableActiveRunId = await this.activeRunLookup?.(existing.id, undefined);
      } catch (error) {
        const lookupFailure = new Error(
          "DBOS active-run lookup failed; refusing to force-close the card",
          { cause: error },
        );
        Object.defineProperty(lookupFailure, "code", {
          configurable: true,
          value: "WORKBOARD_DBOS_LOOKUP_FAILED",
        });
        throw lookupFailure;
      }
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

      const now = Date.now();
      const comment = `[FORCE-CLOSE] ${reasonCode}: ${explanation}`;
      const notification: WorkboardNotification = {
        id: randomUUID(),
        kind: "completed",
        createdAt: now,
        sequence: this.nextNotificationSequence(now),
        message: capText(comment, 240) ?? "Workboard card force-closed.",
        ...(cardSessionKey(existing) ? { sessionKey: cardSessionKey(existing) } : {}),
      };
      const audit = {
        ts: new Date(now).toISOString(),
        agent_id: normalizedAgentId,
        card_id: existing.id,
        reason_code: reasonCode,
        explanation,
        reference_card_id: referenceCardId ?? null,
        prior_status: existing.status,
        dbos_run_id: null,
      };
      await this.appendForceCloseAudit(audit);

      const metadata: WorkboardMetadata = trimMetadataToBudget({
        ...clearDiagnostics(existing.metadata, ["missing_proof"]),
        claim: undefined,
        closureType: "force_close",
        comments: [
          ...(existing.metadata?.comments ?? []),
          { id: randomUUID(), body: comment, createdAt: now },
        ].slice(-MAX_CARD_COMMENTS),
        notifications: [...(existing.metadata?.notifications ?? []), notification].slice(
          -MAX_CARD_NOTIFICATIONS,
        ),
      });

      return await this.updateCard(
        existing.id,
        {
          status: "done",
          metadata,
        },
        {
          enforceStatusHolds: true,
        },
      );
    });
  }

  protected buildBlockedCardPatch(
    existing: WorkboardCard,
    reason: string,
    now: number,
    options: { clearExecutionAssociation?: boolean } = {},
  ): WorkboardCardPatch & { metadata: WorkboardMetadata } {
    const metadata = existing.metadata ?? {};
    const notification: WorkboardNotification = {
      id: randomUUID(),
      kind: "failed",
      createdAt: now,
      sequence: this.nextNotificationSequence(now),
      message: capText(reason, 240) ?? "Workboard card blocked.",
      ...(cardSessionKey(existing) ? { sessionKey: cardSessionKey(existing) } : {}),
      ...(cardRunId(existing) ? { runId: cardRunId(existing) } : {}),
    };
    const execution =
      existing.execution?.status === "running"
        ? { ...existing.execution, status: "blocked" as const, updatedAt: now }
        : existing.execution;
    return {
      status: "blocked",
      ...(options.clearExecutionAssociation
        ? { sessionKey: null, runId: null, execution: null }
        : execution
          ? { execution }
          : {}),
      metadata: {
        ...metadata,
        claim: undefined,
        attempts: closeRunningAttempts(metadata.attempts, now, "blocked", reason),
        failureCount: (metadata.failureCount ?? 0) + 1,
        comments: [
          ...(metadata.comments ?? []),
          { id: randomUUID(), body: reason, createdAt: now },
        ].slice(-MAX_CARD_COMMENTS),
        notifications: [...(metadata.notifications ?? []), notification].slice(
          -MAX_CARD_NOTIFICATIONS,
        ),
      },
    };
  }

  async block(
    id: string,
    input: WorkboardBlockInput = {},
    scope: WorkboardMutationScope | null | undefined = input,
    options: { clearExecutionAssociation?: boolean } = {},
  ): Promise<WorkboardCard> {
    return await this.enqueueMutation(async () => {
      const existing = await this.get(id);
      if (!existing) {
        throw new Error(`card not found: ${id}`);
      }
      assertCanMutateClaimedCard(existing, scope === null ? undefined : scope);
      const now = Date.now();
      const reason =
        normalizeBoundedString(input.reason, undefined, 2000, "block reason") ??
        "Workboard card blocked.";
      return await this.updateCard(id, this.buildBlockedCardPatch(existing, reason, now, options));
    });
  }

  async unblock(id: string, scope?: WorkboardMutationScope): Promise<WorkboardCard> {
    return await this.enqueueMutation(async () => {
      const existing = await this.get(id);
      if (!existing) {
        throw new Error(`card not found: ${id}`);
      }
      assertCanMutateClaimedCard(existing, scope);
      const metadata = clearDiagnostics(existing.metadata, ["blocked_too_long"]);
      return await this.updateCard(id, { status: "todo", metadata: { ...metadata, stale: null } });
    });
  }

  async reassign(
    id: string,
    input: WorkboardReassignInput = {},
    scope?: WorkboardMutationScope | null,
  ): Promise<WorkboardCard> {
    return await this.enqueueMutation(async () => {
      const existing = await this.get(id);
      if (!existing) {
        throw new Error(`card not found: ${id}`);
      }
      assertCanMutateClaimedCard(existing, scope === null ? undefined : scope);
      const agentId =
        input.agentId === undefined ? existing.agentId : normalizeOptionalString(input.agentId);
      const status =
        input.status === undefined
          ? existing.status
          : normalizeStatus(input.status, existing.status);
      const reason = normalizeBoundedString(input.reason, undefined, 1000, "reassign reason");
      const shouldResetFailures = input.resetFailures !== false;
      const baseMetadata = shouldResetFailures
        ? clearDiagnostics(existing.metadata, ["blocked_too_long", "repeated_failures"])
        : existing.metadata;
      const metadata = {
        ...baseMetadata,
        ...(shouldResetFailures ? { failureCount: 0 } : {}),
        comments: reason
          ? [
              ...(baseMetadata?.comments ?? []),
              { id: randomUUID(), body: reason, createdAt: Date.now() },
            ].slice(-MAX_CARD_COMMENTS)
          : baseMetadata?.comments,
      };
      return await this.updateCard(id, { agentId, status, metadata }, { enforceStatusHolds: true });
    });
  }

  async reclaim(
    id: string,
    input: WorkboardReclaimInput = {},
    scope?: WorkboardMutationScope | null,
  ): Promise<WorkboardCard> {
    return await this.enqueueMutation(async () => {
      const existing = await this.get(id);
      if (!existing) {
        throw new Error(`card not found: ${id}`);
      }
      // PATCH workboard-reclaim-expired-claim (card 1b0f98cb, 2026-09-03):
      // reclaim of an expired claim from a dead owner is permitted. The TTL
      // is the authoritative fence; once past, anyone may take the work.
      assertCanMutateClaimedCard(existing, scope === null ? undefined : scope, {
        allowExpiredClaim: true,
      });
      const now = Date.now();
      const reason =
        normalizeBoundedString(input.reason, undefined, 1000, "reclaim reason") ??
        "Workboard claim reclaimed.";
      const targetStatus =
        input.status === undefined
          ? existing.status === "running"
            ? "ready"
            : existing.status
          : normalizeStatus(input.status, existing.status);
      const reclaimed0 = await this.updateCard(
        id,
        {
          status: targetStatus,
          execution: existing.execution?.status === "running" ? null : existing.execution,
          metadata: {
            ...existing.metadata,
            // PATCH-80d44431 (backport 2026-09-03, card a3922b20): reclaim→done
            // must never silently complete without proof — attach a
            // skipped-status proof stub when no proof exists.
            ...(targetStatus === "done" && !existing.metadata?.proof?.length
              ? {
                  proof: [
                    normalizeProofInput(
                      {
                        status: "skipped",
                        label: "reclaim recovery",
                        note: `reclaim recovery: ${reason}`,
                      },
                      now,
                    ),
                  ],
                }
              : {}),
            claim: undefined,
            attempts: closeRunningAttempts(existing.metadata?.attempts, now, "stopped", reason),
            comments: [
              ...(existing.metadata?.comments ?? []),
              { id: randomUUID(), body: reason, createdAt: now },
            ].slice(-MAX_CARD_COMMENTS),
            stale: null,
          },
        },
        { enforceStatusHolds: true },
      );
      // PATCH-80d44431 (backport): if a reclaim→done still lands with no proof
      // row and no artifacts, emit a done_without_proof diagnostic.
      let reclaimed = reclaimed0;
      if (
        reclaimed0.status === "done" &&
        !reclaimed0.metadata?.proof?.length &&
        !reclaimed0.metadata?.artifacts?.length
      ) {
        reclaimed = await this.updateMetadata(reclaimed0.id, (metadataExisting) => ({
          ...metadataExisting.metadata,
          diagnostics: [
            ...(metadataExisting.metadata?.diagnostics ?? []),
            diagnostic(
              {
                kind: "done_without_proof",
                severity: "warning",
                title: "Reclaim to done completed without proof",
                detail: `reclaim recovery: ${reason}`,
                actions: [{ kind: "add_proof", label: "Add proof" }],
              },
              now,
            ),
          ],
        }));
      }
      return await this.promoteDependencyReady(reclaimed.id, now);
    });
  }

  async runs(id: string): Promise<{ card: WorkboardCard; attempts: WorkboardRunAttempt[] }> {
    const card = await this.get(id);
    if (!card) {
      throw new Error(`card not found: ${id}`);
    }
    return { card, attempts: card.metadata?.attempts ?? [] };
  }

  async specify(
    id: string,
    input: WorkboardSpecifyInput = {},
    scope?: WorkboardMutationScope | null,
  ): Promise<WorkboardCard> {
    return await this.enqueueMutation(async () => {
      const existing = await this.get(id);
      if (!existing) {
        throw new Error(`card not found: ${id}`);
      }
      assertCanMutateClaimedCard(existing, scope === null ? undefined : scope);
      if (
        existing.status !== "triage" &&
        existing.status !== "backlog" &&
        existing.status !== "todo"
      ) {
        throw new Error("only triage, backlog, or todo cards can be specified.");
      }
      const requestedStatus = normalizeStatus(input.status, "todo");
      if (requestedStatus !== "todo") {
        throw new Error("specified cards must move to todo.");
      }
      const now = Date.now();
      const summary = normalizeBoundedString(input.summary, undefined, 2000, "spec summary");
      const metadata = {
        ...existing.metadata,
        comments: summary
          ? [
              ...(existing.metadata?.comments ?? []),
              { id: randomUUID(), body: summary, createdAt: now },
            ].slice(-MAX_CARD_COMMENTS)
          : existing.metadata?.comments,
        automation: normalizeAutomation(
          {
            ...existing.metadata?.automation,
            summary: summary ?? existing.metadata?.automation?.summary,
          },
          existing.metadata?.automation,
        ),
      };
      const { summary: _summary, status: _status, ...cardPatch } = input;
      return await this.updateCard(
        id,
        {
          ...cardPatch,
          status: "todo",
          metadata,
        },
        { enforceStatusHolds: true, event: { kind: "specified" }, eventAt: now },
      );
    });
  }

  async decompose(
    id: string,
    input: WorkboardDecomposeInput = {},
    scope?: WorkboardMutationScope | null,
  ): Promise<{ parent: WorkboardCard; children: WorkboardCard[] }> {
    return await this.enqueueMutation(
      async () =>
        await this.withCardCompensation(async () => {
          const parent = await this.get(id);
          if (!parent) {
            throw new Error(`card not found: ${id}`);
          }
          assertCanMutateClaimedCard(parent, scope === null ? undefined : scope);
          const childrenInput = Array.isArray(input.children) ? input.children : [];
          if (childrenInput.length === 0) {
            throw new Error("children are required.");
          }
          if (childrenInput.length > 20) {
            throw new Error("at most 20 children can be created at once.");
          }
          const parentAutomation = parent.metadata?.automation;
          const children: WorkboardCard[] = [];
          for (const rawChild of childrenInput) {
            if (!rawChild || typeof rawChild !== "object" || Array.isArray(rawChild)) {
              throw new Error("children must be objects.");
            }
            const child = rawChild as WorkboardDecomposeChildInput;
            const created = await this.createDirect(
              {
                ...child,
                parents: [parent.id],
                boardId: child.boardId ?? parentAutomation?.boardId,
                tenant: child.tenant ?? parentAutomation?.tenant,
                createdByCardId: parent.id,
                idempotencyKey:
                  child.idempotencyKey ??
                  deriveChildIdempotencyKey(parentAutomation?.idempotencyKey, children.length + 1),
              },
              scope === null ? undefined : scope,
            );
            children.push(
              cardParentIds(created).includes(parent.id)
                ? created
                : await this.linkCardsDirect(parent.id, created.id, Date.now(), {
                    allowStatusOnlyActiveChild: true,
                    scope: scope === null ? undefined : scope,
                  }),
            );
          }
          const summary = normalizeBoundedString(
            input.summary,
            undefined,
            2000,
            "decompose summary",
          );
          const completeParent = input.completeParent !== false;
          const updatedParent = completeParent
            ? await this.completeDirect(
                parent.id,
                { summary, createdCardIds: children.map((child) => child.id) },
                scope,
              )
            : await (async () => {
                const latestParent = (await this.get(parent.id)) ?? parent;
                return await this.updateCard(
                  parent.id,
                  {
                    status:
                      latestParent.status === "triage" || latestParent.status === "backlog"
                        ? "todo"
                        : latestParent.status,
                    metadata: {
                      ...latestParent.metadata,
                      automation: normalizeAutomation(
                        {
                          ...latestParent.metadata?.automation,
                          summary,
                          createdCardIds: children.map((child) => child.id),
                        },
                        latestParent.metadata?.automation,
                      ),
                    },
                  },
                  { enforceStatusHolds: true },
                );
              })();
          const decomposedParent = await this.updateCard(
            updatedParent.id,
            {},
            {
              event: { kind: "decomposed" },
              expectedUpdatedAt: updatedParent.updatedAt,
            },
          );
          return { parent: decomposedParent, children };
        }),
    );
  }
}
