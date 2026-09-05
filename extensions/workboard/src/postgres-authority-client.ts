import { createHash, createHmac, randomBytes } from "node:crypto";
import fs from "node:fs";
import { stableJson } from "@openclaw/execution-contract";
import type {
  WorkboardAuthorityRecord,
  WorkboardAuthorityWriteResult,
} from "./postgres-authority-types.js";

type WorkboardAuthorityClientOptions = {
  baseUrl: string;
  secret: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  retries?: number;
};

type WorkboardAuthorityClient = {
  readonly enabled: true;
  health(): Promise<void>;
  read(namespace: string, key: string): Promise<WorkboardAuthorityRecord>;
  list(namespace: string): Promise<Array<{ key: string; record: WorkboardAuthorityRecord }>>;
  write(input: {
    operationId: string;
    namespace: string;
    key: string;
    value?: unknown;
    mode: "insert" | "upsert" | "delete" | "claim";
    expectedUpdatedAt?: number;
    ownerId?: string;
    now?: number;
    maxConcurrentClaims?: number;
  }): Promise<WorkboardAuthorityWriteResult>;
};

function readSecret(env: NodeJS.ProcessEnv): string | undefined {
  const direct = env.OPENCLAW_DBOS_HMAC_SECRET?.trim();
  if (direct) {
    return direct;
  }
  const pathName = env.OPENCLAW_DBOS_HMAC_CREDENTIAL;
  return pathName ? fs.readFileSync(pathName, "utf8").trim() : undefined;
}

function operationId(input: unknown): string {
  return `workboard:${createHash("sha256").update(stableJson(input)).digest("hex")}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function signedHeaders(
  secret: string,
  method: string,
  pathName: string,
  body: string,
): Record<string, string> {
  const timestamp = String(Date.now());
  const nonce = randomBytes(16).toString("hex");
  const signature = createHmac("sha256", secret)
    .update(`${method}\n${pathName}\n${timestamp}\n${nonce}\n${body}`)
    .digest("hex");
  return {
    "content-type": "application/json",
    "x-dbos-timestamp": timestamp,
    "x-dbos-nonce": nonce,
    "x-dbos-signature": signature,
  };
}

export class HttpWorkboardAuthorityClient implements WorkboardAuthorityClient {
  readonly enabled = true as const;
  private readonly baseUrl: string;
  private readonly secret: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly retries: number;

  constructor(options: WorkboardAuthorityClientOptions) {
    const parsed = new URL(options.baseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("Workboard DBOS authority URL must use HTTP or HTTPS");
    }
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.secret = options.secret;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = Math.max(500, Math.min(30_000, options.timeoutMs ?? 5_000));
    this.retries = Math.max(0, Math.min(5, Math.trunc(options.retries ?? 3)));
  }

  private async request<T>(pathName: string, payload?: unknown): Promise<T> {
    const body = payload === undefined ? "{}" : stableJson(payload);
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(`${this.baseUrl}${pathName}`, {
          method: "POST",
          headers: signedHeaders(this.secret, "POST", pathName, body),
          body,
          signal: controller.signal,
        });
        // SAFETY: the authority endpoint response is decoded under the caller's typed endpoint contract.
        const responseBody = (await response.json()) as T & { error?: string };
        if (response.ok) {
          return responseBody;
        }
        const detail =
          responseBody && typeof responseBody === "object" && typeof responseBody.error === "string"
            ? responseBody.error
            : `authority returned HTTP ${response.status}`;
        lastError = new Error(detail);
        if (response.status < 500 || attempt >= this.retries) {
          throw lastError;
        }
      } catch (error) {
        lastError = error;
        if (attempt >= this.retries) {
          throw error;
        }
      } finally {
        clearTimeout(timer);
      }
      await delay(100 * 2 ** attempt);
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async health(): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(`${this.baseUrl}/ready`, {
          method: "GET",
          signal: controller.signal,
        });
        if (response.ok) {
          return;
        }
        lastError = new Error(`Workboard authority readiness returned HTTP ${response.status}`);
      } catch (error) {
        lastError = error;
      } finally {
        clearTimeout(timer);
      }
      if (attempt < this.retries) {
        await delay(100 * 2 ** attempt);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async read(namespace: string, key: string): Promise<WorkboardAuthorityRecord> {
    const result = await this.request<{ record: WorkboardAuthorityRecord }>("/v1/workboard/read", {
      namespace,
      key,
    });
    return result.record;
  }

  async list(namespace: string): Promise<Array<{ key: string; record: WorkboardAuthorityRecord }>> {
    const result = await this.request<{
      records: Array<{ key: string; record: WorkboardAuthorityRecord }>;
    }>("/v1/workboard/list", { namespace });
    return result.records;
  }

  async write(input: {
    operationId: string;
    namespace: string;
    key: string;
    value?: unknown;
    mode: "insert" | "upsert" | "delete" | "claim";
    expectedUpdatedAt?: number;
    ownerId?: string;
    now?: number;
    maxConcurrentClaims?: number;
  }): Promise<WorkboardAuthorityWriteResult> {
    const result = await this.request<{ result: WorkboardAuthorityWriteResult }>(
      "/v1/workboard/write",
      input,
    );
    return result.result;
  }
}

export function createWorkboardPostgresAuthorityFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): HttpWorkboardAuthorityClient | undefined {
  const baseUrl = env.OPENCLAW_DBOS_URL?.trim();
  if (!baseUrl) {
    return undefined;
  }
  const secret = readSecret(env);
  if (!secret) {
    throw new Error("OPENCLAW_DBOS_URL is set but the DBOS HMAC credential is unavailable");
  }
  return new HttpWorkboardAuthorityClient({ baseUrl, secret });
}

export function deriveWorkboardOperationId(input: unknown): string {
  return operationId(input);
}
