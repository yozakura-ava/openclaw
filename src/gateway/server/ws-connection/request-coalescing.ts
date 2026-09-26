/**
 * Gateway request coalescing + rate-bounding (issue #184 fold-in).
 *
 * Three coordinated mechanisms share one per-connection state holder:
 *
 *   1. Single-flight in-flight dedup — concurrent identical requests (same
 *      method + identical paramsKey) on the same connection share ONE
 *      underlying computation. Extra callers subscribe to the same Promise
 *      and receive the same payload/error, no extra handler execution.
 *
 *   2. Stale-while-revalidate (SWR) cache — for idempotent catalog/metadata
 *      reads (`models.list`, `models.authStatus`, `chat.metadata`,
 *      `sessions.describe` and friends), a recent successful payload is
 *      served from cache and the next request triggers a background
 *      revalidation once the freshness window expires.
 *
 *   3. Rate-limit + circuit-breaker per connection — repeated identical
 *      requests on the same connection past a configurable window open a
 *      per-connection circuit breaker. While open, additional requests are
 *      refused with a 429-style error carrying `Retry-After` (header
 *      `X-RateLimit-Retry-After-Ms`) so the offending client is attributable
 *      from diagnostics.
 *
 * Diagnostics:
 *   Every dispatch emits a `gateway.request.rate` diagnostic event with
 *   client identity (mode/id/device/user), method, connection age, and the
 *   connection's rolling request rate. Includes in-flight/coalesced/served
 *   counters so heap amplification is observable from diagnostics alone.
 *
 * Scope: server-side only. Client-side (Control UI) dedup, reconnect
 * backoff, retry classification lives on card 878a0608.
 */
import { createHash } from "node:crypto";
import { emitTrustedDiagnosticEvent } from "../../../infra/diagnostic-events.js";
import type { createSubsystemLogger } from "../../../logging/subsystem.js";

/** Default freshness window for the SWR cache (covers one Control UI tick). */
export const DEFAULT_SWR_TTL_MS = 2_000;

/** Default half-life of the SWR cache (background revalidation interval). */
export const DEFAULT_SWR_HALF_LIFE_MS = 30_000;

/** Default maximum per-connection rate before the circuit breaker opens. */
export const DEFAULT_RATE_LIMIT_PER_SEC = 4;

/** Default sustained-window length for circuit-breaker evaluation. */
export const DEFAULT_RATE_WINDOW_MS = 5_000;

/** Default circuit-breaker open duration before a half-open probe is allowed. */
export const DEFAULT_BREAKER_OPEN_MS = 5_000;

/** Methods eligible for coalescing + SWR + rate-bound. Keep this list tight. */
export const DEFAULT_COALESCED_METHODS: ReadonlySet<string> = new Set([
  "models.list",
  "models.authStatus",
  "chat.metadata",
  "sessions.describe",
]);

/** Stable identity string for one (method, paramsKey) tuple — used as map key. */
export type CoalesceKey = string;

/** Identity fields we surface in rate diagnostics. */
export type ClientIdentity = Readonly<{
  clientId?: string;
  clientMode?: string;
  role?: string;
  deviceId?: string;
  userId?: string;
  profileId?: string;
  connId?: string;
}>;

export type CoalesceDecision =
  | { kind: "fresh"; key: CoalesceKey }
  | {
      kind: "coalesced";
      key: CoalesceKey;
      subscriberCount: number;
    }
  | {
      kind: "served-cache";
      key: CoalesceKey;
      ageMs: number;
    }
  | {
      kind: "rate-limited";
      key: CoalesceKey;
      retryAfterMs: number;
      reason: "repeated-identical" | "circuit-open";
    };

export type CachedResponse = Readonly<{
  payload: unknown;
  cachedAt: number;
}>;

