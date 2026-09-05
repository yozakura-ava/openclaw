import type { WorkboardStore } from "./store.js";

const DEFAULT_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 30_000;
const AVAILABILITY_ERROR_CODES = new Set([
  "SQLITE_BUSY",
  "SQLITE_LOCKED",
  "SQLITE_CANTOPEN",
  "SQLITE_CORRUPT",
  "SQLITE_FULL",
  "SQLITE_IOERR",
  "SQLITE_NOMEM",
  "SQLITE_NOTADB",
  "SQLITE_READONLY",
  "SQLITE_SCHEMA",
  "WORKBOARD_STORE_UNAVAILABLE",
]);

export type WorkboardStoreFailureSource = "gateway" | "tool" | "lifecycle" | "dbos" | "unknown";

export type WorkboardStoreFailure = {
  operation: string;
  errorCode?: string;
  errorMessage: string;
  storeGeneration: number;
  retryAttempt: number;
  source: WorkboardStoreFailureSource;
  availabilityFailure: boolean;
};

export class WorkboardStoreUnavailableError extends Error {
  readonly code = "workboard_store_unavailable";

  constructor() {
    super("Workboard SQLite store is unavailable; lifecycle services are paused");
    this.name = "WorkboardStoreUnavailableError";
  }
}

function errorRecord(error: unknown): Record<string, unknown> | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  return error as Record<string, unknown>;
}

function readErrorCode(error: unknown): string | undefined {
  const code = errorRecord(error)?.code;
  return typeof code === "string" ? code.toUpperCase() : undefined;
}

function readErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 500);
}

function errorCause(error: unknown): unknown {
  return errorRecord(error)?.cause;
}

export function isWorkboardStoreAvailabilityError(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 3; depth += 1) {
    const code = readErrorCode(current);
    if (code && AVAILABILITY_ERROR_CODES.has(code)) {
      return true;
    }
    const message = readErrorMessage(current).toLowerCase();
    if (
      /database (?:is )?locked|database disk image is malformed|not a database|disk i\/o error|unable to open database file|attempt to write a readonly database|database schema has changed|database connection is closed|sqlite database is closed/u.test(
        message,
      )
    ) {
      return true;
    }
    current = errorCause(current);
    if (current === undefined) {
      break;
    }
  }
  return false;
}

export type WorkboardStoreGuardOptions = {
  open: () => WorkboardStore;
  retryDelayMs?: number;
  maxRetryDelayMs?: number;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
  onFailure?: (failure: WorkboardStoreFailure) => void;
};

export class WorkboardStoreGuard {
  private currentStore: WorkboardStore | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;
  private opening = false;
  private attempts = 0;
  private storeGeneration = 0;
  private logger?: { warn: (message: string) => void };
  private readonly listeners = new Set<(store: WorkboardStore) => void>();
  private readonly setTimer: typeof globalThis.setTimeout;
  private readonly clearTimer: typeof globalThis.clearTimeout;

  constructor(private readonly options: WorkboardStoreGuardOptions) {
    this.setTimer = options.setTimeout ?? globalThis.setTimeout;
    this.clearTimer = options.clearTimeout ?? globalThis.clearTimeout;
  }

  get(): WorkboardStore | undefined {
    return this.currentStore;
  }

  isAvailable(): boolean {
    return this.currentStore !== undefined;
  }

