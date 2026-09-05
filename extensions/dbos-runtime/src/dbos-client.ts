import { createHash, randomBytes } from "node:crypto";
import { URL } from "node:url";
import {
  deriveIdempotencyKey,
  deriveWorkflowId,
  requireNonEmpty,
  stableJson,
  type AdmissionEnvelope,
  type AdmissionGate,
} from "@openclaw/execution-contract";
import { loadDbosSharedSecret, signDbosRequest } from "./authority-auth.js";
import type { DbosAuthority, DbosReceipt, DbosWorkflowInput } from "./authority-types.js";
import { DBOS_QUEUE_CONCURRENCY } from "./dbos-constants.js";
import { DbosRequestError, DbosRuntimeError } from "./dbos-errors.js";

export function requireDbosReceipt(receipt: DbosReceipt | undefined): DbosReceipt {
  if (!receipt) {
    throw new DbosRuntimeError("DBOS admission receipt is required; gateway fallback is disabled");
  }
  for (const key of [
    "workflowId",
    "idempotencyKey",
    "cardId",
    "queue",
    "runId",
    "attemptId",
    "ownerEpoch",
  ] as const) {
    if (typeof receipt[key] !== "string" || receipt[key].trim() === "") {
      throw new DbosRuntimeError(`DBOS admission receipt ${key} is invalid`);
    }
  }
  if (!Number.isFinite(receipt.acknowledgedAt) || receipt.acknowledgedAt <= 0) {
    throw new DbosRuntimeError("DBOS admission receipt timestamp is invalid");
  }
  return receipt;
}

export type DbosHttpClientOptions = {
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  gate?: AdmissionGate;
  timeoutMs?: number;
  maxRetries?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
  sharedSecret?: string;
  allowedHosts?: readonly string[];
  clock?: () => number;
  requireAuthentication?: boolean;
};

/**
 * Thin adapter for the PostgreSQL-backed DBOS services. The service owns the
 * durable workflow row, retries, and worker limit; this client never falls
 * back to SQLite or local process state.
 */
export class PostgresDbosClient implements DbosAuthority {
  private readonly baseUrl?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly gate?: AdmissionGate;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly sleep: (delayMs: number) => Promise<void>;
  private readonly sharedSecret?: string;
  private readonly allowedHosts?: Set<string>;
  private readonly clock: () => number;
  private readonly requireAuthentication: boolean;