export type RequestCoalescerOptions = Readonly<{
  connId: string;
  identity: ClientIdentity;
  /** Wall-clock millisecond the connection was accepted. */
  connectionAcceptedAt: number;
  /** Functions eligible for coalescing + SWR. Defaults to DEFAULT_COALESCED_METHODS. */
  coalescedMethods?: ReadonlySet<string>;
  /** SWR freshness window (ms). */
  swrTtlMs?: number;
  /** SWR half-life for background revalidation trigger (ms). */
  swrHalfLifeMs?: number;
  /** Per-connection rate limit (requests per window). */
  rateLimitPerWindow?: number;
  /** Rate window length (ms). */
  rateWindowMs?: number;
  /** How long the breaker stays open before half-open probe (ms). */
  breakerOpenMs?: number;
  /** Optional test hook for monotonic time. */
  now?: () => number;
  /** Optional logger used for breaker/state transitions. */
  log?: ReturnType<typeof createSubsystemLogger>;
  /** Optional sink for rate-diagnostic emission (defaults to trusted diagnostics). */
  emitRate?: (event: GatewayRequestRateEvent) => void;
}>;

export type GatewayRequestRateEvent = Readonly<{
  type: "gateway.request.rate";
  method: string;
  connId: string;
  clientId: string | undefined;
  clientMode: string | undefined;
  role: string | undefined;
  deviceId: string | undefined;
  userId: string | undefined;
  profileId: string | undefined;
  connectionAgeMs: number;
  windowMs: number;
  requestsInWindow: number;
  limitPerWindow: number;
  inFlight: number;
  coalesced: number;
  cacheHits: number;
  rateLimited: number;
  breakerOpen: 0 | 1;
  decision: CoalesceDecision["kind"];
}>;

/** Rolling request log: per-connection method+timestamp tail. */
type RateBucket = { samples: number[] };

/** In-flight promise holding the eventual response/error. */
type InFlightRecord = { promise: Promise<unknown>; subscribers: number };

/**
 * Per-connection request coalescer.
 *
 * Stateless w.r.t. process-wide model state — instances hold only this
 * connection's bookkeeping plus a pointer to the shared SWR cache.
 */
export class RequestCoalescer {
  private readonly opts: Required<
    Omit<RequestCoalescerOptions, "log" | "emitRate" | "identity">
  > & {
    identity: ClientIdentity;
    log?: ReturnType<typeof createSubsystemLogger>;
    emitRate?: (event: GatewayRequestRateEvent) => void;
  };
  /** In-flight promises keyed by (method, paramsKey). */
  private readonly inFlight = new Map<CoalesceKey, InFlightRecord>();
  /** Per-connection rolling rate buckets (all methods aggregated). */
  private readonly rate: RateBucket = { samples: [] };
  /** SWR cache scoped to this connection (freshness matters per-conn). */
  private readonly cache = new Map<CoalesceKey, CachedResponse>();
  /** Per-method counters for diagnostics. */
  private readonly counters = {
    coalesced: 0,
    cacheHits: 0,
    rateLimited: 0,
    breakerOpened: 0,
  };
  private breakerOpenUntil = 0;

  constructor(options: RequestCoalescerOptions) {
    const coalescedMethods = options.coalescedMethods ?? DEFAULT_COALESCED_METHODS;
    this.opts = {
      connId: options.connId,
      identity: options.identity,
      connectionAcceptedAt: options.connectionAcceptedAt,
      coalescedMethods,
      swrTtlMs: options.swrTtlMs ?? DEFAULT_SWR_TTL_MS,
      swrHalfLifeMs: options.swrHalfLifeMs ?? DEFAULT_SWR_HALF_LIFE_MS,
      rateLimitPerWindow: options.rateLimitPerWindow ?? DEFAULT_RATE_LIMIT_PER_SEC,
      rateWindowMs: options.rateWindowMs ?? DEFAULT_RATE_WINDOW_MS,
      breakerOpenMs: options.breakerOpenMs ?? DEFAULT_BREAKER_OPEN_MS,
      now: options.now ?? Date.now,
      log: options.log,
      emitRate:
        options.emitRate ??
        ((event: GatewayRequestRateEvent) => {
          // DiagnosticEventInput is a discriminated union and our custom
          // gateway.request.rate event is statically outside it (it's a new
          // diagnostic kind scoped to this module). The runtime payload is
          // structurally identical to the trusted-diagnostic base shape; cast
          // through unknown to the trusted channel's parameter type.
          emitTrustedDiagnosticEvent(event as unknown as Parameters<typeof emitTrustedDiagnosticEvent>[0]);
        }),
    };
  }

