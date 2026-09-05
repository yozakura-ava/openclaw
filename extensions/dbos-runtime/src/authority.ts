// Authenticated PostgreSQL DBOS authority.
//
// The Workboard process is a client of this service; it never writes the
// authority tables directly. The backend is deliberately small and uses an
// explicit operation ledger so a retried HTTP request cannot execute twice.
import { createHash } from "node:crypto";
import {
  deriveIdempotencyKey,
  deriveWorkflowId,
  normalizeRepositoryRelativeManifest,
  parseApprovedVerificationCommand,
  requireNonEmpty,
  stableJson,
  type AdmissionEnvelope,
} from "@openclaw/execution-contract";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import type { DbosReceipt, DbosWorkflowInput } from "./dbos.js";
import type { AuthoritySdkOperation, DbosSdkAuthority } from "./sdk-authority.js";

const DBOS_QUEUE_CONCURRENCY = 2;

export type AuthorityAck = {
  workflowId: string;
  idempotencyKey: string;
  cardId: string;
  queue: string;
  runId: string;
  attemptId: string;
  ownerEpoch: string;
  state: "admitted" | "running" | "failed" | "succeeded";
  operationKey: string;
  acknowledgedAt: number;
  serverTimestamp: number;
};

export type DbosAuthorityBackend = {
  admit(
    input: DbosWorkflowInput & {
      workflowId: string;
      operationKey: string;
      envelope?: AdmissionEnvelope;
    },
  ): Promise<DbosReceipt>;
  start(workflowId: string, ownerEpoch: string, operationKey: string): Promise<AuthorityAck>;
  fail(workflowId: string, detail: string, operationKey: string): Promise<AuthorityAck>;
  complete(workflowId: string, evidence: unknown, operationKey: string): Promise<AuthorityAck>;
  /** Return one active admitted/running run for a card, if present. */
  findActiveByCardId?(cardId: string, queue?: string): Promise<string | undefined>;
  health(): Promise<boolean>;
};

type DbosRow = QueryResultRow & {
  workflow_id: string;
  idempotency_key: string;
  card_id: string;
  queue: string;
  run_id: string;
  attempt_id: string;
  owner_epoch: string;
  state: AuthorityAck["state"];
  operation_key?: string;
  acknowledged_at?: number;
  result_hash?: string;
  admission_hash?: string;
};

function operationIdentity(operationKey: string, workflowId: string): string {
  // PostgreSQL TEXT cannot contain NUL. Hash the tuple instead of concatenating
  // with a delimiter so arbitrary operation keys remain unambiguous.
  return createHash("sha256").update(operationKey).update("\0").update(workflowId).digest("hex");
}

function operationAck(row: DbosRow, operationKey: string, now = Date.now()): AuthorityAck {
  return {
    workflowId: row.workflow_id,
    idempotencyKey: row.idempotency_key,
    cardId: row.card_id,
    queue: row.queue,
    runId: row.run_id,
    attemptId: row.attempt_id,
    ownerEpoch: row.owner_epoch,
    state: row.state,
    operationKey,
    acknowledgedAt: row.acknowledged_at ?? now,
    serverTimestamp: now,
  };
}

function admissionHash(
  input: DbosWorkflowInput & {
    workflowId: string;
    operationKey: string;
    envelope?: AdmissionEnvelope;
  },
): string {
  const envelope = input.envelope
    ? (({ admissionTimestamp: _admissionTimestamp, ...rest }) => rest)(input.envelope)
    : undefined;
  return createHash("sha256")
    .update(
      stableJson({
        workflowId: input.workflowId,
        idempotencyKey: input.idempotencyKey,
        cardId: input.cardId,
        queue: input.queue,
        runId: input.runId,
        attemptId: input.attemptId,
        ownerEpoch: input.ownerEpoch,
        operationKey: input.operationKey,
        envelope,
      }),
    )
    .digest("hex");
}