  onAvailable(listener: (store: WorkboardStore) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(logger: { warn: (message: string) => void }): void {
    this.stopped = false;
    this.logger = logger;
    this.attemptOpen();
  }

  stop(): void {
    this.stopped = true;
    this.logger = undefined;
    if (this.retryTimer) {
      this.clearTimer(this.retryTimer);
      this.retryTimer = undefined;
    }
    this.opening = false;
    this.currentStore?.close();
    this.currentStore = undefined;
  }

  reportFailure(
    error: unknown,
    context: {
      operation?: string;
      source?: WorkboardStoreFailureSource;
    } = {},
  ): void {
    const availabilityFailure = isWorkboardStoreAvailabilityError(error);
    const code = readErrorCode(error);
    const failure: WorkboardStoreFailure = {
      operation: context.operation ?? "unknown",
      ...(code ? { errorCode: code } : {}),
      errorMessage: readErrorMessage(error),
      storeGeneration: this.storeGeneration,
      retryAttempt: this.attempts,
      source: code === "WORKBOARD_DBOS_LOOKUP_FAILED" ? "dbos" : (context.source ?? "unknown"),
      availabilityFailure,
    };
    this.options.onFailure?.(failure);
    if (!availabilityFailure) {
      this.logger?.warn(
        `workboard operation failed without disabling SQLite lifecycle services: ${JSON.stringify(failure)}`,
      );
      return;
    }
    if (!this.currentStore && this.retryTimer) {
      return;
    }
    try {
      this.currentStore?.close();
    } catch {
      // The connection is already unhealthy; the retry owner remains authoritative.
    }
    this.currentStore = undefined;
    this.logger?.warn(
      `workboard SQLite store became unavailable; lifecycle services paused: ${JSON.stringify(failure)}`,
    );
    this.scheduleRetry();
  }

  private attemptOpen(): void {
    if (this.stopped || this.currentStore || this.opening) {
      return;
    }
    this.opening = true;
    this.retryTimer = undefined;
    this.attempts += 1;
    try {
      const store = this.options.open();
      // Opening a file can succeed while the connection is already unusable
      // (replacement, corruption, or a stale WAL). Probe before listeners
      // resume lifecycle services.
      store.checkHealth();
      if (this.stopped) {
        store.close();
        return;
      }
      this.currentStore = store;
      this.storeGeneration += 1;
      this.attempts = 0;
      for (const listener of this.listeners) {
        listener(store);
      }
    } catch (error) {
      const code = readErrorCode(error);
      const failure: WorkboardStoreFailure = {
        operation: "open",
        ...(code ? { errorCode: code } : {}),
        errorMessage: readErrorMessage(error),
        storeGeneration: this.storeGeneration,
        retryAttempt: this.attempts,
        source: "lifecycle",
        availabilityFailure: true,
      };
      this.options.onFailure?.(failure);
      this.logger?.warn(
        `workboard SQLite store unavailable; retry ${this.attempts} is bounded: ${JSON.stringify(failure)}`,
      );
      this.scheduleRetry();
    } finally {
      this.opening = false;
    }
  }

  private scheduleRetry(): void {
    if (this.stopped || this.currentStore || this.retryTimer) {
      return;
    }
    const base = this.options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    const maximum = this.options.maxRetryDelayMs ?? MAX_RETRY_DELAY_MS;
    const delay = Math.min(maximum, base * 2 ** Math.max(0, this.attempts - 1));
    this.retryTimer = this.setTimer(() => this.attemptOpen(), delay);
    this.retryTimer.unref?.();
  }
}

/**
 * Keeps Workboard gateway/tool registration available while the SQLite store
 * is being repaired. Calls fail closed instead of making plugin startup fatal.
 */
export function createGuardedWorkboardStore(
  guard: WorkboardStoreGuard,
  source: WorkboardStoreFailureSource = "unknown",
): WorkboardStore {
  return new Proxy(
    {},
    {
      get(_target, property) {
        if (property === "then") {
          return undefined;
        }
        return (...args: unknown[]) => {
          const store = guard.get();
          if (!store) {
            throw new WorkboardStoreUnavailableError();
          }
          const method = store[property as keyof WorkboardStore];
          if (typeof method !== "function") {
            return method;
          }
          try {
            const result = (method as (...input: unknown[]) => unknown).apply(store, args);
            if (result instanceof Promise) {
              return result.catch((error: unknown) => {
                guard.reportFailure(error, { operation: String(property), source });
                throw error;
              });
            }
            return result;
          } catch (error) {
            guard.reportFailure(error, { operation: String(property), source });
            throw error;
          }
        };
      },
    },
  ) as WorkboardStore;
}
