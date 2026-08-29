// Canonical DBOS runtime boundary.
//
// This package owns durable workflow identity, attempt state, retry policy, and
// reconciliation. Callers receive a receipt only after the workflow row is
// committed. There is deliberately no gateway fallback path.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  deriveIdempotencyKey,
  deriveWorkflowId,
  requireNonEmpty,
  stableJson,
  type AdmissionGate,
  type ExecutionIdentityInput,
  type AdmissionEnvelope,
} from "@openclaw/execution-contract";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { DBOS_QUEUE_CONCURRENCY } from "./dbos-constants.js";
import { DbosRuntimeError } from "./dbos-errors.js";

export type DbosWorkflowState = "admitted" | "running" | "succeeded" | "failed" | "quarantined";

export type DbosWorkflowInput = ExecutionIdentityInput & {
  attemptId: string;
  idempotencyKey: string;
  ownerEpoch: string;
  now?: number;
};

/** Durable DBOS authority used by production dispatchers. */
export type DbosAuthority = {
  admit(
    input: DbosWorkflowInput & { envelope?: AdmissionEnvelope },
  ): DbosReceipt | Promise<DbosReceipt>;
  start(workflowId: string, ownerEpoch: string): unknown;
  fail?(workflowId: string, detail: string): unknown;
  complete?(workflowId: string, evidence: unknown): unknown;
};

export type DbosReceipt = {
  workflowId: string;
  idempotencyKey: string;
  cardId: string;
  queue: string;
  runId: string;
  attemptId: string;
  ownerEpoch: string;
  acknowledgedAt: number;
  /** Authority metadata is required on the production HTTP response. */
  operationKey?: string;
  state?: "admitted";
  serverTimestamp?: number;
  sdkWorkflowId?: string;
};

export type DbosResourceState = {
  ownedChild: boolean;
  lease: boolean;
  lock: boolean;
  port: boolean;
  descriptor: boolean;
  unresolvedExternalHandoff: boolean;
};

export type DbosWorkflow = DbosWorkflowInput & {
  workflowId: string;
  state: DbosWorkflowState;
  attemptCount: number;
  resourceState: DbosResourceState;
  resultHash?: string;
  updatedAt: number;
};

export type ReconciliationFinding = {
  kind: "unknown" | "orphaned" | "duplicated" | "conflicting";
  identity: string;
  detail: string;
};

type Row = Record<string, unknown>;
const DEFAULT_DB_PATH = ["plugins", "workboard", "dbos.sqlite"] as const;
export const WORKBOARD_DBOS_STATE_MAP: Readonly<Record<string, DbosWorkflowState | null>> = {
  triage: null,
  backlog: null,
  todo: null,
  scheduled: null,
  ready: null,
  running: "running",
  review: "succeeded",
  done: "succeeded",
  blocked: "failed",
};

function text(row: Row, key: string): string {
  return requireNonEmpty(row[key], `DBOS ${key}`);
}

function number(row: Row, key: string): number {
  const value = typeof row[key] === "bigint" ? Number(row[key]) : row[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`DBOS ${key} is invalid.`);
  }
  return value;
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function parse<T>(value: unknown, fallback: T): T {
  return typeof value === "string" && value.length > 0 ? (JSON.parse(value) as T) : fallback;
}

function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function normalize(input: DbosWorkflowInput): DbosWorkflowInput {
  const identity = {
    cardId: requireNonEmpty(input.cardId, "DBOS cardId"),
    queue: requireNonEmpty(input.queue, "DBOS queue"),
    runId: requireNonEmpty(input.runId, "DBOS runId"),
  };
  const expected = deriveIdempotencyKey(identity);
  if (input.idempotencyKey !== expected) {
    throw new Error("DBOS idempotency key mismatch");
  }
  return {
    ...identity,
    attemptId: requireNonEmpty(input.attemptId, "DBOS attemptId"),
    idempotencyKey: input.idempotencyKey,
    ownerEpoch: requireNonEmpty(input.ownerEpoch, "DBOS ownerEpoch"),
    ...(input.now === undefined ? {} : { now: input.now }),
  };
}

function read(row: Row): DbosWorkflow {
  return {
    cardId: text(row, "card_id"),
    queue: text(row, "queue"),
    runId: text(row, "run_id"),
    attemptId: text(row, "attempt_id"),
    idempotencyKey: text(row, "idempotency_key"),
    ownerEpoch: text(row, "owner_epoch"),
    workflowId: text(row, "workflow_id"),
    state: text(row, "state") as DbosWorkflowState,
    attemptCount: number(row, "attempt_count"),
    resourceState: parse<DbosResourceState>(row.resource_state, {
      ownedChild: false,
      lease: false,
      lock: false,
      port: false,
      descriptor: false,
      unresolvedExternalHandoff: false,
    }),
    ...(typeof row.result_hash === "string" ? { resultHash: row.result_hash } : {}),
    updatedAt: number(row, "updated_at"),
    now: number(row, "updated_at"),
  };
}

