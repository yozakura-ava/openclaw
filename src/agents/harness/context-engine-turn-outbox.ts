import type { AgentMessage } from "../../../packages/agent-core/src/types.js";
import type { ClosedTranscriptTurnReadResult } from "../../config/sessions/session-accessor.transcript-range.worker.js";
import type {
  TranscriptTurnAdmission,
  TranscriptTurnBoundary,
} from "../../config/sessions/transcript-entry-anchor.js";
import type { ContextEngine } from "../../context-engine/types.js";

export type PendingContextEngineTurn = Readonly<{
  advancement_key: string;
  payload_json: string;
  session_id: string;
}>;

/** Persist only resolved model facts, never live capabilities or credential-bearing config. */
export type ContextEngineTurnRuntimeContext = Readonly<{
  provider?: string;
  modelId?: string;
  modelContextWindow?: number;
  tokenBudget?: number;
}>;

type AdmittedContextEngineTurnOutboxPayload = Readonly<{
  admission: TranscriptTurnAdmission;
  isHeartbeat: boolean;
  state: "admitted";
}>;

export type AcceptedContextEngineTurnOutboxPayload = Readonly<{
  boundary: TranscriptTurnBoundary;
  isHeartbeat: boolean;
  state: "accepted";
  runtimeContext?: ContextEngineTurnRuntimeContext;
}>;

export type ReadyContextEngineTurnOutboxPayload = Readonly<{
  boundary: TranscriptTurnBoundary;
  isHeartbeat: boolean;
  messages: AgentMessage[];
  state: "ready";
  runtimeContext?: ContextEngineTurnRuntimeContext;
}>;

export type ContextEngineTurnReadFailureKind = Exclude<
  ClosedTranscriptTurnReadResult,
  { kind: "ok" }
>["kind"];

export type BlockedContextEngineTurnOutboxPayload = Readonly<{
  boundary: TranscriptTurnBoundary;
  failure: Exclude<ContextEngineTurnReadFailureKind, "projection-unavailable">;
  isHeartbeat: boolean;
  state: "blocked";
}>;

export type ContextEngineTurnOutboxPayload =
  | AdmittedContextEngineTurnOutboxPayload
  | AcceptedContextEngineTurnOutboxPayload
  | BlockedContextEngineTurnOutboxPayload
  | ReadyContextEngineTurnOutboxPayload;

export function isRetryableContextEngineTurnReadFailure(
  kind: ContextEngineTurnReadFailureKind,
): kind is "projection-unavailable" {
  return kind === "projection-unavailable";
}

<<<<<<< HEAD
function outboxDb(database: ContextEngineTurnOutboxConnection) {
  ensureContextEngineTurnOutboxSchema(database.db);
  return getNodeSqliteKysely<ContextEngineTurnOutboxDatabase>(database.db);
}

function assertMatchingOutboxOwner(
  existing: { engine_id: string; owner_plugin_id: string | null },
  params: ContextEngineTurnOutboxFilter,
  advancementKey: string,
): void {
  if (
    existing.engine_id !== params.engineId ||
    existing.owner_plugin_id !== (params.ownerPluginId ?? null)
  ) {
    throw new Error(`context-engine advancement key collision: ${advancementKey}`);
  }
}

