import { randomUUID } from "node:crypto";
import {
  WORKBOARD_STATUSES,
  type WorkboardAttemptStatus,
  type WorkboardCard,
  type WorkboardDiagnostic,
  type WorkboardDiagnosticAction,
  type WorkboardDiagnosticKind,
  type WorkboardDiagnosticSeverity,
  type WorkboardEvent,
  type WorkboardExecution,
  type WorkboardMetadata,
  type WorkboardNotification,
  type WorkboardRunAttempt,
  type WorkboardStatus,
} from "@openclaw/workboard-contract";
import { safeEqualSecret } from "openclaw/plugin-sdk/security-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  BLOCKED_TOO_LONG_MS,
  MAX_CARD_ATTEMPTS,
  MAX_CARD_EVENTS,
  READY_STRANDED_MS,
  RUNNING_HEARTBEAT_STALE_MS,
  isWorkboardClaimReclaimable,
} from "./store-constants.js";
import type { WorkboardMutationScope } from "./store-inputs.js";
import {
  capText,
  metadataIsEmpty,
  normalizeEvents,
  normalizeTimestamp,
  removeUndefinedMetadataFields,
} from "./store-normalizers.js";

export function compareCards(left: WorkboardCard, right: WorkboardCard): number {
  if (left.status !== right.status) {
    return WORKBOARD_STATUSES.indexOf(left.status) - WORKBOARD_STATUSES.indexOf(right.status);
  }
  if (left.position !== right.position) {
    return left.position - right.position;
  }
  return left.createdAt - right.createdAt;
}

export function cardSessionKey(card: WorkboardCard): string | undefined {
  return card.sessionKey ?? card.execution?.sessionKey;
}

export function cardRunId(card: WorkboardCard): string | undefined {
  return card.runId ?? card.execution?.runId;
}

function executionAttemptStatus(execution: WorkboardExecution): WorkboardAttemptStatus {
  if (execution.status === "running") {
    return "running";
  }
  if (execution.status === "blocked") {
    return "blocked";
  }
  if (execution.status === "done" || execution.status === "review") {
    return "succeeded";
  }
  return "stopped";
}

export function syncExecutionAttemptMetadata(
  metadata: WorkboardMetadata,
  execution: WorkboardExecution | undefined,
  now: number,
): WorkboardMetadata {
  if (!execution) {
    return metadata;
  }
  const attemptStatus = executionAttemptStatus(execution);
  const attempts = [...(metadata.attempts ?? [])];
  const key = execution.runId ?? execution.sessionKey ?? execution.id;
  const existingIndex = attempts.findIndex(
    (attempt) =>
      (execution.runId && attempt.runId === execution.runId) ||
      (!execution.runId && attempt.id === key),
  );
  const existingAttempt = existingIndex >= 0 ? attempts[existingIndex] : undefined;
  const nextAttempt: WorkboardRunAttempt = {
    id: existingAttempt?.id ?? key,
    status: attemptStatus,
    startedAt: existingAttempt?.startedAt ?? execution.startedAt,
    mode: execution.mode,
    ...(execution.engine ? { engine: execution.engine } : {}),
    ...(execution.model ? { model: execution.model } : {}),
    ...(execution.sessionKey ? { sessionKey: execution.sessionKey } : {}),
    ...(execution.runId ? { runId: execution.runId } : {}),
    ...(attemptStatus !== "running" && { endedAt: execution.updatedAt || now }),
    ...(attemptStatus !== "succeeded" && existingAttempt?.error
      ? { error: existingAttempt.error }
      : {}),
  };
  if (existingIndex >= 0) {
    attempts[existingIndex] = nextAttempt;
  } else {
    attempts.push(nextAttempt);
  }
  const previousFailed =
    existingAttempt?.status === "blocked" || existingAttempt?.status === "failed";
  const attemptFailed = attemptStatus === "blocked" || attemptStatus === "failed";
  const failureCount = attemptFailed
    ? previousFailed
      ? metadata.failureCount
      : (metadata.failureCount ?? 0) + 1
    : attemptStatus === "succeeded"
      ? 0
      : metadata.failureCount;
  return removeUndefinedMetadataFields({
    ...metadata,
    attempts: attempts.slice(-MAX_CARD_ATTEMPTS),
    failureCount,
  });
}