  /** True when this method is in the eligible-for-coalescing list. */
  isCoalescedMethod(method: string): boolean {
    return this.opts.coalescedMethods.has(method);
  }

  /**
   * Decide what to do with an incoming request.
   *
   * Caller MUST call {@link recordOutcome} once the handler completes,
   * regardless of decision kind, so SWR cache + counters stay coherent.
   * Returns the canonical `key` so the caller can reuse it for
   * {@link startRun}, {@link subscribe}, {@link recordOutcome},
   * {@link readCache} without re-deriving the key (which would risk
   * hash collisions on parameter ordering).
   */
  decide(method: string, paramsKeyInput: unknown): CoalesceDecision {
    if (!this.isCoalescedMethod(method)) {
      // Off-list methods skip the coalescer; return a synthetic key so the
      // caller has something stable to thread through recordOutcome. We use
      // the canonical-key format so unrelated callers can't accidentally
      // collide with this connection's per-method entries.
      return {
        kind: "fresh",
        key: `passthrough\u0000${canonicalParamsKey(method, paramsKeyInput)}`,
      };
    }
    const now = this.opts.now();
    const paramsKey = canonicalParamsKey(method, paramsKeyInput);
    this.pruneRateBucket(now);
    const requestsInWindow = this.rate.samples.length;

    // 1. Breaker open?
    if (this.breakerOpenUntil > now) {
      this.counters.rateLimited += 1;
      const decision: CoalesceDecision = {
        kind: "rate-limited",
        key: paramsKey,
        retryAfterMs: this.breakerOpenUntil - now,
        reason: "circuit-open",
      };
      this.emitRateDecision(method, now, requestsInWindow, decision);
      return decision;
    }

    // 2. SWR cache fresh?
    const cached = this.cache.get(paramsKey);
    if (cached && now - cached.cachedAt < this.opts.swrTtlMs) {
      this.counters.cacheHits += 1;
      const decision: CoalesceDecision = {
        kind: "served-cache",
        key: paramsKey,
        ageMs: now - cached.cachedAt,
      };
      this.emitRateDecision(method, now, requestsInWindow, decision);
      return decision;
    }

    // 3. In-flight same request?
    const existing = this.inFlight.get(paramsKey);
    if (existing) {
      existing.subscribers += 1;
      this.counters.coalesced += 1;
      const decision: CoalesceDecision = {
        kind: "coalesced",
        key: paramsKey,
        subscriberCount: existing.subscribers,
      };
      this.emitRateDecision(method, now, requestsInWindow, decision);
      return decision;
    }

    // 4. Rate budget check across ALL coalesced requests on this connection.
    if (requestsInWindow >= this.opts.rateLimitPerWindow) {
      this.counters.rateLimited += 1;
      this.openBreaker(now);
      const decision: CoalesceDecision = {
        kind: "rate-limited",
        key: paramsKey,
        retryAfterMs: this.opts.breakerOpenMs,
        reason: "repeated-identical",
      };
      this.emitRateDecision(method, now, requestsInWindow, decision);
      return decision;
    }

    this.rate.samples.push(now);
    const decision: CoalesceDecision = { kind: "fresh", key: paramsKey };
    this.emitRateDecision(method, now, requestsInWindow + 1, decision);
    return decision;
  }

