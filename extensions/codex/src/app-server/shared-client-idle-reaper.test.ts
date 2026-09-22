import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getSharedClientPoolMetrics,
  releaseSharedClientEntry,
} from "./shared-client-idle-reaper.js";
import type {
  SharedCodexAppServerClientEntry,
  SharedCodexAppServerClientState,
} from "./shared-client-lifecycle.js";

function createState(): {
  entry: SharedCodexAppServerClientEntry;
  state: SharedCodexAppServerClientState;
  close: ReturnType<typeof vi.fn>;
} {
  const close = vi.fn();
  const entry = {
    key: "test",
    client: { close } as never,
    activeLeases: 0,
    anonymousLeases: 0,
    pendingAcquires: 0,
    closeWhenIdle: false,
    onStartedClientCallbacks: new Set(),
  } satisfies SharedCodexAppServerClientEntry;
  return {
    entry,
    state: {
      clients: new Map([[entry.key, entry]]),
      liveClients: new Set(),
      isolatedClients: new Set(),
      entriesByClient: new WeakMap(),
      desktopGenerationDrainChecks: new Set(),
      createdCount: 1,
      reapedCount: 0,
      startup: { controller: new AbortController(), pending: new Set() },
      startMetadata: new WeakMap(),
    },
    close,
  };
}

describe("shared Codex app-server idle reaper", () => {
  afterEach(() => vi.useRealTimers());

  it("reaps idle clients but leaves leased clients alone", async () => {
    vi.useFakeTimers();
    const { entry, state, close } = createState();
    releaseSharedClientEntry(entry, state, "activeLeases", vi.fn());
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(close).toHaveBeenCalledOnce();
    expect(getSharedClientPoolMetrics(state)).toMatchObject({ active: 0, idle: 0, reaped: 1 });
  });
});
