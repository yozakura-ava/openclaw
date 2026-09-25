import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canonicalParamsKey,
  captureRespond,
  DEFAULT_BREAKER_OPEN_MS,
  DEFAULT_COALESCED_METHODS,
  DEFAULT_RATE_LIMIT_PER_SEC,
  DEFAULT_RATE_WINDOW_MS,
  DEFAULT_SWR_TTL_MS,
  dispatchWithCoalescing,
  extractClientIdentity,
  RequestCoalescer,
  RunHandle,
  stableStringify,
  type CoalesceDecision,
  type GatewayRequestRateEvent,
} from "./request-coalescing.js";

/** Fake monotonic clock for deterministic test runs. */
class FakeClock {
  private current = 1_000_000;
  now(): number {
    return this.current;
  }
  advance(ms: number): void {
    this.current += ms;
  }
}

function makeIdentity(
  overrides: Partial<Parameters<typeof extractClientIdentity>[0]> = {},
): ReturnType<typeof extractClientIdentity> {
  return extractClientIdentity({
    connId: overrides.connId ?? "test-conn",
    client: overrides.client ?? {
      connect: {
        client: { id: "control-ui", mode: "browser" },
        role: "operator",
        device: { id: "device-xyz" },
        userId: "user-123",
        profileId: "profile-abc",
      },
      authenticatedUserId: "user-123",
      authenticatedUserProfile: { profileId: "profile-abc" },
    },
  });
}

