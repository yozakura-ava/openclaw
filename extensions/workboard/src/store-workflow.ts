import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { isDeepStrictEqual, promisify } from "node:util";
import type {
  WorkboardArtifact,
  WorkboardCard,
  WorkboardClaim,
  WorkboardMetadata,
  WorkboardRunAttempt,
} from "@openclaw/workboard-contract";
import {
  isFutureDateTimestampMs,
  resolveOptionalIntegerOption,
} from "openclaw/plugin-sdk/number-runtime";
import { safeEqualSecret } from "openclaw/plugin-sdk/security-runtime";
import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeActor } from "./actor-attribution.js";
import type { ConsumerSurfaceEvidence } from "./persistence-types.js";
import {
  appendComment,
  assertCanMutateClaimedCard,
  cardBoardId,
  cardChildIds,
  cardParentIds,
  cardRunId,
  cardSessionKey,
  closeRunningAttempts,
  retryBudgetExhausted,
} from "./store-card-helpers.js";
import {
  recordClaimConflict,
  snapshotClaimConflictHistory,
  type WorkboardClaimConflictEvent,
} from "./store-claim-conflict.js";
import {
  addWorkboardDurationMs,
  DEFAULT_CLAIM_TTL_MS,
  isWorkboardClaimReclaimable,
  MAX_CARD_ARTIFACTS,
  secondsToDurationMs,
} from "./store-constants.js";
import type {
  WorkboardBlockInput,
  WorkboardCardPatch,
  WorkboardClaimInput,
  WorkboardClaimOptions,
  WorkboardCompleteInput,
  WorkboardDecomposeInput,
  WorkboardHeartbeatInput,
  WorkboardMutationScope,
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
} from "./store-normalizers.js";
import { WorkboardPromoteStore } from "./store-promote.js";
import type { ConsumerSurfaceEvidence } from "./persistence-types.js";
import { finishRun } from "./store-status-write.js";
import {
  recordClaimConflict,
  snapshotClaimConflictHistory,
  type WorkboardClaimConflictEvent,
} from "./store-claim-conflict.js";

class WorkboardClaimRefusedError extends Error {
  constructor(message: string) {
    super(message);
    // The name lets Gateway tool invocation return the actionable message.
    this.name = "ToolInputError";
  }
}

function assertClaimIdentity(claim: WorkboardClaim, input: WorkboardHeartbeatInput): void {
  const token = normalizeOptionalString(input.token);
  const ownerId = normalizeOptionalString(input.ownerId);
  if (token && !safeEqualSecret(token, claim.token)) {
    throw new Error("claim token does not match.");
  }
  if (!token && ownerId && ownerId !== claim.ownerId) {
    throw new Error("claim owner does not match.");
  }
}

const execFileAsync = promisify(execFile);

/** Card labels that gate completion on consumer_surface_evidence. */
const CONSUMER_SURFACE_EVIDENCE_LABELS = new Set(["[BUILD]", "[INFRA]"]);

function asConsumerSurfaceEvidence(input: unknown): ConsumerSurfaceEvidence {
  if (!isRecord(input)) {
    throw new Error(
      '[BUILD]/[INFRA] cards require consumer_surface_evidence on completion: an object like { kind: "code" | "skill" | "research", repoPath?, commitSha?, filePath?, consumerId? }. The evidence is verified independently; caller-supplied proof text is never trusted.',
    );
  }
  const kind = input.kind;
  if (kind !== "code" && kind !== "skill" && kind !== "research") {
    throw new Error(
      'consumer_surface_evidence.kind must be one of "code", "skill", or "research".',
    );
  }
  const readPath = (field: string): string | undefined => {
    const value = input[field];
    if (value === undefined) {
      return undefined;
    }
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(`consumer_surface_evidence.${field} must be a non-empty string.`);
    }
    return value;
  };
  const evidence: ConsumerSurfaceEvidence = {
    kind,
    ...(readPath("repoPath") ? { repoPath: readPath("repoPath") } : {}),
    ...(readPath("commitSha") ? { commitSha: readPath("commitSha") } : {}),
    ...(readPath("filePath") ? { filePath: readPath("filePath") } : {}),
    ...(readPath("consumerId") ? { consumerId: readPath("consumerId") } : {}),
  };
  return evidence;
}

