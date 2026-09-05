import type { WorkboardStore } from "./store.js";

const DEFAULT_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 30_000;

export class WorkboardStoreUnavailableError extends Error {
  readonly code = "workboard_store_unavailable";

  constructor() {
    super("Workboard SQLite store is unavailable; lifecycle services are paused");
    this.name = "WorkboardStoreUnavailableError";
  }
}

export function isWorkboardStoreAvailabilityError(error: unknown): boolean {
  const message = String(error).toLowerCase();
  return /(sqlite|database|not a database|malformed|closed|no such table|disk i\/o|wal|schema)/u.test(
    message,
  );
}

export type WorkboardStoreGuardOptions = {
  open: () => WorkboardStore;
  retryDelayMs?: number;
  maxRetryDelayMs?: number;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
};

export class WorkboardStoreGuard {
  private currentStore: WorkboardStore | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;
  private attempts = 0;
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
    this.currentStore?.close();
    this.currentStore = undefined;
  }

  reportFailure(error: unknown): void {
    if (!isWorkboardStoreAvailabilityError(error)) {
      this.logger?.warn(
        `workboard operation failed without disabling SQLite lifecycle services: ${String(error)}`,
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
      `workboard SQLite store became unavailable; lifecycle services paused: ${String(error)}`,
    );
    this.scheduleRetry();
  }

  private attemptOpen(): void {
    if (this.stopped || this.currentStore) {
      return;
    }
    this.retryTimer = undefined;
    this.attempts += 1;
    try {
      const store = this.options.open();
      if (this.stopped) {
        store.close();
        return;
      }
      this.currentStore = store;
      this.attempts = 0;
      for (const listener of this.listeners) {
        listener(store);
      }
    } catch (error) {
      this.logger?.warn(
        `workboard SQLite store unavailable; retry ${this.attempts} is bounded: ${String(error)}`,
      );
      this.scheduleRetry();
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
export function createGuardedWorkboardStore(guard: WorkboardStoreGuard): WorkboardStore {
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
                guard.reportFailure(error);
                throw error;
              });
            }
            return result;
          } catch (error) {
            guard.reportFailure(error);
            throw error;
          }
        };
      },
    },
  ) as WorkboardStore;
}
