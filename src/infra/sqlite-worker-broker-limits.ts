import { racePromiseWithAbortSignal } from "./abort-signal.js";

export const SQLITE_WORKER_MAX_REQUESTS_PER_WORKER = 128;
export const limits = Object.freeze({
  maxRequestsPerWorker: SQLITE_WORKER_MAX_REQUESTS_PER_WORKER,
  maxQueuedBytes: 256 * 1024 * 1024,
  maxStores: 64,
  maxQueuedCommandBytes: 64 * 1024 * 1024,
});

export function waitForSqliteOpen<T>(pending: Promise<T>, signal?: AbortSignal) {
  return racePromiseWithAbortSignal(pending, signal, (aborted) => aborted.reason);
}
