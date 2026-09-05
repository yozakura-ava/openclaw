import { deriveIdempotencyKey, deriveWorkflowId } from "@openclaw/execution-contract";
import { describe, expect, it } from "vitest";
import { createDbosAuthorityServer, signDbosRequest } from "./authority-server.js";
import type { DbosAuthorityBackend } from "./authority.js";
import { PostgresDbosClient } from "./dbos.js";

function backend(): DbosAuthorityBackend {
  return {
    admit: async (input) => ({
      workflowId: input.workflowId,
      idempotencyKey: input.idempotencyKey,
      cardId: input.cardId,
      queue: input.queue,
      runId: input.runId,
      attemptId: input.attemptId,
      ownerEpoch: input.ownerEpoch,
      acknowledgedAt: 1_000,
      operationKey: input.operationKey,
      state: "admitted",
      serverTimestamp: 1_000,
    }),
    start: async (workflowId, _epoch, operationKey) => ({
      workflowId,
      idempotencyKey: "openclaw:key",
      cardId: "card-1",
      queue: "workboard",
      runId: "run-1",
      attemptId: "attempt-1",
      ownerEpoch: "epoch-1",
      state: "running",
      operationKey,
      acknowledgedAt: 1_000,
      serverTimestamp: 1_000,
    }),
    fail: async (workflowId, _detail, operationKey) => ({
      workflowId,
      idempotencyKey: "openclaw:key",
      cardId: "card-1",
      queue: "workboard",
      runId: "run-1",
      attemptId: "attempt-1",
      ownerEpoch: "epoch-1",
      state: "failed",
      operationKey,
      acknowledgedAt: 1_000,
      serverTimestamp: 1_000,
    }),
    complete: async (workflowId, _evidence, operationKey) => ({
      workflowId,
      idempotencyKey: "openclaw:key",
      cardId: "card-1",
      queue: "workboard",
      runId: "run-1",
      attemptId: "attempt-1",
      ownerEpoch: "epoch-1",
      state: "succeeded",
      operationKey,
      acknowledgedAt: 1_000,
      serverTimestamp: 1_000,
    }),
    findActiveByCardId: async (cardId) =>
      cardId === "active-card" ? "dbos:run-active" : undefined,
    health: async () => true,
  };
}

describe("authenticated DBOS authority boundary", () => {
  it("accepts signed requests, rejects replay, and serves readiness", async () => {
    const server = createDbosAuthorityServer({
      backend: backend(),
      sharedSecret: "secret",
      now: () => 1_000,
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("authority did not bind");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const identity = { cardId: "card-1", queue: "workboard", runId: "run-1" } as const;
    const client = new PostgresDbosClient({
      baseUrl,
      sharedSecret: "secret",
      allowedHosts: ["127.0.0.1"],
      clock: () => 1_000,
      maxRetries: 0,
    });
    await expect(
      client.admit({
        ...identity,
        attemptId: "attempt-1",
        idempotencyKey: deriveIdempotencyKey(identity),
        ownerEpoch: "epoch-1",
        envelope: {
          ...identity,
          attemptId: "attempt-1",
          idempotencyKey: deriveIdempotencyKey(identity),
          workflowId: deriveWorkflowId(identity),
          sourceIdentity: "source",
          artifactIdentity: "artifact",
          ownerEpoch: "epoch-1",
          allowedFiles: ["src/a.ts"],
          targetFiles: ["src/a.ts"],
          acceptanceCriteria: ["tests pass"],
          verificationCommand: "pnpm test",
          artifactPath: "artifact.bin",
          admissionTimestamp: 1_000,
        },
      }),
    ).resolves.toMatchObject({ workflowId: deriveWorkflowId(identity) });
    await expect(fetch(`${baseUrl}/ready`)).resolves.toMatchObject({ status: 200 });
    await expect(client.findActiveByCardId("active-card", "workboard")).resolves.toBe(
      "dbos:run-active",
    );
    await expect(client.findActiveByCardId("idle-card", "workboard")).resolves.toBeUndefined();

    const operationKey = "openclaw:dbos-operation:" + "a".repeat(64);
    const body = JSON.stringify({ ownerEpoch: "epoch-1", operationKey });
    const timestamp = "1000";
    const nonce = "fixed-nonce";
    const signature = signDbosRequest(
      "secret",
      "POST",
      `/v1/workflows/${encodeURIComponent(deriveWorkflowId(identity))}/start`,
      timestamp,
      nonce,
      body,
    );
    const headers = {
      "content-type": "application/json",
      "x-dbos-timestamp": timestamp,
      "x-dbos-nonce": nonce,
      "x-dbos-signature": signature,
    };
    const firstStart = await fetch(
      `${baseUrl}/v1/workflows/${encodeURIComponent(deriveWorkflowId(identity))}/start`,
      {
        method: "POST",
        headers,
        body,
      },
    );
    expect(firstStart.status).toBe(200);
    const firstStartValue = await firstStart.json();
    expect(firstStartValue).toMatchObject({
      acknowledgement: {
        workflowId: deriveWorkflowId(identity),
        state: "running",
        operationKey,
      },
    });
    const replayStart = await fetch(
      `${baseUrl}/v1/workflows/${encodeURIComponent(deriveWorkflowId(identity))}/start`,
      {
        method: "POST",
        headers,
        body,
      },
    );
    expect(replayStart.status).toBe(401);
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  });

  it("fails closed when the replay nonce cache reaches its bounded cap", async () => {
    const server = createDbosAuthorityServer({
      backend: backend(),
      sharedSecret: "secret",
      maxReplayNonces: 1,
      now: () => 1_000,
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("authority did not bind");
    }
    const pathName = "/v1/workflows/dbos:test/start";
    const body = JSON.stringify({
      ownerEpoch: "epoch-1",
      operationKey: "openclaw:dbos-operation:" + "b".repeat(64),
    });
    const send = async (nonce: string) => {
      const timestamp = "1000";
      const signature = signDbosRequest("secret", "POST", pathName, timestamp, nonce, body);
      return await fetch(`http://127.0.0.1:${address.port}${pathName}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-dbos-timestamp": timestamp,
          "x-dbos-nonce": nonce,
          "x-dbos-signature": signature,
        },
        body,
      });
    };
    await expect(send("nonce-1")).resolves.toMatchObject({ status: 200 });
    await expect(send("nonce-2")).resolves.toMatchObject({ status: 401 });
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  });
});
