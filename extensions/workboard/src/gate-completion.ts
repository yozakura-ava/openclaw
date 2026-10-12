import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AnyAgentTool, OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

const execFileAsync = promisify(execFile);

/**
 * Workboard completion gate — Phase 0 scaffold (default-off).
 *
 * Phase 0 adds the plugin seam only. With `completionGate` absent or
 * `enabled: false`, every assertion returns `admitted` without spawning a
 * process, so plugin behavior is byte-identical to stock upstream. The
 * enforcement decision for an admitted terminal transition lands in the
 * follow-up card.
 *
 * Config schema (`completionGate`):
 * - `enabled` (boolean, default false): master switch. Absent config = stock
 *   upstream behavior.
 * - `mainRoot` (string, optional): config-declared canonical main checkout
 *   root. Never derived from the caller's workspace: a worktree session must not
 *   be able to self-attribute main.
 * - `mainRef` (string, default "main"): branch/ref whose state is probed.
 * - `rolloutOwner` (string, optional): named owner accountable for the dark
 *   rollout window; required before the gate may ever be enabled in production.
 * - `rolloutEndsOn` (string, optional): ISO date the dark rollout window
 *   closes; enforcement must be re-decided on or after this date.
 *
 * Accepted config locations, first match wins:
 * `plugins.entries.workboard.completionGate`, `plugins.workboard.completionGate`,
 * `workboard.completionGate`, `completionGate`.
 */
export type CompletionGateConfig = {
  enabled: boolean;
  mainRoot?: string;
  mainRef: string;
  rolloutOwner?: string;
  rolloutEndsOn?: string;
};

export type CompletionGateVerdict =
  | { admitted: true; reason: string }
  | { admitted: false; code: string; message: string };

export type CanonicalMainState = {
  mainRoot: string;
  mainRef: string;
  dirty: boolean;
};

const DEFAULT_MAIN_REF = "main";
const TERMINAL_STATUS = "done";
const TERMINAL_TOOL_NAMES = ["workboard_complete", "workboard_force_close"] as const;

/** Git environment overrides that must not leak into the child's own repo. */
export const GIT_ENV_KEYS_TO_STRIP = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_CONFIG_PARAMETERS",
] as const;

export function buildScrubbedGitEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const scrubbed: NodeJS.ProcessEnv = { ...env };
  for (const key of GIT_ENV_KEYS_TO_STRIP) {
    delete scrubbed[key];
  }
  return scrubbed;
}

function readPath(source: unknown, ...path: readonly string[]): unknown {
  let current: unknown = source;
  for (const key of path) {
    const record = asOptionalRecord(current);
    if (!record) {
      return undefined;
    }
    current = record[key];
  }
  return current;
}

function readCompletionGateRecord(
  context: OpenClawPluginToolContext | undefined,
): Record<string, unknown> | undefined {
  const config = asOptionalRecord(
    context?.runtimeConfig ?? context?.getRuntimeConfig?.() ?? context?.config,
  );
  if (!config) {
    return undefined;
  }
  for (const path of [
    ["plugins", "entries", "workboard", "completionGate"],
    ["plugins", "workboard", "completionGate"],
    ["workboard", "completionGate"],
    ["completionGate"],
  ] as const) {
    const candidate = asOptionalRecord(readPath(config, ...path));
    if (candidate) {
      return candidate;
    }
  }
  return undefined;
}

function readTrimmedString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function resolveCompletionGateConfig(
  context: OpenClawPluginToolContext | undefined,
): CompletionGateConfig {
  const raw = readCompletionGateRecord(context);
  if (!raw) {
    return { enabled: false, mainRef: DEFAULT_MAIN_REF };
  }
  const mainRoot = readTrimmedString(raw, "mainRoot");
  const rolloutOwner = readTrimmedString(raw, "rolloutOwner");
  const rolloutEndsOn = readTrimmedString(raw, "rolloutEndsOn");
  return {
    enabled: raw.enabled === true,
    ...(mainRoot ? { mainRoot } : {}),
    mainRef: readTrimmedString(raw, "mainRef") ?? DEFAULT_MAIN_REF,
    ...(rolloutOwner ? { rolloutOwner } : {}),
    ...(rolloutEndsOn ? { rolloutEndsOn } : {}),
  };
}