function writeContextEngineTurnOutboxPayload(
  params: ContextEngineTurnOutboxFilter & {
    database: ContextEngineTurnOutboxConnection;
    payload: ContextEngineTurnOutboxPayload;
  },
): void {
  const db = outboxDb(params.database);
  const admission =
    params.payload.state === "admitted"
      ? params.payload.admission
      : params.payload.boundary.admission;
  const advancementKey = admission.logicalTurnId;
  const payloadJson = JSON.stringify(params.payload);
  const existing = executeSqliteQueryTakeFirstSync(
    params.database.db,
    db
      .selectFrom("context_engine_turn_outbox")
      .select(["engine_id", "owner_plugin_id", "payload_json"])
      .where("advancement_key", "=", advancementKey),
  );
  if (existing) {
    assertMatchingOutboxOwner(existing, params, advancementKey);
    const existingPayload = JSON.parse(existing.payload_json) as ContextEngineTurnOutboxPayload;
    const transitionMatches =
      (params.payload.state === "accepted" &&
        existingPayload.state === "admitted" &&
        existingPayload.admission.entryId === admission.entryId) ||
      ((params.payload.state === "blocked" || params.payload.state === "ready") &&
        existingPayload.state === "accepted" &&
        existingPayload.boundary.admission.entryId === admission.entryId &&
        existingPayload.boundary.terminal.entryId === params.payload.boundary.terminal.entryId);
    if (transitionMatches) {
      executeSqliteQuerySync(
        params.database.db,
        db
          .updateTable("context_engine_turn_outbox")
          .set({
            attempt_count: 0,
            last_attempt_at: null,
            last_error: null,
            payload_json: payloadJson,
          })
          .where("advancement_key", "=", advancementKey),
      );
      return;
    }
    if (existing.payload_json !== payloadJson) {
      throw new Error(`context-engine advancement key collision: ${advancementKey}`);
    }
    return;
  }
  executeSqliteQuerySync(
    params.database.db,
    db
      .insertInto("context_engine_turn_outbox")
      .values({
        advancement_key: advancementKey,
        engine_id: params.engineId,
        owner_plugin_id: params.ownerPluginId ?? null,
        session_id: admission.sessionId,
        payload_json: payloadJson,
        created_at: Date.now(),
        last_attempt_at: null,
        last_error: null,
      })
      .onConflict((conflict) => conflict.column("advancement_key").doNothing()),
  );
}

export function enqueueContextEngineTurnIntent(params: OutboxKernelParams<"enqueueIntent">): void {
  writeContextEngineTurnOutboxPayload({
    ...params,
    payload: {
      admission: params.admission,
      isHeartbeat: params.isHeartbeat,
      state: "admitted",
    },
  });
}

export function acceptContextEngineTurnIntent(params: OutboxKernelParams<"acceptIntent">): void {
  writeContextEngineTurnOutboxPayload({
    ...params,
    payload: {
      boundary: params.boundary,
      isHeartbeat: params.isHeartbeat,
      state: "accepted",
      runtimeContext: params.runtimeContext,
    },
  });
}

export function enqueueContextEngineTurnCommit(params: {
  database: ContextEngineTurnOutboxConnection;
  engineId: string;
  ownerPluginId?: string;
  payload: Omit<ReadyContextEngineTurnOutboxPayload, "state">;
}): void {
  writeContextEngineTurnOutboxPayload({
    ...params,
    payload: { ...params.payload, state: "ready" },
  });
}

function blockContextEngineTurnIntent(
  params: ContextEngineTurnOutboxFilter & {
    boundary: TranscriptTurnBoundary;
    database: ContextEngineTurnOutboxConnection;
    failure: BlockedContextEngineTurnOutboxPayload["failure"];
    isHeartbeat: boolean;
  },
): void {
  writeContextEngineTurnOutboxPayload({
    ...params,
    payload: {
      boundary: params.boundary,
      failure: params.failure,
      isHeartbeat: params.isHeartbeat,
      state: "blocked",
    },
  });
}

function discardContextEngineTurnIntent(params: OutboxKernelParams<"discardIntent">): boolean {
  const db = outboxDb(params.database);
  const result = executeSqliteQuerySync(
    params.database.db,
    db
      .deleteFrom("context_engine_turn_outbox")
      .where("advancement_key", "=", params.admission.logicalTurnId)
      .where("engine_id", "=", params.engineId)
      // Accepted work remains recoverable when publication or acknowledgment fails.
      .where(
        /* kysely-allow-raw: Closed outbox payload state. */ sql`json_extract(payload_json, '$.state')`,
        "=",
        "admitted",
      )
      .where("owner_plugin_id", params.ownerPluginId ? "=" : "is", params.ownerPluginId ?? null),
  );
  return result.numAffectedRows !== undefined && result.numAffectedRows > 0n;
}

/**
 * Reads an accepted turn's bounded range and publishes it as ready or blocked.
 * The acceptance commits first in its own transaction, so a failed read or
 * publication leaves the turn accepted and the next recovery advances it.
 */
