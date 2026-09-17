/**
 * Watchdog and supervisor key helpers for CLI runner reliability.
 */
import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CliBackendConfig } from "../../plugins/cli-backend.types.js";
import {
  CLI_FRESH_WATCHDOG_DEFAULTS,
  CLI_RESUME_WATCHDOG_DEFAULTS,
  CLI_WATCHDOG_BEHAVIOR_DEFAULTS,
  CLI_WATCHDOG_MIN_TIMEOUT_MS,
} from "../cli-watchdog-defaults.js";
import type { EmbeddedRunTrigger } from "../embedded-agent-runner/run/params.js";
import { AGENT_LANE_SUBAGENT } from "../lanes.js";

function pickWatchdogProfile(
  backend: CliBackendConfig,
  useResume: boolean,
  trigger?: EmbeddedRunTrigger,
  hasExplicitRunTimeout?: boolean,
): {
  noOutputTimeoutMs?: number;
  noOutputTimeoutRatio: number;
  minMs: number;
  maxMs: number;
  extendOnModelCallMs: number;
} {
  const configured = useResume
    ? backend.reliability?.watchdog?.resume
    : backend.reliability?.watchdog?.fresh;
  const defaults =
    useResume && !configured && (trigger === "cron" || hasExplicitRunTimeout === true)
      ? CLI_FRESH_WATCHDOG_DEFAULTS
      : useResume
        ? CLI_RESUME_WATCHDOG_DEFAULTS
        : CLI_FRESH_WATCHDOG_DEFAULTS;

  const ratio = (() => {
    const value = configured?.noOutputTimeoutRatio;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return defaults.noOutputTimeoutRatio;
    }
    return Math.max(0.05, Math.min(0.95, value));
  })();
  const minMs = (() => {
    const value = configured?.minMs;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return defaults.minMs;
    }
    return Math.max(CLI_WATCHDOG_MIN_TIMEOUT_MS, Math.floor(value));
  })();
  const maxMs = (() => {
    const value = configured?.maxMs;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return defaults.maxMs;
    }
    return Math.max(CLI_WATCHDOG_MIN_TIMEOUT_MS, Math.floor(value));
  })();
  const fixedNoOutputTimeoutMs = (() => {
    const value = configured?.noOutputTimeoutMs;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return undefined;
    }
    return Math.max(CLI_WATCHDOG_MIN_TIMEOUT_MS, Math.floor(value));
  })();
  const extendOnModelCallMs = (() => {
    const value = configured?.extendOnModelCallMs;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return defaults.extendOnModelCallMs;
    }
    return Math.max(0, Math.floor(value));
  })();

  return {
    noOutputTimeoutMs: fixedNoOutputTimeoutMs,
    noOutputTimeoutRatio: ratio,
    minMs: Math.min(minMs, maxMs),
    maxMs: Math.max(minMs, maxMs),
    extendOnModelCallMs,
  };
}

/** Resolves the no-output watchdog timeout for a fresh or resumed CLI run. */
export function resolveCliNoOutputTimeoutMs(params: {
  backend: CliBackendConfig;
  timeoutMs: number;
  useResume: boolean;
  expectedQuiet?: boolean;
  trigger?: EmbeddedRunTrigger;
  runTimeoutOverrideMs?: number;
  /**
   * #126 mitigation: when true, the caller is waiting on a slow-starting
   * provider (model call dispatched, no first response yet). Watchdog
   * extends its threshold so a legitimate slow-start is not aborted as a
   * dead CLI. Defaults to false.
   */
  modelCallInFlight?: boolean;
}): number {
  if (params.expectedQuiet) {
    // Expected-quiet controls have no earlier liveness signal; the caller's
    // overall operation timeout remains their authoritative execution budget.
    return params.timeoutMs;
  }
  const hasExplicitRunTimeout =
    typeof params.runTimeoutOverrideMs === "number" &&
    Number.isFinite(params.runTimeoutOverrideMs) &&
    params.runTimeoutOverrideMs > 0;
  const profile = pickWatchdogProfile(
    params.backend,
    params.useResume,
    params.trigger,
    hasExplicitRunTimeout,
  );
  // Keep watchdog below global timeout in normal cases.
  const cap = Math.max(CLI_WATCHDOG_MIN_TIMEOUT_MS, params.timeoutMs - 1_000);
  const base = (() => {
    if (profile.noOutputTimeoutMs !== undefined) {
      return profile.noOutputTimeoutMs;
    }
    const computed = Math.floor(params.timeoutMs * profile.noOutputTimeoutRatio);
    return Math.min(profile.maxMs, Math.max(profile.minMs, computed));
  })();
  const extended =
    params.modelCallInFlight === true && profile.extendOnModelCallMs > 0
      ? base + profile.extendOnModelCallMs
      : base;
  return Math.min(extended, cap);
}

/**
 * Resolves the watchdog behavior flags introduced for #126 mitigation.
 * Both flags have explicit defaults so existing configs pick them up
 * without operator changes; per-backend overrides win when set.
 */
export function resolveCliWatchdogBehavior(backend: CliBackendConfig): {
  emitAbortLifecycleEvent: boolean;
  disableSilentRedispatch: boolean;
} {
  return {
    emitAbortLifecycleEvent:
      backend.reliability?.watchdog?.emitAbortLifecycleEvent ??
      CLI_WATCHDOG_BEHAVIOR_DEFAULTS.emitAbortLifecycleEvent,
    disableSilentRedispatch:
      backend.reliability?.watchdog?.disableSilentRedispatch ??
      CLI_WATCHDOG_BEHAVIOR_DEFAULTS.disableSilentRedispatch,
  };
}

export function resolveCliRunTimeoutOverrideMs(params: {
  config?: OpenClawConfig;
  lane?: string;
  timeoutMs: number;
  runTimeoutOverrideMs?: number;
}): number | undefined {
  if (params.runTimeoutOverrideMs !== undefined) {
    return params.runTimeoutOverrideMs;
  }
  const configuredTimeoutSeconds = params.config?.agents?.defaults?.timeoutSeconds;
  const hasConfiguredTimeout =
    params.lane !== AGENT_LANE_SUBAGENT &&
    typeof configuredTimeoutSeconds === "number" &&
    Number.isFinite(configuredTimeoutSeconds) &&
    configuredTimeoutSeconds > 0;
  return hasConfiguredTimeout ? params.timeoutMs : undefined;
}

/** Builds a supervisor scope key for session-owned CLI processes. */
export function buildCliSupervisorScopeKey(params: {
  backend: CliBackendConfig;
  backendId: string;
  cliSessionId?: string;
}): string | undefined {
  const commandToken = normalizeLowercaseStringOrEmpty(path.basename(params.backend.command ?? ""));
  const backendToken = normalizeLowercaseStringOrEmpty(params.backendId);
  const sessionToken = params.cliSessionId?.trim();
  if (!sessionToken) {
    return undefined;
  }
  return `cli:${backendToken}:${commandToken}:${sessionToken}`;
}