/** Config-declared canonical main root; never derived from the caller workspace. */
export function resolveCanonicalMainRoot(
  context: OpenClawPluginToolContext | undefined,
): string | undefined {
  return resolveCompletionGateConfig(context).mainRoot;
}

export function isTerminalWorkboardTransition(toolName: string, rawParams: unknown): boolean {
  if ((TERMINAL_TOOL_NAMES as readonly string[]).includes(toolName)) {
    return true;
  }
  if (toolName !== "workboard_move") {
    return false;
  }
  const status = asOptionalRecord(rawParams)?.status;
  return typeof status === "string" && status.trim().toLowerCase() === TERMINAL_STATUS;
}

function describeProbeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0] ?? message;
}

/**
 * Probe the canonical main checkout. Fail-closed: an unresolvable repo or ref
 * throws instead of reporting a clean state.
 */
export async function probeCanonicalMainState(params: {
  mainRoot: string;
  mainRef: string;
  env?: NodeJS.ProcessEnv;
}): Promise<CanonicalMainState> {
  const spawn = { env: buildScrubbedGitEnv(params.env), encoding: "utf8" } as const;
  try {
    await execFileAsync(
      "git",
      ["-C", params.mainRoot, "rev-parse", "--verify", `${params.mainRef}^{commit}`],
      spawn,
    );
    const { stdout } = await execFileAsync(
      "git",
      ["-C", params.mainRoot, "status", "--porcelain=v1"],
      spawn,
    );
    return {
      mainRoot: params.mainRoot,
      mainRef: params.mainRef,
      dirty: stdout.trim().length > 0,
    };
  } catch (error) {
    throw new Error(
      `completion gate: git probe failed for ${params.mainRoot} (ref ${params.mainRef}): ${describeProbeFailure(error)}`,
    );
  }
}

export async function assertTerminalTransitionAdmitted(
  toolName: string,
  rawParams: unknown,
  context: OpenClawPluginToolContext | undefined,
): Promise<CompletionGateVerdict> {
  const config = resolveCompletionGateConfig(context);
  if (!config.enabled) {
    return { admitted: true, reason: "gate-disabled" };
  }
  if (!isTerminalWorkboardTransition(toolName, rawParams)) {
    return { admitted: true, reason: "non-terminal-transition" };
  }
  const mainRoot = config.mainRoot;
  if (!mainRoot) {
    return {
      admitted: false,
      code: "missing_main_root",
      message:
        "completionGate.mainRoot must be configured before the gate can admit a terminal transition.",
    };
  }
  try {
    await probeCanonicalMainState({ mainRoot, mainRef: config.mainRef });
  } catch (error) {
    return {
      admitted: false,
      code: "git_probe_failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  // Phase 0 scaffold: the probe proves the state is knowable. Refusing an
  // admitted terminal transition is the follow-up card's decision.
  return { admitted: true, reason: "scaffold-probe-passed" };
}

export function guardWorkboardToolsForCompletionGate(
  tools: AnyAgentTool[],
  context: OpenClawPluginToolContext | undefined,
): AnyAgentTool[] {
  return tools.map((tool) => ({
    ...tool,
    execute: async (toolCallId, rawParams, signal, onUpdate) => {
      const verdict = await assertTerminalTransitionAdmitted(tool.name, rawParams, context);
      if (!verdict.admitted) {
        throw new Error(`workboard completion gate refused ${tool.name}: ${verdict.message}`);
      }
      return await tool.execute(toolCallId, rawParams, signal, onUpdate);
    },
  }));
}
