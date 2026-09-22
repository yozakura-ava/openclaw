import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import type {
  SharedCodexAppServerClientEntry,
  SharedCodexAppServerClientState,
} from "./shared-client-lifecycle.js";
import {
  clearSharedClientIdleReaper,
  closeRetiredSharedClientEntryIfIdle,
} from "./shared-client-lifecycle.js";

const CODEX_APP_SERVER_IDLE_REAP_TIMEOUT_MS = 5 * 60_000;

function scheduleSharedClientIdleReaper(params: {
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

function readSharedClientPoolMetrics(state: SharedCodexAppServerClientState): {
  created: number;
  active: number;
  idle: number;
  reaped: number;
} {
  let active = 0;
  let idle = 0;
  for (const entry of state.clients.values()) {
    if (!entry.client) {
      continue;
    }
    if (entry.activeLeases > 0 || entry.pendingAcquires > 0) {
      active += 1;
    } else {
      idle += 1;
    }
  }
  return { created: state.createdCount, active, idle, reaped: state.reapedCount };
}

function logSharedClientPoolMetrics(state: SharedCodexAppServerClientState, event: string): void {
  embeddedAgentLog.info("codex app-server process pool", {
    event,
    ...readSharedClientPoolMetrics(state),
  });
}

export function recordSharedClientCreated(state: SharedCodexAppServerClientState): void {
  state.createdCount += 1;
  logSharedClientPoolMetrics(state, "created");
}

export function resetSharedClientPoolMetrics(state: SharedCodexAppServerClientState): void {
  for (const entry of state.clients.values()) {
    clearSharedClientIdleReaper(entry);
  }
  state.createdCount = 0;
  state.reapedCount = 0;
}

export function retainSharedClientEntryWithIdleReaper(
  entry: SharedCodexAppServerClientEntry,
  state: SharedCodexAppServerClientState,
  counter: "activeLeases" | "pendingAcquires",
  notify: () => void,
): () => void {
  let released = false;
  clearSharedClientIdleReaper(entry);
  entry[counter] += 1;
  logSharedClientPoolMetrics(state, "leased");
  return () => {
    if (released) {
      return;
    }
    released = true;
    releaseSharedClientEntry(entry, state, counter, notify);
  };
}

export function releaseSharedClientEntry(
  entry: SharedCodexAppServerClientEntry,
  state: SharedCodexAppServerClientState,
  counter: "activeLeases" | "pendingAcquires",
  notify: () => void,
): void {
  entry[counter] = Math.max(0, entry[counter] - 1);
  closeRetiredSharedClientEntryIfIdle(entry);
  scheduleSharedClientIdleReaper({
    entry,
    state,
    onReaped: () => logSharedClientPoolMetrics(state, "idle_reaped"),
  });
  logSharedClientPoolMetrics(state, "released");
  notify();
}

export function getSharedClientPoolMetrics(state: SharedCodexAppServerClientState) {
  return readSharedClientPoolMetrics(state);
}
