// Card diagnostic helpers — extracted 2026-09-20 from store-card-helpers.ts.
//
// Pure move: no semantic change. These two functions (mergeDiagnostics and
// computeCardDiagnostics) form a coherent module: they own the construction,
// deduplication, and lifecycle-event merging of WorkboardDiagnostic entries
// attached to cards. The diagnostics subsystem is independent of card state
// transitions and event log append, so the extraction does not introduce
// cross-module dependencies.
//
// Sibling re-exported from store-card-helpers.ts so existing importers
// (notably store.ts) continue to work without import-path changes.

import {
  BLOCKED_TOO_LONG_MS,
  READY_STRANDED_MS,
  RUNNING_HEARTBEAT_STALE_MS,
} from "./store-constants.js";

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
  const diagnostics: WorkboardDiagnostic[] = [];
  const addDiagnostic = (
    params: Omit<WorkboardDiagnostic, "firstSeenAt" | "lastSeenAt" | "count">,
  ): void => {
    diagnostics.push({ ...params, firstSeenAt: now, lastSeenAt: now, count: 1 });
  };
  if (card.metadata?.archivedAt) {
    // Archived cards intentionally skip automation. Keep nonterminal cards
    // visible as a transient diagnostic without rewriting archived metadata.
    if (card.status !== "done") {
      addDiagnostic({
        kind: "archived_but_active",
        severity: "warning",
        title: "Archived card is still in an active status",
        detail: `Card status is "${card.status}" but it is archived, so it is excluded from dispatch without any start failure or error. Unarchive it or move it to "done" to stop the silent skip.`,
        actions: [],
      });
    }
    return diagnostics;
  }
  const claim = card.metadata?.claim;
  const lastHeartbeatAt = claim?.lastHeartbeatAt ?? card.execution?.updatedAt ?? card.updatedAt;
  if (
    (card.status === "todo" || card.status === "backlog" || card.status === "ready") &&
    card.agentId &&
    now - card.updatedAt > READY_STRANDED_MS
  ) {
    addDiagnostic({
      kind: "stranded_ready",
      severity: "warning",
      title: "Assigned card is waiting",
      detail: "The card has an assigned agent but has not been claimed recently.",
      actions: [{ kind: "claim", label: "Claim card" }],
    });
  }
  if (card.status === "running" && now - lastHeartbeatAt > RUNNING_HEARTBEAT_STALE_MS) {
    addDiagnostic({
      kind: "running_without_heartbeat",
      severity: "error",
      title: "Running card has no recent heartbeat",
      detail: "The linked run or claim has not reported recent activity.",
      actions: [
        { kind: "open_session", label: "Open session" },
        { kind: "reassign", label: "Reassign card" },
      ],
    });
  }
  if (card.status === "blocked" && now - card.updatedAt > BLOCKED_TOO_LONG_MS) {
    addDiagnostic({
      kind: "blocked_too_long",
      severity: "warning",
      title: "Blocked card needs attention",
      detail: "The card has been blocked for more than a day.",
      actions: [{ kind: "unblock", label: "Move to todo" }],
    });
  }
  if ((card.metadata?.failureCount ?? 0) >= 2) {
    addDiagnostic({
      kind: "repeated_failures",
      severity: "error",
      title: "Repeated run failures",
      detail: "Multiple attempts failed or blocked on this card.",
      actions: [{ kind: "reassign", label: "Reassign card" }],
    });
  }
  if (
    card.status === "done" &&
    !(
      card.metadata?.proof?.length ||
      card.metadata?.artifacts?.length ||
      card.metadata?.attachments?.length
    )
  ) {
    addDiagnostic({
      kind: "missing_proof",
      severity: "warning",
      title: "Done card has no proof",
      detail: "The card is marked done without proof or an attached artifact.",
      actions: [{ kind: "add_proof", label: "Add proof" }],
    });
  }
  if (card.sessionKey && !card.execution && card.status === "running") {
    addDiagnostic({
      kind: "orphaned_session",
      severity: "warning",
      title: "Running card has only a loose session link",
      detail: "The card is running but has no execution record for lifecycle handoff.",
      actions: [{ kind: "open_session", label: "Open session" }],
    });
  }
  return diagnostics;
}