export function appendEvent(
  card: WorkboardCard,
  event: Omit<WorkboardEvent, "id" | "at">,
  at = Date.now(),
): WorkboardEvent[] {
  return [
    ...normalizeEvents(card.events),
    {
      id: randomUUID(),
      at,
      ...event,
    },
  ].slice(-MAX_CARD_EVENTS);
}

function metadataEntriesChanged(
  existing: WorkboardCard,
  next: WorkboardCard,
  key:
    | "comments"
    | "links"
    | "proof"
    | "artifacts"
    | "attachments"
    | "workerLogs"
    | "notifications",
): boolean {
  const previous = existing.metadata?.[key];
  const current = next.metadata?.[key];
  const latestId = current?.at(-1)?.id;
  return (
    (previous?.length ?? 0) !== (current?.length ?? 0) ||
    Boolean(latestId && latestId !== previous?.at(-1)?.id)
  );
}

export function lifecycleStatusSourceUpdatedAtFromPatch(metadata: unknown): number | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return undefined;
  }
  if (!Object.hasOwn(metadata, "lifecycleStatusSourceUpdatedAt")) {
    return undefined;
  }
  const sourceUpdatedAt = normalizeTimestamp(
    (metadata as Record<string, unknown>).lifecycleStatusSourceUpdatedAt,
    0,
  );
  return sourceUpdatedAt;
}

function latestStatusTransitionAt(card: WorkboardCard): number | undefined {
  for (let index = (card.events?.length ?? 0) - 1; index >= 0; index -= 1) {
    const event = card.events?.[index];
    if (
      (event?.kind === "moved" || event?.kind === "created") &&
      ((event.kind === "created" && card.status !== "todo") ||
        (event.kind === "moved" && event.fromStatus !== event.toStatus)) &&
      event.toStatus === card.status &&
      typeof event.at === "number" &&
      Number.isFinite(event.at)
    ) {
      return event.at;
    }
  }
  return undefined;
}

export function shouldSkipPersistedLifecycleStatusUpdate(
  existing: WorkboardCard,
  sourceUpdatedAt: number,
): boolean {
  const lifecycleStatusSourceUpdatedAt = existing.metadata?.lifecycleStatusSourceUpdatedAt;
  if (lifecycleStatusSourceUpdatedAt !== undefined) {
    return sourceUpdatedAt < lifecycleStatusSourceUpdatedAt;
  }
  const statusTransitionAt = latestStatusTransitionAt(existing);
  return statusTransitionAt !== undefined && sourceUpdatedAt < statusTransitionAt;
}

export function shouldSyncWorkboardLifecycleStatus(
  card: WorkboardCard,
  target: WorkboardStatus | undefined,
): boolean {
  if (!target || card.status === target) {
    return false;
  }
  if (target === "running") {
    return card.status === "backlog" || card.status === "todo" || card.status === "ready";
  }
  return (
    (target === "blocked" || target === "review") &&
    (card.status === "running" || card.status === "todo" || card.status === "ready")
  );
}

