import crypto from "node:crypto";
import fs from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PostgresWorkboardAuthorityBackend } from "./workboard-authority.js";

const livePostgres =
  process.env.OPENCLAW_DBOS_WORKBOARD_TEST === "1" &&
  typeof process.env.OPENCLAW_DBOS_WORKBOARD_TEST_URL === "string";

function connection() {
  return {
    connectionString: process.env.OPENCLAW_DBOS_WORKBOARD_TEST_URL,
    ...(process.env.OPENCLAW_DBOS_WORKBOARD_TEST_PASSWORD_FILE
      ? {
          password: fs
            .readFileSync(process.env.OPENCLAW_DBOS_WORKBOARD_TEST_PASSWORD_FILE, "utf8")
            .trim(),
        }
      : process.env.OPENCLAW_DBOS_WORKBOARD_TEST_PASSWORD
        ? { password: process.env.OPENCLAW_DBOS_WORKBOARD_TEST_PASSWORD }
        : {}),
  };
}

describe.skipIf(!livePostgres)("PostgreSQL Workboard authority", () => {
  const schema = `workboard_authority_test_${crypto.randomUUID().replaceAll("-", "")}`;
  let admin: Pool;
  let pool: Pool;
  let backend: PostgresWorkboardAuthorityBackend;

  beforeAll(async () => {
    const config = connection();
    admin = new Pool(config);
    pool = new Pool({ ...config, options: `-c search_path=${schema},public` });
    backend = new PostgresWorkboardAuthorityBackend(pool);
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await backend.migrate();
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE openclaw_workboard_operations, openclaw_workboard_records");
  });

  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  it("keeps duplicate writes idempotent and enforces compare-and-set", async () => {
    const first = await backend.write({
      operationId: "operation-1",
      namespace: "cards",
      key: "card-1",
      value: { card: { id: "card-1" } },
      mode: "insert",
    });
    expect(first.applied).toBe(true);
    await expect(
      backend.write({
        operationId: "operation-1",
        namespace: "cards",
        key: "card-1",
        value: { card: { id: "card-1" } },
        mode: "insert",
      }),
    ).resolves.toEqual(first);
    await expect(
      backend.write({
        operationId: "operation-2",
        namespace: "cards",
        key: "card-1",
        value: { card: { id: "card-1", changed: true } },
        mode: "upsert",
        expectedUpdatedAt: 1,
      }),
    ).resolves.toMatchObject({ applied: false, result: "conflict" });
  });

  it("retains a tombstone so an old SQLite projection cannot resurrect a delete", async () => {
    const created = await backend.write({
      operationId: "operation-create",
      namespace: "cards",
      key: "card-delete",
      value: { card: { id: "card-delete" } },
      mode: "insert",
    });
    await expect(
      backend.write({
        operationId: "operation-delete",
        namespace: "cards",
        key: "card-delete",
        mode: "delete",
        expectedUpdatedAt: created.record.updatedAt,
      }),
    ).resolves.toMatchObject({ applied: true });
    await expect(backend.read("cards", "card-delete")).resolves.toMatchObject({
      found: true,
      deleted: true,
    });
    await expect(backend.list("cards")).resolves.toEqual([]);
  });
});