/**
 * Independently verify consumer surface evidence against the world — never
 * trusting caller-supplied text. kind=code resolves the commit in the given
 * git repository; kind=skill requires an existing SKILL.md; kind=research
 * requires an existing non-empty artifact file.
 */
async function verifyConsumerSurfaceEvidence(
  input: unknown,
  now: number,
): Promise<WorkboardArtifact> {
  const evidence = asConsumerSurfaceEvidence(input);
  if (evidence.kind === "code") {
    if (!evidence.repoPath || !evidence.commitSha) {
      throw new Error('consumer_surface_evidence kind "code" requires repoPath and commitSha.');
    }
    try {
      await execFileAsync("git", [
        "-C",
        evidence.repoPath,
        "cat-file",
        "-e",
        `${evidence.commitSha}^{commit}`,
      ]);
    } catch {
      throw new Error(
        `consumer_surface_evidence rejected: commit ${evidence.commitSha} does not resolve in repository ${evidence.repoPath}.`,
      );
    }
  }
  if (evidence.filePath) {
    try {
      const info = await stat(evidence.filePath);
      if (evidence.kind === "research" && !info.isFile()) {
        throw new Error("not a file");
      }
      if (evidence.kind === "research" && info.size === 0) {
        throw new Error("empty file");
      }
      if (
        evidence.kind === "skill" &&
        (!info.isFile() || !evidence.filePath.split("/").at(-1)?.endsWith(".md"))
      ) {
        throw new Error("not a markdown skill file");
      }
    } catch (error) {
      throw new Error(
        `consumer_surface_evidence rejected: filePath ${evidence.filePath} failed verification (${error instanceof Error ? error.message : String(error)}).`,
        { cause: error },
      );
    }
  } else if (evidence.kind === "skill" || evidence.kind === "research") {
    throw new Error(`consumer_surface_evidence kind "${evidence.kind}" requires filePath.`);
  }
  return {
    id: randomUUID(),
    createdAt: now,
    label: `consumer_surface_evidence:${evidence.kind}`,
    ...(evidence.filePath
      ? { path: evidence.filePath }
      : evidence.repoPath
        ? { path: evidence.repoPath }
        : {}),
    ...(evidence.consumerId ? { url: `consumer:${evidence.consumerId}` } : {}),
  };
}

export class WorkboardWorkflowStore extends WorkboardPromoteStore {
  /**
   * Read-only snapshot of the bounded takeover / claim-conflict history
   * (#115 scope, prior art upstream issue #24 — CLOSED). Records every
<<<<<<< HEAD
   * archived/done rejection and every foreign takeover attempt the store has
   * rejected since process start. Bounded at CLAIM_CONFLICT_HISTORY_CAP
=======
   * archived/done rejection and every foreign takeover attempt the store
   * has rejected since process start. Bounded at CLAIM_CONFLICT_HISTORY_CAP
>>>>>>> 97b6e87616f
   * entries, FIFO. Not persisted — restarts clear it.
   */
  get claimConflicts(): readonly WorkboardClaimConflictEvent[] {
    return snapshotClaimConflictHistory();
  }