export function updateEvent(
  existing: WorkboardCard,
  next: WorkboardCard,
): Omit<WorkboardEvent, "id" | "at"> {
  if (
    existing.metadata?.workerProtocol?.state !== next.metadata?.workerProtocol?.state &&
    next.metadata?.workerProtocol?.state === "violated"
  ) {
    return { kind: "protocol_violation" };
  }
  if (existing.status !== next.status || existing.position !== next.position) {
    return {
      kind: "moved",
      fromStatus: existing.status,
      toStatus: next.status,
    };
  }
  if (cardSessionKey(existing) !== cardSessionKey(next)) {
    return {
      kind: "linked",
      ...(cardSessionKey(next) ? { sessionKey: cardSessionKey(next) } : {}),
    };
  }
  if (existing.metadata?.claim?.token !== next.metadata?.claim?.token) {
    return { kind: "claimed" };
  }
  if (existing.metadata?.claim?.lastHeartbeatAt !== next.metadata?.claim?.lastHeartbeatAt) {
    return { kind: "heartbeat" };
  }
  if (
    existing.execution?.status !== next.execution?.status ||
    existing.execution?.engine !== next.execution?.engine ||
    cardRunId(existing) !== cardRunId(next)
  ) {
    const existingAttempts = existing.metadata?.attempts ?? [];
    const nextAttempts = next.metadata?.attempts ?? [];
    const latestAttempt = nextAttempts.at(-1);
    if (nextAttempts.length > existingAttempts.length) {
      return {
        kind: "attempt_started",
        ...(latestAttempt?.sessionKey ? { sessionKey: latestAttempt.sessionKey } : {}),
        ...(latestAttempt?.runId ? { runId: latestAttempt.runId } : {}),
      };
    }
    const previousAttempt = latestAttempt
      ? existingAttempts.find((attempt) => attempt.id === latestAttempt.id)
      : undefined;
    if (latestAttempt && previousAttempt?.status !== latestAttempt.status) {
      return {
        kind: "attempt_updated",
        ...(latestAttempt.sessionKey ? { sessionKey: latestAttempt.sessionKey } : {}),
        ...(latestAttempt.runId ? { runId: latestAttempt.runId } : {}),
      };
    }
    return {
      kind: "execution_updated",
      ...(cardSessionKey(next) ? { sessionKey: cardSessionKey(next) } : {}),
      ...(cardRunId(next) ? { runId: cardRunId(next) } : {}),
    };
  }
  for (const [key, kind] of [
    ["comments", "comment_added"],
    ["links", "link_added"],
    ["proof", "proof_added"],
    ["artifacts", "artifact_added"],
  ] as const) {
    if (metadataEntriesChanged(existing, next, key)) {
      return { kind };
    }
  }
  if (metadataEntriesChanged(existing, next, "attachments")) {
    return (next.metadata?.attachments?.length ?? 0) > (existing.metadata?.attachments?.length ?? 0)
      ? { kind: "attachment_added" }
      : { kind: "edited" };
  }
  if (existing.metadata?.workerProtocol?.state !== next.metadata?.workerProtocol?.state) {
    return { kind: "orchestration" };
  }
  if (metadataEntriesChanged(existing, next, "workerLogs")) {
    return { kind: "orchestration" };
  }
  if ((existing.metadata?.diagnostics?.length ?? 0) !== (next.metadata?.diagnostics?.length ?? 0)) {
    return { kind: "diagnostic" };
  }
  if (metadataEntriesChanged(existing, next, "notifications")) {
    return { kind: "notification" };
  }
  if (
    existing.metadata?.automation?.dispatchCount !== next.metadata?.automation?.dispatchCount ||
    existing.metadata?.automation?.lastDispatchAt !== next.metadata?.automation?.lastDispatchAt
  ) {
    return { kind: "dispatch" };
  }
  if (!existing.metadata?.archivedAt && next.metadata?.archivedAt) {
    return { kind: "archived" };
  }
  if (existing.metadata?.archivedAt && !next.metadata?.archivedAt) {
    return { kind: "unarchived" };
  }
  if (!existing.metadata?.stale && next.metadata?.stale) {
    return { kind: "stale" };
  }
  return { kind: "edited" };
}

export function removeUndefinedCardFields(card: WorkboardCard): WorkboardCard {
  const next = { ...card };
  for (const key of [
    "notes",
    "agentId",
    "sessionKey",
    "runId",
    "taskId",
    "sourceUrl",
    "execution",
    "startedAt",
    "completedAt",
    "metadata",
  ] as const) {
    if (next[key] === undefined) {
      delete next[key];
    }
  }
  if (metadataIsEmpty(next.metadata)) {
    delete next.metadata;
  }
  return next;
}

/**
 * Options for `assertCanMutateClaimedCard`.
 *
 * `allowExpiredClaim`: when true, an assertion pass is granted for a card
 * whose claim fence has expired (per `isWorkboardClaimReclaimable`). Used by
 * `workboard_reclaim` so a dead-owner claim does not permanently fence
 * recovery; the canonical TTL predicate is the authoritative fence — once
 * expired, anyone may take the work (card 1b0f98cb, 2026-09-03).
 */
export interface AssertCanMutateClaimedCardOptions {
  allowExpiredClaim?: boolean;
}

