import { WorkerTaskError } from "../../infra/worker-task-pool.js";

/**
 * Wait briefly for transient worker admission pressure to drain.
 *
 * Retries only admission rejections with `code === "overloaded"`:
 * 25 ms initial delay, exponential growth capped at 1 s, ±50% jitter,
 * the request timeout as the total retry deadline, abort-signal support.
 * No worker-task or byte limit is raised here.
 */
export async function retrySessionHistoryAdmission<T>(
  admit: () => Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  let attempt = 0;
  while (true) {
    try {
      return await admit();
    } catch (error) {
      // SAFETY: admit() rejects with unknown cause; only errors shaped like
      // { code: "overloaded" } are retried — everything else rethrows unchanged.
      if ((error as { code?: unknown })?.code !== "overloaded") throw error;
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        throw new WorkerTaskError("worker task timed out", "timeout");
      }
      signal?.throwIfAborted();
      const delay = Math.min(
        remaining,
        Math.max(1, Math.min(1_000, 25 * 2 ** attempt) * (0.5 + Math.random())),
      );
      await new Promise<void>((resolve, reject) => {
        let timer: NodeJS.Timeout | undefined;
        const onAbort = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          reject(signal?.reason);
        };
        timer = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        }, delay);
        timer.unref?.();
        signal?.addEventListener("abort", onAbort, { once: true });
      });
      attempt++;
    }
  }
}
