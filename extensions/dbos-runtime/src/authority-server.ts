// Authenticated HTTP boundary for the PostgreSQL DBOS authority.
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { URL } from "node:url";
import {
  deriveIdempotencyKey,
  deriveWorkflowId,
  requireNonEmpty,
} from "@openclaw/execution-contract";
import { validateAdmissionEnvelope, type DbosAuthorityBackend } from "./authority.js";
import type { WorkboardAuthorityBackend } from "./workboard-authority.js";
export { loadDbosSharedSecret, signDbosRequest } from "./authority-auth.js";

export type DbosAuthorityServerOptions = {
  backend: DbosAuthorityBackend;
  workboard?: WorkboardAuthorityBackend;
  sharedSecret: string;
  allowedHosts?: readonly string[];
  maxBodyBytes?: number;
  replayWindowMs?: number;
  maxReplayNonces?: number;
  now?: () => number;
};

async function readBody(request: IncomingMessage, limit: number): Promise<string> {
  let total = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += value.length;
    if (total > limit) {
      throw new Error("request body is too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function jsonResponse(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

export function createDbosAuthorityServer(options: DbosAuthorityServerOptions): Server {
  const secret = requireNonEmpty(options.sharedSecret, "DBOS HMAC secret");
  const allowedHosts = new Set(
    (options.allowedHosts ?? ["127.0.0.1", "localhost", "::1"]).map((host) => host.toLowerCase()),
  );
  const replayWindowMs = Math.max(1_000, options.replayWindowMs ?? 30_000);
  const maxReplayNonces = Math.max(
    1,
    Math.min(100_000, Math.trunc(options.maxReplayNonces ?? 10_000)),
  );
  // Workboard attachment values are bounded at 256 KiB before base64/JSON
  // framing. Keep enough headroom for that encoded payload and its authority
  // envelope while retaining a bounded request body.
  const maxBodyBytes = Math.max(1024, options.maxBodyBytes ?? 512 * 1024);
  const now = options.now ?? Date.now;
  const nonces = new Map<string, number>();

  const authenticate = (request: IncomingMessage, body: string, pathName: string): void => {
    const host = ((request.headers.host ?? "").split(":", 1)[0] ?? "").toLowerCase();
    if (!allowedHosts.has(host)) {
      throw new Error("DBOS host is not allowlisted");
    }
    const timestamp = requireNonEmpty(
      request.headers["x-dbos-timestamp"],
      "DBOS request timestamp",
    );
    const nonce = requireNonEmpty(request.headers["x-dbos-nonce"], "DBOS request nonce");
    const signature = requireNonEmpty(
      request.headers["x-dbos-signature"],
      "DBOS request signature",
    );
    const numericTimestamp = Number(timestamp);
    if (
      !Number.isSafeInteger(numericTimestamp) ||
      Math.abs(now() - numericTimestamp) > replayWindowMs
    ) {
      throw new Error("DBOS request timestamp is outside replay window");
    }
    for (const [key, value] of nonces) {
      if (Math.abs(now() - value) > replayWindowMs) {
        nonces.delete(key);
      }
    }
    if (nonces.has(nonce)) {
      throw new Error("DBOS request nonce was replayed");
    }
    if (nonces.size >= maxReplayNonces) {
      throw new Error("DBOS replay nonce cache is full");
    }
    const expected = createHmac("sha256", secret)
      .update(`${request.method}\n${pathName}\n${timestamp}\n${nonce}\n${body}`)
      .digest("hex");
    const expectedBuffer = Buffer.from(expected, "utf8");
    const providedBuffer = Buffer.from(signature, "utf8");
    if (
      expectedBuffer.length !== providedBuffer.length ||
      !timingSafeEqual(expectedBuffer, providedBuffer)
    ) {
      throw new Error("DBOS request signature is invalid");
    }
    nonces.set(nonce, numericTimestamp);
  };

  return createServer((request, response) => {
    void (async () => {
      const pathName = new URL(request.url ?? "/", "http://localhost").pathname;
      if (request.method === "GET" && pathName === "/health") {
        return jsonResponse(response, 200, { ok: true });
      }
      if (request.method === "GET" && pathName === "/ready") {
        try {
          await options.backend.health();
          await options.workboard?.health();
          return jsonResponse(response, 200, { ready: true });
        } catch (error) {
          return jsonResponse(response, 503, {
            ready: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (
        request.method !== "POST" ||
        !(
          pathName === "/v1/workflows/admit" ||
          /^\/v1\/workflows\/[^/]+\/(start|fail|complete)$/.test(pathName) ||
          /^\/v1\/workboard\/(read|list|write)$/.test(pathName)
        )
      ) {
        return jsonResponse(response, 404, { error: "not found" });
      }
      try {
        const body = await readBody(request, maxBodyBytes);
        authenticate(request, body, pathName);
        const input = JSON.parse(body) as Record<string, unknown>;
        if (pathName.startsWith("/v1/workboard/")) {
          if (!options.workboard) {
            throw new Error("Workboard PostgreSQL authority is not configured");
          }
          const namespace = requireNonEmpty(input.namespace, "Workboard namespace");
          if (pathName.endsWith("/read")) {
            const key = requireNonEmpty(input.key, "Workboard key");
            return jsonResponse(response, 200, {
              record: await options.workboard.read(namespace, key),
            });
          }
          if (pathName.endsWith("/list")) {
            return jsonResponse(response, 200, {
              records: await options.workboard.list(namespace),
            });
          }
          const operationId = requireNonEmpty(input.operationId, "Workboard operation id");
          const mode = input.mode;
          if (mode !== "insert" && mode !== "upsert" && mode !== "delete" && mode !== "claim") {
            throw new Error("Workboard write mode is invalid");
          }
          return jsonResponse(response, 200, {
            result: await options.workboard.write({
              operationId,
              namespace,
              key: requireNonEmpty(input.key, "Workboard key"),
              mode,
              value: input.value,
              ...(typeof input.expectedUpdatedAt === "number"
                ? { expectedUpdatedAt: input.expectedUpdatedAt }
                : {}),
              ...(typeof input.ownerId === "string" ? { ownerId: input.ownerId } : {}),
              ...(typeof input.now === "number" ? { now: input.now } : {}),
              ...(typeof input.maxConcurrentClaims === "number"
                ? { maxConcurrentClaims: input.maxConcurrentClaims }
                : {}),
            }),
          });
        }
        const operationKey = requireNonEmpty(
          input.operationKey ?? input.idempotencyKey,
          "DBOS operation key",
        );
        if (!/^openclaw:dbos-operation:[0-9a-f]{64}$/.test(operationKey)) {
          throw new Error("DBOS operation key format is invalid");
        }
        const operation = pathName.split("/").at(-1);
        if (operation === "admit") {
          const identity = {
            cardId: requireNonEmpty(input.cardId, "cardId"),
            queue: requireNonEmpty(input.queue, "queue"),
            runId: requireNonEmpty(input.runId, "runId"),
          } as const;
          const attemptId = requireNonEmpty(input.attemptId, "attemptId");
          const idempotencyKey = requireNonEmpty(input.idempotencyKey, "idempotencyKey");
          const workflowId = requireNonEmpty(input.workflowId, "workflowId");
          const ownerEpoch = requireNonEmpty(input.ownerEpoch, "ownerEpoch");
          if (
            workflowId !== deriveWorkflowId(identity) ||
            idempotencyKey !== deriveIdempotencyKey(identity)
          ) {
            throw new Error("DBOS admission identity mismatch");
          }
          const envelope = validateAdmissionEnvelope(
            input.envelope,
            identity,
            attemptId,
            idempotencyKey,
            workflowId,
            ownerEpoch,
          );
          const receipt = await options.backend.admit({
            ...identity,
            attemptId,
            idempotencyKey,
            ownerEpoch,
            workflowId,
            operationKey,
            envelope,
          });
          return jsonResponse(response, 200, { receipt });
        }
        const workflowId = decodeURIComponent(pathName.split("/")[3] ?? "");
        const ack =
          operation === "start"
            ? await options.backend.start(
                workflowId,
                requireNonEmpty(input.ownerEpoch, "ownerEpoch"),
                operationKey,
              )
            : operation === "fail"
              ? await options.backend.fail(
                  workflowId,
                  requireNonEmpty(input.detail, "detail"),
                  operationKey,
                )
              : await options.backend.complete(workflowId, input.evidence, operationKey);
        return jsonResponse(response, 200, { acknowledgement: ack });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const status = /authentication|signature|nonce|host allowlist/i.test(detail)
          ? 401
          : /timeout|temporar|connection|deadlock|serialization|capacity limit/i.test(detail)
            ? 503
            : /conflict|identity mismatch|not found|cannot /i.test(detail)
              ? 409
              : 400;
        return jsonResponse(response, status, {
          error: detail,
        });
      }
    })();
  });
}