export function assertCanMutateClaimedCard(
  card: WorkboardCard,
  scope: WorkboardMutationScope | undefined,
  options: AssertCanMutateClaimedCardOptions = {},
) {
  if (!scope) {
    return;
  }
  const claim = card.metadata?.claim;
  if (!claim) {
    return;
  }
  const ownerId = normalizeOptionalString(scope.ownerId);
  const token = normalizeOptionalString(scope.token);
  if (claim.ownerId === ownerId || safeEqualSecret(token, claim.token)) {
    return;
  }
  // PATCH workboard-reclaim-expired-claim (card 1b0f98cb, 2026-09-03):
  // claim TTL is the authoritative fence. Once a claim is reclaimable per
  // the canonical predicate (5-min grace past expiresAt), any caller may
  // reclaim — including cross-owner recovery of a dead-owner claim. This
  // closes the recurring-shape bug where dead-pid claims permanently
  // fenced card writes. See ADR-025 candidate: claim-fence expiry contract.
  if (options.allowExpiredClaim && isWorkboardClaimReclaimable(claim, Date.now())) {
    return;
  }
  throw new Error(`card is claimed by ${claim.ownerId}.`);
}

export function retryBudgetExhausted(card: WorkboardCard): boolean {
  const maxRetries = card.metadata?.automation?.maxRetries;
  return Boolean(maxRetries && (card.metadata?.failureCount ?? 0) > maxRetries);
}

// PATCH-d16f9796 (backport 2026-09-03, card a3922b20): review-independence
// invariant — fail-closed namespace check at clearance/completion (annuls the
// HR36 builder-as-reviewer fallback). Canonical policy:
// docs/governance/review-independence.md (filed 2026-08-31).
// A "passed" proof is a review clearance; its reviewer_session MUST NOT share
// the card's builder agent namespace (`agent:<agentId>:*`). Otherwise the
// proof is self-review and the API rejects it with an actionable error.
export function assertReviewIndependenceFromScope(
  card: WorkboardCard,
  scope: WorkboardMutationScope | null | undefined,
  proof: { status?: string } | undefined,
): void {
  if (!proof || proof.status !== "passed") {
    return;
  }
  const scopeObj = scope && typeof scope === "object" ? (scope as Record<string, unknown>) : null;
  if (!scopeObj) {
    return;
  }
  const callerKey =
    typeof scopeObj.sessionKey === "string" && scopeObj.sessionKey
      ? scopeObj.sessionKey
      : typeof scopeObj.ownerId === "string" && scopeObj.ownerId
        ? scopeObj.ownerId
        : null;
  const agentId = typeof card.agentId === "string" && card.agentId ? card.agentId : null;
  if (!callerKey || !agentId) {
    return;
  }
  const namespacePrefix = `agent:${agentId}:`;
  if (callerKey.startsWith(namespacePrefix)) {
    throw new Error(
      `review-independence invariant: review clearance rejected — reviewer_session shares builder agent namespace '${namespacePrefix}' (card agentId='${agentId}', reviewer_session='${callerKey}'). See docs/governance/review-independence.md (annulled HR36 fallback).`,
    );
  }
}

export function diagnostic(
  params: {
    kind: WorkboardDiagnosticKind;
    severity: WorkboardDiagnosticSeverity;
    title: string;
    detail: string;
    actions: WorkboardDiagnosticAction[];
  },
  now: number,
): WorkboardDiagnostic {
  return {
    ...params,
    firstSeenAt: now,
    lastSeenAt: now,
    count: 1,
  };
}

export function mergeDiagnostics(
  previous: readonly WorkboardDiagnostic[] | undefined,
  next: WorkboardDiagnostic[],
): WorkboardDiagnostic[] {
  const byKind = new Map(previous?.map((entry) => [entry.kind, entry]));
  return next.map((entry) => {
    const prior = byKind.get(entry.kind);
    return prior
      ? {
          ...entry,
          firstSeenAt: prior.firstSeenAt,
          count: prior.count + 1,
        }
      : entry;
  });
}

