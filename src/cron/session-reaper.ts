/** Prunes expired per-run cron sessions and archives unreferenced transcripts. */
import path from "node:path";
import { buildPendingGeneratedMediaSessionKeySet } from "../agents/media-generation-activity.js";
import { hasDescendantRunAwaitingSettle } from "../agents/subagents/registry/subagent-registry-read.js";
import { parseDurationMs } from "../cli/parse-duration.js";
import {
  applySessionEntryLifecycleMutation,
  loadExactSessionEntryReadOnly,
  type SessionEntryLifecycleRemoval,
} from "../config/sessions/session-accessor.js";
import {
  getSessionKysely,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { readExpiredCronRunEntriesInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { resolveMaintenanceConfig } from "../config/sessions/store-maintenance-runtime.js";
import type { CronConfig } from "../config/types.cron.js";
import { formatErrorMessage } from "../infra/errors.js";
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { isCronJobLevelSessionKey, isHeartbeatSessionKey } from "../sessions/session-key-utils.js";
import { isCompetingSessionWorkAdmissionActive } from "../sessions/session-lifecycle-admission.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { deleteCronSessionViaGateway } from "./isolated-agent/session-cleanup.js";
import { resolveCronAgentSessionKey } from "./isolated-agent/session-key.js";
import type { Logger } from "./service/state.js";

const DEFAULT_RETENTION_MS = 24 * 3_600_000; // 24 hours
const DEFAULT_HISTORY_RETENTION_MS = 7 * 24 * 3_600_000; // 7 days
const DEFAULT_HEARTBEAT_RETENTION_MS = 7 * 24 * 3_600_000; // 7 days

/** Minimum interval between reaper sweeps (avoid running every timer tick). */
const MIN_SWEEP_INTERVAL_MS = 5 * 60_000; // 5 minutes

const lastSweepAtMsByTarget = new Map<string, number>();

function reaperTargetKey(agentId: string, storePath: string): string {
  return `${normalizeAgentId(agentId)}\0${path.resolve(storePath)}`;
}

/** Resolves cron run-session retention; `false` disables pruning, bad strings fall back safely. */
function resolveRetentionMs(cronConfig?: CronConfig): number | null {
  if (cronConfig?.sessionRetention === false) {
    return null; // pruning disabled
  }
  const raw = cronConfig?.sessionRetention;
  if (typeof raw === "string" && raw.trim()) {
    try {
      const ms = parseDurationMs(raw.trim(), { defaultUnit: "h" });
      // A zero retention ("0h") is a disable signal, not "prune everything":
      // cutoff would equal now and the next sweep would delete every cron run
      // session. Negative durations never get here (the parser rejects them);
      // the <= 0 check stays defensive.
      if (ms <= 0) {
        return null;
      }
      return ms;
    } catch {
      return DEFAULT_RETENTION_MS;
    }
  }
  return DEFAULT_RETENTION_MS;
}

/**
 * Resolves one of the optional history-retention settings. `false` disables,
 * bad strings fall back to the default, `undefined` enables the default,
 * `null` (no field) is treated like the default to match documented opt-in /
 * opt-out behavior. A zero retention disables pruning.
 */
function resolveHistoryRetentionMs(
  raw: string | false | undefined,
  defaultMs: number,
): number | null {
  if (raw === false) {
    return null;
  }
  if (typeof raw === "string" && raw.trim()) {
    try {
      const ms = parseDurationMs(raw.trim(), { defaultUnit: "d" });
      if (ms <= 0) {
        return null;
      }
      return ms;
    } catch {
      return defaultMs;
    }
  }
  return defaultMs;
}

type ReaperResult = {
  swept: boolean;
  pruned: number;
};

/** Removes the reusable base session whose owning isolated cron job was deleted. */
export async function removeCronJobBaseSession(params: {
  agentId: string;
  jobId: string;
  sessionStorePath: string;
}): Promise<boolean> {
  const sessionKey = resolveCronAgentSessionKey({
    agentId: params.agentId,
    sessionKey: `cron:${params.jobId}`,
  });
  const existing = loadExactSessionEntryReadOnly({
    storePath: params.sessionStorePath,
    sessionKey,
  })?.entry;
  if (!existing) {
    return false;
  }
  const sessionId = existing.sessionId.trim();
  if (sessionId) {
    return await deleteCronSessionViaGateway({
      agentSessionKey: sessionKey,
      sessionId,
      lifecycleRevision: existing.lifecycleRevision,
      sessionUpdatedAt: existing.updatedAt,
    });
  }
  const result = await applySessionEntryLifecycleMutation({
    agentId: params.agentId,
    storePath: params.sessionStorePath,
    removals: [{ sessionKey, archiveRemovedTranscript: true, expectedEntry: existing }],
  });
  return result.removedEntries > 0;
}

/**
 * Sweeps completed isolated cron run sessions while preserving base cron sessions.
 *
 * Run outside the cron service `locked()` section: cleanup acquires session
 * lifecycle and writer ownership, so nesting the queues can deadlock timer ticks.
 */
export async function sweepCronRunSessions(params: {
  cronConfig?: CronConfig;
  agentId: string;
  /** Resolved session-store target, interpreted by the SQLite accessor. */
  sessionStorePath: string;
  isAgentAvailable?: (agentId: string) => boolean;
  nowMs?: number;
  log: Logger;
}): Promise<ReaperResult> {
  const retentionMs = resolveRetentionMs(params.cronConfig);
  if (retentionMs === null) {
    return { swept: false, pruned: 0 };
  }

  const now = params.nowMs ?? Date.now();
  const storePath = params.sessionStorePath;
  // Shared physical stores still hold agent-scoped rows. The throttle also
  // suppresses in-flight attempts, so its identity must retain both scopes.
  const targetKey = reaperTargetKey(params.agentId, storePath);
  const lastSweepAtMs = lastSweepAtMsByTarget.get(targetKey) ?? 0;

  // Timer ticks can be frequent; throttle per agent/store target to avoid
  // repeated session-store I/O.
  if (now >= lastSweepAtMs && now - lastSweepAtMs < MIN_SWEEP_INTERVAL_MS) {
    return { swept: false, pruned: 0 };
  }

  // Throttle attempts, not only successful sweeps. A broken session store must
  // not turn frequent timer ticks into an unbounded persistence-error loop.
  lastSweepAtMsByTarget.set(targetKey, now);

  let pruned = 0;
  let transcriptCleanupError: unknown;
  try {
    if (params.isAgentAvailable?.(params.agentId) === false) {
      params.log.debug({ agentId: params.agentId }, "cron-reaper: skipped unavailable agent");
      return { swept: false, pruned: 0 };
    }
    const cutoff = now - retentionMs;
    let pendingMediaSessionKeys: Set<string> | undefined;
    const removals: SessionEntryLifecycleRemoval[] = [];
    // Discovery validates the physical store in its reader worker and returns only full
    // expired candidates. Live continuation/admission checks remain with this owner.
    for (const { sessionKey, entry } of await readExpiredCronRunEntriesInWorker({
      agentId: params.agentId,
      storePath,
      updatedBefore: cutoff,
    })) {
      if (entry.cronRunContinuation) {
        // Build one unordered snapshot only when an expired continuation needs it.
        // Fresh rows and stores without continuations never read media operation state.
        pendingMediaSessionKeys ??= buildPendingGeneratedMediaSessionKeySet();
        if (pendingMediaSessionKeys.has(sessionKey) || hasDescendantRunAwaitingSettle(sessionKey)) {
          continue;
        }
      }
      // Skip known-busy rows so one active generation cannot abort idle sibling cleanup.
      // The shared deletion guard still closes the race between selection and commit.
      if (
        entry.sessionId &&
        isCompetingSessionWorkAdmissionActive(storePath, [sessionKey, entry.sessionId])
      ) {
        continue;
      }
      removals.push({
        sessionKey,
        expectedEntry: entry,
        ...(entry.sessionId ? { expectedSessionId: entry.sessionId } : {}),
        expectedUpdatedAt: entry.updatedAt,
        archiveRemovedTranscript: true,
      });
    }
    if (removals.length > 0) {
      // Archive-age cleanup follows the session maintenance retention knob:
      // the reaper's cron retention decides which rows die, but archived
      // transcript files are conversation history owned by the archive
      // retention policy (null = keep until the disk budget evicts).
      const archiveRetentionMs = resolveMaintenanceConfig().resetArchiveRetentionMs;
      const result = await applySessionEntryLifecycleMutation({
        agentId: params.agentId,
        storePath,
        removals,
        beforeCommitInTransaction: () => {
          // Descendants can acquire the continuation while deletion preparation awaits.
          for (const removal of removals) {
            if (
              removal.expectedEntry?.cronRunContinuation &&
              hasDescendantRunAwaitingSettle(removal.sessionKey)
            ) {
              throw new Error(
                `Cannot prune cron run continuation while subagents await settlement for ${removal.sessionKey}`,
              );
            }
          }
        },
        ...(archiveRetentionMs == null
          ? {}
          : {
              cleanupArchivedTranscripts: {
                rules: [{ reason: "deleted", olderThanMs: archiveRetentionMs }],
                nowMs: now,
              },
            }),
        captureArtifactCleanupError: true,
      });
      pruned = result.removedEntries;
      transcriptCleanupError = result.artifactCleanupError;
    }
  } catch (err) {
    params.log.warn({ err: String(err) }, "cron-reaper: failed to sweep session store");
    return { swept: false, pruned: 0 };
  }

  if (transcriptCleanupError) {
    params.log.warn(
      { err: formatErrorMessage(transcriptCleanupError) },
      "cron-reaper: transcript cleanup failed",
    );
  }

  if (pruned > 0) {
    params.log.info(
      { pruned, retentionMs },
      `cron-reaper: pruned ${pruned} expired cron run session(s)`,
    );
  }

  return { swept: true, pruned };
}

type HistoryRetentionMode = "cron-job-level" | "heartbeat";

/**
 * Prune one EARLIER window of a cron job-level or heartbeat session key while
 * preserving the current window (the row pointed to by `session_nodes.cronRunContinuation`
 * — or by the canonical entry's `current_session_id`). The earlier window's row
 * cascades through the canonical transcript tables; the FTS index is cleared
 * explicitly because FTS is virtual.
 */
function deleteCronHistoryWindow(
  database: ReturnType<typeof openOpenClawAgentDatabase>,
  sessionId: string,
): boolean {
  const db = getSessionKysely(database.db);
  executeSqliteQuerySync(
    database.db,
    db.deleteFrom("session_windows").where("session_id", "=", sessionId),
  );
  return true;
}

/**
 * Build the key-family predicate for one retention mode. Returns the Kysely
 * filter fragment that selects candidate windows for the given family.
 */
function buildHistoryWindowQuery(params: {
  database: ReturnType<typeof openOpenClawAgentDatabase>;
  cutoffMs: number;
  protectedSessionIds: ReadonlySet<string>;
  mode: HistoryRetentionMode;
}) {
  const db = getSessionKysely(params.database.db);
  let query = db
    .selectFrom("session_windows")
    .select(["session_id", "session_key", "updated_at"])
    .where("updated_at", "<", params.cutoffMs)
    .orderBy("updated_at", "asc")
    .limit(500);
  if (params.mode === "cron-job-level") {
    query = query.where((eb) =>
      eb.and([
        eb("session_key", "like", "agent:%:cron:%"),
        eb("session_key", "not like", "%:run:%"),
      ]),
    );
  } else {
    query = query.where("session_key", "like", "%:heartbeat");
  }
  return query;
}

/**
 * Sweeps earlier windows of JOB-LEVEL cron keys (`agent:<id>:cron:<jobId>`,
 * no `:run:` scope) and heartbeat keys (`agent:<id>:<scope>:heartbeat`).
 * `cron.sessionRetention` only prunes per-run rows; this sweep closes the
 * unbounded-growth gap reported in upstream issue #162319 and extends the
 * same retention to heartbeat keys (the dominant contributor locally).
 *
 * The current window for each key (the row pointed to by the canonical
 * entry's `current_session_id`) is always preserved. In-flight work
 * (admitted session ids) and active admissions are also preserved.
 *
 * Config knobs:
 *  - `cron.historyRetention`     (string duration | false; default 7d)
 *  - `cron.heartbeatRetention`   (string duration | false; default 7d)
 *
 * Returns { swept, pruned } where `pruned` is the count of earlier windows
 * deleted across both families. When both knobs resolve to disabled,
 * returns { swept: false, pruned: 0 } without touching the store.
 */
export async function sweepCronHistorySessions(params: {
  cronConfig?: CronConfig;
  agentId: string;
  /** Resolved session-store target, interpreted by the SQLite accessor. */
  sessionStorePath: string;
  isAgentAvailable?: (agentId: string) => boolean;
  nowMs?: number;
  log: Logger;
}): Promise<ReaperResult> {
  const cronMs = resolveHistoryRetentionMs(
    params.cronConfig?.historyRetention as string | false | undefined,
    DEFAULT_HISTORY_RETENTION_MS,
  );
  const heartbeatMs = resolveHistoryRetentionMs(
    params.cronConfig?.heartbeatRetention as string | false | undefined,
    DEFAULT_HEARTBEAT_RETENTION_MS,
  );
  if (cronMs === null && heartbeatMs === null) {
    return { swept: false, pruned: 0 };
  }

  const now = params.nowMs ?? Date.now();
  const storePath = params.sessionStorePath;
  const targetKey = reaperTargetKey(params.agentId, storePath);
  const lastSweepAtMs = lastSweepAtMsByTarget.get(targetKey) ?? 0;
  if (now >= lastSweepAtMs && now - lastSweepAtMs < MIN_SWEEP_INTERVAL_MS) {
    return { swept: false, pruned: 0 };
  }
  lastSweepAtMsByTarget.set(targetKey, now);

  let pruned = 0;
  try {
    if (params.isAgentAvailable?.(params.agentId) === false) {
      params.log.debug(
        { agentId: params.agentId },
        "cron-history-reaper: skipped unavailable agent",
      );
      return { swept: false, pruned: 0 };
    }
    const database = openOpenClawAgentDatabase(
      toDatabaseOptions({ agentId: params.agentId, storePath }),
    );
    try {
      const db = getSessionKysely(database.db);
      // Collect current-window session ids per key so they are protected
      // regardless of which family the cutoff selects.
      const currentRows = executeSqliteQuerySync(
        database.db,
        db
          .selectFrom("session_nodes")
          .select(["session_key", "current_session_id"])
          .where("current_session_id", "is not", null),
      ).rows as Array<{ session_key: string; current_session_id: string | null }>;
      const currentByKey = new Map<string, string>();
      for (const row of currentRows) {
        if (row.current_session_id) {
          currentByKey.set(row.session_key, row.current_session_id);
        }
      }

      const modes: Array<{ mode: HistoryRetentionMode; retentionMs: number | null }> = [
        { mode: "cron-job-level", retentionMs: cronMs },
        { mode: "heartbeat", retentionMs: heartbeatMs },
      ];
      for (const { mode, retentionMs } of modes) {
        if (retentionMs === null) {
          continue;
        }
        const cutoff = now - retentionMs;
        const candidates = executeSqliteQuerySync(
          database.db,
          buildHistoryWindowQuery({
            database,
            cutoffMs: cutoff,
            protectedSessionIds: new Set(currentByKey.values()),
            mode,
          }),
        ).rows as Array<{ session_id: string; session_key: string; updated_at: number }>;
        for (const row of candidates) {
          if (currentByKey.get(row.session_key) === row.session_id) {
            // Current window: never delete.
            continue;
          }
          if (
            !isCronJobLevelSessionKey(row.session_key) &&
            !isHeartbeatSessionKey(row.session_key)
          ) {
            // Defensive: the SQL filter is best-effort; the canonical helper
            // is the source of truth on what counts as cron job-level or
            // heartbeat. Skipping mismatches keeps the sweep conservative.
            continue;
          }
          deleteCronHistoryWindow(database, row.session_id);
          pruned += 1;
        }
      }
    } finally {
      database.close();
    }
  } catch (err) {
    params.log.warn({ err: String(err) }, "cron-history-reaper: failed to sweep session store");
    return { swept: false, pruned: 0 };
  }

  if (pruned > 0) {
    params.log.info(
      { pruned },
      `cron-history-reaper: pruned ${pruned} earlier cron/heartbeat window(s)`,
    );
  }

  return { swept: true, pruned };
}

/** Resets per-target reaper throttles between tests. */
function resetReaperThrottle(): void {
  lastSweepAtMsByTarget.clear();
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.cronSessionReaperTestApi")] = {
    resetReaperThrottle,
  };
}