function captureRates(): { events: GatewayRequestRateEvent[] } {
  const events: GatewayRequestRateEvent[] = [];
  return { events };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("request-coalescing: scope and boundaries", () => {
  it("DEFAULT_COALESCED_METHODS matches the issue #184 fold-in scope", () => {
    expect(new Set(DEFAULT_COALESCED_METHODS)).toEqual(
      new Set(["models.list", "models.authStatus", "chat.metadata", "sessions.describe"]),
    );
  });

  it("non-coalesced methods bypass the coalescer entirely", () => {
    const clock = new FakeClock();
    const rates = captureRates();
    const c = new RequestCoalescer({
      connId: "c1",
      identity: makeIdentity({ connId: "c1" }),
      connectionAcceptedAt: clock.now() - 1_000,
      now: clock.now.bind(clock),
      emitRate: (e) => rates.events.push(e),
    });
    for (let i = 0; i < 100; i += 1) {
      const decision = c.decide("chat.send", { turn: i });
      expect(decision.kind).toBe("fresh");
    }
    expect(rates.events).toHaveLength(0);
    expect(c.snapshot().requestsInWindow).toBe(0);
  });
});

describe("request-coalescing: single-flight in-flight dedup", () => {
  it("two concurrent identical decisions coalsece; the producer runs once", () => {
    const clock = new FakeClock();
    const rates = captureRates();
    const c = new RequestCoalescer({
      connId: "c1",
      identity: makeIdentity({ connId: "c1" }),
      connectionAcceptedAt: clock.now() - 500,
      now: clock.now.bind(clock),
      emitRate: (e) => rates.events.push(e),
    });
    const params = { sessionKey: "s1", agentId: "a1" };
    const first = c.decide("models.list", params);
    expect(first.kind).toBe("fresh");
    if (first.kind !== "fresh") {
      throw new Error("expected fresh");
    }
    const run = c.startRun(first.key);
    const second = c.decide("models.list", params);
    expect(second.kind).toBe("coalesced");
    if (second.kind !== "coalesced") {
      throw new Error("expected coalesced");
    }
    expect(second.subscriberCount).toBe(2);
    expect(second.key).toBe(first.key);

    // Subscribing twice to the same in-flight yields the same shared promise.
    const sub1 = c.subscribe(first.key)!;
    const sub2 = c.subscribe(first.key)!;
    expect(sub1.promise).toBe(sub2.promise);
    expect(sub1.promise).toBe(run.promise);

    run.resolve({ models: [1, 2, 3] });
    c.recordOutcome(first.key, true, { models: [1, 2, 3] });
    expect(c.snapshot().inFlight).toBe(0);
    expect(c.snapshot().counters.coalesced).toBe(1);
  });

  it("different params dedupe independently", () => {
    const clock = new FakeClock();
    const c = new RequestCoalescer({
      connId: "c1",
      identity: makeIdentity({ connId: "c1" }),
      connectionAcceptedAt: clock.now(),
      now: clock.now.bind(clock),
    });
    const dA = c.decide("models.list", { sessionKey: "a" });
    if (dA.kind !== "fresh") {
      throw new Error("expected fresh");
    }
    c.startRun(dA.key);
    const dB = c.decide("models.list", { sessionKey: "b" });
    if (dB.kind !== "fresh") {
      throw new Error("expected fresh");
    }
    c.startRun(dB.key);
    const dA2 = c.decide("models.list", { sessionKey: "a" });
    expect(dA2.kind).toBe("coalesced");
  });

  it("decide returns the same key for the same (method, params) tuple", () => {
    const c = new RequestCoalescer({
      connId: "c",
      identity: makeIdentity({ connId: "c" }),
      connectionAcceptedAt: 0,
    });
    const a = c.decide("models.list", { a: 1 });
    const b = c.decide("models.list", { a: 1 });
    if (a.kind !== "fresh" || b.kind !== "fresh") {
      throw new Error("expected fresh");
    }
    expect(a.key).toBe(b.key);
    const off = c.decide("models.authStatus", { a: 1 });
    if (off.kind !== "fresh") {
      throw new Error("expected fresh");
    }
    expect(off.key).not.toBe(a.key);
  });
});

describe("request-coalescing: stale-while-revalidate cache", () => {
  it("serves cache within TTL and counts the hit", () => {
    const clock = new FakeClock();
    const rates = captureRates();
    const c = new RequestCoalescer({
      connId: "c1",
      identity: makeIdentity({ connId: "c1" }),
      connectionAcceptedAt: clock.now() - 2_000,
      swrTtlMs: 1_000,
      now: clock.now.bind(clock),
      emitRate: (e) => rates.events.push(e),
    });
    const params = { provider: "openai" };
    const first = c.decide("models.authStatus", params);
    if (first.kind !== "fresh") {
      throw new Error("expected fresh");
    }
    const run = c.startRun(first.key);
    const payload = { authed: ["openai"] };
    run.resolve(payload);
    c.recordOutcome(first.key, true, payload);

    clock.advance(500);
    const second = c.decide("models.authStatus", params);
    expect(second.kind).toBe("served-cache");
    if (second.kind !== "served-cache") {
      throw new Error("expected served-cache");
    }
    expect(second.ageMs).toBe(500);
    expect(c.snapshot().counters.cacheHits).toBe(1);
    expect(c.readCache(second.key)?.payload).toEqual(payload);
  });

  it("expired cache falls back to fresh and re-emits decisions", () => {
    const clock = new FakeClock();
    const c = new RequestCoalescer({
      connId: "c1",
      identity: makeIdentity({ connId: "c1" }),
      connectionAcceptedAt: clock.now(),
      swrTtlMs: 500,
      now: clock.now.bind(clock),
    });
    const params = { sid: "s" };
    const d1 = c.decide("chat.metadata", params);
    if (d1.kind !== "fresh") {
      throw new Error("expected fresh");
    }
    const r1 = c.startRun(d1.key);
    r1.resolve({ meta: 1 });
    c.recordOutcome(d1.key, true, { meta: 1 });

    clock.advance(600);
    const after = c.decide("chat.metadata", params);
    expect(after.kind).toBe("fresh");
  });

  it("failed outcome does not poison the cache", () => {
    const clock = new FakeClock();
    const c = new RequestCoalescer({
      connId: "c1",
      identity: makeIdentity({ connId: "c1" }),
      connectionAcceptedAt: clock.now(),
      swrTtlMs: 5_000,
      now: clock.now.bind(clock),
    });
    const d1 = c.decide("models.list", { p: 1 });
    if (d1.kind !== "fresh") {
      throw new Error("expected fresh");
    }
    const r = c.startRun(d1.key);
    r.resolve({ err: true });
    c.recordOutcome(d1.key, false);

    const next = c.decide("models.list", { p: 1 });
    expect(next.kind).toBe("fresh");
  });
});

describe("request-coalescing: rate-limit + circuit breaker", () => {
  it("opens after the per-window limit is exceeded", () => {
    const clock = new FakeClock();
    const c = new RequestCoalescer({
      connId: "c1",
      identity: makeIdentity({ connId: "c1" }),
      connectionAcceptedAt: clock.now() - 60_000,
      rateLimitPerWindow: 3,
      rateWindowMs: 5_000,
      now: clock.now.bind(clock),
    });
    for (let i = 0; i < 3; i += 1) {
      const d = c.decide("models.list", { i });
      if (d.kind !== "fresh") {
        throw new Error("expected fresh");
      }
      const run = c.startRun(d.key);
      run.resolve({ ok: true });
      c.recordOutcome(d.key, true, { ok: true });
    }
    const fourth = c.decide("models.list", { i: 99 });
    expect(fourth.kind).toBe("rate-limited");
    if (fourth.kind !== "rate-limited") {
      throw new Error("expected rate-limited");
    }
    expect(fourth.reason).toBe("repeated-identical");
    expect(c.isBreakerOpen()).toBe(true);
    expect(c.snapshot().counters.rateLimited).toBe(1);
  });

  it("rate-limited response carries retry-after equal to breaker open duration", () => {
    const clock = new FakeClock();
    const c = new RequestCoalescer({
      connId: "c1",
      identity: makeIdentity({ connId: "c1" }),
      connectionAcceptedAt: clock.now(),
      rateLimitPerWindow: 1,
      rateWindowMs: 1_000,
      breakerOpenMs: DEFAULT_BREAKER_OPEN_MS,
      now: clock.now.bind(clock),
    });
    const d1 = c.decide("models.list", { p: "x" });
    if (d1.kind !== "fresh") {
      throw new Error("expected fresh");
    }
    const r = c.startRun(d1.key);
    r.resolve({ ok: true });
    c.recordOutcome(d1.key, true, { ok: true });
    const limited = c.decide("models.list", { p: "y" }) as Extract<
      CoalesceDecision,
      { kind: "rate-limited" }
    >;
    expect(limited.kind).toBe("rate-limited");
    expect(limited.retryAfterMs).toBe(DEFAULT_BREAKER_OPEN_MS);
  });

  it("breaker-open requests are attributed to 'circuit-open' while open", () => {
    const clock = new FakeClock();
    const c = new RequestCoalescer({
      connId: "c1",
      identity: makeIdentity({ connId: "c1" }),
      connectionAcceptedAt: clock.now(),
      rateLimitPerWindow: 1,
      rateWindowMs: 5_000,
      now: clock.now.bind(clock),
    });
    const d1 = c.decide("models.list", { p: 1 });
    if (d1.kind !== "fresh") {
      throw new Error("expected fresh");
    }
    const r = c.startRun(d1.key);
    r.resolve({ ok: true });
    c.recordOutcome(d1.key, true, { ok: true });
    c.decide("models.list", { p: 2 }); // opens breaker

    const whileOpen = c.decide("models.list", { p: 3 });
    expect(whileOpen.kind).toBe("rate-limited");
    if (whileOpen.kind !== "rate-limited") {
      throw new Error("expected rate-limited");
    }
    expect(whileOpen.reason).toBe("circuit-open");
  });

  it("half-open probe is allowed exactly at breaker expiry", () => {
    const clock = new FakeClock();
    const c = new RequestCoalescer({
      connId: "c1",
      identity: makeIdentity({ connId: "c1" }),
      connectionAcceptedAt: clock.now(),
      rateLimitPerWindow: 1,
      breakerOpenMs: 1_000,
      now: clock.now.bind(clock),
    });
    const d1 = c.decide("models.list", { p: 1 });
    if (d1.kind !== "fresh") {
      throw new Error("expected fresh");
    }
    const r = c.startRun(d1.key);
    r.resolve({ ok: true });
    c.recordOutcome(d1.key, true, { ok: true });
    c.decide("models.list", { p: 2 });
    expect(c.allowHalfOpenProbe()).toBe(false);
    clock.advance(1_000);
    expect(c.allowHalfOpenProbe()).toBe(true);
    expect(c.allowHalfOpenProbe()).toBe(true);
  });
});

describe("request-coalescing: rate diagnostics", () => {
  it("emits an event with client identity + method + connection age + rate", () => {
    const clock = new FakeClock();
    const rates = captureRates();
    const c = new RequestCoalescer({
      connId: "conn-foo",
      identity: {
        connId: "conn-foo",
        clientId: "control-ui",
        clientMode: "browser",
        role: "operator",
        deviceId: "device-xyz",
        userId: "user-123",
        profileId: "profile-abc",
      },
      connectionAcceptedAt: clock.now() - 30_000,
      now: clock.now.bind(clock),
      emitRate: (e) => rates.events.push(e),
    });
    const decision = c.decide("models.list", { sessionKey: "s" });
    expect(decision.kind).toBe("fresh");
    expect(rates.events).toHaveLength(1);
    const event = rates.events[0]!;
    expect(event.type).toBe("gateway.request.rate");
    expect(event.method).toBe("models.list");
    expect(event.connId).toBe("conn-foo");
    expect(event.clientId).toBe("control-ui");
    expect(event.clientMode).toBe("browser");
    expect(event.role).toBe("operator");
    expect(event.deviceId).toBe("device-xyz");
    expect(event.userId).toBe("user-123");
    expect(event.profileId).toBe("profile-abc");
    expect(event.connectionAgeMs).toBe(30_000);
    expect(event.windowMs).toBe(DEFAULT_RATE_WINDOW_MS);
    expect(event.requestsInWindow).toBe(1);
    expect(event.limitPerWindow).toBe(DEFAULT_RATE_LIMIT_PER_SEC);
    expect(event.decision).toBe("fresh");
    expect(event.breakerOpen).toBe(0);
  });

  it("emits one event per request — never zero per dispatch", () => {
    const clock = new FakeClock();
    const rates = captureRates();
    const c = new RequestCoalescer({
      connId: "c",
      identity: makeIdentity({ connId: "c" }),
      connectionAcceptedAt: clock.now(),
      now: clock.now.bind(clock),
      emitRate: (e) => rates.events.push(e),
    });
    for (let i = 0; i < 6; i += 1) {
      const d = c.decide("models.list", { i });
      if (d.kind === "fresh") {
        const r = c.startRun(d.key);
        r.resolve({ ok: true });
        c.recordOutcome(d.key, true, { ok: true });
      }
    }
    expect(rates.events).toHaveLength(6);
    expect(rates.events.map((e) => e.decision)).toEqual([
      "fresh",
      "fresh",
      "fresh",
      "fresh",
      "rate-limited",
      "rate-limited",
    ]);
    expect(rates.events.filter((e) => e.breakerOpen === 1).length).toBeGreaterThanOrEqual(2);
  });
});

describe("request-coalescing: keys + identity", () => {
  it("canonicalParamsKey is stable across key order", () => {
    expect(canonicalParamsKey("m", { a: 1, b: 2 })).toBe(canonicalParamsKey("m", { b: 2, a: 1 }));
  });

  it("canonicalParamsKey ignores undefined fields (JSON semantics)", () => {
    expect(canonicalParamsKey("m", { a: 1, b: undefined })).toBe(canonicalParamsKey("m", { a: 1 }));
  });

  it("canonicalParamsKey gives different keys for distinct param shapes", () => {
    expect(canonicalParamsKey("m", { a: 1 })).not.toBe(canonicalParamsKey("m", { a: 2 }));
  });

  it("extractClientIdentity composes device/user/profile from the connect payload", () => {
    const out = extractClientIdentity({
      connId: "x",
      client: {
        connect: {
          client: { id: "cli", mode: "tty" },
          role: "node",
          deviceId: "dev1",
          userId: "u1",
          profileId: "p1",
        },
      },
    });
    expect(out).toEqual({
      connId: "x",
      clientId: "cli",
      clientMode: "tty",
      role: "node",
      deviceId: "dev1",
      userId: "u1",
      profileId: "p1",
    });
  });

  it("extractClientIdentity falls back to authenticated-only when connect fields missing", () => {
    const out = extractClientIdentity({
      connId: "y",
      client: {
        connect: {},
        authenticatedUserId: "fallback-user",
        authenticatedUserProfile: { profileId: "fallback-profile" },
      },
    });
    expect(out.userId).toBe("fallback-user");
    expect(out.profileId).toBe("fallback-profile");
  });
});

describe("request-coalescing: RunHandle and dispose semantics", () => {
  it("RunHandle resolves at most once (later resolves are ignored)", async () => {
    const h = new RunHandle();
    h.resolve("first");
    h.resolve("ignored");
    expect(h.done).toBe(true);
    await expect(h.promise).resolves.toBe("first");
  });

  it("RunHandle rejects at most once (later resolves are ignored)", async () => {
    const h = new RunHandle();
    h.reject("err");
    h.resolve("ignored");
    await expect(h.promise).rejects.toBe("err");
  });

  it("dispose clears cache + in-flight + rate bucket", () => {
    const clock = new FakeClock();
    const c = new RequestCoalescer({
      connId: "x",
      identity: makeIdentity({ connId: "x" }),
      connectionAcceptedAt: clock.now(),
      now: clock.now.bind(clock),
    });
    const d = c.decide("models.list", { a: 1 });
    if (d.kind !== "fresh") {
      throw new Error("expected fresh");
    }
    c.startRun(d.key);
    c.dispose();
    const snap = c.snapshot();
    expect(snap.inFlight).toBe(0);
    expect(snap.cacheSize).toBe(0);
    expect(snap.requestsInWindow).toBe(0);
  });
});

describe("request-coalescing: connectionAge is monotonic", () => {
  it("connectionAgeMs grows as time advances between dispatches", () => {
    const clock = new FakeClock();
    const events: GatewayRequestRateEvent[] = [];
    const c = new RequestCoalescer({
      connId: "x",
      identity: makeIdentity({ connId: "x" }),
      connectionAcceptedAt: clock.now(),
      now: clock.now.bind(clock),
      emitRate: (e) => events.push(e),
    });
    c.decide("models.list", { i: 1 });
    clock.advance(5_000);
    c.decide("models.list", { i: 1 });
    expect(events[0]!.connectionAgeMs).toBe(0);
    expect(events[1]!.connectionAgeMs).toBe(5_000);
  });
});

describe("request-coalescing: defaults match the audit", () => {
  it("uses the audit-recommended SWR TTL by default", () => {
    expect(DEFAULT_SWR_TTL_MS).toBe(2_000);
  });

  it("uses audit-recommended rate defaults", () => {
    expect(DEFAULT_RATE_LIMIT_PER_SEC).toBe(4);
    expect(DEFAULT_RATE_WINDOW_MS).toBe(5_000);
  });
});

describe("request-coalescing: deterministic stableStringify", () => {
  it("produces identical output for identical inputs", () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
  });
  it("handles nested arrays/objects", () => {
    expect(stableStringify({ z: [{ y: 1 }, { x: 2 }] })).toBe(
      stableStringify({ z: [{ y: 1 }, { x: 2 }] }),
    );
  });
  it("drops undefined fields", () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe(stableStringify({ a: 1 }));
  });
});