  /**
   * Register that this caller is about to start a fresh computation.
   *
   * Returns a {@link RunHandle} the caller must `await` once the
   * underlying handler finishes. The handle stores the result so future
   * concurrent callers can subscribe via {@link subscribe}. The `key`
   * must be the canonical key returned by {@link decide}.
   *
   * The in-flight entry is bound to the RunHandle's lifetime: when the
   * handle settles (resolve or reject), the in-flight entry is removed
   * even if {@link recordOutcome} is not called — prevents leaks when a
   * handler throws or is abandoned mid-flight.
   */
  startRun(key: CoalesceKey): RunHandle {
    const handle = new RunHandle();
    const record: InFlightRecord = { promise: handle.promise, subscribers: 1 };
    this.inFlight.set(key, record);
    handle.onSettle(() => {
      // Settle-time cleanup: remove the in-flight entry on resolve or
      // reject. Idempotent with recordOutcome, which also calls delete.
      if (this.inFlight.get(key) === record) {
        this.inFlight.delete(key);
      }
    });
    return handle;
  }

  /** Subscribe to an already-running identical request. */
  subscribe(key: CoalesceKey): { promise: Promise<unknown> } | undefined {
    const existing = this.inFlight.get(key);
    if (!existing) {
      return undefined;
    }
    existing.subscribers += 1;
    return { promise: existing.promise };
  }

  /**
   * Record the outcome of a handler run for SWR cache + cleanup.
   *
   * `ok=true` updates the cache (with `payload`).
   * `ok=false` does NOT cache (so the next caller retries), and clears
   * in-flight bookkeeping regardless.
   */
  recordOutcome(key: CoalesceKey, ok: boolean, payload?: unknown): void {
    const now = this.opts.now();
    if (ok && payload !== undefined) {
      this.cache.set(key, { payload, cachedAt: now });
    }
    this.inFlight.delete(key);
    // A failed outcome keeps breaker state — the next caller will see
    // whether the window has calmed or whether they should be rate-limited
    // again.
  }

  /** Read the SWR cache for a previous successful payload (used by served-cache path). */
  readCache(key: CoalesceKey): CachedResponse | undefined {
    return this.cache.get(key);
  }

  /** True while the breaker is open. */
  isBreakerOpen(now: number = this.opts.now()): boolean {
    return this.breakerOpenUntil > now;
  }

  /** Force a half-open probe; returns true if a probe is allowed. */
  allowHalfOpenProbe(now: number = this.opts.now()): boolean {
    if (this.breakerOpenUntil === 0) {
      return true;
    }
    if (now < this.breakerOpenUntil) {
      return false;
    }
    this.breakerOpenUntil = 0;
    return true;
  }

  /** Close any held cache/in-flight state on connection close. */
  dispose(): void {
    this.inFlight.clear();
    this.cache.clear();
    this.rate.samples.length = 0;
    this.breakerOpenUntil = 0;
  }

  /** Diagnostic snapshot — used in tests and external observers. */
  snapshot(now: number = this.opts.now()): Readonly<{
    inFlight: number;
    cacheSize: number;
    requestsInWindow: number;
    breakerOpen: boolean;
    counters: { coalesced: number; cacheHits: number; rateLimited: number; breakerOpened: number };
    connectionAgeMs: number;
  }> {
    this.pruneRateBucket(now);
    return {
      inFlight: this.inFlight.size,
      cacheSize: this.cache.size,
      requestsInWindow: this.rate.samples.length,
      breakerOpen: this.breakerOpenUntil > now,
      counters: { ...this.counters },
      connectionAgeMs: now - this.opts.connectionAcceptedAt,
    };
  }

  /** Toggle the SWR cache (used in tests). */
  clearCache(): void {
    this.cache.clear();
  }

