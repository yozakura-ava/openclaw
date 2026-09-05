import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deriveIdempotencyKey, deriveWorkflowId } from "@openclaw/execution-contract";
import { describe, expect, it } from "vitest";
import {
  createProductionDbosAuthority,
  DbosRuntime,
  PostgresDbosClient,
  requireDbosReceipt,
} from "./dbos.js";

function makeRuntime() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-dbos-"));
  return {
    runtime: new DbosRuntime({ dbPath: path.join(dir, "dbos.sqlite"), now: () => 1000 }),
    dir,
  };
}

function input(runId = "run-1") {
  const identity = { cardId: "card-1", queue: "workboard", runId } as const;
  return {
    ...identity,
    attemptId: "attempt-1",
    idempotencyKey: deriveIdempotencyKey(identity),
    ownerEpoch: "epoch-1",
  };
}

describe("durable DBOS runtime", () => {
  it("queries the authenticated PostgreSQL authority for active card runs", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const client = new PostgresDbosClient({
      baseUrl: "https://dbos.test",
      fetchImpl: async (url, init) => {
        calls.push({
          url: String(url),
          body: JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<
            string,
            unknown
          >,
        });
        return new Response(JSON.stringify({ runId: "dbos:run-active" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    await expect(client.findActiveByCardId("card-1", "workboard")).resolves.toBe("dbos:run-active");
    expect(calls[0]).toMatchObject({
      url: "https://dbos.test/v1/workflows/active",
      body: { cardId: "card-1", queue: "workboard" },
    });
  });

  it("requires a systemd credential for the production authority", () => {
    expect(() =>
      createProductionDbosAuthority({
        OPENCLAW_DBOS_URL: "http://127.0.0.1:8787",
        OPENCLAW_DBOS_HMAC_SECRET: "legacy-environment-secret",
      }),
    ).toThrow("systemd-loaded HMAC credential");
  });

  it("fails closed without PostgreSQL authority and validates remote receipt identity", async () => {
    const missing = new PostgresDbosClient({ env: {} });
    await expect(missing.admit(input())).rejects.toThrow("SQLite fallback is disabled");
    const calls: string[] = [];
    const client = new PostgresDbosClient({
      baseUrl: "https://dbos.test",
      fetchImpl: async (url, init) => {
        const urlText =
          typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
        const body = typeof init?.body === "string" ? init.body : "{}";
        calls.push(`${urlText} ${init?.method ?? ""}`);
        const request = JSON.parse(body) as { operationKey?: string };
        return new Response(
          JSON.stringify({
            receipt: {
              workflowId: "dbos:bad",
              idempotencyKey: input().idempotencyKey,
              cardId: "card-1",
              queue: "workboard",
              runId: "run-1",
              attemptId: "attempt-1",
              ownerEpoch: "epoch-1",
              acknowledgedAt: 1000,
              operationKey: request.operationKey,
              state: "admitted",
              serverTimestamp: 1000,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    await expect(client.admit(input())).rejects.toThrow("identity mismatch");
    expect(calls).toEqual(["https://dbos.test/v1/workflows/admit POST"]);
  });

  it("rejects a forged idempotency key before making a remote enqueue request", async () => {
    let calls = 0;
    const client = new PostgresDbosClient({
      baseUrl: "https://dbos.test",
      fetchImpl: async () => {
        calls += 1;
        return new Response("{}", { status: 200 });
      },
    });
    await expect(client.admit({ ...input(), idempotencyKey: "forged" })).rejects.toThrow(
      "idempotency key mismatch",
    );
    expect(calls).toBe(0);
  });

  it("rejects a forged lifecycle acknowledgement identity", async () => {
    const client = new PostgresDbosClient({
      baseUrl: "https://dbos.test",
      fetchImpl: async (_url, init) => {
        const body = typeof init?.body === "string" ? init.body : "{}";
        const request = JSON.parse(body) as { operationKey?: string };
        return new Response(
          JSON.stringify({
            acknowledgement: {
              workflowId: deriveWorkflowId({
                cardId: "card-1",
                queue: "workboard",
                runId: "run-1",
              }),
              idempotencyKey: "forged-idempotency-key",
              cardId: "card-1",
              queue: "workboard",
              runId: "run-1",
              attemptId: "attempt-1",
              ownerEpoch: "epoch-1",
              operationKey: request.operationKey,
              state: "running",
              serverTimestamp: 1000,
            },
          }),
          { status: 200 },
        );
      },
    });
    await expect(
      client.start(
        deriveWorkflowId({ cardId: "card-1", queue: "workboard", runId: "run-1" }),
        "epoch-1",
      ),
    ).rejects.toThrow("identity or state mismatch");
  });

  it("derives one deterministic workflow identity and acknowledges only committed rows", () => {
    const { runtime } = makeRuntime();
    const first = runtime.admit(input());
    expect(runtime.admit(input())).toEqual(first);
    expect(first.workflowId).toMatch(/^dbos:/);
    expect(() => requireDbosReceipt(undefined)).toThrow("fallback is disabled");
    runtime.close();
  });

  it("enforces the two-worker limit and blocks unsafe retry", () => {
    const { runtime } = makeRuntime();
    const first = runtime.admit(input("run-1"));
    const second = runtime.admit(input("run-2"));
    const third = runtime.admit(input("run-3"));
    runtime.start(first.workflowId, "epoch-1");
    runtime.start(second.workflowId, "epoch-1");
    expect(() => runtime.start(third.workflowId, "epoch-1")).toThrow("two-worker");
    expect(() =>
      runtime.retry(first.workflowId, "attempt-2", {
        ownedChild: true,
        lease: false,
        lock: false,
        port: false,
        descriptor: false,
        unresolvedExternalHandoff: false,
      }),
    ).toThrow("resources");
    runtime.close();
  });

  it("reconciles without mutating durable state and records failed executions", async () => {
    const { runtime } = makeRuntime();
    const receipt = runtime.admit(input());
    await expect(
      runtime.execute(receipt.workflowId, "epoch-1", async () => {
        throw new Error("injected crash");
      }),
    ).rejects.toThrow("injected crash");
    expect(runtime.get(receipt.workflowId)?.state).toBe("failed");
    expect(
      runtime.reconcile([
        { cardId: "card-1", queue: "workboard", runId: "run-1", state: "running" },
      ]),
    ).toEqual([expect.objectContaining({ kind: "conflicting" })]);
    expect(
      runtime.reconcile([
        { cardId: "unknown", queue: "workboard", runId: "run-x", state: "running" },
      ]),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "unknown" }),
        expect.objectContaining({ kind: "orphaned" }),
      ]),
    );
    expect(() =>
      runtime.retry(receipt.workflowId, "attempt-2", {
        ownedChild: false,
        lease: false,
        lock: false,
        port: false,
        descriptor: false,
        unresolvedExternalHandoff: false,
      }),
    ).not.toThrow();
    runtime.close();
  });

  it("retries transient PostgreSQL failures with bounded backoff", async () => {
    let calls = 0;
    const delays: number[] = [];
    const client = new PostgresDbosClient({
      baseUrl: "https://dbos.test",
      initialBackoffMs: 7,
      maxRetries: 2,
      sleep: async (delay) => {
        delays.push(delay);
      },
      fetchImpl: async (_url, init) => {
        calls += 1;
        if (calls === 1) {
          return new Response(JSON.stringify({ error: "busy" }), { status: 503 });
        }
        const body = typeof init?.body === "string" ? init.body : "{}";
        const request = JSON.parse(body) as { operationKey?: string };
        return new Response(
          JSON.stringify({
            receipt: {
              workflowId: "dbos:" + "0".repeat(64),
              idempotencyKey: input().idempotencyKey,
              cardId: "card-1",
              queue: "workboard",
              runId: "run-1",
              attemptId: "attempt-1",
              ownerEpoch: "epoch-1",
              acknowledgedAt: 1000,
              operationKey: request.operationKey,
              state: "admitted",
              serverTimestamp: 1000,
            },
          }),
          { status: 200 },
        );
      },
    });
    await expect(client.admit(input())).rejects.toThrow("identity mismatch");
    expect(calls).toBe(2);
    expect(delays).toEqual([7]);
  });

  it("classifies an authority timeout explicitly", async () => {
    const client = new PostgresDbosClient({
      baseUrl: "https://dbos.test",
      timeoutMs: 1,
      maxRetries: 0,
      fetchImpl: () => new Promise<Response>(() => {}),
    });
    await expect(client.admit(input())).rejects.toMatchObject({ kind: "timeout", retryable: true });
  });
});