export function resolveDbosDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), ...DEFAULT_DB_PATH);
}

/**
 * SQLite compatibility runtime. This is intentionally not a production
 * authority; production wiring uses PostgresDbosClient below. Keeping it
 * available makes deterministic unit tests possible without silently adding
 * a second live workflow store.
 */
export class DbosRuntime {
  readonly db: DatabaseSync;
  private readonly now: () => number;
  private readonly gate?: AdmissionGate;

  constructor(options: { dbPath?: string; now?: () => number; gate?: AdmissionGate } = {}) {
    const dbPath = options.dbPath ?? resolveDbosDbPath();
    fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(dbPath);
    this.now = options.now ?? Date.now;
    this.gate = options.gate;
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS dbos_workflows (
        workflow_id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, card_id TEXT NOT NULL,
        queue TEXT NOT NULL, run_id TEXT NOT NULL, attempt_id TEXT NOT NULL, owner_epoch TEXT NOT NULL,
        state TEXT NOT NULL, attempt_count INTEGER NOT NULL, resource_state TEXT NOT NULL,
        result_hash TEXT, updated_at INTEGER NOT NULL,
        UNIQUE(card_id, queue, run_id)
      );
      CREATE TABLE IF NOT EXISTS dbos_workflow_events (
        workflow_id TEXT NOT NULL REFERENCES dbos_workflows(workflow_id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL, state TEXT NOT NULL, detail TEXT NOT NULL, at INTEGER NOT NULL,
        PRIMARY KEY(workflow_id, sequence)
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  private assertOpen(): void {
    this.gate?.assertAdmissionOpen();
  }

  admit(rawInput: DbosWorkflowInput): DbosReceipt {
    this.assertOpen();
    const input = normalize(rawInput);
    const workflowId = deriveWorkflowId(input);
    const now = input.now ?? this.now();
    return transaction(this.db, () => {
      const existing = this.db
        .prepare("SELECT * FROM dbos_workflows WHERE workflow_id = ?")
        .get(workflowId) as Row | undefined;
      if (existing) {
        const current = read(existing);
        if (
          stableJson({
            ...current,
            state: undefined,
            attemptCount: undefined,
            resourceState: undefined,
            updatedAt: undefined,
            now: undefined,
          }) !== stableJson({ ...input, workflowId, now: undefined })
        ) {
          throw new DbosRuntimeError("conflicting or duplicated DBOS workflow identity");
        }
        return this.receipt(current, now);
      }
      const resources: DbosResourceState = {
        ownedChild: false,
        lease: false,
        lock: false,
        port: false,
        descriptor: false,
        unresolvedExternalHandoff: false,
      };
      this.db
        .prepare(`INSERT INTO dbos_workflows
        (workflow_id, idempotency_key, card_id, queue, run_id, attempt_id, owner_epoch, state, attempt_count, resource_state, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'admitted', 0, ?, ?)`)
        .run(
          workflowId,
          input.idempotencyKey,
          input.cardId,
          input.queue,
          input.runId,
          input.attemptId,
          input.ownerEpoch,
          json(resources),
          now,
        );
      this.addEvent(workflowId, "admitted", "durable DBOS workflow admitted");
      return this.receipt(
        read(
          this.db
            .prepare("SELECT * FROM dbos_workflows WHERE workflow_id = ?")
            .get(workflowId) as Row,
        ),
        now,
      );
    });
  }

  private receipt(workflow: DbosWorkflow, acknowledgedAt: number): DbosReceipt {
    return {
      workflowId: workflow.workflowId,
      idempotencyKey: workflow.idempotencyKey,
      cardId: workflow.cardId,
      queue: workflow.queue,
      runId: workflow.runId,
      attemptId: workflow.attemptId,
      ownerEpoch: workflow.ownerEpoch,
      acknowledgedAt,
    };
  }

  get(workflowId: string): DbosWorkflow | undefined {
    const row = this.db
      .prepare("SELECT * FROM dbos_workflows WHERE workflow_id = ?")
      .get(workflowId) as Row | undefined;
    return row ? read(row) : undefined;
  }

  start(workflowId: string, ownerEpoch: string): DbosWorkflow {
    return transaction(this.db, () => {
      const current = this.get(workflowId);
      if (!current) {
        throw new DbosRuntimeError("DBOS workflow not found");
      }
      if (current.ownerEpoch !== ownerEpoch) {
        throw new DbosRuntimeError("stale DBOS owner epoch");
      }
      if (current.state === "running") {
        return current;
      }
      if (current.state !== "admitted") {
        throw new DbosRuntimeError(`cannot start DBOS ${current.state} workflow`);
      }
      const running = this.db
        .prepare(
          "SELECT COUNT(*) AS count FROM dbos_workflows WHERE queue = ? AND state = 'running'",
        )
        .get(current.queue) as Row;
      if (Number(running.count) >= DBOS_QUEUE_CONCURRENCY) {
        throw new DbosRuntimeError("DBOS two-worker limit reached");
      }
      this.db
        .prepare(
          "UPDATE dbos_workflows SET state = 'running', attempt_count = attempt_count + 1, updated_at = ? WHERE workflow_id = ?",
        )
        .run(this.now(), workflowId);
      this.addEvent(workflowId, "running", "workflow started");
      return this.get(workflowId)!;
    });
  }

  retry(workflowId: string, nextAttemptId: string, resources: DbosResourceState): DbosWorkflow {
    this.assertOpen();
    const normalizedAttemptId = requireNonEmpty(nextAttemptId, "DBOS next attempt id");
    if (Object.values(resources).some(Boolean)) {
      throw new DbosRuntimeError("DBOS retry blocked while owned resources remain");
    }
    return transaction(this.db, () => {
      const current = this.get(workflowId);
      if (!current) {
        throw new DbosRuntimeError("DBOS workflow not found");
      }
      if (current.state !== "failed") {
        throw new DbosRuntimeError("DBOS retry requires a failed workflow");
      }
      if (current.attemptId === normalizedAttemptId) {
        throw new DbosRuntimeError("DBOS retry must use a new attempt id");
      }
      this.db
        .prepare(
          "UPDATE dbos_workflows SET state = 'admitted', attempt_id = ?, resource_state = ?, updated_at = ? WHERE workflow_id = ?",
        )
        .run(normalizedAttemptId, json(resources), this.now(), workflowId);
      this.addEvent(workflowId, "admitted", "retry admitted after resource reconciliation");
      return this.get(workflowId)!;
    });
  }

  async execute(
    workflowId: string,
    ownerEpoch: string,
    run: () => Promise<{ resultHash: string; resources?: DbosResourceState }>,
  ): Promise<DbosWorkflow> {
    this.start(workflowId, ownerEpoch);
    try {
      const result = await run();
      if (!result.resultHash) {
        throw new DbosRuntimeError("DBOS workflow returned no result identity");
      }
      return transaction(this.db, () => {
        const updated = this.db
          .prepare(
            "UPDATE dbos_workflows SET state = 'succeeded', result_hash = ?, resource_state = ?, updated_at = ? WHERE workflow_id = ? AND state = 'running'",
          )
          .run(
            result.resultHash,
            json(
              result.resources ?? {
                ownedChild: false,
                lease: false,
                lock: false,
                port: false,
                descriptor: false,
                unresolvedExternalHandoff: false,
              },
            ),
            this.now(),
            workflowId,
          );
        if (Number(updated.changes) !== 1) {
          throw new DbosRuntimeError("DBOS workflow changed before completion");
        }
        this.addEvent(workflowId, "succeeded", "workflow completed");
        return this.get(workflowId)!;
      });
    } catch (error) {
      const recovered = transaction(this.db, () => {
        const current = this.get(workflowId);
        if (current?.state === "succeeded") {
          return current;
        }
        if (!current || current.state !== "running") {
          return undefined;
        }
        const updated = this.db
          .prepare(
            "UPDATE dbos_workflows SET state = 'failed', updated_at = ? WHERE workflow_id = ? AND state = 'running'",
          )
          .run(this.now(), workflowId);
        if (Number(updated.changes) !== 1) {
          return this.get(workflowId);
        }
        this.addEvent(workflowId, "failed", error instanceof Error ? error.message : String(error));
        return this.get(workflowId);
      });
      if (recovered?.state === "succeeded") {
        return recovered;
      }
      throw error;
    }
  }

  quarantine(workflowId: string, detail: string): void {
    requireNonEmpty(detail, "quarantine detail");
    transaction(this.db, () => {
      const current = this.get(workflowId);
      if (!current) {
        throw new DbosRuntimeError("DBOS workflow not found");
      }
      if (current.state === "quarantined") {
        return;
      }
      if (current.state === "succeeded") {
        throw new DbosRuntimeError("cannot quarantine a succeeded DBOS workflow");
      }
      this.db
        .prepare(
          "UPDATE dbos_workflows SET state = 'quarantined', updated_at = ? WHERE workflow_id = ?",
        )
        .run(this.now(), workflowId);
      this.addEvent(workflowId, "quarantined", detail);
    });
  }

  fail(workflowId: string, detail: string): DbosWorkflow {
    requireNonEmpty(detail, "DBOS failure detail");
    return transaction(this.db, () => {
      const current = this.get(workflowId);
      if (!current) {
        throw new DbosRuntimeError("DBOS workflow not found");
      }
      if (current.state === "failed") {
        return current;
      }
      if (current.state !== "admitted" && current.state !== "running") {
        throw new DbosRuntimeError(`cannot fail DBOS ${current.state} workflow`);
      }
      this.db
        .prepare("UPDATE dbos_workflows SET state = 'failed', updated_at = ? WHERE workflow_id = ?")
        .run(this.now(), workflowId);
      this.addEvent(workflowId, "failed", detail);
      return this.get(workflowId)!;
    });
  }

  complete(workflowId: string, evidence: { verification?: { outputHash?: string } }): DbosWorkflow {
    const resultHash = evidence.verification?.outputHash;
    if (!resultHash) {
      throw new DbosRuntimeError("DBOS completion requires a result identity");
    }
    return transaction(this.db, () => {
      const current = this.get(workflowId);
      if (!current) {
        throw new DbosRuntimeError("DBOS workflow not found");
      }
      if (current.state === "succeeded" && current.resultHash === resultHash) {
        return current;
      }
      if (current.state !== "running") {
        throw new DbosRuntimeError(`cannot complete DBOS ${current.state} workflow`);
      }
      this.db
        .prepare(
          "UPDATE dbos_workflows SET state = 'succeeded', result_hash = ?, updated_at = ? WHERE workflow_id = ? AND state = 'running'",
        )
        .run(resultHash, this.now(), workflowId);
      this.addEvent(workflowId, "succeeded", "workflow completed with BQES evidence");
      return this.get(workflowId)!;
    });
  }

  reconcile(
    workboard: Array<{ cardId: string; queue: string; runId: string; state: string }>,
  ): ReconciliationFinding[] {
    const findings: ReconciliationFinding[] = [];
    const workboardByIdentity = new Map(
      workboard.map((entry) => [`${entry.cardId}\0${entry.queue}\0${entry.runId}`, entry]),
    );
    const dbos = this.db.prepare("SELECT * FROM dbos_workflows").all() as Row[];
    const dbosByIdentity = new Map<string, DbosWorkflow>();
    const seen = new Set<string>();
    for (const row of dbos) {
      const workflow = read(row);
      const identity = `${workflow.cardId}\0${workflow.queue}\0${workflow.runId}`;
      dbosByIdentity.set(identity, workflow);
      if (!workboardByIdentity.has(identity)) {
        findings.push({ kind: "orphaned", identity, detail: workflow.workflowId });
      }
      if (seen.has(workflow.idempotencyKey)) {
        findings.push({ kind: "duplicated", identity, detail: workflow.idempotencyKey });
      }
      seen.add(workflow.idempotencyKey);
    }
    for (const [identity, card] of workboardByIdentity) {
      const workflow = dbosByIdentity.get(identity);
      const expectedDbosState = WORKBOARD_DBOS_STATE_MAP[card.state] ?? null;
      if (!expectedDbosState) {
        if (workflow) {
          findings.push({
            kind: "conflicting",
            identity,
            detail: `Workboard=${card.state} must not have DBOS execution (${workflow.state})`,
          });
        }
        continue;
      }
      if (!workflow) {
        findings.push({
          kind: "unknown",
          identity,
          detail: "workboard record has no DBOS workflow",
        });
      } else if (workflow.state !== expectedDbosState) {
        findings.push({
          kind: "conflicting",
          identity,
          detail: `Workboard=${card.state}, DBOS=${workflow.state}`,
        });
      }
    }
    return findings;
  }

  private addEvent(workflowId: string, state: string, detail: string): void {
    const row = this.db
      .prepare(
        "SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM dbos_workflow_events WHERE workflow_id = ?",
      )
      .get(workflowId) as Row;
    this.db
      .prepare("INSERT INTO dbos_workflow_events VALUES (?, ?, ?, ?, ?)")
      .run(workflowId, Number(row.next), state, detail, this.now());
  }
}

export { DbosRuntimeError, DbosRequestError } from "./dbos-errors.js";
export {
  PostgresDbosClient,
  createProductionDbosAuthority,
  requireDbosReceipt,
} from "./dbos-client.js";
export type { DbosRequestFailureKind } from "./dbos-errors.js";
export type { DbosHttpClientOptions } from "./dbos-client.js";
