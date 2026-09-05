import type { Pool, PoolClient, QueryResultRow } from "pg";

export type WorkboardAuthorityRecord = {
  found: boolean;
  deleted: boolean;
  value?: unknown;
  revision?: number;
  updatedAt?: number;
};

export type WorkboardAuthorityWrite = {
  operationId: string;
  namespace: string;
  key: string;
  value?: unknown;
  mode: "insert" | "upsert" | "delete" | "claim";
  expectedUpdatedAt?: number;
  ownerId?: string;
  now?: number;
  maxConcurrentClaims?: number;
};

export type WorkboardAuthorityWriteResult = {
  applied: boolean;
  result: "updated" | "conflict" | "owner_busy";
  record: WorkboardAuthorityRecord;
};

export type WorkboardAuthorityBackend = {
  migrate?(): Promise<void>;
  health(): Promise<boolean>;
  read(namespace: string, key: string): Promise<WorkboardAuthorityRecord>;
  list(namespace: string): Promise<Array<{ key: string; record: WorkboardAuthorityRecord }>>;
  write(input: WorkboardAuthorityWrite): Promise<WorkboardAuthorityWriteResult>;
};

type RecordRow = QueryResultRow & {
  record_key: string;
  value: unknown;
  deleted: boolean;
  revision: number | string;
  updated_at: number | string;
};

type OperationRow = QueryResultRow & {
  request_hash: string;
  response: WorkboardAuthorityWriteResult;
};

const MAX_NAMESPACE = 80;
const MAX_KEY = 240;
const MAX_OPERATION_ID = 160;
const MAX_VALUE_BYTES = 768 * 1024;
const MAX_CLAIMS = 1000;

function validateString(value: string, label: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

function recordFromRow(row: RecordRow | undefined): WorkboardAuthorityRecord {
  if (!row) {
    return { found: false, deleted: false };
  }
  return {
    found: true,
    deleted: row.deleted,
    ...(!row.deleted ? { value: row.value } : {}),
    revision: Number(row.revision),
    updatedAt: Number(row.updated_at),
  };
}

function claimConsumesSlot(value: unknown, now: number): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  // SAFETY: the guard above proves value is a non-array object; only its optional card field is read.
  const card = (value as { card?: unknown }).card;
  if (!card || typeof card !== "object" || Array.isArray(card)) {
    return false;
  }
  // SAFETY: the guard above proves card is a non-array object before its bounded fields are read.
  const candidate = card as {
    status?: unknown;
    execution?: { status?: unknown };
    metadata?: { archivedAt?: unknown; claim?: { expiresAt?: unknown } };
  };
  if (candidate.metadata?.archivedAt) {
    return false;
  }
  const expiresAt = candidate.metadata?.claim?.expiresAt;
  const activeClaim = typeof expiresAt === "number" && expiresAt > now;
  return (
    candidate.status === "running" ||
    (candidate.status !== "done" && activeClaim) ||
    candidate.execution?.status === "running"
  );
}

function slotOwner(value: unknown, now: number): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "workboard-dispatcher";
  }
  // SAFETY: the guard above proves value is a non-array object; only its optional card field is read.
  const card = (value as { card?: unknown }).card;
  if (!card || typeof card !== "object" || Array.isArray(card)) {
    return "workboard-dispatcher";
  }
  // SAFETY: the guard above proves card is a non-array object before its bounded fields are read.
  const candidate = card as {
    agentId?: unknown;
    metadata?: { claim?: { ownerId?: unknown; expiresAt?: unknown } };
  };
  const claim = candidate.metadata?.claim;
  if (
    claim &&
    typeof claim.ownerId === "string" &&
    typeof claim.expiresAt === "number" &&
    claim.expiresAt > now
  ) {
    return claim.ownerId;
  }
  return typeof candidate.agentId === "string" && candidate.agentId
    ? candidate.agentId
    : "workboard-dispatcher";
}

function requestHash(input: WorkboardAuthorityWrite): string {
  return JSON.stringify({
    operationId: input.operationId,
    namespace: input.namespace,
    key: input.key,
    value: input.value,
    mode: input.mode,
    expectedUpdatedAt: input.expectedUpdatedAt,
    ownerId: input.ownerId,
    now: input.now,
    maxConcurrentClaims: input.maxConcurrentClaims,
  });
}

export class PostgresWorkboardAuthorityBackend implements WorkboardAuthorityBackend {
  constructor(private readonly pool: Pool) {}