function resultHash(evidence: unknown): string {
  const value =
    evidence && typeof evidence === "object" ? (evidence as Record<string, unknown>) : {};
  const verification =
    value.verification && typeof value.verification === "object"
      ? (value.verification as Record<string, unknown>)
      : {};
  return requireNonEmpty(verification.outputHash, "DBOS completion output hash");
}

export function validateAdmissionEnvelope(
  envelope: unknown,
  identity: { cardId: string; queue: string; runId: string },
  attemptId: string,
  idempotencyKey: string,
  workflowId: string,
  ownerEpoch: string,
): AdmissionEnvelope {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    throw new Error("DBOS admission envelope is required");
  }
  const value = envelope as Partial<AdmissionEnvelope>;
  if (
    value.cardId !== identity.cardId ||
    value.queue !== identity.queue ||
    value.runId !== identity.runId ||
    value.attemptId !== attemptId ||
    value.idempotencyKey !== idempotencyKey ||
    value.workflowId !== workflowId ||
    value.ownerEpoch !== ownerEpoch
  ) {
    throw new Error("DBOS admission envelope identity mismatch");
  }
  const sourceIdentity = requireNonEmpty(value.sourceIdentity, "DBOS source identity");
  const artifactIdentity = requireNonEmpty(value.artifactIdentity, "DBOS artifact identity");
  const normalizedOwnerEpoch = requireNonEmpty(value.ownerEpoch, "DBOS owner epoch");
  const allowedFiles = normalizeRepositoryRelativeManifest(
    value.allowedFiles,
    "DBOS allowed files",
  );
  const targetFiles = normalizeRepositoryRelativeManifest(value.targetFiles, "DBOS target files");
  if (targetFiles.some((file) => !allowedFiles.includes(file))) {
    throw new Error("DBOS target files must be contained in allowed files");
  }
  if (!Array.isArray(value.acceptanceCriteria) || value.acceptanceCriteria.length === 0) {
    throw new Error("DBOS acceptance criteria manifest is required");
  }
  const acceptanceCriteria = value.acceptanceCriteria.map((entry) =>
    requireNonEmpty(entry, "DBOS acceptance criterion"),
  );
  const verificationCommand = parseApprovedVerificationCommand(value.verificationCommand).command;
  return {
    ...identity,
    attemptId,
    idempotencyKey,
    workflowId,
    sourceIdentity,
    artifactIdentity,
    ownerEpoch: normalizedOwnerEpoch,
    allowedFiles,
    targetFiles,
    acceptanceCriteria,
    verificationCommand,
    ...(typeof value.artifactPath === "string"
      ? {
          artifactPath: normalizeRepositoryRelativeManifest(
            [value.artifactPath],
            "DBOS artifact path",
          )[0],
        }
      : {}),
    ...(typeof value.buildArtifactPath === "string"
      ? {
          buildArtifactPath: normalizeRepositoryRelativeManifest(
            [value.buildArtifactPath],
            "DBOS build artifact path",
          )[0],
        }
      : {}),
    ...(Array.isArray(value.documentedExemptPaths)
      ? {
          documentedExemptPaths: normalizeRepositoryRelativeManifest(
            value.documentedExemptPaths,
            "DBOS documented exemptions",
          ),
        }
      : {}),
    admissionTimestamp:
      typeof value.admissionTimestamp === "number" && Number.isFinite(value.admissionTimestamp)
        ? value.admissionTimestamp
        : Date.now(),
  };
}

/** PostgreSQL store used by the authority process. */
export class PostgresDbosAuthorityBackend implements DbosAuthorityBackend {
  constructor(
    private readonly pool: Pool,
    private readonly sdk?: DbosSdkAuthority,
  ) {}