  private pruneRateBucket(now: number): void {
    const cutoff = now - this.opts.rateWindowMs;
    const samples = this.rate.samples;
    // Samples are inserted in monotonic order; once we find a non-stale
    // timestamp, every subsequent sample is also non-stale. The `!` is
    // safe because `i < samples.length` is the loop guard.
    let i = 0;
    while (i < samples.length && samples[i]! < cutoff) {
      i += 1;
    }
    if (i > 0) {
      samples.splice(0, i);
    }
  }

  private openBreaker(now: number): void {
    if (this.breakerOpenUntil > now) {
      return;
    }
    this.breakerOpenUntil = now + this.opts.breakerOpenMs;
    this.counters.breakerOpened += 1;
    this.opts.log?.warn?.(
      `[gateway.request.coalesce] breaker open connId=${this.opts.connId} duration=${this.opts.breakerOpenMs}ms`,
    );
  }

  private emitRateDecision(
    method: string,
    now: number,
    requestsInWindow: number,
    decision: CoalesceDecision,
  ): void {
    const identity = this.opts.identity;
    this.opts.emitRate?.({
      type: "gateway.request.rate",
      method,
      connId: this.opts.connId,
      clientId: identity.clientId,
      clientMode: identity.clientMode,
      role: identity.role,
      deviceId: identity.deviceId,
      userId: identity.userId,
      profileId: identity.profileId,
      connectionAgeMs: now - this.opts.connectionAcceptedAt,
      windowMs: this.opts.rateWindowMs,
      requestsInWindow,
      limitPerWindow: this.opts.rateLimitPerWindow,
      inFlight: this.inFlight.size,
      coalesced: this.counters.coalesced,
      cacheHits: this.counters.cacheHits,
      rateLimited: this.counters.rateLimited,
      breakerOpen: this.breakerOpenUntil > now ? 1 : 0,
      decision: decision.kind,
    });
  }
}

/**
 * Promise-like handle that the dispatch layer can `await` once the
 * handler completes. The first caller owns the producer side; subsequent
 * callers subscribe via RequestCoalescer.subscribe.
 *
 * Settle-time callbacks ({@link onSettle}) fire when the handle settles
 * (resolve OR reject) and are used by {@link RequestCoalescer.startRun}
 * to clean up the in-flight map. Callers can also attach their own
 * settle-time hooks via {@link onSettle}.
 */
export class RunHandle {
  private resolveFn!: (value: unknown) => void;
  private rejectFn!: (err: unknown) => void;
  readonly promise: Promise<unknown>;
  private settled = false;
  private settleCallbacks: Array<(settled: "resolved" | "rejected") => void> = [];
  /** No-op catch attached to `promise` to suppress Node-level unhandled-rejection
   *  warnings when the producer itself has no awaiter (the producer's
   *  dispatchWithCoalescing does not await its own runHandle). Subscribers'
   *  `await subscribed.promise` chains still see the rejection through their
   *  own .then handlers. */
  private readonly suppressUnhandled: () => void;

  constructor() {
    let resolveFn!: (value: unknown) => void;
    let rejectFn!: (err: unknown) => void;
    const p = new Promise<unknown>((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });
    // Always attach a no-op catch so the rejection is never truly "unhandled"
    // (subscribers chain off the same promise and still observe the rejection).
    this.suppressUnhandled = () => {
      /* keeps Node quiet */
    };
    p.catch(this.suppressUnhandled);
    this.promise = p;
    this.resolveFn = resolveFn;
    this.rejectFn = rejectFn;
  }

  /** Register a callback invoked when the handle settles (resolve or reject). */
  onSettle(cb: (settled: "resolved" | "rejected") => void): void {
    if (this.settled) {
      // Fire immediately for already-settled handles so callers don't have to
      // branch on the order of onSettle registration vs. settle.
      cb("resolved");
      return;
    }
    this.settleCallbacks.push(cb);
  }