function publishClosedContextEngineTurn(
  params: OutboxKernelParams<"publishClosedTurn">,
): ClosedTranscriptTurnReadResult["kind"] {
  // Recovery may already have advanced or completed this turn in the gap after
  // acceptance; only a still-accepted row is published, so it cannot reappear.
  const existing = executeSqliteQueryTakeFirstSync(
    params.database.db,
    outboxDb(params.database)
      .selectFrom("context_engine_turn_outbox")
      .select("payload_json")
      .where("advancement_key", "=", params.boundary.admission.logicalTurnId),
  );
  if (!existing) {
    return "ok";
  }
  // SAFETY: payload_json is written only by writeContextEngineTurnOutboxPayload from this union.
  const existingPayload = JSON.parse(existing.payload_json) as ContextEngineTurnOutboxPayload;
  if (existingPayload.state !== "accepted") {
    return "ok";
  }
  return advanceAcceptedContextEngineTurn(params, params, params);
}

function advanceAcceptedContextEngineTurn(
  owner: ContextEngineTurnOutboxFilter & { database: ContextEngineTurnOutboxConnection },
  payload: Omit<AcceptedContextEngineTurnOutboxPayload, "state">,
  limits: { maxEvents: number; maxBytes: number },
  onReadFailure?: (kind: ContextEngineTurnReadFailureKind) => void,
): ClosedTranscriptTurnReadResult["kind"] {
  const closedTurn = readClosedTranscriptTurnInDatabase(owner.database.db, {
    boundary: payload.boundary,
    maxEvents: limits.maxEvents,
    maxBytes: limits.maxBytes,
  });
  if (closedTurn.kind !== "ok") {
    onReadFailure?.(closedTurn.kind);
    if (!isRetryableContextEngineTurnReadFailure(closedTurn.kind)) {
      blockContextEngineTurnIntent({
        boundary: payload.boundary,
        database: owner.database,
        engineId: owner.engineId,
        failure: closedTurn.kind,
        isHeartbeat: payload.isHeartbeat,
        ownerPluginId: owner.ownerPluginId,
      });
    }
    return closedTurn.kind;
  }
  enqueueContextEngineTurnCommit({
    database: owner.database,
    engineId: owner.engineId,
    ownerPluginId: owner.ownerPluginId,
    payload: {
      boundary: payload.boundary,
      isHeartbeat: payload.isHeartbeat,
      messages: closedTurn.messages,
      runtimeContext: payload.runtimeContext,
    },
  });
  return closedTurn.kind;
}

export function recoverContextEngineTurnOutbox(params: {
  database: ContextEngineTurnOutboxConnection;
  engineId: string;
  ownerPluginId?: string;
  sessionId: string;
  warn: (message: string) => void;
}): void {
  const db = outboxDb(params.database);
  const rows = executeSqliteQuerySync(
    params.database.db,
    db
      .selectFrom("context_engine_turn_outbox")
      .select(["advancement_key", "payload_json"])
      .where("engine_id", "=", params.engineId)
      .where("owner_plugin_id", params.ownerPluginId ? "=" : "is", params.ownerPluginId ?? null)
      .where("session_id", "=", params.sessionId)
      // Blocked rows are terminal; their outcome was logged once when the turn was blocked.
      .where(outboxPayloadRequiresAdvancement())
      .orderBy(outboxEnqueueSequence(), "asc"),
  ).rows;
  for (const row of rows) {
    const payload = JSON.parse(row.payload_json) as ContextEngineTurnOutboxPayload;
    if (payload.state === "ready") {
      continue;
    }
    if (payload.state === "blocked") {
      continue;
    }
    if (payload.state === "admitted") {
      // Admission proves provider dispatch only. Without the host-owned accepted
      // transition, later descendants may belong to a rejected fallback attempt.
      discardContextEngineTurnIntent({
        admission: payload.admission,
        database: params.database,
        engineId: params.engineId,
        ownerPluginId: params.ownerPluginId,
      });
      params.warn(
        `[context-engine] discarded unaccepted turn advancement: ${row.advancement_key}: recovery found no host acceptance`,
      );
      continue;
    }
    advanceAcceptedContextEngineTurn(
      params,
      payload,
      {
        maxEvents: RECOVERED_TURN_MAX_EVENTS,
        maxBytes: RECOVERED_TURN_MAX_BYTES,
      },
      (kind) =>
        params.warn(
          isRetryableContextEngineTurnReadFailure(kind)
            ? `[context-engine] durable turn recovery remains queued: ${row.advancement_key}: transcript range is ${kind}`
            : `[context-engine] blocked unrecoverable turn advancement: ${row.advancement_key}: transcript range is ${kind}`,
        ),
    );
  }
}

