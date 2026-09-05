// Provides bounded FIFO admission for asynchronous SQLite authority writes.

export const DEFAULT_SQLITE_WRITER_QUEUE_MAX_DEPTH = 64;

export type SqliteWriterQueueSnapshot = {
  name: string;
  depth: number;
  pending: number;
  active: boolean;
  maxDepth: number;
  degraded: boolean;
  rejected: number;
  completed: number;
  failed: number;
};

export type SqliteWriterQueueOptions = {
  name?: string;
  maxDepth?: number;
  onFailure?: (error: unknown, snapshot: SqliteWriterQueueSnapshot) => void;
};

export class SqliteWriterQueueError extends Error {
  readonly code:
    | "SQLITE_WRITER_QUEUE_FULL"
    | "SQLITE_WRITER_QUEUE_DEGRADED"
    | "SQLITE_WRITER_QUEUE_CLOSED";

  constructor(code: SqliteWriterQueueError["code"], message: string) {
    super(message);
    this.name = "SqliteWriterQueueError";
    this.code = code;
  }
}

type QueueJob<T> = {
  run: () => T | PromiseLike<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (error: unknown) => void;
};

/**
 * A process-local writer gate. Jobs are started in arrival order and never
 * wait by blocking the event loop; callers either await their turn or receive
 * bounded backpressure when the authority is not accepting more work.
 */
export class SqliteWriterQueue {
  private readonly name: string;
  private readonly maxDepth: number;
  private readonly onFailure?: SqliteWriterQueueOptions["onFailure"];
  private readonly jobs: QueueJob<unknown>[] = [];
  private active = false;
  private accepting = true;
  private degraded = false;
  private rejected = 0;
  private completed = 0;
  private failed = 0;

  constructor(options: SqliteWriterQueueOptions = {}) {
    this.name = options.name ?? "sqlite-authority";
    this.maxDepth = options.maxDepth ?? DEFAULT_SQLITE_WRITER_QUEUE_MAX_DEPTH;
    if (!Number.isInteger(this.maxDepth) || this.maxDepth < 1) {
      throw new Error("SQLite writer queue maxDepth must be a positive integer");
    }
    this.onFailure = options.onFailure;
  }

  get snapshot(): SqliteWriterQueueSnapshot {
    return {
      name: this.name,
      depth: this.jobs.length + (this.active ? 1 : 0),
      pending: this.jobs.length,
      active: this.active,
      maxDepth: this.maxDepth,
      degraded: this.degraded,
      rejected: this.rejected,
      completed: this.completed,
      failed: this.failed,
    };
  }

  run<T>(operation: () => T | PromiseLike<T>): Promise<T> {
    if (!this.accepting) {
      this.rejected += 1;
      return Promise.reject(
        new SqliteWriterQueueError(
          "SQLITE_WRITER_QUEUE_CLOSED",
          `${this.name} writer queue is closed`,
        ),
      );
    }
    if (this.degraded) {
      this.rejected += 1;
      return Promise.reject(
        new SqliteWriterQueueError(
          "SQLITE_WRITER_QUEUE_DEGRADED",
          `${this.name} writer queue is degraded; retry after recovery`,
        ),
      );
    }
    if (this.snapshot.depth >= this.maxDepth) {
      this.rejected += 1;
      return Promise.reject(
        new SqliteWriterQueueError(
          "SQLITE_WRITER_QUEUE_FULL",
          `${this.name} writer queue is full (${this.maxDepth})`,
        ),
      );
    }

    return new Promise<T>((resolve, reject) => {
      this.jobs.push({
        run: operation,
        // SAFETY: Promise<T> resolve accepts the same value shape as the erased QueueJob value.
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.pump();
    });
  }

  /**
   * Compatibility boundary for legacy synchronous adapters. It never waits:
   * a queued or active async writer is rejected so a sync caller cannot cut
   * ahead of FIFO admission or block the event loop waiting for a lock.
   */
  runSync<T>(operation: () => T): T {
    if (!this.accepting) {
      this.rejected += 1;
      throw new SqliteWriterQueueError(
        "SQLITE_WRITER_QUEUE_CLOSED",
        `${this.name} writer queue is closed`,
      );
    }
    if (this.degraded) {
      this.rejected += 1;
      throw new SqliteWriterQueueError(
        "SQLITE_WRITER_QUEUE_DEGRADED",
        `${this.name} writer queue is degraded; retry after recovery`,
      );
    }
    if (this.active || this.jobs.length > 0) {
      this.rejected += 1;
      throw new SqliteWriterQueueError(
        "SQLITE_WRITER_QUEUE_FULL",
        `${this.name} writer queue cannot admit a synchronous writer while asynchronous writes are pending`,
      );
    }
    this.active = true;
    try {
      const value = operation();
      this.completed += 1;
      return value;
    } catch (error) {
      this.failed += 1;
      try {
        this.onFailure?.(error, this.snapshot);
      } catch {
        // Queue telemetry cannot change the write result.
      }
      throw error;
    } finally {
      this.active = false;
      this.pump();
    }
  }

  /** Stop accepting writes and reject jobs that have not started. */
  close(): void {
    this.accepting = false;
    const error = new SqliteWriterQueueError(
      "SQLITE_WRITER_QUEUE_CLOSED",
      `${this.name} writer queue is closed`,
    );
    while (this.jobs.length > 0) {
      this.jobs.shift()!.reject(error);
    }
  }

  /** Backpressure is explicit so a supervisor can recover the authority. */
  markDegraded(): void {
    this.degraded = true;
  }

  recover(): void {
    this.degraded = false;
    this.pump();
  }

  private pump(): void {
    if (this.active || this.jobs.length === 0 || !this.accepting || this.degraded) {
      return;
    }
    const job = this.jobs.shift()!;
    this.active = true;
    void Promise.resolve()
      .then(job.run)
      .then(
        (value) => {
          this.completed += 1;
          job.resolve(value);
        },
        (error: unknown) => {
          this.failed += 1;
          try {
            this.onFailure?.(error, this.snapshot);
          } catch {
            // Queue telemetry cannot change the write result.
          }
          job.reject(error);
        },
      )
      .finally(() => {
        this.active = false;
        this.pump();
      });
  }
}

let sqliteAuthorityWriterQueue: SqliteWriterQueue | undefined;

/** The gateway-wide gate shared by all first-party SQLite authority stores. */
export function getSqliteAuthorityWriterQueue(): SqliteWriterQueue {
  sqliteAuthorityWriterQueue ??= new SqliteWriterQueue({ name: "sqlite-authority" });
  return sqliteAuthorityWriterQueue;
}

/** Enqueue an approved asynchronous SQLite authority mutation. */
export function runSqliteAuthorityWrite<T>(operation: () => T | PromiseLike<T>): Promise<T> {
  return getSqliteAuthorityWriterQueue().run(operation);
}

/** Route a legacy synchronous authority adapter through the same FIFO gate. */
export function runSqliteAuthorityWriteSync<T>(operation: () => T): T {
  return getSqliteAuthorityWriterQueue().runSync(operation);
}