  async migrate(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS openclaw_workboard_records (
        namespace TEXT NOT NULL,
        record_key TEXT NOT NULL,
        value JSONB,
        deleted BOOLEAN NOT NULL DEFAULT FALSE,
        revision BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY(namespace, record_key)
      );
      CREATE TABLE IF NOT EXISTS openclaw_workboard_operations (
        operation_id TEXT PRIMARY KEY,
        request_hash TEXT NOT NULL,
        response JSONB NOT NULL,
        created_at BIGINT NOT NULL
      );
    `);
  }

  async health(): Promise<boolean> {
    await this.pool.query("SELECT 1");
    return true;
  }

  async read(namespace: string, key: string): Promise<WorkboardAuthorityRecord> {
    validateString(namespace, "Workboard namespace", MAX_NAMESPACE);
    validateString(key, "Workboard key", MAX_KEY);
    const result = await this.pool.query<RecordRow>(
      "SELECT record_key, value, deleted, revision, updated_at FROM openclaw_workboard_records WHERE namespace = $1 AND record_key = $2",
      [namespace, key],
    );
    return recordFromRow(result.rows[0]);
  }

  async list(namespace: string): Promise<Array<{ key: string; record: WorkboardAuthorityRecord }>> {
    validateString(namespace, "Workboard namespace", MAX_NAMESPACE);
    const result = await this.pool.query<RecordRow>(
      "SELECT record_key, value, deleted, revision, updated_at FROM openclaw_workboard_records WHERE namespace = $1 AND deleted = FALSE ORDER BY record_key ASC LIMIT 10000",
      [namespace],
    );
    return result.rows.map((row) => ({ key: row.record_key, record: recordFromRow(row) }));
  }

  private async withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async write(input: WorkboardAuthorityWrite): Promise<WorkboardAuthorityWriteResult> {
    validateString(input.operationId, "Workboard operation id", MAX_OPERATION_ID);
    validateString(input.namespace, "Workboard namespace", MAX_NAMESPACE);
    validateString(input.key, "Workboard key", MAX_KEY);
    if (input.mode !== "delete" && input.value === undefined) {
      throw new Error("Workboard value is required");
    }
    if (input.value !== undefined && jsonBytes(input.value) > MAX_VALUE_BYTES) {
      throw new Error("Workboard value is too large");
    }
    if (input.mode === "claim") {
      validateString(input.ownerId ?? "", "Workboard claim owner", 120);
      if (!Number.isInteger(input.maxConcurrentClaims) || input.maxConcurrentClaims! < 1) {
        throw new Error("Workboard claim limit is invalid");
      }
      if (input.maxConcurrentClaims! > MAX_CLAIMS) {
        throw new Error("Workboard claim limit is too large");
      }
    }
    const hash = requestHash(input);
    return await this.withTransaction(async (client) => {
      // Serialize exact operation replays before looking up the ledger row.
      // Without this lock, two first attempts could both miss the row and race
      // on the ledger primary key after one of them has already mutated data.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        input.operationId,
      ]);
      const operation = await client.query<OperationRow>(
        "SELECT request_hash, response FROM openclaw_workboard_operations WHERE operation_id = $1 FOR SHARE",
        [input.operationId],
      );
      const prior = operation.rows[0];
      if (prior) {
        if (prior.request_hash !== hash) {
          throw new Error("conflicting Workboard operation identity");
        }
        return prior.response;
      }

      const rowResult = await client.query<RecordRow>(
        "SELECT record_key, value, deleted, revision, updated_at FROM openclaw_workboard_records WHERE namespace = $1 AND record_key = $2 FOR UPDATE",
        [input.namespace, input.key],
      );
      const current = recordFromRow(rowResult.rows[0]);
      const expected = input.expectedUpdatedAt;
      if (expected !== undefined && current.updatedAt !== expected) {
        const result: WorkboardAuthorityWriteResult = {
          applied: false,
          result: "conflict",
          record: current,
        };
        await this.saveOperation(client, input, hash, result);
        return result;
      }
      if (input.mode === "insert" && current.found) {
        const result: WorkboardAuthorityWriteResult = {
          applied: false,
          result: "conflict",
          record: current,
        };
        await this.saveOperation(client, input, hash, result);
        return result;
      }
      if (input.mode === "delete" && !current.found) {
        const result: WorkboardAuthorityWriteResult = {
          applied: false,
          result: "updated",
          record: current,
        };
        await this.saveOperation(client, input, hash, result);
        return result;
      }

      if (input.mode === "claim") {
        const now = input.now ?? Date.now();
        const owners = await client.query<RecordRow>(
          "SELECT record_key, value, deleted, revision, updated_at FROM openclaw_workboard_records WHERE namespace = $1 AND deleted = FALSE FOR UPDATE",
          [input.namespace],
        );
        const ownerActiveClaims = owners.rows.reduce(
          (count, ownerRow) =>
            ownerRow.record_key !== input.key &&
            claimConsumesSlot(ownerRow.value, now) &&
            slotOwner(ownerRow.value, now) === input.ownerId
              ? count + 1
              : count,
          0,
        );
        if (ownerActiveClaims >= input.maxConcurrentClaims!) {
          const result: WorkboardAuthorityWriteResult = {
            applied: false,
            result: "owner_busy",
            record: current,
          };
          await this.saveOperation(client, input, hash, result);
          return result;
        }
      }

      const now = input.now ?? Date.now();
      const previousUpdatedAt = current.updatedAt ?? 0;
      const updatedAt = Math.max(now, previousUpdatedAt + 1);
      const revision = (current.revision ?? 0) + 1;
      const deleted = input.mode === "delete";
      await client.query(
        `INSERT INTO openclaw_workboard_records
           (namespace, record_key, value, deleted, revision, updated_at)
         VALUES ($1, $2, $3::jsonb, $4, $5, $6)
         ON CONFLICT(namespace, record_key) DO UPDATE SET
           value = EXCLUDED.value,
           deleted = EXCLUDED.deleted,
           revision = EXCLUDED.revision,
           updated_at = EXCLUDED.updated_at`,
        [
          input.namespace,
          input.key,
          deleted ? null : JSON.stringify(input.value),
          deleted,
          revision,
          updatedAt,
        ],
      );
      const result: WorkboardAuthorityWriteResult = {
        applied: true,
        result: "updated",
        record: {
          found: true,
          deleted,
          ...(!deleted ? { value: input.value } : {}),
          revision,
          updatedAt,
        },
      };
      await this.saveOperation(client, input, hash, result);
      return result;
    });
  }

  private async saveOperation(
    client: PoolClient,
    input: WorkboardAuthorityWrite,
    hash: string,
    response: WorkboardAuthorityWriteResult,
  ): Promise<void> {
    await client.query(
      "INSERT INTO openclaw_workboard_operations(operation_id, request_hash, response, created_at) VALUES ($1, $2, $3::jsonb, $4)",
      [input.operationId, hash, JSON.stringify(response), Date.now()],
    );
  }
}