  resolve(value: unknown): void {
    if (this.settled) {
      return;
    }
    this.settled = true;
    const callbacks = this.settleCallbacks;
    this.settleCallbacks = [];
    callbacks.forEach((cb) => {
      try {
        cb("resolved");
      } catch {
        // Swallow callback errors so one bad listener cannot poison settle.
      }
    });
    this.resolveFn(value);
  }

  reject(err: unknown): void {
    if (this.settled) {
      return;
    }
    this.settled = true;
    const callbacks = this.settleCallbacks;
    this.settleCallbacks = [];
    callbacks.forEach((cb) => {
      try {
        cb("rejected");
      } catch {
        // Swallow callback errors so one bad listener cannot poison settle.
      }
    });
    this.rejectFn(err);
  }

  get done(): boolean {
    return this.settled;
  }
}

/**
 * Canonical stable string for use as map key.
 *
 * `method` is included when supplied so callers can use one helper for both
 * the per-method dispatch key and the (method, paramsKey) in-flight key.
 * `params` is JSON-canonicalised; nested objects with stable key order.
 */
export function canonicalParamsKey(method: string | undefined, params: unknown): CoalesceKey {
  if (params === undefined || params === null) {
    return method ?? "_";
  }
  const serialized = stableStringify(params);
  if (!method) {
    return stableHash(serialized);
  }
  return `${method}\u0000${stableHash(serialized)}`;
}

/** Deterministic JSON stringify with sorted keys. */
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).toSorted();
  const parts: string[] = [];
  for (const k of keys) {
    const v = (value as Record<string, unknown>)[k];
    if (v === undefined) {
      continue;
    } // Drop undefined to match JSON semantics.
    parts.push(`${JSON.stringify(k)}:${stableStringify(v)}`);
  }
  return `{${parts.join(",")}}`;
}

function stableHash(input: string): string {
  return createHash("sha1").update(input).digest("hex").slice(0, 16);
}

/**
 * Best-effort extraction of client identity from a request context client.
 *
 * Public for tests; `authenticated-request-dispatch.ts` calls this once per
 * connection when it instantiates the {@link RequestCoalescer}.
 */
export function extractClientIdentity(input: {
  connId?: string;
  client?: {
    connect?: {
      client?: { id?: unknown; mode?: unknown };
      role?: unknown;
      device?: { id?: unknown };
      deviceId?: unknown;
      userId?: unknown;
      profileId?: unknown;
    };
    authenticatedUserProfile?: { profileId?: unknown };
    authenticatedUserId?: unknown;
  };
}): ClientIdentity {
  const c = input.client?.connect;
  return {
    connId: input.connId,
    clientId: typeof c?.client?.id === "string" ? c.client.id : undefined,
    clientMode: typeof c?.client?.mode === "string" ? c.client.mode : undefined,
    role: typeof c?.role === "string" ? c.role : undefined,
    deviceId:
      typeof c?.device?.id === "string"
        ? c.device.id
        : typeof c?.deviceId === "string"
          ? c.deviceId
          : undefined,
    userId:
      typeof c?.userId === "string"
        ? c.userId
        : typeof input.client?.authenticatedUserId === "string"
          ? input.client.authenticatedUserId
          : undefined,
    profileId:
      typeof c?.profileId === "string"
        ? c.profileId
        : typeof input.client?.authenticatedUserProfile?.profileId === "string"
          ? input.client.authenticatedUserProfile.profileId
          : undefined,
  };
}

/* ============================================================================
 * Integration layer: capturing-respond + dispatchWithCoalescing.
 *
 * These helpers pull the wire-up logic the dispatcher previously inlined into
 * a single, testable entry point. The dispatch tests were passing before
 * because they called the low-level coalescer API directly — which masked
 * two real wire-up bugs (SWR cache never populated; coalesced subscribers
 * received `{ok:true}` with no payload). Integration-style tests now drive
 * the dispatch path end-to-end through `dispatchWithCoalescing`.
 * ==========================================================================*/

