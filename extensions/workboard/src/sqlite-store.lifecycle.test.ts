import { deserialize, serialize } from "node:v8";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  encodeWorkboardSqliteFailure,
  unwrapWorkboardSqliteResult,
  type WorkboardSqliteResult,
} from "./sqlite-store-errors.js";

<<<<<<< HEAD
const { isSqliteWorkerStoreAvailable, openSqliteWorkerStore } = vi.hoisted(() => ({
  isSqliteWorkerStoreAvailable: vi.fn(() => false),
  openSqliteWorkerStore: vi.fn(),
}));
vi.mock(import("openclaw/plugin-sdk/sqlite-runtime"), async (importOriginal) => ({
  ...(await importOriginal()),
  isSqliteWorkerStoreAvailable,
  openSqliteWorkerStore,
=======
const { openEngineWorkerStore } = vi.hoisted(() => ({ openEngineWorkerStore: vi.fn() }));
vi.mock(import("openclaw/plugin-sdk/database-engine-runtime"), async (importOriginal) => ({
  ...(await importOriginal()),
  openEngineWorkerStore,
>>>>>>> 97b6e87616f
}));
import { createWorkboardSqliteStores } from "./test/database-config.js";

const workerModuleUrl = new URL("./sqlite-store.worker.ts", import.meta.url);
beforeEach(() => {
  openEngineWorkerStore.mockReset();
});

function workerFixture() {
  const execute = vi.fn<() => Promise<WorkboardSqliteResult<unknown>>>();
  const close = vi.fn(async () => {});
  openEngineWorkerStore.mockResolvedValue({ execute, close });
  const stores = createWorkboardSqliteStores({
    dbPath: "/unused-workboard-lifecycle.sqlite",
    workerModuleUrl,
  });
  return { execute, close, stores };
}

<<<<<<< HEAD
beforeEach(() => {
  isSqliteWorkerStoreAvailable.mockReset().mockReturnValue(false);
  openSqliteWorkerStore.mockReset();
});

describe("Workboard SQLite facade cleanup", () => {
  it("retains its broker reference until the same connection closes successfully", async () => {
    // Model the successfully registered worker returned by workerFixture.
    isSqliteWorkerStoreAvailable.mockReturnValue(true);
    const lookupResult = createDeferred<WorkboardSqliteResult<unknown>>();
    const firstClose = createDeferred<WorkboardSqliteResult<unknown>>();
    const failure = new SqliteWorkerError("connection cleanup failed", "unavailable");
    const { execute, release, stores } = workerFixture();
    execute
      .mockResolvedValueOnce({ ok: true, value: { connection: 7, dataVersion: 4 } })
      .mockImplementationOnce(() => lookupResult.promise)
      .mockImplementationOnce(() => firstClose.promise)
      .mockResolvedValueOnce({ ok: true, value: undefined });
    await expect(stores.ready).resolves.toBe(4);
=======
describe("Workboard SQLite facade cleanup", () => {
  it("drains accepted operations before releasing the broker and seals later calls", async () => {
    const result = createDeferred<WorkboardSqliteResult<unknown>>();
    const { execute, close, stores } = workerFixture();
    execute.mockImplementation(() => result.promise);
    await stores.ready;
>>>>>>> 97b6e87616f
    const lookup = stores.cards.lookup("missing");
    const closing = stores.close();
    expect(stores.close()).toBe(closing);
    await expect(stores.cards.lookup("late")).rejects.toThrow("closed");
    expect(close).not.toHaveBeenCalled();
    result.resolve({ ok: true, value: undefined });
    await expect(lookup).resolves.toBeUndefined();
    await closing;
    await stores.close();
    expect(close).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
  });

  it("retains failed broker cleanup for explicit close retry", async () => {
    const { close, stores } = workerFixture();
    const failure = new Error("broker cleanup failed");
    close.mockRejectedValueOnce(failure);
    await stores.ready;
    await expect(stores.close()).rejects.toBe(failure);
    await expect(stores.boards.entries()).rejects.toThrow("closed");
    await stores.close();
    await stores.close();
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("preserves initial admission failure without inventing a lease to release", async () => {
    const failure = new Error("store initialization failed");
    openEngineWorkerStore.mockRejectedValue(failure);
    const stores = createWorkboardSqliteStores({
      dbPath: "/unused-workboard-lifecycle.sqlite",
      workerModuleUrl,
    });
    await expect(stores.ready).rejects.toBe(failure);
    await expect(stores.cards.entries()).rejects.toBe(failure);
    await stores.close();
    expect(openEngineWorkerStore).toHaveBeenCalledOnce();
  });

  it("preserves aggregate error order, cause, and SQLite fields through V8 serialization", () => {
    const sqlite = Object.assign(new Error("write failed"), {
      name: "StorageFixtureError",
      code: "SQLITE_CONSTRAINT",
      errcode: 19,
      errstr: "constraint failed",
    });
    const failure = new AggregateError(
      [sqlite, new TypeError("cleanup failed")],
      "write and cleanup failed",
      {
        cause: sqlite,
      },
    );
    const encoded: WorkboardSqliteResult<never> = {
      ok: false,
      failure: encodeWorkboardSqliteFailure(failure),
    };
    const transported: WorkboardSqliteResult<never> = deserialize(serialize(encoded));
    let decoded: unknown;
    try {
      unwrapWorkboardSqliteResult(transported);
    } catch (error) {
      decoded = error;
    }
    if (!(decoded instanceof AggregateError)) {
      throw new Error("Expected the transported aggregate failure");
    }
    expect(decoded.message).toBe("write and cleanup failed");
    expect(decoded.errors).toHaveLength(2);
    expect(decoded.errors[0]).toMatchObject({
      name: "StorageFixtureError",
      message: "write failed",
      code: "SQLITE_CONSTRAINT",
      errcode: 19,
      errstr: "constraint failed",
    });
    expect(decoded.errors[1]).toBeInstanceOf(TypeError);
    expect(decoded.errors[1].message).toBe("cleanup failed");
    expect(decoded.cause).toBe(decoded.errors[0]);
  });
});
