import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import {
<<<<<<< HEAD
  isSqliteWorkerStoreAvailable,
  openSqliteWorkerStore,
  runSqliteWorkerStoreOperation,
  type SqliteWorkerStore,
} from "openclaw/plugin-sdk/sqlite-runtime";
=======
  resolveDatabaseEngineInput,
  openEngineWorkerStore,
  runEngineStoreOperation,
} from "openclaw/plugin-sdk/database-engine-runtime";
import { readSqliteDatabaseWriteTokenForPath } from "openclaw/plugin-sdk/sqlite-runtime";
>>>>>>> 97b6e87616f
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import type { WorkboardPersistence, WorkboardWriteAuthority } from "./persistence-types.js";
import type {
  WorkboardSqliteOperations,
  WorkboardSqliteWorkerOperations,
} from "./sqlite-store-contract.js";
import { unwrapWorkboardSqliteResult } from "./sqlite-store-errors.js";

type WorkboardSqliteStores = WorkboardPersistence & {
  ready: Promise<void>;
  readWriteToken(this: void): string | undefined;
  close(this: void): Promise<void>;
  runWithWriteAuthority: WorkboardWriteAuthority;
};

export function createWorkboardSqliteStores(options: {
  config?: Parameters<typeof resolveDatabaseEngineInput>[0];
  dbPath?: string;
  workerModuleUrl: URL;
}): WorkboardSqliteStores {
  const databasePath = path.resolve(
    options.dbPath ?? path.join(resolveStateDir(), "plugins", "workboard", "workboard.sqlite"),
  );
<<<<<<< HEAD
  const workerOptions = {
    moduleUrl: options.workerModuleUrl,
    databasePath,
    input: undefined,
  } as const;
  let worker = openSqliteWorkerStore<WorkboardSqliteWorkerOperations>(workerOptions);
  let ownedConnection: number | undefined;
  let brokerClosed = false;
  let brokerCleanup = false;
=======
  const selectedDatabase = resolveDatabaseEngineInput(options.config ?? {});
  const worker = selectedDatabase.then((input) =>
    openEngineWorkerStore<WorkboardSqliteWorkerOperations>(
      {
        moduleUrl: options.workerModuleUrl,
        databasePath,
        input,
      },
      input,
    ),
  );
>>>>>>> 97b6e87616f
  let sealed = false;
  let closing: Promise<void> | undefined;
  let reopening: Promise<void> | undefined;
  const operations = new Set<Promise<unknown>>();
  const writeAuthority = new AsyncLocalStorage<{ active: boolean; assertCurrent?: () => void }>();
<<<<<<< HEAD
  async function cleanup() {
    // Rejected admission stays broker-owned; this facade received no lease to release.
    const store = await worker.catch(() => undefined);
    if (!store) {
      return;
    }
    if (ownedConnection !== undefined && !brokerCleanup) {
      const result = await store
        .execute({ type: "connection.close", input: { connection: ownedConnection } })
        .catch((error: unknown) => {
          const code = extractErrorCode(error);
          if (code === "closed" || code === "unavailable" || code === "outcome-unknown") {
            // Terminal transport cleanup belongs to the broker's joined retirement.
            brokerCleanup = true;
            return undefined;
          }
          throw error;
        });
      if (result !== undefined) {
        unwrapWorkboardSqliteResult(result);
        ownedConnection = undefined;
      }
    }
    if (!brokerClosed) {
      await store.close();
      brokerClosed = true;
      ownedConnection = undefined;
    }
  }
  async function openConnection(
    store: SqliteWorkerStore<WorkboardSqliteWorkerOperations>,
  ): Promise<{
    connection: number;
    dataVersion: number;
    store: SqliteWorkerStore<WorkboardSqliteWorkerOperations>;
  }> {
    const result = await store.execute({ type: "connection.open", input: undefined });
    if (result.ok) {
      ownedConnection = result.value.connection;
      return { ...result.value, store };
    }
    ownedConnection = result.failure.cleanupConnection;
    const value =
      unwrapWorkboardSqliteResult<WorkboardSqliteOperations["connection.open"]["output"]>(result);
    return { ...value, store };
  }
  let opened = worker.then(openConnection).catch(async (error: unknown) => {
    openingFailure = { error };
    sealed = true;
    if (ownedConnection === undefined) {
      try {
        await cleanup();
      } catch {
        /* Explicit close retains the failed broker cleanup. */
      }
    }
    throw error;
  });
  async function currentOpened() {
    const current = await worker;
    if (isSqliteWorkerStoreAvailable(current)) {
      return opened;
    }
    reopening ??= (async () => {
      await current.close();
      const candidate = await openSqliteWorkerStore<WorkboardSqliteWorkerOperations>(workerOptions);
      ownedConnection = undefined;
      brokerClosed = false;
      brokerCleanup = false;
      const candidateOpened = await openConnection(candidate);
      worker = Promise.resolve(candidate);
      opened = Promise.resolve(candidateOpened);
    })().finally(() => {
      reopening = undefined;
    });
    await reopening;
    return opened;
  }
  const ready = opened.then((value) => value.dataVersion);
=======
  const ready = worker.then(() => undefined);
>>>>>>> 97b6e87616f
  void ready.catch(() => {});
  async function execute<K extends keyof WorkboardSqliteOperations>(
    type: K,
    input: WorkboardSqliteOperations[K]["input"],
    writes = false,
  ): Promise<WorkboardSqliteOperations[K]["output"]> {
    const authority = writes ? writeAuthority.getStore() : undefined;
<<<<<<< HEAD
    const { store } = await currentOpened();
    if (!authority) {
      return unwrapWorkboardSqliteResult(await store.execute({ type, input }));
    }
=======
    const store = await worker;
>>>>>>> 97b6e87616f
    const result = unwrapWorkboardSqliteResult(
      await runEngineStoreOperation(
        store,
        await selectedDatabase,
        writes,
        (scope) => scope.execute({ type, input }),
        authority
          ? () => {
              if (!authority.active) {
                throw new Error("Workboard mutation authority has settled.");
              }
              authority.assertCurrent?.();
            }
          : undefined,
        databasePath,
      ),
    );
    // A rejected comparison has accepted no mutation; a retry still needs authority.
    if (authority && result !== false && result !== "conflict" && result !== "owner_busy") {
      authority.assertCurrent = undefined;
    }
    return result;
  }
  async function run<T>(operation: () => Promise<T>): Promise<T> {
    if (sealed) {
      throw new Error("Workboard SQLite connection is closed.");
    }
<<<<<<< HEAD
    const captured = structuredClone(args);
    const pending = currentOpened().then(({ connection }) => operation(connection, captured));
=======
    const pending = operation();
>>>>>>> 97b6e87616f
    operations.add(pending);
    try {
      return await pending;
    } finally {
      operations.delete(pending);
    }
  }
  function bindOperation<K extends keyof WorkboardSqliteOperations>(type: K, writes = false) {
    return (...args: WorkboardSqliteOperations[K]["input"]["args"]) =>
      run(() => execute(type, { args }, writes));
  }
  return {
    async runWithWriteAuthority(assertCurrent, operation) {
      const authority: { active: boolean; assertCurrent?: () => void } = {
        active: true,
        assertCurrent,
      };
      try {
        return await writeAuthority.run(authority, operation);
      } finally {
        authority.active = false;
      }
    },
    ready,
    readWriteToken: () => readSqliteDatabaseWriteTokenForPath(databasePath),
    cards: {
      register: bindOperation("cards.register", true),
      registerIfAbsent: bindOperation("cards.registerIfAbsent", true),
      registerIfUpdatedAt: bindOperation("cards.registerIfUpdatedAt", true),
      claimIfOwnerAvailable: bindOperation("cards.claimIfOwnerAvailable", true),
      deleteIfUpdatedAt: bindOperation("cards.deleteIfUpdatedAt", true),
      lookup: bindOperation("cards.lookup"),
      delete: bindOperation("cards.delete", true),
      entries: bindOperation("cards.entries"),
      listCardStatuses: bindOperation("cards.listCardStatuses"),
      listBoardAggregates: bindOperation("cards.listBoardAggregates"),
      listStatsAggregates: bindOperation("cards.listStatsAggregates"),
      hasCards: bindOperation("cards.hasCards"),
    },
    boards: {
      register: bindOperation("boards.register", true),
      lookup: bindOperation("boards.lookup"),
      delete: bindOperation("boards.delete", true),
      entries: bindOperation("boards.entries"),
    },
    sessionsBoard: {
      get: bindOperation("sessionsBoard.get"),
      update: bindOperation("sessionsBoard.update", true),
      listPlacements: bindOperation("sessionsBoard.listPlacements"),
      repairPlacements: bindOperation("sessionsBoard.repairPlacements", true),
      writePlacement: bindOperation("sessionsBoard.writePlacement", true),
    },
    subscriptions: {
      register: bindOperation("subscriptions.register", true),
      lookup: bindOperation("subscriptions.lookup"),
      delete: bindOperation("subscriptions.delete", true),
      entries: bindOperation("subscriptions.entries"),
    },
    attachments: {
      register: bindOperation("attachments.register", true),
      lookup: bindOperation("attachments.lookup"),
      delete: bindOperation("attachments.delete", true),
      entries: bindOperation("attachments.entries"),
    },
    close() {
      sealed = true;
      closing ??= Promise.resolve()
        .then(async () => {
          while (operations.size) {
            await Promise.allSettled(operations);
          }
          const store = await worker.catch(() => undefined);
          await store?.close();
        })
        .catch((error: unknown) => {
          closing = undefined;
          throw error;
        });
      return closing;
    },
  };
}
