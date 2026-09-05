import type { OpenClawPluginService } from "../api.js";
import type { WorkboardStore } from "./store.js";

const WORKBOARD_STORE_GUARD_INTERVAL_MS = 15_000;

/**
 * Keeps the Workboard SQLite authority live independently of gateway_start.
 * The gateway event is useful for session reconciliation, but it is not a
 * safe prerequisite for a database guard: a plugin can be registered after
 * that event or an in-process restart can skip the callback entirely.
 */
export function createWorkboardStoreAuthorityGuard(store: WorkboardStore): OpenClawPluginService & {
  startGuard: (logger: { warn: (message: string) => void }) => void;
  stop: () => void;
} {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  let started = false;

  const schedule = (owner: number, logger: { warn: (message: string) => void }) => {
    if (generation !== owner) {
      return;
    }
    timer = setTimeout(() => void probe(owner, logger), WORKBOARD_STORE_GUARD_INTERVAL_MS);
    timer.unref?.();
  };

  const probe = async (owner: number, logger: { warn: (message: string) => void }) => {
    if (generation !== owner) {
      return;
    }
    try {
      if (typeof store.probeSqliteAuthority !== "function") {
        throw new Error("workboard SQLite authority probe is unavailable");
      }
      await store.probeSqliteAuthority();
    } catch (error) {
      const recovered =
        typeof store.recoverSqliteAuthority === "function" ? store.recoverSqliteAuthority() : false;
      logger.warn(
        `workboard SQLite authority probe failed; recovery=${recovered ? "succeeded" : "scheduled_or_failed"}: ${String(error)}`,
      );
    } finally {
      schedule(owner, logger);
    }
  };

  return {
    id: "workboard-sqlite-authority-guard",
    startGuard(logger) {
      if (started) {
        return;
      }
      started = true;
      const owner = ++generation;
      void probe(owner, logger);
    },
    start(ctx) {
      this.startGuard(ctx.logger);
    },
    stop() {
      generation += 1;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}
