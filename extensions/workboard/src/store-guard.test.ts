import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGuardedWorkboardStore,
  isWorkboardStoreAvailabilityError,
  WorkboardStoreGuard,
  type WorkboardStoreFailure,
} from "./store-guard.js";
import { WorkboardStore } from "./store.js";

afterEach(() => vi.useRealTimers());

describe("WorkboardStoreGuard", () => {
  it("fails closed on a malformed database and recovers after a valid replacement", async () => {
    vi.useFakeTimers();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-workboard-guard-"));
    const dbPath = path.join(directory, "workboard.sqlite");
    fs.writeFileSync(dbPath, "not a sqlite database", "utf8");
    const warn = vi.fn();
    const guard = new WorkboardStoreGuard({
      open: () => WorkboardStore.openSqlite({ dbPath }),
      retryDelayMs: 10,
      maxRetryDelayMs: 20,
    });

    try {
      guard.start({ warn });
      expect(guard.isAvailable()).toBe(false);
      expect(warn).toHaveBeenCalled();

      fs.rmSync(dbPath, { force: true });
      await vi.advanceTimersByTimeAsync(10);

      expect(guard.isAvailable()).toBe(true);
      guard.stop();
      expect(guard.isAvailable()).toBe(false);
    } finally {
      guard.stop();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("uses one bounded retry lane instead of retrying on every lifecycle event", async () => {
    vi.useFakeTimers();
    const open = vi.fn(() => {
      throw new Error("database unavailable");
    });
    const guard = new WorkboardStoreGuard({
      open,
      retryDelayMs: 10,
      maxRetryDelayMs: 20,
    });

    guard.start({ warn: vi.fn() });
    expect(open).toHaveBeenCalledTimes(1);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      guard.get();
    }
    expect(open).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10);
    expect(open).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(19);
    expect(open).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(open).toHaveBeenCalledTimes(3);
    guard.stop();
  });

  it("classifies SQLite availability narrowly and records structured failure context", () => {
    expect(
      isWorkboardStoreAvailabilityError(Object.assign(new Error("busy"), { code: "SQLITE_BUSY" })),
    ).toBe(true);
    expect(isWorkboardStoreAvailabilityError(new Error("card is claimed by another agent"))).toBe(
      false,
    );
    expect(
      isWorkboardStoreAvailabilityError(new Error("schema validation failed for card input")),
    ).toBe(false);

    const failures: WorkboardStoreFailure[] = [];
    const store = new WorkboardStore({
      async register() {},
      async lookup() {},
      async delete() {
        return false;
      },
      async entries() {
        return [];
      },
    });
    const guard = new WorkboardStoreGuard({
      open: () => store,
      onFailure: (failure) => failures.push(failure),
    });
    guard.start({ warn: vi.fn() });
    guard.reportFailure(new Error("card is claimed by another agent"), {
      operation: "forceClose",
      source: "tool",
    });
    expect(guard.isAvailable()).toBe(true);
    guard.reportFailure(Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }), {
      operation: "forceClose",
      source: "tool",
    });
    expect(guard.isAvailable()).toBe(false);
    expect(failures.at(-1)).toMatchObject({
      operation: "forceClose",
      errorCode: "SQLITE_BUSY",
      source: "tool",
      availabilityFailure: true,
      storeGeneration: 1,
    });
    guard.stop();
  });

  it("probes a replacement before notifying lifecycle services", async () => {
    vi.useFakeTimers();
    const warn = vi.fn();
    const available = vi.fn();
    let probeAttempts = 0;
    const store = {
      checkHealth: () => {
        probeAttempts += 1;
        if (probeAttempts === 1) {
          throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
        }
      },
      close: vi.fn(),
    } as unknown as WorkboardStore;
    const guard = new WorkboardStoreGuard({
      open: () => store,
      retryDelayMs: 10,
    });
    guard.onAvailable(available);
    guard.start({ warn });
    expect(guard.isAvailable()).toBe(false);
    expect(available).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10);
    expect(guard.isAvailable()).toBe(true);
    expect(available).toHaveBeenCalledTimes(1);
    expect(probeAttempts).toBe(2);
    guard.stop();
  });

  it("keeps gateway and tool proxies on the same guarded store generation", async () => {
    const store = new WorkboardStore({
      async register() {},
      async lookup() {},
      async delete() {
        return false;
      },
      async entries() {
        return [];
      },
    });
    const guard = new WorkboardStoreGuard({ open: () => store });
    guard.start({ warn: vi.fn() });
    const gatewayStore = createGuardedWorkboardStore(guard, "gateway");
    const toolStore = createGuardedWorkboardStore(guard, "tool");
    await expect(gatewayStore.list()).resolves.toEqual([]);
    await expect(toolStore.list()).resolves.toEqual([]);
    expect(guard.get()).toBe(store);
    guard.stop();
  });
});