export function computeCardDiagnostics(card: WorkboardCard, now: number): WorkboardDiagnostic[] {
  if (card.metadata?.archivedAt) {
    // Archived cards intentionally skip automation. Keep nonterminal cards
    // visible as a transient diagnostic without rewriting archived metadata.
    if (card.status !== "done") {
      return [
        diagnostic(
          {
            kind: "archived_but_active",
            severity: "warning",
            title: "Archived card is still in an active status",
            detail: `Card status is "${card.status}" but it is archived, so it is excluded from dispatch without any start failure or error. Unarchive it or move it to "done" to stop the silent skip.`,
            actions: [],
          },
          now,
        ),
      ];
    }
    return [];
  }
  const diagnostics: WorkboardDiagnostic[] = [];
  const claim = card.metadata?.claim;
  const lastHeartbeatAt = claim?.lastHeartbeatAt ?? card.execution?.updatedAt ?? card.updatedAt;
  if (
    (card.status === "todo" || card.status === "backlog" || card.status === "ready") &&
    card.agentId &&
    now - card.updatedAt > READY_STRANDED_MS
  ) {
    diagnostics.push(
      diagnostic(
        {
          kind: "stranded_ready",
          severity: "warning",
          title: "Assigned card is waiting",
          detail: "The card has an assigned agent but has not been claimed recently.",
          actions: [{ kind: "claim", label: "Claim card" }],
        },
        now,
      ),
    );
  }
  if (card.status === "running" && now - lastHeartbeatAt > RUNNING_HEARTBEAT_STALE_MS) {
    diagnostics.push(
      diagnostic(
        {
          kind: "running_without_heartbeat",
          severity: "error",
          title: "Running card has no recent heartbeat",
          detail: "The linked run or claim has not reported recent activity.",
          actions: [
            { kind: "open_session", label: "Open session" },
            { kind: "reassign", label: "Reassign card" },
          ],
        },
        now,
      ),
    );
  }
  if (card.status === "blocked" && now - card.updatedAt > BLOCKED_TOO_LONG_MS) {
    diagnostics.push(
      diagnostic(
        {
          kind: "blocked_too_long",
          severity: "warning",
          title: "Blocked card needs attention",
          detail: "The card has been blocked for more than a day.",
          actions: [{ kind: "unblock", label: "Move to todo" }],
        },
        now,
      ),
    );
  }
  if ((card.metadata?.failureCount ?? 0) >= 2) {
    diagnostics.push(
      diagnostic(
        {
          kind: "repeated_failures",
          severity: "error",
          title: "Repeated run failures",
          detail: "Multiple attempts failed or blocked on this card.",
          actions: [{ kind: "reassign", label: "Reassign card" }],
        },
        now,
      ),
    );
  }
  if (
    card.status === "done" &&
    !(
      card.metadata?.proof?.length ||
      card.metadata?.artifacts?.length ||
      card.metadata?.attachments?.length
    )
  ) {
    diagnostics.push(
      diagnostic(
        {
          kind: "missing_proof",
          severity: "warning",
          title: "Done card has no proof",
          detail: "The card is marked done without proof or an attached artifact.",
          actions: [{ kind: "add_proof", label: "Add proof" }],
        },
        now,
      ),
    );
  }
  if (card.sessionKey && !card.execution && card.status === "running") {
    diagnostics.push(
      diagnostic(
        {
          kind: "orphaned_session",
          severity: "warning",
          title: "Running card has only a loose session link",
          detail: "The card is running but has no execution record for lifecycle handoff.",
          actions: [{ kind: "open_session", label: "Open session" }],
        },
        now,
      ),
    );
  }
  return diagnostics;
}

export function cardBoardId(card: WorkboardCard): string {
  return card.metadata?.automation?.boardId ?? "default";
}

function cardResultSummary(card: WorkboardCard): string | undefined {
  return (
    card.metadata?.automation?.summary ??
    card.metadata?.comments?.findLast((comment) => comment.body.trim())?.body ??
    card.metadata?.proof?.findLast((proof) => proof.note?.trim())?.note
  );
}

function appendWorkerContextSection<T>(
  lines: string[],
  heading: string,
  entries: readonly T[] | undefined,
  format: (entry: T) => string,
  maxEntries = 8,
): void {
  const recent = entries?.slice(-maxEntries) ?? [];
  if (recent.length) {
    lines.push("", `## ${heading}`, ...recent.map(format));
  }
}