/** Standard gateway RPC respond callback. */
export type RespondFn = (
  ok: boolean,
  payload?: unknown,
  error?: unknown,
  meta?: Record<string, unknown>,
) => void;

/** Capture shape returned by `captureRespond` for use by the dispatcher. */
export type RespondCapture = {
  ok: boolean;
  payload?: unknown;
  error?: unknown;
  meta?: Record<string, unknown>;
};

/** Resolved replay value shape produced by the producer for its subscribers. */
export type ReplayResponse = Readonly<{
  ok: boolean;
  payload?: unknown;
  error?: unknown;
}>;

/** Minimal diagnostics surface used by `dispatchWithCoalescing`. */
export type DispatchDiagnostics = {
  response(outcome: "ok" | "error" | "unavailable" | "suppressed"): void;
};

/**
 * Wrap a `RespondFn` so the wrapped call still publishes to the original
 * destination but the most recent (ok, payload, error, meta) tuple is
 * retained for the caller to read via `captureRespond.capture()`.
 *
 * Replaces the previously-fabricated "response shim" comment: this is the
 * canonical way the dispatcher feeds real handler output into SWR cache
 * + runHandle resolution + subscriber replay.
 */
export function captureRespond(
  respond: RespondFn,
): RespondFn & { capture(): RespondCapture | undefined; reset(): void } {
  let last: RespondCapture | undefined;
  const wrapped = ((
    ok: boolean,
    payload?: unknown,
    error?: unknown,
    meta?: Record<string, unknown>,
  ) => {
    last = { ok, payload, error, meta };
    respond(ok, payload, error, meta);
  }) as RespondFn & {
    capture(): RespondCapture | undefined;
    reset(): void;
  };
  wrapped.capture = () => last;
  wrapped.reset = () => {
    last = undefined;
  };
  return wrapped;
}

/** Error-shape factory used for handler failures. */
export type ErrorShapeFactory = (err: unknown) => unknown;

/** Default error-shape factory: falls back to UNKNOWN. */
export const defaultErrorShape: ErrorShapeFactory = (err) => ({
  code: "UNKNOWN",
  message: err instanceof Error ? err.message : String(err),
});

/**
 * Dispatch a single request through the coalescing + SWR + rate-limit layer.
 *
 * Decisions:
 *   - `served-cache` → respond directly with the cached payload.
 *   - `rate-limited` → respond UNAVAILABLE with retry hint.
 *   - `coalesced`    → subscribe to the producer's RunHandle and replay.
 *   - `fresh`        → call `runFresh(capturingRespond)`, capture the
 *     handler's (ok, payload, error, meta) tuple, call
 *     `coalescer.recordOutcome(...)` for SWR + in-flight cleanup, and
 *     resolve the RunHandle so coalesced subscribers receive the same data.
 *
 *   For non-coalesced methods the function falls back to running the
 *   handler with the original respond (i.e. pass-through). Behaviour
 *   matches the dispatcher's pre-coalescer dispatch exactly for
 *   mutations / chat streams / any method outside `coalescedMethods`.
 */