  async claim(
    id: string,
    input: WorkboardClaimInput,
    options: WorkboardClaimOptions = {},
  ): Promise<{ card: WorkboardCard; token: string }> {
    const ownerId = normalizeBoundedString(input.ownerId, undefined, 120, "claim owner");
    if (!ownerId) {
      throw new Error("claim ownerId is required.");
    }
    const sessionId = normalizeBoundedString(input.sessionId, undefined, 160, "claim session");
    const ttlSeconds = resolveOptionalIntegerOption(input.ttlSeconds, { min: 1 });
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
        recordClaimConflict({
          kind: "claim_on_archived",
          cardId: id,
          attemptedOwnerId: ownerId,
          at: now,
        });
        throw new Error("card is archived.");
      }
      // PATCH done-card claim guard (#115 scope, prior art issue #24):
<<<<<<< HEAD
      // completed cards must reject claim attempts BEFORE the strict claim
      // fence evaluates, otherwise a done card that already carries a live
      // claim would hit the fence branch and never reach this guard. Without
      // it a stale orchestrator can attach a new claim token to a terminal
      // card and silently re-open the work surface.
=======
      // completed cards must reject claim attempts BEFORE the claim fence
      // evaluates, otherwise a done card carrying a live claim would hit
      // the fence branch and never reach this guard. Without it a stale
      // orchestrator can attach a new claim token to a terminal card and
      // silently re-open the work surface.
>>>>>>> 97b6e87616f
      if (guarded.status === "done") {
        recordClaimConflict({
          kind: "claim_on_done",
          cardId: id,
          attemptedOwnerId: ownerId,
          at: now,
        });
        throw new Error("card is completed.");
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
      // [claim-fence 59663fca] STRICT (default): a live claim blocks every
      // re-claim — same agentId included — closing the silent-supersede class
      // (incident 8593cbd6: two sessions of one agent overwrote a live claim).
      // The only exemption is the holder proving ownership with the CURRENT
      // claim token (idempotent refresh). Holders extend via heartbeat/release;
      // others wait for expiry + grace or use reclaim/reassign recovery.
      // LEGACY (OPENCLAW_WORKBOARD_CLAIM_FENCE=legacy): pre-fence semantics,
      // kept verbatim below as the instant-rollback lever.
      const fenceStrict = process.env.OPENCLAW_WORKBOARD_CLAIM_FENCE !== "legacy";
      const holderRefresh = Boolean(
        existingClaim &&
<<<<<<< HEAD
        existingClaim.ownerId === ownerId &&
        (existingClaim.token === token ||
          (existingClaim.sessionId ?? null) === (sessionId ?? null)),
      );
      const activeClaim =
        !existingClaim || holderRefresh
          ? undefined
          : fenceStrict
            ? isFutureDateTimestampMs(existingClaim.expiresAt, { nowMs: now }) ||
              (guarded.status === "running" && !isWorkboardClaimReclaimable(existingClaim, now))
              ? existingClaim
              : undefined
            : existingClaim.ownerId !== ownerId &&
                (isFutureDateTimestampMs(existingClaim.expiresAt, { nowMs: now }) ||
                  // Direct claims must honor the same running-worker heartbeat grace
                  // as dispatcher recovery; otherwise they silently steal live tokens.
                  // An EXPIRED claim never blocks its own owner from re-claiming
                  // immediately (fb3854a7 semantics): the heartbeat grace exists to
                  // stop OTHER owners from stealing a live worker's token, not to
                  // lock the original owner out of its own stale claim.
                  (guarded.status === "running" &&
                    !isWorkboardClaimReclaimable(existingClaim, now) &&
                    existingClaim.ownerId !== ownerId))
              ? existingClaim
              : undefined;
      const parentIds = cardParentIds(guarded);
      if (parentIds.length > 0 && guarded.status !== "ready" && !activeClaim) {
        if (guarded.status === "blocked") {
          throw new Error("card is blocked; use workboard_unblock before claiming.");
        }
        // Dependency promotion skips review and running cards, so judge the parents.
        if (!(await this.parentsDone(parentIds))) {
          throw new Error("card dependencies are not done.");
=======
        (isFutureDateTimestampMs(existingClaim.expiresAt, { nowMs: now }) ||
          // Direct claims must honor the same running-worker heartbeat grace
          // as dispatcher recovery; otherwise they silently steal live tokens.
          (guarded.status === "running" && !isWorkboardClaimReclaimable(existingClaim, now)))
          ? existingClaim
          : undefined;
      const parentIds = cardParentIds(guarded);
      if (parentIds.length > 0 && guarded.status !== "ready" && !activeClaim) {
        if (guarded.status === "blocked") {
          throw new WorkboardClaimRefusedError(
            "card is blocked; use workboard_unblock before claiming.",
          );
        }
        // Dependency promotion skips review and running cards, so judge the parents.
        if (!(await this.parentsDone(parentIds))) {
          throw new WorkboardClaimRefusedError("card dependencies are not done.");
>>>>>>> 97b6e87616f
        }
      }
      if (guarded.status === "scheduled") {
        throw new WorkboardClaimRefusedError("card is scheduled for later.");
      }
      if (retryBudgetExhausted(guarded)) {
        throw new WorkboardClaimRefusedError("card exhausted its retry budget.");
      }
      if (activeClaim) {
        // PATCH takeover diagnostic (#115 scope, prior art issue #24): record
<<<<<<< HEAD
        // the takeover ONLY when we are about to reject a FOREIGN live claim
        // attempt. Same-owner self-recovery does NOT record a takeover event
        // — the original owner reclaiming its own slot is not a takeover.
=======
        // the takeover ONLY when rejecting a FOREIGN live claim attempt.
        // Same-owner self-recovery does not record a takeover event — the
        // original owner reclaiming its own slot is not a takeover.
>>>>>>> 97b6e87616f
        if (activeClaim.ownerId !== ownerId) {
          recordClaimConflict({
            kind: "takeover",
            cardId: id,
            attemptedOwnerId: ownerId,
            priorOwnerId: activeClaim.ownerId,
            priorExpiresAt: activeClaim.expiresAt,
            at: now,
          });
        }
<<<<<<< HEAD
        throw new Error(
          fenceStrict
            ? `card already claimed by ${activeClaim.ownerId ?? "another agent"}. [claim-fence:strict]` +
                ` holder session=${activeClaim.sessionId ?? "<unknown-session>"}` +
                ` claimedAt=${new Date(activeClaim.claimedAt).toISOString()}` +
                ` — holder must workboard_release/heartbeat; others wait for expiry + grace or reclaim/reassign.`
            : `card already claimed by ${activeClaim.ownerId}.`,
        );
=======
        throw new WorkboardClaimRefusedError(`card already claimed by ${activeClaim.ownerId}.`);
>>>>>>> 97b6e87616f
      }
      const metadata = clearDiagnostics(guarded.metadata, ["stranded_ready"]);
      const card = await this.updateCard(
        guarded,
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
            claim: {
              ownerId,
              token,
              claimedAt: now,
              lastHeartbeatAt: now,
              expiresAt,
              ...(sessionId ? { sessionId } : {}),
            },
          },
        },
        {
          expectedUpdatedAt: guarded.updatedAt,
          ownerSlot: { ownerId, now },
        },
      );
      return { card, token };
    }, options.assertOwnerCurrent);
  }

  async heartbeat(id: string, input: WorkboardHeartbeatInput): Promise<WorkboardCard> {
    const note = normalizeBoundedString(input.note, undefined, 400, "heartbeat note");
    return await this.updateMetadata(id, (existing) => {
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
        claim: nextClaim,
        comments: appendComment(metadata.comments, note, now),
      };
    });
  }

  async releaseClaim(
    id: string,
    input: WorkboardHeartbeatInput & { status?: unknown } = {},
  ): Promise<WorkboardCard> {
    return await this.enqueueMutation(async () => {
      const existing = await this.requireCard(id);
      const status = normalizeStatus(input.status, existing.status);
      const claim = existing.metadata?.claim;
      if (claim) {
        assertClaimIdentity(claim, input);
      }
      return await this.updateCard(
        existing,
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
    return await this.enqueueMutation(() => this.completeDirect(id, input, scope));
  }

  private async completeDirect(
    id: string,
    input: WorkboardCompleteInput = {},
    scope: WorkboardMutationScope | null | undefined = input,
  ): Promise<WorkboardCard> {
    const existing = await this.requireCard(id);
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
    const actor = normalizeActor(input);
    const proofInput = isRecord(input.proof) ? input.proof : undefined;
    const proofId = normalizeBoundedString(input.proofId, undefined, 120, "proof id");
    if (input.proofId !== undefined && !proofId) {
      throw new Error("proofId must be a non-empty string.");
    }
<<<<<<< HEAD
    const proof = proofInput ? normalizeProofInput({ ...proofInput, ...actor }, now) : undefined;
=======
    const proof = proofInput ? normalizeProofInput(proofInput, now) : undefined;
>>>>>>> 97b6e87616f
    const buildCardRequiresEvidence = (existing.labels ?? []).some((label) =>
      CONSUMER_SURFACE_EVIDENCE_LABELS.has(label),
    );
    let evidenceArtifact: WorkboardArtifact | undefined;
    if (buildCardRequiresEvidence) {
      evidenceArtifact = await verifyConsumerSurfaceEvidence(input.consumer_surface_evidence, now);
    }
    const artifacts = Array.isArray(input.artifacts)
      ? input.artifacts
          .map((artifact) => normalizeArtifact({ ...artifact, createdAt: now }))
          .filter((artifact): artifact is WorkboardArtifact => artifact !== null)
          .slice(-MAX_CARD_ARTIFACTS)
      : [];
    const finished = finishRun(existing, "done", now);
    const metadata = clearDiagnostics(finished.metadata, ["missing_proof"]);
    const notifications = this.appendNotification(metadata, now, {
      kind: "completed",
      message: capText(summary, 240) ?? "Workboard card completed.",
      ...(cardSessionKey(existing) ? { sessionKey: cardSessionKey(existing) } : {}),
      ...(cardRunId(existing) ? { runId: cardRunId(existing) } : {}),
    });
    return await this.updateCard(
      existing,
      {
        ...finished,
        metadata: {
          ...metadata,
          automation: normalizeAutomation(
            {
              ...metadata.automation,
              summary,
              createdCardIds,
            },
            metadata.automation,
          ),
          comments: appendComment(metadata.comments, summary, now, actor),
          proof: appendCompletionProof(metadata.proof, proof, proofId),
          artifacts:
            evidenceArtifact || artifacts.length
              ? [
                  ...(evidenceArtifact ? [evidenceArtifact] : []),
                  ...(metadata.artifacts ?? []),
                  ...artifacts,
                ].slice(-MAX_CARD_ARTIFACTS)
              : metadata.artifacts,
          notifications,
        },
      },
      {
        enforceStatusHolds: true,
        preserveProofId: proofId ?? proof?.id,
        preserveNotificationId: notification.id,
      },
    );
  }

  protected buildBlockedCardPatch(
    existing: WorkboardCard,
    reason: string,
    now: number,
    options: { clearExecutionAssociation?: boolean } = {},
  ): WorkboardCardPatch & { metadata: WorkboardMetadata } {
    const finished = finishRun(existing, "blocked", now, reason);
    const metadata = finished.metadata;
    const notifications = this.appendNotification(metadata, now, {
      kind: "failed",
      message: capText(reason, 240) ?? "Workboard card blocked.",
      ...(cardSessionKey(existing) ? { sessionKey: cardSessionKey(existing) } : {}),
      ...(cardRunId(existing) ? { runId: cardRunId(existing) } : {}),
    });
    return {
      ...finished,
      ...(options.clearExecutionAssociation
        ? { sessionKey: null, runId: null, execution: null }
        : {}),
      metadata: {
        ...metadata,
        comments: appendComment(metadata.comments, reason, now),
        notifications,
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
      const existing = await this.requireCard(id);
      assertCanMutateClaimedCard(existing, scope === null ? undefined : scope);
      const now = Date.now();
      const reason =
        normalizeBoundedString(input.reason, undefined, 2000, "block reason") ??
        "Workboard card blocked.";
      return await this.updateCard(
        existing,
        this.buildBlockedCardPatch(existing, reason, now, options),
      );
    });
  }

  async unblock(id: string, scope?: WorkboardMutationScope): Promise<WorkboardCard> {
    return await this.enqueueMutation(async () => {
      const existing = await this.requireCard(id);
      assertCanMutateClaimedCard(existing, scope);
      const metadata = clearDiagnostics(existing.metadata, ["blocked_too_long"]);
      return await this.updateCard(existing, {
        status: "todo",
        metadata: { ...metadata, stale: null },
      });
    });
  }

  async reassign(
    id: string,
    input: WorkboardReassignInput = {},
    scope?: WorkboardMutationScope | null,
  ): Promise<WorkboardCard> {
    return await this.enqueueMutation(async () => {
      const existing = await this.requireCard(id);
      assertCanMutateClaimedCard(existing, scope === null ? undefined : scope);
      const agentId =
        input.agentId === undefined ? existing.agentId : normalizeOptionalString(input.agentId);
      const status = normalizeStatus(input.status, existing.status);
      const reason = normalizeBoundedString(input.reason, undefined, 1000, "reassign reason");
      const shouldResetFailures = input.resetFailures !== false;
      const baseMetadata = shouldResetFailures
        ? clearDiagnostics(existing.metadata, ["blocked_too_long", "repeated_failures"])
        : existing.metadata;
      const metadata = {
        ...baseMetadata,
        ...(shouldResetFailures ? { failureCount: 0 } : {}),
        comments: appendComment(baseMetadata?.comments, reason),
      };
      return await this.updateCard(
        existing,
        { agentId, status, metadata },
        { enforceStatusHolds: true },
      );
    });
  }

  async reclaim(
    id: string,
    input: WorkboardReclaimInput = {},
    scope?: WorkboardMutationScope | null,
  ): Promise<WorkboardCard> {
    return await this.enqueueMutation(async () => {
      const existing = await this.requireCard(id);
      assertCanMutateClaimedCard(existing, scope === null ? undefined : scope);
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
      const reclaimed = await this.updateCard(
        existing,
        {
          status: targetStatus,
          execution: existing.execution?.status === "running" ? null : existing.execution,
          metadata: {
            ...existing.metadata,
            claim: undefined,
            attempts: closeRunningAttempts(existing.metadata?.attempts, now, "stopped", reason),
            comments: appendComment(existing.metadata?.comments, reason, now),
            stale: null,
          },
        },
        { enforceStatusHolds: true },
      );
      return await this.promoteDependencyReady(reclaimed.id, now);
    });
  }

  async runs(id: string): Promise<{ card: WorkboardCard; attempts: WorkboardRunAttempt[] }> {
    const card = await this.requireCard(id);
    return { card, attempts: card.metadata?.attempts ?? [] };
  }

  async specify(
    id: string,
    input: WorkboardSpecifyInput = {},
    scope?: WorkboardMutationScope | null,
  ): Promise<WorkboardCard> {
    return await this.enqueueMutation(async () => {
      const existing = await this.requireCard(id);
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
        comments: appendComment(existing.metadata?.comments, summary, now),
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
        existing,
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
    return await this.enqueueMutation(async () => {
      const parent = await this.requireCard(id);
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
      for (const child of childrenInput) {
        if (!isRecord(child)) {
          throw new Error("children must be objects.");
        }
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
      const summary = normalizeBoundedString(input.summary, undefined, 2000, "decompose summary");
      const completeParent = input.completeParent !== false;
      const updatedParent = completeParent
        ? await this.completeDirect(
            parent.id,
            { summary, createdCardIds: children.map((child) => child.id) },
            scope,
          )
        : await (async () => {
            const latestParent = await this.requireCard(parent.id);
            return await this.updateCard(
              latestParent,
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
        updatedParent,
        {},
        {
          event: { kind: "decomposed" },
          expectedUpdatedAt: updatedParent.updatedAt,
        },
      );
      return { parent: decomposedParent, children };
    });
  }
}