/* ============================================================================
 * Wire-up integration tests for dispatchWithCoalescing.
 *
 * Rin flag (2026-09-25): the 28 unit tests above passed because they called
 * recordOutcome directly. The wire-up path (the integration between
 * dispatchWithCoalescing, captureRespond, runHandle resolution, and the
 * diagnostics channel) was UNTESTED — that's how the two CRITICAL bugs
 * slipped through: SWR cache never populated (no recordOutcome in wire-up)
 * and coalesced subscribers received `{ok:true}` empty (no payload in
 * runHandle.resolve).
 *
 * These tests drive dispatchWithCoalescing end-to-end. Each one asserts
 * on the actual captured payload reaching respond() — not on internal
 * coalescer state that could pass while the wire response is broken.
 * ==========================================================================*/

/** Build a fake request-coalescer + handshake to drive dispatchWithCoalescing. */
function makeIntegration(
  opts: {
    coalescedMethods?: ReadonlySet<string>;
    rateLimitPerWindow?: number;
    rateWindowMs?: number;
    breakerOpenMs?: number;
    swrTtlMs?: number;
  } = {},
) {
  const clock = new FakeClock();
  const coalescer = new RequestCoalescer({
    connId: "integration-conn",
    identity: makeIdentity({ connId: "integration-conn" }),
    connectionAcceptedAt: clock.now(),
    now: clock.now.bind(clock),
    coalescedMethods: opts.coalescedMethods ?? DEFAULT_COALESCED_METHODS,
    rateLimitPerWindow: opts.rateLimitPerWindow ?? DEFAULT_RATE_LIMIT_PER_SEC,
    rateWindowMs: opts.rateWindowMs ?? DEFAULT_RATE_WINDOW_MS,
    breakerOpenMs: opts.breakerOpenMs ?? DEFAULT_BREAKER_OPEN_MS,
    swrTtlMs: opts.swrTtlMs ?? DEFAULT_SWR_TTL_MS,
  });
  return { clock, coalescer };
}