export function buildWorkerContext(
  card: WorkboardCard,
  cards: readonly WorkboardCard[] = [],
): string {
  const lines = [
    `# Workboard card ${card.id}`,
    `Title: ${card.title}`,
    `Status: ${card.status}`,
    `Priority: ${card.priority}`,
    `Board: ${cardBoardId(card)}`,
    `Agent: ${card.agentId ?? "(default)"}`,
  ];
  if (card.notes) {
    lines.push("", "## Notes", capText(card.notes, 4000) ?? "");
  }
  appendWorkerContextSection(lines, "Recent attempts", card.metadata?.attempts, (attempt) =>
    `- ${attempt.status} ${attempt.model ?? ""} ${attempt.error ? `error=${capText(attempt.error, 240)}` : ""}`.trim(),
  );
  appendWorkerContextSection(
    lines,
    "Recent comments",
    card.metadata?.comments,
    (comment) => `- ${capText(comment.body, 400)}`,
    12,
  );
  appendWorkerContextSection(
    lines,
    "Proof",
    card.metadata?.proof,
    (entry) =>
      `- ${entry.status}: ${capText(entry.label ?? entry.command ?? entry.url ?? entry.note, 400)}`,
  );
  appendWorkerContextSection(
    lines,
    "Artifacts",
    card.metadata?.artifacts,
    (artifact) => `- ${capText(artifact.label ?? artifact.url ?? artifact.path, 400)}`,
  );
  appendWorkerContextSection(lines, "Attachments", card.metadata?.attachments, (attachment) => {
    const detail = [
      attachment.fileName,
      `${attachment.byteSize} bytes`,
      attachment.mimeType,
      attachment.note,
    ]
      .filter(Boolean)
      .join(" · ");
    return `- ${capText(detail, 500)}`;
  });
  if (card.metadata?.workerProtocol) {
    const protocol = card.metadata.workerProtocol;
    lines.push("", "## Worker protocol");
    lines.push(`${protocol.state}: ${capText(protocol.detail, 500) ?? "no detail"}`);
  }
  appendWorkerContextSection(
    lines,
    "Worker logs",
    card.metadata?.workerLogs,
    (log) => `- ${log.level}: ${capText(log.message, 500)}`,
  );
  appendWorkerContextSection(
    lines,
    "Links",
    card.metadata?.links,
    (link) => `- ${link.type}: ${link.title ?? link.url ?? link.targetCardId ?? ""}`,
  );
  const cardsById = new Map(cards.map((entry) => [entry.id, entry]));
  const parentResults = cardParentIds(card)
    .map((parentId) => cardsById.get(parentId))
    .filter((parent): parent is WorkboardCard => parent !== undefined && parent.status === "done")
    .slice(-6);
  appendWorkerContextSection(
    lines,
    "Parent results",
    parentResults,
    (parent) =>
      `- ${parent.id} ${parent.title}: ${capText(cardResultSummary(parent), 500) ?? "done"}`,
  );
  const recentAgentWork =
    card.agentId && cards.length
      ? cards
          .filter(
            (entry) =>
              entry.id !== card.id &&
              cardBoardId(entry) === cardBoardId(card) &&
              entry.agentId === card.agentId &&
              entry.status === "done",
          )
          .toSorted((a, b) => b.updatedAt - a.updatedAt)
          .slice(0, 5)
      : [];
  appendWorkerContextSection(
    lines,
    `Recent done work by ${card.agentId}`,
    recentAgentWork,
    (entry) => `- ${entry.id} ${entry.title}: ${capText(cardResultSummary(entry), 300) ?? "done"}`,
  );
  const automation = card.metadata?.automation;
  if (automation) {
    lines.push("", "## Automation");
    if (automation.tenant) {
      lines.push(`Tenant: ${automation.tenant}`);
    }
    if (automation.boardId) {
      lines.push(`Board: ${automation.boardId}`);
    }
    if (automation.skills?.length) {
      lines.push(`Skills: ${automation.skills.join(", ")}`);
    }
    if (automation.workspace) {
      lines.push(
        `Workspace: ${automation.workspace.kind}${automation.workspace.path ? ` ${automation.workspace.path}` : ""}`,
      );
    }
    if (automation.summary) {
      lines.push(`Summary: ${capText(automation.summary, 400)}`);
    }
  }
  const diagnostics = computeCardDiagnostics(card, Date.now());
  appendWorkerContextSection(
    lines,
    "Active diagnostics",
    diagnostics,
    (entry) => `- ${entry.severity}: ${entry.title}`,
    diagnostics.length,
  );
  return lines.join("\n");
}

export function cardParentIds(card: WorkboardCard): string[] {
  return (card.metadata?.links ?? [])
    .filter((link) => link.type === "parent" && link.targetCardId)
    .map((link) => link.targetCardId!)
    .filter((id, index, ids) => ids.indexOf(id) === index);
}