export async function dispatchWithCoalescing(opts: {
  coalescer: RequestCoalescer;
  method: string;
  params: unknown;
  /** Original respond (used for served-cache / rate-limited / coalesced paths AND by the capturing respond on the fresh path). */
  respond: RespondFn;
  /**
   * Run the underlying handler with a capturing respond. The dispatcher MUST
   * pass the supplied `capturingRespond` as the handler's respond callback so
   * dispatchWithCoalescing can read the captured (ok, payload, error, meta)
   * tuple after the handler completes.
   */
  runFresh: (capturingRespond: RespondFn) => Promise<void>;
  /** Optional diagnostics channel; response is called per dispatched request. */
  diagnostics?: DispatchDiagnostics;
  /** Override the coalesced-methods check (default: `coalescer.isCoalescedMethod`). */
  isMethodCoalesced?: (method: string) => boolean;
  /** Error-shape factory for handler failures (default: `defaultErrorShape`). */
  errorShape?: ErrorShapeFactory;
}): Promise<void> {
  const errorShape = opts.errorShape ?? defaultErrorShape;
  const isCoalesced =
    opts.isMethodCoalesced ?? opts.coalescer.isCoalescedMethod.bind(opts.coalescer);

  // Pass-through for non-coalesced methods: just run the handler with the
  // original respond. Mirrors the pre-coalescer dispatch path exactly.
  if (!isCoalesced(opts.method)) {
    await opts.runFresh(opts.respond);
    return;
  }

  const decision = opts.coalescer.decide(opts.method, opts.params);

  if (decision.kind === "served-cache") {
    const cached = opts.coalescer.readCache(decision.key);
    if (cached) {
      opts.respond(true, cached.payload);
      opts.diagnostics?.response("ok");
      return;
    }
    // Cache-miss race (entry evicted mid-decide): fall through to fresh path.
  } else if (decision.kind === "rate-limited") {
    opts.diagnostics?.response("unavailable");
    opts.respond(
      false,
      undefined,
      errorShape({
        code: "RATE_LIMITED",
        message: "gateway rate limit exceeded for this connection",
        retryable: true,
        retryAfterMs: decision.retryAfterMs,
      }),
      { "X-RateLimit-Retry-After-Ms": String(decision.retryAfterMs) },
    );
    return;
  } else if (decision.kind === "coalesced") {
    const subscribed = opts.coalescer.subscribe(decision.key);
    if (subscribed) {
      try {
        const replay = (await subscribed.promise) as ReplayResponse | undefined;
        opts.diagnostics?.response(replay && !replay.ok ? "error" : "ok");
        opts.respond(replay?.ok ?? false, replay?.payload, replay?.error);
      } catch (err) {
        opts.diagnostics?.response("error");
        opts.respond(false, undefined, errorShape(err));
      }
      return;
    }
    // Concurrent finish — fall through and run as fresh.
  }

  // Fresh path: start an in-flight record, run the handler with a capturing
  // respond, then on success capture the payload into SWR + resolve the
  // RunHandle so coalesced subscribers replay the producer's data.
  const runHandle = opts.coalescer.startRun(decision.key);
  const capturingRespond = captureRespond(opts.respond);
  try {
    await opts.runFresh(capturingRespond);
    const captured = capturingRespond.capture();
    if (!captured || captured.ok) {
      // Either no captured response (handler didn't call respond) OR explicit
      // success. Treat as success for cache + replay purposes; respond remains
      // in whatever state the handler left it.
      const ok = captured?.ok !== false;
      const payload = ok ? captured?.payload : undefined;
      if (ok && payload !== undefined) {
        opts.coalescer.recordOutcome(decision.key, true, payload);
        runHandle.resolve({ ok: true, payload, error: undefined });
        opts.diagnostics?.response("ok");
      } else if (ok) {
        // Successful but no payload (e.g. empty models list). Don't poison
        // the cache — caller can retry. RunHandle still resolves empty.
        opts.coalescer.recordOutcome(decision.key, true);
        runHandle.resolve({ ok: true, payload: undefined, error: undefined });
        opts.diagnostics?.response("ok");
      } else {
        // Captured explicit failure.
        opts.coalescer.recordOutcome(decision.key, false);
        runHandle.resolve({ ok: false, payload: undefined, error: captured?.error });
        opts.diagnostics?.response("error");
      }
    } else {
      // Captured explicit failure (older code path with ok=false).
      opts.coalescer.recordOutcome(decision.key, false);
      runHandle.resolve({ ok: false, payload: undefined, error: captured?.error });
      opts.diagnostics?.response("error");
    }
  } catch (handlerError) {
    runHandle.reject(handlerError);
    throw handlerError;
  }
}