/** Capture the latest (ok, payload, error, meta) tuple passed to respond. */
function makeRecorder() {
  const calls: Array<{
    ok: boolean;
    payload?: unknown;
    error?: unknown;
    meta?: Record<string, unknown>;
  }> = [];
  const respond = (
    ok: boolean,
    payload?: unknown,
    error?: unknown,
    meta?: Record<string, unknown>,
  ) => {
    calls.push({ ok, payload, error, meta });
  };
  return { calls, respond };
}

describe("dispatchWithCoalescing — wire-up integration", () => {
  it("served-cache replays the actual payload (not undefined) — Rin finding [1]", async () => {
    const { clock, coalescer } = makeIntegration();
    const { calls: subscriberCalls, respond: subscriberRespond } = makeRecorder();
    const handler = vi.fn(async () => {});

    // First dispatch primes the SWR cache.
    const firstPayload = {
      models: [
        { id: "a", name: "Model A" },
        { id: "b", name: "Model B" },
      ],
    };
    await dispatchWithCoalescing({
      coalescer,
      method: "models.list",
      params: { sessionKey: "s1" },
      respond: subscriberRespond,
      runFresh: async (capturing) => {
        capturing(true, firstPayload);
      },
      diagnostics: { response: () => {} },
    });
    expect(handler).not.toHaveBeenCalled();
    expect(subscriberCalls).toHaveLength(1);
    expect(subscriberCalls[0]?.ok).toBe(true);
    expect(subscriberCalls[0]?.payload).toEqual(firstPayload);

    // Second dispatch within TTL: must serve from cache with real payload
    // (Rin flag [1]: served-cache was emitting `(true, undefined)`).
    clock.advance(500);
    subscriberCalls.length = 0;
    await dispatchWithCoalescing({
      coalescer,
      method: "models.list",
      params: { sessionKey: "s1" },
      respond: subscriberRespond,
      runFresh: async () => {
        throw new Error("handler must NOT run on served-cache hit");
      },
      diagnostics: { response: () => {} },
    });
    expect(subscriberCalls).toHaveLength(1);
    expect(subscriberCalls[0]?.ok).toBe(true);
    expect(subscriberCalls[0]?.payload).toEqual(firstPayload);
  });

  it("coalesced subscribers receive the producer's actual payload — Rin finding [2]", async () => {
    const { coalescer } = makeIntegration();
    const { calls: subscriberCalls, respond: subscriberRespond } = makeRecorder();
    const { calls: producerCalls, respond: producerRespond } = makeRecorder();

    const expectedPayload = { authed: ["openai", "anthropic"], count: 2 };

    let release: () => void = () => {};
    const producerGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const producerDone = dispatchWithCoalescing({
      coalescer,
      method: "models.authStatus",
      params: { provider: "all" },
      respond: producerRespond,
      runFresh: async (capturing) => {
        await producerGate;
        capturing(true, expectedPayload);
      },
      diagnostics: { response: () => {} },
    });

    // Yield enough microtasks for the producer to reach `await producerGate`.
    for (let i = 0; i < 5; i += 1) {
      await Promise.resolve();
    }

    // Start subscriber — DO NOT await yet; subscriber's dispatch will
    // suspend on the upstream in-flight promise, and awaiting would block
    // the test before `release()` is reached (deadlock).
    const subscriberDone = dispatchWithCoalescing({
      coalescer,
      method: "models.authStatus",
      params: { provider: "all" },
      respond: subscriberRespond,
      runFresh: async () => {
        throw new Error("handler must NOT run on coalesced subscriber");
      },
      diagnostics: { response: () => {} },
    });

    // Yield enough microtasks for the subscriber to attach to the in-flight record.
    for (let i = 0; i < 5; i += 1) {
      await Promise.resolve();
    }

    release();
    await Promise.allSettled([producerDone, subscriberDone]);

    expect(producerCalls).toHaveLength(1);
    expect(producerCalls[0]?.payload).toEqual(expectedPayload);

    // Rin finding [2]: previously this was `(true, undefined)`.
    expect(subscriberCalls).toHaveLength(1);
    expect(subscriberCalls[0]?.ok).toBe(true);
    expect(subscriberCalls[0]?.payload).toEqual(expectedPayload);
  });

  it("wire-up populates the SWR cache (recordOutcome called via dispatch) — Rin finding [1]", async () => {
    const { coalescer } = makeIntegration();
    const { calls, respond } = makeRecorder();
    const payload = { meta: { id: "x", revision: 5 } };

    // Drive dispatch and check cache state via a followup subscribe / decide.
    await dispatchWithCoalescing({
      coalescer,
      method: "chat.metadata",
      params: { sessionKey: "x" },
      respond,
      runFresh: async (capturing) => {
        capturing(true, payload);
      },
      diagnostics: { response: () => {} },
    });

    // The wire-up MUST have called recordOutcome so the cache is warm.
    // Verify by looking up via the public canonical key.
    const decision = coalescer.decide("chat.metadata", { sessionKey: "x" });
    expect(decision.kind).toBe("served-cache");
    if (decision.kind !== "served-cache") {
      throw new Error("expected served-cache");
    }
    const cached = coalescer.readCache(decision.key);
    expect(cached?.payload).toEqual(payload);
    // And the dispatch actually published the response.
    expect(calls[0]?.payload).toEqual(payload);
  });

  it("handler error path: runHandle rejects, subscribers see error — Rin supervisory", async () => {
    const { coalescer } = makeIntegration();
    const { calls: subscriberCalls, respond: subscriberRespond } = makeRecorder();
    const { calls: producerCalls, respond: producerRespond } = makeRecorder();

    const producerErr = new Error("upstream service unavailable");

    let release: () => void = () => {};
    const producerGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const producerDone = dispatchWithCoalescing({
      coalescer,
      method: "sessions.describe",
      params: { id: "abc" },
      respond: producerRespond,
      runFresh: async (capturing) => {
        await producerGate;
        capturing(false, undefined, { code: "UNAVAILABLE", message: producerErr.message });
      },
      diagnostics: { response: () => {} },
    });

    for (let i = 0; i < 5; i += 1) {
      await Promise.resolve();
    }

    const subscriberDone = dispatchWithCoalescing({
      coalescer,
      method: "sessions.describe",
      params: { id: "abc" },
      respond: subscriberRespond,
      runFresh: async () => {
        throw new Error("handler must NOT run on coalesced subscriber");
      },
      diagnostics: { response: () => {} },
    });

    for (let i = 0; i < 5; i += 1) {
      await Promise.resolve();
    }

    release();
    await Promise.allSettled([producerDone, subscriberDone]);

    expect(producerCalls).toHaveLength(1);
    expect(producerCalls[0]?.ok).toBe(false);
    expect((producerCalls[0]?.error as { code?: string } | undefined)?.code).toBe("UNAVAILABLE");

    expect(subscriberCalls).toHaveLength(1);
    expect(subscriberCalls[0]?.ok).toBe(false);
    expect((subscriberCalls[0]?.error as { code?: string } | undefined)?.code).toBe("UNAVAILABLE");
    expect((subscriberCalls[0]?.error as { message?: string } | undefined)?.message).toContain(
      "upstream service unavailable",
    );
  });

  it("handler exception (not respond-driven) propagates to subscribers as a respond call — Rin supervisory", async () => {
    const { coalescer } = makeIntegration();
    const { calls: subscriberCalls, respond: subscriberRespond } = makeRecorder();

    const producerErr = new Error("kaboom");

    let release: () => void = () => {};
    const producerGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    // Producer's exception is expected to reject — swallow it inside the dispatch
    // bridge so vitest doesn't flag it as an unhandled rejection.
    const producerDone = dispatchWithCoalescing({
      coalescer,
      method: "models.list",
      params: {},
      respond: vi.fn(),
      runFresh: async () => {
        await producerGate;
        throw producerErr;
      },
      diagnostics: { response: () => {} },
    }).catch(() => undefined);

    for (let i = 0; i < 5; i += 1) {
      await Promise.resolve();
    }

    const subscriberDone = dispatchWithCoalescing({
      coalescer,
      method: "models.list",
      params: {},
      respond: subscriberRespond,
      runFresh: async () => {
        throw new Error("handler must NOT run on coalesced subscriber");
      },
      diagnostics: { response: () => {} },
    });

    for (let i = 0; i < 5; i += 1) {
      await Promise.resolve();
    }

    release();
    await Promise.allSettled([producerDone, subscriberDone]);

    // The producer's runFresh was NOT captured into a respond frame (it threw);
    // the coalesced subscriber received a respond(false, error) translated from
    // the upstream rejection. Its own runFresh was NOT called (single-flight
    // preserved).
    expect(subscriberCalls).toHaveLength(1);
    expect(subscriberCalls[0]?.ok).toBe(false);
    const errRecord = subscriberCalls[0]?.error as { message?: string } | undefined;
    expect(errRecord?.message).toContain("kaboom");
  });

  it("diagnostics.response is emitted on every dispatch path — Rin MEDIUM", async () => {
    const { coalescer } = makeIntegration();
    const observed: string[] = [];
    const diagnostics = { response: (o: string) => observed.push(o) };

    // served-cache hit → "ok"
    const { respond: r1 } = makeRecorder();
    await dispatchWithCoalescing({
      coalescer,
      method: "models.list",
      params: { sessionKey: "a" },
      respond: r1,
      runFresh: async (capturing) => capturing(true, { models: [] }),
      diagnostics,
    });
    // served-cache again → "ok"
    const { respond: r2 } = makeRecorder();
    await dispatchWithCoalescing({
      coalescer,
      method: "models.list",
      params: { sessionKey: "a" },
      respond: r2,
      runFresh: async (capturing) => capturing(true, { models: [] }), // never called
      diagnostics,
    });
    // fresh path → "ok"
    const { respond: r3 } = makeRecorder();
    await dispatchWithCoalescing({
      coalescer,
      method: "models.list",
      params: { sessionKey: "b" },
      respond: r3,
      runFresh: async (capturing) => capturing(true, { models: [] }),
      diagnostics,
    });
    expect(observed).toEqual(["ok", "ok", "ok"]);
  });

  it("diagnostics.response('error') is emitted when the handler replies with ok=false", async () => {
    const { coalescer } = makeIntegration();
    const observed: string[] = [];
    await dispatchWithCoalescing({
      coalescer,
      method: "models.list",
      params: { sessionKey: "fail" },
      respond: makeRecorder().respond,
      runFresh: async (capturing) => capturing(false, undefined, { code: "X" }),
      diagnostics: { response: (o: string) => observed.push(o) },
    });
    expect(observed).toEqual(["error"]);
  });

  it("rate-limited path emits 'unavailable' and stops — Rin MEDIUM (regression)", async () => {
    const { coalescer } = makeIntegration({ rateLimitPerWindow: 1 });
    const observed: string[] = [];
    const { respond: r1 } = makeRecorder();
    await dispatchWithCoalescing({
      coalescer,
      method: "models.list",
      params: { i: 1 },
      respond: r1,
      runFresh: async (capturing) => capturing(true, {}),
      diagnostics: { response: (o: string) => observed.push(o) },
    });
    const { calls, respond: r2 } = makeRecorder();
    await dispatchWithCoalescing({
      coalescer,
      method: "models.list",
      params: { i: 2 },
      respond: r2,
      runFresh: async () => {
        throw new Error("handler must NOT run when rate-limited");
      },
      diagnostics: { response: (o: string) => observed.push(o) },
    });
    expect(observed).toContain("unavailable");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.ok).toBe(false);
  });

  it("non-coalesced method bypasses coalescer entirely (pass-through)", async () => {
    const { coalescer } = makeIntegration();
    const { calls, respond } = makeRecorder();
    let handlerCalled = 0;
    await dispatchWithCoalescing({
      coalescer,
      method: "chat.send",
      params: { turn: "x" },
      respond,
      runFresh: async (handlerRespond) => {
        handlerCalled++;
        handlerRespond(true, { ok: true });
      },
      diagnostics: { response: () => {} },
    });
    expect(handlerCalled).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.ok).toBe(true);
    // No SWR priming for non-coalesced methods.
    expect(coalescer.snapshot().cacheSize).toBe(0);
    expect(coalescer.snapshot().inFlight).toBe(0);
  });

  it("inFlight is cleared at handle settle (not just dispose) — Rin HIGH", async () => {
    const { coalescer } = makeIntegration();
    const observed: Array<{ phase: string; inFlight: number }> = [];

    observed.push({ phase: "before", inFlight: coalescer.snapshot().inFlight });

    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const dispatchDone = dispatchWithCoalescing({
      coalescer,
      method: "models.list",
      params: { a: 1 },
      respond: makeRecorder().respond,
      runFresh: async (capturing) => {
        await gate;
        observed.push({ phase: "mid-handler", inFlight: coalescer.snapshot().inFlight });
        capturing(true, { ok: 1 });
      },
      diagnostics: { response: () => {} },
    });

    // Yield enough microtasks for startRun + runFresh to reach `await gate`.
    for (let i = 0; i < 5; i += 1) {
      await Promise.resolve();
    }
    observed.push({ phase: "after-decide", inFlight: coalescer.snapshot().inFlight });

    release();
    await dispatchDone;
    observed.push({ phase: "after-handler", inFlight: coalescer.snapshot().inFlight });

    expect(observed.map((o) => o.inFlight)).toEqual([0, 1, 1, 0]);
  });

  it("inFlight is cleared at handle settle even on handler exception — Rin HIGH", async () => {
    const { coalescer } = makeIntegration();
    const dispatchDone = dispatchWithCoalescing({
      coalescer,
      method: "models.list",
      params: { a: 1 },
      respond: makeRecorder().respond,
      runFresh: async () => {
        throw new Error("boom");
      },
      diagnostics: { response: () => {} },
    }).catch(() => undefined); // we expect reject; swallow for the test
    await dispatchDone;
    expect(coalescer.snapshot().inFlight).toBe(0);
  });

  it("captureRespond captures + delegates; .reset() clears", () => {
    const original = vi.fn();
    const capturing = captureRespond(original);
    capturing(true, { x: 1 });
    expect(capturing.capture()).toEqual({
      ok: true,
      payload: { x: 1 },
      error: undefined,
      meta: undefined,
    });
    expect(original).toHaveBeenCalledOnce();
    expect(original).toHaveBeenCalledWith(true, { x: 1 }, undefined, undefined);

    capturing.reset();
    expect(capturing.capture()).toBeUndefined();
  });

  it("captureRespond + dispatchWithCoalescing: producer publishes once, cache populated", async () => {
    const { coalescer } = makeIntegration();
    const captured: Array<{ ok: boolean; payload?: unknown }> = [];
    const respond = (ok: boolean, payload?: unknown) => {
      captured.push({ ok, payload });
    };

    const expected = { items: [1, 2, 3] };
    await dispatchWithCoalescing({
      coalescer,
      method: "models.list",
      params: { p: "capture" },
      respond,
      runFresh: async (handlerRespond) => {
        // Real handler pattern: capture-and-publish via capturingRespond.
        const capturing = captureRespond(handlerRespond);
        capturing(true, expected);
        // Confirm capture happened
        expect(capturing.capture()?.payload).toEqual(expected);
      },
      diagnostics: { response: () => {} },
    });

    // respond() was called exactly once with the real payload.
    expect(captured).toEqual([{ ok: true, payload: expected }]);
    // Cache is warm for followup serves.
    const followupDecide = coalescer.decide("models.list", { p: "capture" });
    expect(followupDecide.kind).toBe("served-cache");
  });
});
