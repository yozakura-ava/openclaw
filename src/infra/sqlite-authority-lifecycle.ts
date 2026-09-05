// Tracks SQLite authority availability without hiding recovery behind a pause.

import { randomUUID } from "node:crypto";

export const SQLITE_AUTHORITY_LIFECYCLE_STATES = [
  "healthy",
  "contention",
  "degraded",
  "recovering",
  "unavailable",
] as const;

export type SqliteAuthorityLifecycleState = (typeof SQLITE_AUTHORITY_LIFECYCLE_STATES)[number];

export type SqliteAuthorityLifecycleContext = {
  operation: string;
  source: string;
  databaseIdentity: string;
  primaryErrorCode?: string | null;
  extendedErrorCode?: string | number | null;
  storeGeneration: string;
  retryCount: number;
  queueDepth: number;
  transactionHoldTimeMs: number;
  eventLoopLagMs: number;
  recoveryResult?: string | null;
  correlationId?: string;
  timestamp?: string;
};

export type SqliteAuthorityLifecycleRecord = SqliteAuthorityLifecycleContext & {
  kind: "transition" | "retry_scheduled" | "watchdog";
  from: SqliteAuthorityLifecycleState;
  to: SqliteAuthorityLifecycleState;
  correlationId: string;
  timestamp: string;
};

type LifecycleTimer = ReturnType<typeof setTimeout> & { unref?: () => void };
type LifecycleInterval = ReturnType<typeof setInterval> & { unref?: () => void };

const ALLOWED_TRANSITIONS: Readonly<
  Record<SqliteAuthorityLifecycleState, readonly SqliteAuthorityLifecycleState[]>
> = {
  healthy: ["healthy", "contention", "degraded", "recovering", "unavailable"],
  contention: ["healthy", "contention", "degraded", "recovering", "unavailable"],
  degraded: ["degraded", "recovering", "unavailable"],
  recovering: ["healthy", "contention", "degraded", "recovering", "unavailable"],
  unavailable: ["recovering", "unavailable"],
};

function normalizeDuration(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative finite number`);
  }
  return value;
}

export class SqliteAuthorityLifecycle {
  private state: SqliteAuthorityLifecycleState = "healthy";
  private retryTimer: LifecycleTimer | undefined;
  private watchdogTimer: LifecycleInterval | undefined;
  private terminalReason: string | undefined;

  constructor(
    private readonly options: {
      onRecord?: (record: SqliteAuthorityLifecycleRecord) => void;
      onWatchdog?: (record: SqliteAuthorityLifecycleRecord) => void;
      now?: () => number;
      watchdogIntervalMs?: number;
    } = {},
  ) {
    if (
      options.watchdogIntervalMs !== undefined &&
      (!Number.isFinite(options.watchdogIntervalMs) || options.watchdogIntervalMs <= 0)
    ) {
      throw new Error("SQLite lifecycle watchdogIntervalMs must be positive");
    }
  }

  get currentState(): SqliteAuthorityLifecycleState {
    return this.state;
  }

  get retryScheduled(): boolean {
    return this.retryTimer !== undefined;
  }

  transition(
    next: SqliteAuthorityLifecycleState,
    context: SqliteAuthorityLifecycleContext,
  ): SqliteAuthorityLifecycleRecord {
    if (!ALLOWED_TRANSITIONS[this.state].includes(next)) {
      throw new Error(`invalid SQLite authority lifecycle transition ${this.state} -> ${next}`);
    }
    const previous = this.state;
    this.state = next;
    if (next === "healthy") {
      this.terminalReason = undefined;
    }
    return this.emit("transition", context, previous, next);
  }

  markTerminal(
    reason: string,
    context: SqliteAuthorityLifecycleContext,
  ): SqliteAuthorityLifecycleRecord {
    const normalizedReason = reason.trim();
    if (!normalizedReason) {
      throw new Error("SQLite lifecycle terminal reason is required");
    }
    this.terminalReason = normalizedReason;
    return this.transition("unavailable", {
      ...context,
      recoveryResult: `terminal:${normalizedReason}`,
    });
  }

  scheduleRetry(params: {
    delayMs: number;
    context: SqliteAuthorityLifecycleContext;
    attempt: () => Promise<boolean>;
  }): boolean {
    const delayMs = normalizeDuration(params.delayMs, "SQLite lifecycle retry delayMs");
    if (this.retryTimer || this.terminalReason) {
      return false;
    }
    const correlationId = params.context.correlationId ?? randomUUID();
    const context = { ...params.context, correlationId, recoveryResult: "retry_scheduled" };
    this.emit("retry_scheduled", context, this.state, this.state);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.runRecovery({ ...params, context }).catch(() => undefined);
    }, delayMs);
    this.retryTimer.unref?.();
    return true;
  }

  async runRecovery(params: {
    context: SqliteAuthorityLifecycleContext;
    attempt: () => Promise<boolean>;
  }): Promise<boolean> {
    const context = {
      ...params.context,
      correlationId: params.context.correlationId ?? randomUUID(),
    };
    this.transition("recovering", { ...context, recoveryResult: "probe_started" });
    try {
      const ready = await params.attempt();
      if (ready) {
        this.transition("healthy", { ...context, recoveryResult: "probe_succeeded" });
        return true;
      }
      this.transition("unavailable", { ...context, recoveryResult: "probe_failed" });
      return false;
    } catch (error) {
      this.transition("unavailable", {
        ...context,
        primaryErrorCode:
          context.primaryErrorCode ??
          (error && typeof error === "object" && "code" in error
            ? String(
                // SAFETY: the preceding object/code-in guard proves the error has a code property.
                (error as { code: unknown }).code,
              )
            : "RECOVERY_FAILED"),
        recoveryResult: "probe_failed",
      });
      return false;
    }
  }

  startWatchdog(context: SqliteAuthorityLifecycleContext): void {
    if (this.watchdogTimer || this.options.watchdogIntervalMs === undefined) {
      return;
    }
    this.watchdogTimer = setInterval(() => {
      if (this.state === "healthy" || this.retryTimer || this.terminalReason) {
        return;
      }
      const record = this.emit(
        "watchdog",
        {
          ...context,
          recoveryResult: "missing_retry_or_terminal_reason",
        },
        this.state,
        this.state,
      );
      this.options.onWatchdog?.(record);
    }, this.options.watchdogIntervalMs);
    this.watchdogTimer.unref?.();
  }

  close(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = undefined;
    }
  }

  private emit(
    kind: SqliteAuthorityLifecycleRecord["kind"],
    context: SqliteAuthorityLifecycleContext,
    from: SqliteAuthorityLifecycleState,
    to: SqliteAuthorityLifecycleState,
  ): SqliteAuthorityLifecycleRecord {
    const timestamp =
      context.timestamp ?? new Date(this.options.now?.() ?? Date.now()).toISOString();
    const record: SqliteAuthorityLifecycleRecord = {
      ...context,
      kind,
      from,
      to,
      correlationId: context.correlationId ?? randomUUID(),
      timestamp,
    };
    try {
      this.options.onRecord?.(record);
    } catch {
      // Lifecycle telemetry must not mask the store operation or recovery.
    }
    return record;
  }
}