type ContextEngineTurnOutboxFilter = Readonly<{
=======
export type ContextEngineTurnOutboxFilter = Readonly<{
>>>>>>> 97b6e87616f
  engineId: string;
  ownerPluginId?: string;
}>;

/** Durable outbox rows the drain reads and settles through the agent database worker. */
export type ContextEngineTurnOutboxStore = Readonly<{
  /** Keep the selected owner through consumption and acknowledgment, outside its writer FIFO. */
  retain?<T>(operation: () => Promise<T>): Promise<T>;
  assertReadable?(): void;
  listPendingSessions(
    filter: ContextEngineTurnOutboxFilter & { sessionId?: string; limit: number },
  ): Promise<string[]>;
  readNextPending(
    filter: ContextEngineTurnOutboxFilter & { sessionId: string },
  ): Promise<PendingContextEngineTurn | undefined>;
  complete(advancementKey: string): Promise<void>;
  recordFailure(advancementKey: string, message: string, attemptedAt: number): Promise<void>;
  hasPending(filter: ContextEngineTurnOutboxFilter & { sessionId?: string }): Promise<boolean>;
}>;

/** The durable context-engine turn outbox of one agent database, executed in its worker. */
export type ContextEngineTurnOutboxWorkerStore = ContextEngineTurnOutboxStore &
  Readonly<{
    [
      Type in
        | "prepareRun"
        | "enqueueIntent"
        | "acceptIntent"
        | "publishClosedTurn"
        | "discardIntent"
    ]: (
      input: ContextEngineTurnOutboxWorkerOperations[Type]["input"],
    ) => Promise<
      ContextEngineTurnOutboxWorkerOperations[Type]["output"] extends undefined
        ? void
        : ContextEngineTurnOutboxWorkerOperations[Type]["output"]
    >;
  }>;

export async function drainContextEngineTurnOutbox(params: {
  store: ContextEngineTurnOutboxStore;
  engine: ContextEngine;
  engineId: string;
  ownerPluginId?: string;
  sessionId?: string;
  limit?: number;
  /** Observe acknowledged turns without changing durable advancement on observer failure. */
  onCommitted?: (turn: Parameters<NonNullable<ContextEngine["commitTurn"]>>[0]) => void;
  warn: (message: string) => void;
}): Promise<{ pending: boolean }> {
  return params.store.retain
    ? params.store.retain(() => drainRetainedContextEngineTurnOutbox(params))
    : drainRetainedContextEngineTurnOutbox(params);
}

async function drainRetainedContextEngineTurnOutbox(
  params: Parameters<typeof drainContextEngineTurnOutbox>[0],
): Promise<{ pending: boolean }> {
  const { store } = params;
  const filter = { engineId: params.engineId, ownerPluginId: params.ownerPluginId };
  if (typeof params.engine.commitTurn !== "function") {
    return { pending: false };
  }
  let remaining = Math.max(0, params.limit ?? 16);
  if (remaining === 0) {
    return { pending: await store.hasPending({ ...filter, sessionId: params.sessionId }) };
  }
  let activeSessionIds = await store.listPendingSessions({
    ...filter,
    sessionId: params.sessionId,
    limit: remaining,
  });
  while (remaining > 0 && activeSessionIds.length > 0) {
    const continuingSessionIds: string[] = [];
    for (const sessionId of activeSessionIds) {
      if (remaining === 0) {
        break;
      }
      const row = await store.readNextPending({ ...filter, sessionId });
      if (!row) {
        continue;
      }
      remaining -= 1;
      if (await commitPendingContextEngineTurn({ ...params, store, row })) {
        continuingSessionIds.push(sessionId);
      }
    }
    activeSessionIds = continuingSessionIds;
  }
  return { pending: await store.hasPending({ ...filter, sessionId: params.sessionId }) };
}

async function commitPendingContextEngineTurn(params: {
  engine: ContextEngine;
  onCommitted?: (turn: Parameters<NonNullable<ContextEngine["commitTurn"]>>[0]) => void;
  row: PendingContextEngineTurn;
  store: ContextEngineTurnOutboxStore;
  warn: (message: string) => void;
}): Promise<boolean> {
  const { row } = params;
  try {
    const payload = JSON.parse(row.payload_json) as ContextEngineTurnOutboxPayload;
    if (payload.state !== "ready") {
      return false;
    }
    const commonParams = {
      advancementKey: row.advancement_key,
      admission: payload.boundary.admission,
      terminal: payload.boundary.terminal,
      messages: payload.messages,
      sessionId: payload.boundary.admission.sessionId,
      sessionKey: payload.boundary.admission.sessionKey,
      sessionTarget: {
        agentId: payload.boundary.admission.agentId,
        sessionId: payload.boundary.admission.sessionId,
        sessionKey: payload.boundary.admission.sessionKey,
        storePath: payload.boundary.admission.storePath,
      },
      isHeartbeat: payload.isHeartbeat,
      ...(payload.runtimeContext ? { runtimeContext: payload.runtimeContext } : {}),
    };
    params.store.assertReadable?.();
    const result = await params.engine.commitTurn?.(commonParams);
    if (!result) {
      throw new Error("context engine does not implement commitTurn");
    }
    if (result.status !== "committed" && result.status !== "duplicate") {
      throw new Error(`invalid commitTurn result status: ${String(result.status)}`);
    }
    await params.store.complete(row.advancement_key);
    // Notification is best effort after acknowledgment; its failure must never requeue a commit.
    try {
      params.store.assertReadable?.();
      params.onCommitted?.(commonParams);
    } catch (error) {
      params.warn(
        `[context-engine] committed turn notification failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await params.store.recordFailure(row.advancement_key, message, Date.now());
    params.warn(
      `[context-engine] durable turn advancement remains queued: ${row.advancement_key}: ${message}`,
    );
    return false;
  }
}

export type ContextEngineTurnOutboxWorkerOperations = {
  prepareRun: {
    input: ContextEngineTurnOutboxFilter & {
      admission?: TranscriptTurnAdmission;
      isHeartbeat: boolean;
      sessionId: string;
    };
    output: { warnings: string[]; pending: boolean; admitted: boolean };
  };
  listPendingSessions: {
    input: ContextEngineTurnOutboxFilter & { sessionId?: string; limit: number };
    output: string[];
  };
  readNextPending: {
    input: ContextEngineTurnOutboxFilter & { sessionId: string };
    output: PendingContextEngineTurn | undefined;
  };
  complete: { input: { advancementKey: string }; output: undefined };
  recordFailure: {
    input: { advancementKey: string; message: string; attemptedAt: number };
    output: undefined;
  };
  hasPending: { input: ContextEngineTurnOutboxFilter & { sessionId?: string }; output: boolean };
  enqueueIntent: {
    input: ContextEngineTurnOutboxFilter & {
      admission: TranscriptTurnAdmission;
      isHeartbeat: boolean;
    };
    output: undefined;
  };
  acceptIntent: {
    input: ContextEngineTurnOutboxFilter & {
      boundary: TranscriptTurnBoundary;
      isHeartbeat: boolean;
      runtimeContext?: ContextEngineTurnRuntimeContext;
    };
    output: undefined;
  };
  publishClosedTurn: {
    input: ContextEngineTurnOutboxFilter & {
      boundary: TranscriptTurnBoundary;
      isHeartbeat: boolean;
      maxBytes: number;
      maxEvents: number;
      runtimeContext?: ContextEngineTurnRuntimeContext;
    };
    output: ClosedTranscriptTurnReadResult["kind"];
  };
  discardIntent: {
    input: ContextEngineTurnOutboxFilter & { admission: TranscriptTurnAdmission };
    output: boolean;
  };
};
