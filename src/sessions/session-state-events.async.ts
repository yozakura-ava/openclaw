import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import { captureSessionWatcherStorePaths } from "../config/sessions/session-store-path.js";
import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import type { SessionStateActorType, SessionStateEventKind } from "./session-state-event-kinds.js";
import {
  normalizeOptionalSqliteNumber,
  type SessionStateEventInput,
  type SessionStateEventRecord,
  type SessionStateEventRow,
} from "./session-state-events.kernel.js";
import { enqueueSessionStateNotice } from "./session-state-notices.js";

const log = createSubsystemLogger("sessions/state-events");

function rowToSessionStateEvent(row: SessionStateEventRow): SessionStateEventRecord {
  const payload = row.payload_json ? safeParseJsonRecord(row.payload_json) : undefined;
  return {
    sequence: normalizeOptionalSqliteNumber(row.sequence) ?? 0,
    sessionKey: row.session_key,
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    agentId: row.agent_id,
    // SAFETY: SQLite rows are constrained to the event-kind enum at insertion time.
    kind: row.kind as SessionStateEventKind,
    // SAFETY: SQLite rows are constrained to the actor-type enum at insertion time.
    actorType: row.actor_type as SessionStateActorType,
    ...(row.actor_id ? { actorId: row.actor_id } : {}),
    ...(row.run_id ? { runId: row.run_id } : {}),
    occurredAt: normalizeOptionalSqliteNumber(row.occurred_at) ?? 0,
    summary: row.summary,
    ...(payload ? { payload } : {}),
  };
}

type AsyncSessionStateEventOptions = Pick<OpenClawStateDatabaseOptions, "path" | "env"> & {
  now?: number;
  assertCurrent?: () => void;
};

/** Persist an event through the shared worker so terminal signals stay responsive under contention. */
export async function recordSessionStateEventAsync(
  input: SessionStateEventInput,
  options: AsyncSessionStateEventOptions = {},
): Promise<SessionStateEventRecord | undefined> {
  try {
    const context = captureOpenClawStateWorkerContext(options);
    const now = options.now ?? Date.now();
    const event = structuredClone({
      ...input,
      watcherStorePaths:
        input.watcherStorePaths ??
        captureSessionWatcherStorePaths(input.watcherSessionKeys, options.env),
    });
    return await runOpenClawStateWorkerOperation(
      context,
      async (scope) => {
        const recorded = await scope.execute({
          type: "sessionState.record",
          input: { event, now },
        });
        for (const notice of recorded.notices) {
          enqueueSessionStateNotice(notice);
        }
        return recorded.row ? rowToSessionStateEvent(recorded.row) : undefined;
      },
      {
        assertCurrent: options.assertCurrent,
        createAdmission: () => ({
          nativeLocations: [context.admission.databasePath],
          admission: createSqliteWorkerOperationAdmission((request, grant) => {
            if (request.stage !== "transaction" && request.stage !== "commit") {
              throw new Error("Session signal mutation requires transaction admission");
            }
            context.admission.assertCurrent();
            options.assertCurrent?.();
            grant();
          }),
        }),
      },
    );
  } catch (error) {
    try {
      log.warn(`failed to record session state event: ${String(error)}`);
    } catch {
      // Preserve the originating durable result when diagnostics are unavailable.
    }
    return undefined;
  }
}
