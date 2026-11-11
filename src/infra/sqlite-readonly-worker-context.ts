import { AsyncLocalStorage } from "node:async_hooks";
import type { SqliteReadOnlyWorkerSession } from "./sqlite-readonly-worker-session-types.js";

export type SqliteReadOnlyWorkerScope = {
  active: boolean;
  busy: boolean;
  controller: AbortController;
  pending: Set<Promise<unknown>>;
  deadlineOwnedByCaller: boolean;
  worker?: SqliteReadOnlyWorkerSession;
  releaseReadWorker?: () => Promise<void>;
};
export const readOnlyWorkerScope = new AsyncLocalStorage<SqliteReadOnlyWorkerScope>();

/** Reuse child imports until the lifecycle owner closes; reads reacquire source admission. */
export function createSqliteReadOnlyWorkerScope(options?: {
  signal: AbortSignal;
  deadlineOwnedByCaller: boolean;
}) {
  const scope: SqliteReadOnlyWorkerScope = {
    active: true,
    busy: false,
    controller: new AbortController(),
    pending: new Set(),
    deadlineOwnedByCaller: options?.deadlineOwnedByCaller ?? false,
<<<<<<< HEAD
    readTail: Promise.resolve(),
=======
>>>>>>> 97b6e87616f
  };
  const abort = () => scope.controller.abort(options?.signal.reason);
  options?.signal.addEventListener("abort", abort, { once: true });
  if (options?.signal.aborted) {
    abort();
  }
  let closing: Promise<void> | undefined;
  return {
    run<T>(operation: () => T): T {
      return readOnlyWorkerScope.run(scope, operation);
    },
    close(): Promise<void> {
      closing ??= (async () => {
        options?.signal.removeEventListener("abort", abort);
        scope.active = false;
        scope.controller.abort(new Error("SQLite read-only worker scope closed"));
        await Promise.allSettled(scope.pending);
        const closed = await Promise.allSettled([
          scope.worker?.close(),
<<<<<<< HEAD
          scope.readWorker?.session.close(),
=======
          scope.releaseReadWorker?.(),
>>>>>>> 97b6e87616f
        ]);
        const failures = closed.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (failures.length > 0) {
          throw new AggregateError(failures, "SQLite read-only worker scope cleanup failed");
        }
      })();
      return closing;
    },
  };
}

/** Carry the owning readers into callbacks without retaining startup or request authority. */
export function captureSqliteReadOnlyWorkerScope(): <T>(operation: () => T) => T {
  const scope = readOnlyWorkerScope.getStore();
  return (operation) => {
    if (!scope) {
      return readOnlyWorkerScope.exit(operation);
    }
    if (!scope.active) {
      throw new Error("SQLite read-only worker scope closed");
    }
    scope.controller.signal.throwIfAborted();
    return readOnlyWorkerScope.run(scope, operation);
  };
}
