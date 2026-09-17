// Default watchdog timing bounds for CLI-backed agent sessions.
export const CLI_WATCHDOG_MIN_TIMEOUT_MS = 1_000;

export const CLI_FRESH_WATCHDOG_DEFAULTS = {
  noOutputTimeoutRatio: 0.8,
  minMs: 180_000,
  maxMs: 600_000,
  /** Default extension when modelCallInFlight=true (provider slow-start). */
  extendOnModelCallMs: 120_000,
} as const;

export const CLI_RESUME_WATCHDOG_DEFAULTS = {
  noOutputTimeoutRatio: 0.3,
  minMs: 60_000,
  maxMs: 180_000,
  /** Default extension when modelCallInFlight=true (provider slow-start). */
  extendOnModelCallMs: 60_000,
} as const;

/**
 * Global defaults for the watchdog behavior flags introduced for #126
 * mitigation. Per-backend `reliability.watchdog` values still override.
 */
export const CLI_WATCHDOG_BEHAVIOR_DEFAULTS = {
  /** Emit `lifecycle:phase="abort"` agent event when watchdog fires. */
  emitAbortLifecycleEvent: true,
  /**
   * Mark watchdog aborts non-retryable so silent re-dispatch cannot
   * happen. Off by default to preserve existing failover semantics.
   */
  disableSilentRedispatch: false,
} as const;
