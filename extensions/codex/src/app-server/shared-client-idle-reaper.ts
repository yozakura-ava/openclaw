import type {
  SharedCodexAppServerClientEntry,
  SharedCodexAppServerClientState,
} from "./shared-client-lifecycle.js";

export const CODEX_APP_SERVER_IDLE_REAP_TIMEOUT_MS = 5 * 60_000;

export function scheduleSharedClientIdleReaper(params: {
  entry: SharedCodexAppServerClientEntry;
  state: SharedCodexAppServerClientState;
  onReaped: () => void;
}): void {
  const { entry, state } = params;
  if (
    entry.activeLeases > 0 ||
    entry.pendingAcquires > 0 ||
    !entry.client ||
    entry.closeWhenIdle ||
    entry.closeError ||
    entry.idleReaper
  ) {
    return;
  }
  if (state.clients.get(entry.key) !== entry) {
    return;
  }
  entry.idleReaper = setTimeout(() => {
    entry.idleReaper = undefined;
    if (
      state.clients.get(entry.key) !== entry ||
      entry.activeLeases > 0 ||
      entry.pendingAcquires > 0 ||
      !entry.client ||
      entry.closeWhenIdle ||
      entry.closeError
    ) {
      return;
    }
    state.clients.delete(entry.key);
    state.reapedCount += 1;
    entry.client.close();
    params.onReaped();
  }, CODEX_APP_SERVER_IDLE_REAP_TIMEOUT_MS);
  entry.idleReaper.unref?.();
}

export function readSharedClientPoolMetrics(state: SharedCodexAppServerClientState): {
  created: number;
  active: number;
  idle: number;
  reaped: number;
} {
  let active = 0;
  let idle = 0;
  for (const entry of state.clients.values()) {
    if (!entry.client) continue;
    if (entry.activeLeases > 0 || entry.pendingAcquires > 0) active += 1;
    else idle += 1;
  }
  return { created: state.createdCount, active, idle, reaped: state.reapedCount };
}