  async migrate(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS openclaw_dbos_workflows (
        workflow_id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        card_id TEXT NOT NULL,
        queue TEXT NOT NULL,
        run_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        owner_epoch TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('admitted','running','failed','succeeded')),
        acknowledged_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        result_hash TEXT,
        UNIQUE(card_id, queue, run_id)
      );
      CREATE TABLE IF NOT EXISTS openclaw_dbos_operations (
        operation_id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL REFERENCES openclaw_dbos_workflows(workflow_id),
        response JSONB NOT NULL,
        created_at BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS openclaw_dbos_workflows_active_card_idx
        ON openclaw_dbos_workflows(card_id, state, updated_at DESC);
    `);
    await this.pool.query(
      "ALTER TABLE openclaw_dbos_workflows ADD COLUMN IF NOT EXISTS result_hash TEXT",
    );
    await this.pool.query(
      "ALTER TABLE openclaw_dbos_workflows ADD COLUMN IF NOT EXISTS sdk_workflow_id TEXT",
    );
    await this.pool.query(
      "ALTER TABLE openclaw_dbos_workflows ADD COLUMN IF NOT EXISTS admission_hash TEXT",
    );
    await this.pool.query(
      "ALTER TABLE openclaw_dbos_operations DROP CONSTRAINT IF EXISTS openclaw_dbos_operations_workflow_id_fkey",
    );
    await this.pool.query(
      "ALTER TABLE openclaw_dbos_operations ADD CONSTRAINT openclaw_dbos_operations_workflow_id_fkey FOREIGN KEY (workflow_id) REFERENCES openclaw_dbos_workflows(workflow_id) ON DELETE CASCADE",
    );
    await this.pool.query(`
      UPDATE openclaw_dbos_operations AS operations
      SET response = operations.response || jsonb_build_object(
        'cardId', workflows.card_id,
        'queue', workflows.queue,
        'runId', workflows.run_id,
        'attemptId', workflows.attempt_id,
        'ownerEpoch', workflows.owner_epoch
      )
      FROM openclaw_dbos_workflows AS workflows
      WHERE operations.workflow_id = workflows.workflow_id
        AND NOT (operations.response ? 'cardId')
    `);
  }

  async health(): Promise<boolean> {
    await this.pool.query("SELECT 1");
    return (await this.sdk?.health()) ?? true;
  }

  async findActiveByCardId(cardId: string, queue?: string): Promise<string | undefined> {
    const normalizedCardId = requireNonEmpty(cardId, "DBOS cardId");
    const normalizedQueue = queue === undefined ? undefined : requireNonEmpty(queue, "DBOS queue");
    const result = await this.pool.query<{ run_id: string }>(
      `SELECT run_id
         FROM openclaw_dbos_workflows
        WHERE card_id = $1
          AND state IN ('admitted', 'running')
          AND ($2::text IS NULL OR queue = $2)
        ORDER BY updated_at DESC, workflow_id DESC
        LIMIT 1`,
      [normalizedCardId, normalizedQueue ?? null],
    );
    return result.rows[0]?.run_id;
  }

  private async executeSdkOperation(operation: AuthoritySdkOperation): Promise<void> {
    await this.sdk?.execute(operation);
  }

  private async withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const value = await fn(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async existingOperation(
    client: PoolClient,
    operationKey: string,
    workflowId: string,
  ): Promise<AuthorityAck | DbosReceipt | undefined> {
    const result = await client.query<{ response: AuthorityAck | DbosReceipt }>(
      "SELECT response FROM openclaw_dbos_operations WHERE operation_id = $1",
      [operationIdentity(operationKey, workflowId)],
    );
    return result.rows[0]?.response;
  }

  private async saveOperation(
    client: PoolClient,
    operationKey: string,
    workflowId: string,
    response: AuthorityAck | DbosReceipt,
  ): Promise<void> {
    const existing = await this.existingOperation(client, operationKey, workflowId);
    if (existing) {
      if (stableJson(existing) !== stableJson(response)) {
        throw new Error("conflicting DBOS operation identity");
      }
      return;
    }
    await client.query(
      "INSERT INTO openclaw_dbos_operations(operation_id, workflow_id, response, created_at) VALUES ($1, $2, $3::jsonb, $4) ON CONFLICT (operation_id) DO NOTHING",
      [
        operationIdentity(operationKey, workflowId),
        workflowId,
        JSON.stringify(response),
        Date.now(),
      ],
    );
  }

  async admit(
    input: DbosWorkflowInput & {
      workflowId: string;
      operationKey: string;
      envelope?: AdmissionEnvelope;
    },
  ): Promise<DbosReceipt> {
    const identity = {
      cardId: requireNonEmpty(input.cardId, "DBOS cardId"),
      queue: requireNonEmpty(input.queue, "DBOS queue"),
      runId: requireNonEmpty(input.runId, "DBOS runId"),
    } as const;
    if (
      input.workflowId !== deriveWorkflowId(identity) ||
      input.idempotencyKey !== deriveIdempotencyKey(identity)
    ) {
      throw new Error("DBOS admission identity mismatch");
    }
    const envelope = validateAdmissionEnvelope(
      input.envelope,
      identity,
      requireNonEmpty(input.attemptId, "DBOS attempt id"),
      input.idempotencyKey,
      input.workflowId,
      requireNonEmpty(input.ownerEpoch, "DBOS owner epoch"),
    );
    const admittedInput = { ...input, envelope };
    const now = Date.now();
    const requestHash = admissionHash(admittedInput);
    const client = await this.pool.connect();
    const lockKeys = [
      `admit:idempotency:${admittedInput.idempotencyKey}`,
      `admit:workflow:${admittedInput.workflowId}`,
    ].toSorted();
    let transactionStarted = false;
    try {
      // The lock spans the SDK command and projection commit. This prevents
      // two different workflow identities from both creating durable DBOS
      // operations for one idempotency key before PostgreSQL can reject one.
      for (const lockKey of lockKeys) {
        await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [lockKey]);
      }
      const existing = await client.query<DbosRow>(
        "SELECT * FROM openclaw_dbos_workflows WHERE idempotency_key = $1 OR workflow_id = $2 FOR UPDATE",
        [admittedInput.idempotencyKey, admittedInput.workflowId],
      );
      if (existing.rows.length > 1) {
        throw new Error("conflicting DBOS admission identity: multiple owners");
      }
      if (existing.rows[0]) {
        const row = existing.rows[0];
        if (
          row.idempotency_key !== admittedInput.idempotencyKey ||
          row.workflow_id !== admittedInput.workflowId ||
          row.card_id !== admittedInput.cardId ||
          row.queue !== admittedInput.queue ||
          row.run_id !== admittedInput.runId ||
          row.attempt_id !== admittedInput.attemptId ||
          row.owner_epoch !== admittedInput.ownerEpoch ||
          (row.admission_hash !== undefined &&
            row.admission_hash !== null &&
            row.admission_hash !== requestHash)
        ) {
          throw new Error("conflicting DBOS admission identity");
        }
        await client.query("BEGIN");
        transactionStarted = true;
        const prior = await this.existingOperation(
          client,
          admittedInput.operationKey,
          admittedInput.workflowId,
        );
        if (prior) {
          await client.query("COMMIT");
          transactionStarted = false;
          return prior as DbosReceipt;
        }
        if (row.sdk_workflow_id && row.sdk_workflow_id !== admittedInput.workflowId) {
          throw new Error("conflicting DBOS SDK workflow identity");
        }
        if (!row.sdk_workflow_id || !row.admission_hash) {
          await client.query(
            "UPDATE openclaw_dbos_workflows SET sdk_workflow_id = COALESCE(sdk_workflow_id, $1), admission_hash = COALESCE(admission_hash, $2), updated_at = $3 WHERE workflow_id = $1",
            [admittedInput.workflowId, requestHash, now],
          );
          row.sdk_workflow_id = row.sdk_workflow_id ?? admittedInput.workflowId;
          row.admission_hash = row.admission_hash ?? requestHash;
        }
        const receipt = this.receipt(row, admittedInput.operationKey, now);
        await this.saveOperation(
          client,
          admittedInput.operationKey,
          admittedInput.workflowId,
          receipt,
        );
        await client.query("COMMIT");
        transactionStarted = false;
        return receipt;
      }

      // DBOS SDK execution is deliberately outside the SQL transaction. The
      // session advisory locks above make this operation linearizable by both
      // workflow and idempotency identity while keeping the SDK out of a
      // PostgreSQL transaction that it may itself need to use.
      await this.executeSdkOperation({
        operationId: admittedInput.workflowId,
        workflowId: admittedInput.workflowId,
        operationKey: admittedInput.operationKey,
        kind: "admit",
        identity: admittedInput,
      });
      await client.query("BEGIN");
      transactionStarted = true;
      await client.query(
        "INSERT INTO openclaw_dbos_workflows(workflow_id,idempotency_key,card_id,queue,run_id,attempt_id,owner_epoch,state,acknowledged_at,updated_at,sdk_workflow_id,admission_hash) VALUES ($1,$2,$3,$4,$5,$6,$7,'admitted',$8,$8,$1,$9) ON CONFLICT DO NOTHING",
        [
          admittedInput.workflowId,
          admittedInput.idempotencyKey,
          admittedInput.cardId,
          admittedInput.queue,
          admittedInput.runId,
          admittedInput.attemptId,
          admittedInput.ownerEpoch,
          now,
          requestHash,
        ],
      );
      const persistedResult = await client.query<DbosRow>(
        "SELECT * FROM openclaw_dbos_workflows WHERE idempotency_key = $1 OR workflow_id = $2 FOR UPDATE",
        [admittedInput.idempotencyKey, admittedInput.workflowId],
      );
      if (persistedResult.rows.length !== 1) {
        throw new Error("DBOS admission projection identity is ambiguous");
      }
      const persisted = persistedResult.rows[0];
      if (!persisted) {
        throw new Error("DBOS admission projection identity is missing");
      }
      if (
        persisted.workflow_id !== admittedInput.workflowId ||
        persisted.idempotency_key !== admittedInput.idempotencyKey ||
        persisted.admission_hash !== requestHash
      ) {
        throw new Error("conflicting DBOS admission identity");
      }
      const receipt = this.receipt(persisted, admittedInput.operationKey, now);
      await this.saveOperation(
        client,
        admittedInput.operationKey,
        admittedInput.workflowId,
        receipt,
      );
      await client.query("COMMIT");
      transactionStarted = false;
      return receipt;
    } catch (error) {
      if (transactionStarted) {
        await client.query("ROLLBACK").catch(() => undefined);
      }
      throw error;
    } finally {
      for (const lockKey of lockKeys.toReversed()) {
        await client
          .query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [lockKey])
          .catch(() => undefined);
      }
      client.release();
    }
  }

  private receipt(row: DbosRow, operationKey: string, now = Date.now()): DbosReceipt {
    return {
      workflowId: row.workflow_id,
      idempotencyKey: row.idempotency_key,
      cardId: row.card_id,
      queue: row.queue,
      runId: row.run_id,
      attemptId: row.attempt_id,
      ownerEpoch: row.owner_epoch,
      acknowledgedAt: Number(row.acknowledged_at),
      operationKey,
      state: "admitted",
      serverTimestamp: now,
      sdkWorkflowId: row.sdk_workflow_id,
    };
  }

  private async mutate(
    workflowId: string,
    operationKey: string,
    kind: "start" | "fail" | "complete",
    payload: unknown,
    transition: (client: PoolClient, row: DbosRow) => Promise<DbosRow>,
  ): Promise<AuthorityAck> {
    requireNonEmpty(operationKey, "DBOS operation key");
    const priorResult = await this.pool.query<{ response: AuthorityAck }>(
      "SELECT response FROM openclaw_dbos_operations WHERE operation_id = $1",
      [operationIdentity(operationKey, workflowId)],
    );
    if (priorResult.rows[0]?.response) {
      return priorResult.rows[0].response as AuthorityAck;
    }
    const identityResult = await this.pool.query<DbosRow>(
      "SELECT card_id, queue, run_id, attempt_id, owner_epoch FROM openclaw_dbos_workflows WHERE workflow_id = $1",
      [workflowId],
    );
    const identityRow = identityResult.rows[0];
    if (!identityRow) {
      throw new Error("DBOS workflow not found");
    }
    // The SDK command is durable and idempotent, but it must not execute while
    // a projection transaction is holding PostgreSQL locks.
    await this.executeSdkOperation({
      operationId: `dbos-authority:${operationIdentity(operationKey, workflowId)}`,
      workflowId,
      operationKey,
      kind,
      identity: {
        cardId: identityRow.card_id,
        queue: identityRow.queue,
        runId: identityRow.run_id,
        attemptId: identityRow.attempt_id,
        ownerEpoch: identityRow.owner_epoch,
      },
      payload,
    });
    return this.withTransaction(async (client) => {
      const prior = await this.existingOperation(client, operationKey, workflowId);
      if (prior) {
        return prior as AuthorityAck;
      }
      const result = await client.query<DbosRow>(
        "SELECT * FROM openclaw_dbos_workflows WHERE workflow_id = $1 FOR UPDATE",
        [workflowId],
      );
      const row = result.rows[0];
      if (!row) {
        throw new Error("DBOS workflow not found");
      }
      const next = await transition(client, row);
      const ack = operationAck(next, operationKey);
      await this.saveOperation(client, operationKey, workflowId, ack);
      return ack;
    });
  }

  async start(workflowId: string, ownerEpoch: string, operationKey: string): Promise<AuthorityAck> {
    return this.mutate(workflowId, operationKey, "start", { ownerEpoch }, async (client, row) => {
      if (row.owner_epoch !== ownerEpoch) {
        throw new Error("stale DBOS owner epoch");
      }
      if (row.state === "running") {
        return row;
      }
      if (row.state !== "admitted") {
        throw new Error(`cannot start DBOS ${row.state} workflow`);
      }
      // Serialize the capacity check and state transition for this queue.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [row.queue]);
      const count = await client.query<{ count: string }>(
        "SELECT COUNT(*) AS count FROM openclaw_dbos_workflows WHERE queue = $1 AND state = 'running'",
        [row.queue],
      );
      if (Number(count.rows[0]?.count ?? 0) >= DBOS_QUEUE_CONCURRENCY) {
        throw new Error("DBOS queue concurrency limit reached");
      }
      await client.query(
        "UPDATE openclaw_dbos_workflows SET state = 'running', updated_at = $1 WHERE workflow_id = $2",
        [Date.now(), workflowId],
      );
      return { ...row, state: "running" };
    });
  }

  async fail(workflowId: string, detail: string, operationKey: string): Promise<AuthorityAck> {
    requireNonEmpty(detail, "DBOS failure detail");
    return this.mutate(workflowId, operationKey, "fail", { detail }, async (client, row) => {
      if (row.state === "failed") {
        return row;
      }
      if (row.state !== "admitted" && row.state !== "running") {
        throw new Error(`cannot fail DBOS ${row.state} workflow`);
      }
      await client.query(
        "UPDATE openclaw_dbos_workflows SET state = 'failed', updated_at = $1 WHERE workflow_id = $2",
        [Date.now(), workflowId],
      );
      return { ...row, state: "failed" };
    });
  }

  async complete(
    workflowId: string,
    evidence: unknown,
    operationKey: string,
  ): Promise<AuthorityAck> {
    const hash = resultHash(evidence);
    return this.mutate(workflowId, operationKey, "complete", { evidence }, async (client, row) => {
      if (row.state === "succeeded") {
        if (row.result_hash !== hash) {
          throw new Error("conflicting DBOS completion evidence");
        }
        return row;
      }
      if (row.state !== "running") {
        throw new Error(`cannot complete DBOS ${row.state} workflow`);
      }
      await client.query(
        "UPDATE openclaw_dbos_workflows SET state = 'succeeded', result_hash = $1, updated_at = $2 WHERE workflow_id = $3",
        [hash, Date.now(), workflowId],
      );
      return { ...row, state: "succeeded", result_hash: hash };
    });
  }
}
