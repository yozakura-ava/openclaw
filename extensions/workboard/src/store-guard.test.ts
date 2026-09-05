import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkboardStoreGuard } from "./store-guard.js";
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
});
