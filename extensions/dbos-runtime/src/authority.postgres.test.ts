import crypto from "node:crypto";
import fs from "node:fs";
import { deriveIdempotencyKey, deriveWorkflowId } from "@openclaw/execution-contract";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PostgresDbosAuthorityBackend, type DbosAuthorityBackend } from "./authority.js";

const livePostgres =
  process.env.OPENCLAW_DBOS_POSTGRES_TEST === "1" &&
  typeof process.env.OPENCLAW_DBOS_POSTGRES_TEST_URL === "string";
const postgresTestConnection = {
  connectionString: process.env.OPENCLAW_DBOS_POSTGRES_TEST_URL,
  ...(process.env.OPENCLAW_DBOS_POSTGRES_TEST_PASSWORD_FILE
    ? {
        password: fs
          .readFileSync(process.env.OPENCLAW_DBOS_POSTGRES_TEST_PASSWORD_FILE, "utf8")
          .trim(),
      }
    : process.env.OPENCLAW_DBOS_POSTGRES_TEST_PASSWORD
      ? { password: process.env.OPENCLAW_DBOS_POSTGRES_TEST_PASSWORD }
      : {}),
};

type TestInput = Parameters<DbosAuthorityBackend["admit"]>[0];

function input(overrides: Partial<TestInput> = {}): TestInput {
  const identity = {
    cardId: "postgres-card",
    queue: "postgres-test",
    runId: "postgres-run",
  } as const;
  const resolvedIdentity = {
    cardId: overrides.cardId ?? identity.cardId,
    queue: overrides.queue ?? identity.queue,
    runId: overrides.runId ?? identity.runId,
  } as const;
  const attemptId = overrides.attemptId ?? "postgres-attempt";
  const idempotencyKey = overrides.idempotencyKey ?? deriveIdempotencyKey(resolvedIdentity);
  const workflowId = overrides.workflowId ?? deriveWorkflowId(resolvedIdentity);
  const envelope = overrides.envelope ?? {
    ...resolvedIdentity,
    attemptId,
    idempotencyKey,
    workflowId,
    ownerEpoch: overrides.ownerEpoch ?? "postgres-epoch",
    sourceIdentity: "source:postgres-test",
    artifactIdentity: "artifact:postgres-test",
    allowedFiles: ["extensions/dbos-runtime/src/authority.ts"],
    targetFiles: ["extensions/dbos-runtime/src/authority.ts"],
    acceptanceCriteria: ["postgres authority test passes"],
    verificationCommand: "pnpm test extensions/dbos-runtime/src/authority.test.ts",
    admissionTimestamp: 1_000,
  };
  return {
    ...resolvedIdentity,
    attemptId,
    idempotencyKey,
    workflowId,
    ownerEpoch: overrides.ownerEpoch ?? "postgres-epoch",
    operationKey: overrides.operationKey ?? "openclaw:postgres-admit",
    envelope,
    ...overrides,
  };
}

describe.skipIf(!livePostgres)("PostgreSQL DBOS authority admission", () => {
  const schema = `authority_test_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new Pool(postgresTestConnection);
  const pool = new Pool({
    ...postgresTestConnection,
    options: `-c search_path=${schema},public`,
    max: 12,
  });
  const execute = vi.fn().mockResolvedValue(undefined);
  const sdk = {
    launch: vi.fn(),
    execute,
    status: vi.fn(),
    health: vi.fn().mockResolvedValue(true),
    shutdown: vi.fn(),
  };
  let backend: PostgresDbosAuthorityBackend;

  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    backend = new PostgresDbosAuthorityBackend(pool, sdk);
    await backend.migrate();
  });

  beforeEach(async () => {
    execute.mockClear();
    await pool.query("TRUNCATE openclaw_dbos_operations, openclaw_dbos_workflows CASCADE");
  });

  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  it("linearizes concurrent exact replays and persists one receipt", async () => {
    const requests = Array.from({ length: 8 }, () => backend.admit(input()));
    const receipts = await Promise.all(requests);
    expect(new Set(receipts.map((receipt) => receipt.workflowId)).size).toBe(1);
    expect(new Set(receipts.map((receipt) => receipt.idempotencyKey)).size).toBe(1);
    expect(execute).toHaveBeenCalledTimes(1);
    await expect(
      pool.query("SELECT COUNT(*)::int AS count FROM openclaw_dbos_workflows"),
    ).resolves.toMatchObject({ rows: [{ count: 1 }] });
    await expect(
      pool.query("SELECT COUNT(*)::int AS count FROM openclaw_dbos_operations"),
    ).resolves.toMatchObject({ rows: [{ count: 1 }] });
  });

  it("rejects a legacy idempotency collision as a conflict, not a raw unique error", async () => {
    const value = input({});
    const legacyWorkflowId = "dbos:legacy-collision";
    await pool.query(
      "INSERT INTO openclaw_dbos_workflows(workflow_id,idempotency_key,card_id,queue,run_id,attempt_id,owner_epoch,state,acknowledged_at,updated_at,sdk_workflow_id,admission_hash) VALUES($1,$2,$3,$4,$5,$6,$7,'admitted',$8,$8,$1,NULL)",
      [
        legacyWorkflowId,
        value.idempotencyKey,
        "legacy-card",
        value.queue,
        "legacy-run",
        "legacy-attempt",
        "legacy-epoch",
        1_000,
      ],
    );
    await expect(backend.admit(value)).rejects.toThrow("conflicting DBOS admission identity");
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not project an admission when the SDK command fails, then succeeds on retry", async () => {
    const value = input({
      cardId: "fault-card",
      runId: "fault-run",
      operationKey: "openclaw:fault-admit",
    });
    execute.mockRejectedValueOnce(new Error("injected SDK failure"));
    await expect(backend.admit(value)).rejects.toThrow("injected SDK failure");
    await expect(
      pool.query("SELECT COUNT(*)::int AS count FROM openclaw_dbos_workflows WHERE card_id = $1", [
        value.cardId,
      ]),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
    await expect(backend.admit(value)).resolves.toMatchObject({
      workflowId: value.workflowId,
      idempotencyKey: value.idempotencyKey,
    });
  });
});