  constructor(options: DbosHttpClientOptions = {}) {
    const env = options.env ?? process.env;
    this.baseUrl = (options.baseUrl ?? env.OPENCLAW_DBOS_URL ?? env.DBOS_URL)?.replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.gate = options.gate;
    this.timeoutMs = Math.max(1, Math.trunc(options.timeoutMs ?? 10_000));
    this.maxRetries = Math.max(0, Math.min(5, Math.trunc(options.maxRetries ?? 2)));
    this.initialBackoffMs = Math.max(1, Math.trunc(options.initialBackoffMs ?? 100));
    this.maxBackoffMs = Math.max(this.initialBackoffMs, Math.trunc(options.maxBackoffMs ?? 2_000));
    this.sleep =
      options.sleep ??
      ((delayMs) =>
        new Promise((resolve) => {
          setTimeout(resolve, delayMs);
        }));
    this.sharedSecret = options.sharedSecret?.trim() || env.OPENCLAW_DBOS_HMAC_SECRET?.trim();
    this.allowedHosts = options.allowedHosts
      ? new Set(options.allowedHosts.map((host) => host.toLowerCase()))
      : undefined;
    this.clock = options.clock ?? Date.now;
    this.requireAuthentication = options.requireAuthentication ?? false;
    if (this.baseUrl && this.requireAuthentication && !this.sharedSecret) {
      throw new DbosRuntimeError("DBOS authority authentication credential is required");
    }
    if (this.baseUrl) {
      const parsed = new URL(this.baseUrl);
      if (
        !(
          parsed.protocol === "https:" ||
          (parsed.protocol === "http:" &&
            ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname))
        )
      ) {
        throw new DbosRuntimeError("DBOS authority URL must use HTTPS or loopback HTTP");
      }
      if (parsed.username || parsed.password || parsed.search || parsed.hash) {
        throw new DbosRuntimeError(
          "DBOS authority URL contains unsupported credentials or query state",
        );
      }
      if (this.allowedHosts && !this.allowedHosts.has(parsed.hostname.toLowerCase())) {
        throw new DbosRuntimeError("DBOS authority host is not allowlisted");
      }
    }
  }

  private configured(): string {
    if (!this.baseUrl) {
      throw new DbosRuntimeError(
        "PostgreSQL DBOS authority is not configured; SQLite fallback is disabled",
      );
    }
    return this.baseUrl;
  }

  private async request<T>(pathName: string, body: unknown): Promise<T> {
    let attempt = 0;
    while (true) {
      const controller = new AbortController();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const bodyText = JSON.stringify(body);
        const timestamp = String(this.clock());
        const nonce = randomBytes(16).toString("hex");
        const headers: Record<string, string> = {
          "content-type": "application/json",
          accept: "application/json",
        };
        if (this.sharedSecret) {
          headers["x-dbos-timestamp"] = timestamp;
          headers["x-dbos-nonce"] = nonce;
          headers["x-dbos-signature"] = signDbosRequest(
            this.sharedSecret,
            "POST",
            pathName,
            timestamp,
            nonce,
            bodyText,
          );
        }
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            controller.abort();
            reject(
              new DbosRequestError(
                `DBOS authority request timed out after ${this.timeoutMs}ms`,
                "timeout",
                true,
              ),
            );
          }, this.timeoutMs);
        });
        const response = await Promise.race([
          this.fetchImpl(`${this.configured()}${pathName}`, {
            method: "POST",
            headers,
            body: bodyText,
            redirect: "error",
            signal: controller.signal,
          }),
          timeoutPromise,
        ]);
        let payload: unknown;
        try {
          payload = await Promise.race([response.json(), timeoutPromise]);
        } catch (error) {
          if (error instanceof DbosRequestError) {
            throw error;
          }
          throw new DbosRequestError(
            `DBOS authority returned non-JSON response (${response.status})`,
            "http",
            false,
          );
        }
        if (!response.ok) {
          const retryable =
            response.status === 408 ||
            response.status === 425 ||
            response.status === 429 ||
            response.status >= 500;
          const detail =
            payload && typeof payload === "object" && "error" in payload
              ? String((payload as { error: unknown }).error)
              : response.statusText;
          throw new DbosRequestError(
            `DBOS authority rejected request: ${detail}`,
            "http",
            retryable,
          );
        }
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
          throw new DbosRequestError("DBOS authority returned malformed JSON", "http", false);
        }
        return payload as T;
      } catch (error) {
        const failure =
          error instanceof DbosRequestError
            ? error
            : new DbosRequestError(
                `DBOS authority transport failed: ${error instanceof Error ? error.message : String(error)}`,
                "transport",
                true,
              );
        if (!failure.retryable || attempt >= this.maxRetries) {
          throw failure;
        }
        const delay = Math.min(this.maxBackoffMs, this.initialBackoffMs * 2 ** attempt);
        attempt += 1;
        await this.sleep(delay);
      } finally {
        if (timeout) {
          clearTimeout(timeout);
        }
      }
    }
  }

  async admit(input: DbosWorkflowInput & { envelope?: AdmissionEnvelope }): Promise<DbosReceipt> {
    this.gate?.assertAdmissionOpen();
    const identity = {
      cardId: requireNonEmpty(input.cardId, "DBOS cardId"),
      queue: requireNonEmpty(input.queue, "DBOS queue"),
      runId: requireNonEmpty(input.runId, "DBOS runId"),
    };
    const normalized = {
      ...input,
      ...identity,
      attemptId: requireNonEmpty(input.attemptId, "DBOS attemptId"),
      idempotencyKey: requireNonEmpty(input.idempotencyKey, "DBOS idempotency key"),
      ownerEpoch: requireNonEmpty(input.ownerEpoch, "DBOS owner epoch"),
    };
    const expectedIdempotencyKey = deriveIdempotencyKey(identity);
    if (normalized.idempotencyKey !== expectedIdempotencyKey) {
      throw new DbosRuntimeError("DBOS idempotency key mismatch; refusing remote enqueue");
    }
    const expectedWorkflowId = deriveWorkflowId(identity);
    if (
      input.envelope &&
      (input.envelope.cardId !== normalized.cardId ||
        input.envelope.queue !== normalized.queue ||
        input.envelope.runId !== normalized.runId ||
        input.envelope.attemptId !== normalized.attemptId ||
        input.envelope.idempotencyKey !== normalized.idempotencyKey ||
        input.envelope.workflowId !== expectedWorkflowId ||
        input.envelope.ownerEpoch !== normalized.ownerEpoch)
    ) {
      throw new DbosRuntimeError("DBOS envelope identity mismatch; refusing remote enqueue");
    }
    const payload = await this.request<{ receipt?: DbosReceipt } | DbosReceipt>(
      "/v1/workflows/admit",
      {
        ...normalized,
        workflowId: expectedWorkflowId,
        operationKey: this.operationKey("admit", expectedWorkflowId, normalized),
        admissionTimestamp: input.now ?? Date.now(),
        concurrency: DBOS_QUEUE_CONCURRENCY,
      },
    );
    const candidate =
      payload && typeof payload === "object" && "receipt" in payload
        ? (payload as { receipt?: DbosReceipt }).receipt
        : (payload as DbosReceipt);
    const receipt = requireDbosReceipt(candidate);
    const operationKey = this.operationKey("admit", expectedWorkflowId, normalized);
    if (
      receipt.workflowId !== expectedWorkflowId ||
      receipt.idempotencyKey !== normalized.idempotencyKey ||
      receipt.cardId !== normalized.cardId ||
      receipt.queue !== normalized.queue ||
      receipt.runId !== normalized.runId ||
      receipt.attemptId !== normalized.attemptId ||
      receipt.ownerEpoch !== normalized.ownerEpoch ||
      receipt.operationKey !== operationKey ||
      receipt.state !== "admitted" ||
      typeof receipt.serverTimestamp !== "number" ||
      !Number.isFinite(receipt.serverTimestamp) ||
      receipt.serverTimestamp <= 0
    ) {
      throw new DbosRuntimeError("DBOS acknowledgement identity mismatch");
    }
    return receipt;
  }

  async start(workflowId: string, ownerEpoch: string): Promise<unknown> {
    const operationKey = this.operationKey("start", workflowId, { ownerEpoch });
    const response = await this.request<{ acknowledgement?: unknown }>(
      `/v1/workflows/${encodeURIComponent(workflowId)}/start`,
      {
        ownerEpoch,
        operationKey,
      },
    );
    return this.requireAcknowledgement(
      response.acknowledgement,
      workflowId,
      "running",
      operationKey,
      ownerEpoch,
    );
  }

  async fail(workflowId: string, detail: string): Promise<unknown> {
    const operationKey = this.operationKey("fail", workflowId, { detail });
    const response = await this.request<{ acknowledgement?: unknown }>(
      `/v1/workflows/${encodeURIComponent(workflowId)}/fail`,
      {
        detail,
        operationKey,
      },
    );
    return this.requireAcknowledgement(
      response.acknowledgement,
      workflowId,
      "failed",
      operationKey,
    );
  }

  async complete(workflowId: string, evidence: unknown): Promise<unknown> {
    const operationKey = this.operationKey("complete", workflowId, evidence);
    const response = await this.request<{ acknowledgement?: unknown }>(
      `/v1/workflows/${encodeURIComponent(workflowId)}/complete`,
      {
        evidence,
        operationKey,
      },
    );
    return this.requireAcknowledgement(
      response.acknowledgement,
      workflowId,
      "succeeded",
      operationKey,
    );
  }

  private requireAcknowledgement(
    value: unknown,
    workflowId: string,
    state: string,
    operationKey: string,
    expectedOwnerEpoch?: string,
  ): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new DbosRuntimeError("DBOS authority returned malformed acknowledgement");
    }
    const acknowledgement = value as Record<string, unknown>;
    if (
      typeof acknowledgement.idempotencyKey !== "string" ||
      typeof acknowledgement.cardId !== "string" ||
      typeof acknowledgement.queue !== "string" ||
      typeof acknowledgement.runId !== "string" ||
      typeof acknowledgement.attemptId !== "string" ||
      typeof acknowledgement.ownerEpoch !== "string" ||
      typeof acknowledgement.serverTimestamp !== "number" ||
      !Number.isFinite(acknowledgement.serverTimestamp) ||
      acknowledgement.serverTimestamp <= 0
    ) {
      throw new DbosRuntimeError("DBOS acknowledgement identity or state mismatch");
    }
    const ackIdentity = {
      cardId: acknowledgement.cardId,
      queue: acknowledgement.queue,
      runId: acknowledgement.runId,
    };
    if (
      acknowledgement.workflowId !== workflowId ||
      acknowledgement.workflowId !== deriveWorkflowId(ackIdentity) ||
      acknowledgement.state !== state ||
      acknowledgement.operationKey !== operationKey
    ) {
      throw new DbosRuntimeError("DBOS acknowledgement identity or state mismatch");
    }
    if (acknowledgement.idempotencyKey !== deriveIdempotencyKey(ackIdentity)) {
      throw new DbosRuntimeError("DBOS acknowledgement identity or state mismatch");
    }
    if (expectedOwnerEpoch !== undefined && acknowledgement.ownerEpoch !== expectedOwnerEpoch) {
      throw new DbosRuntimeError("DBOS acknowledgement owner epoch mismatch");
    }
    return acknowledgement;
  }

  private operationKey(operation: string, workflowId: string, payload: unknown): string {
    const digest = createHash("sha256")
      .update(stableJson({ operation, workflowId, payload }))
      .digest("hex");
    return `openclaw:dbos-operation:${digest}`;
  }
}

export function createProductionDbosAuthority(
  env: NodeJS.ProcessEnv = process.env,
  gate?: AdmissionGate,
): PostgresDbosClient {
  const baseUrl = env.OPENCLAW_DBOS_URL ?? env.DBOS_URL;
  if (baseUrl && !env.OPENCLAW_DBOS_HMAC_CREDENTIAL) {
    throw new DbosRuntimeError("DBOS authority requires a systemd-loaded HMAC credential");
  }
  const hostname = baseUrl ? new URL(baseUrl).hostname : undefined;
  const allowedHosts = (env.OPENCLAW_DBOS_ALLOWED_HOSTS ?? hostname ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return new PostgresDbosClient({
    env,
    gate,
    sharedSecret: loadDbosSharedSecret(env),
    allowedHosts,
    requireAuthentication: true,
  });
}