export function cardChildIds(card: WorkboardCard): string[] {
  return (card.metadata?.links ?? [])
    .filter((link) => link.type === "child" && link.targetCardId)
    .map((link) => link.targetCardId!)
    .filter((id, index, ids) => ids.indexOf(id) === index);
}

export function latestRunningAttempt(card: WorkboardCard): WorkboardRunAttempt | undefined {
  return card.metadata?.attempts?.findLast((attempt) => attempt.status === "running");
}

export function isDependencyPromotableStatus(status: WorkboardStatus): boolean {
  return (
    status === "backlog" ||
    status === "triage" ||
    status === "todo" ||
    status === "scheduled" ||
    status === "ready"
  );
}

export function isActiveDependencyTarget(
  card: WorkboardCard,
  options: { allowStatusOnly?: boolean } = {},
): boolean {
  return (
    Boolean(card.metadata?.claim) ||
    card.execution?.status === "running" ||
    Boolean(latestRunningAttempt(card)) ||
    (!options.allowStatusOnly && (card.status === "running" || card.status === "review"))
  );
}

// Pipeline auto-dispatch dedup helpers (card ee4dda8f).

/**
 * Most-recent run attempt on this card (any terminal status), used to detect
 * "just failed" within the dispatch cooldown window.
 */
export function latestRunAttempt(card: WorkboardCard): WorkboardRunAttempt | undefined {
  const attempts = card.metadata?.attempts;
  if (!attempts || attempts.length === 0) {
    return undefined;
  }
  return attempts[attempts.length - 1];
}

/**
 * True when the card's most-recent attempt ended in a non-successful status
 * (failed/blocked/stopped) within `cooldownMs` of `now`. Pipeline auto-dispatch
 * must NOT re-dispatch a card that recently failed; doing so creates duplicate
 * escalation cards and burns the worker slot.
 */
export function hasRecentFailedAttempt(
  card: WorkboardCard,
  now: number,
  cooldownMs: number,
): boolean {
  const attempt = latestRunAttempt(card);
  if (!attempt || attempt.status === "running" || attempt.status === "succeeded") {
    return false;
  }
  if (typeof attempt.endedAt !== "number") {
    return false;
  }
  return now - attempt.endedAt < cooldownMs;
}

/**
 * Consecutive pipeline strikes accumulated on the card. 0 means the card has
 * not recently failed dispatch attempts.
 */
export function pipelineStrikeCount(card: WorkboardCard): number {
  const strikes = card.metadata?.automation?.pipelineStrikes;
  return typeof strikes === "number" && Number.isFinite(strikes) && strikes > 0
    ? Math.trunc(strikes)
    : 0;
}

/**
 * True when the card has exhausted its pipeline retry budget and must be
 * parked in `blocked` rather than re-dispatched. Caller parks the card with
 * a notification + worker-log entry explaining the saturation.
 */
export function pipelineStrikesExhausted(card: WorkboardCard, maxStrikes: number): boolean {
  return pipelineStrikeCount(card) >= maxStrikes;
}

export function closeRunningAttempts(
  attempts: WorkboardRunAttempt[] | undefined,
  now: number,
  status: WorkboardAttemptStatus,
  reason?: string,
): WorkboardRunAttempt[] | undefined {
  if (!attempts?.some((attempt) => attempt.status === "running")) {
    return attempts;
  }
  return attempts.map((attempt) =>
    attempt.status === "running"
      ? { ...attempt, status, endedAt: now, ...(reason ? { error: reason } : {}) }
      : attempt,
  );
}

export function notificationSequence(event: WorkboardNotification): number | undefined {
  return typeof event.sequence === "number" && Number.isFinite(event.sequence)
    ? Math.trunc(event.sequence)
    : undefined;
}

export function compareNotifications(a: WorkboardNotification, b: WorkboardNotification): number {
  if (a.createdAt !== b.createdAt) {
    return a.createdAt - b.createdAt;
  }
  const aSequence = notificationSequence(a);
  const bSequence = notificationSequence(b);
  if (aSequence !== undefined && bSequence !== undefined) {
    return aSequence - bSequence || a.id.localeCompare(b.id);
  }
  if (aSequence !== undefined) {
    return -1;
  }
  if (bSequence !== undefined) {
    return 1;
  }
  return a.id.localeCompare(b.id);
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
