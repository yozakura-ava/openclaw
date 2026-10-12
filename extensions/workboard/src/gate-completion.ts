import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
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
 * - `deriveScript` (string, optional): ABSOLUTE path to
 *   `derive_completion_claim.py`. When set, a terminal transition must be
 *   backed by an admitted claim from that script. When absent the gate stays
 *   the Phase 0 probe-only scaffold, so existing configs are unaffected.
 *   A relative path is refused: the gate never resolves the script from CWD.
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
  deriveScript?: string;
};

/**
 * Gate verdict.
 *
 * `signals` is non-refusing diagnostic detail attached to an admitted verdict
 * (currently `basis_diverged`). It is omitted entirely when empty so the
 * scaffold's plain `{ admitted, reason }` shape stays byte-identical for every
 * payload that carries no numeric claims.
 */
export type CompletionGateVerdict =
  | { admitted: true; reason: string; signals?: string[] }
  | { admitted: false; code: string; message: string };

export type CanonicalMainState = {
  mainRoot: string;
  mainRef: string;
  dirty: boolean;
};

const DEFAULT_MAIN_REF = "main";
const TERMINAL_STATUSES = ["done", "cancelled"] as const;
const TERMINAL_TOOL_NAMES = ["workboard_complete", "workboard_force_close"] as const;

/** Hard wall-clock bound for every child process the gate spawns. */
export const GATE_CHILD_TIMEOUT_MS = 30_000;

/**
 * Git environment overrides that must not leak into the child's own repo.
 *
 * `GIT_CONFIG_COUNT` and the `GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>`
 * families form the modern config-injection channel: a caller can set arbitrary
 * config (aliases, hooks, `core.fsmonitor`, object-format overrides) without
 * writing any config file, so they must be stripped as a family rather than
 * by fixed key name.
 */
export const GIT_ENV_KEYS_TO_STRIP = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
] as const;

/** Prefixed Git families stripped alongside the fixed keys above. */
export const GIT_ENV_KEY_PREFIXES_TO_STRIP = ["GIT_CONFIG_KEY_", "GIT_CONFIG_VALUE_"] as const;

export function isGitEnvKeyToStrip(key: string): boolean {
  if ((GIT_ENV_KEYS_TO_STRIP as readonly string[]).includes(key)) {
    return true;
  }
  return GIT_ENV_KEY_PREFIXES_TO_STRIP.some((prefix) => key.startsWith(prefix));
}

export function buildScrubbedGitEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const scrubbed: NodeJS.ProcessEnv = { ...env };
  for (const key of Object.keys(scrubbed)) {
    if (isGitEnvKeyToStrip(key)) {
      delete scrubbed[key];
    }
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
  const deriveScript = readTrimmedString(raw, "deriveScript");
  return {
    enabled: raw.enabled === true,
    ...(mainRoot ? { mainRoot } : {}),
    mainRef: readTrimmedString(raw, "mainRef") ?? DEFAULT_MAIN_REF,
    ...(rolloutOwner ? { rolloutOwner } : {}),
    ...(rolloutEndsOn ? { rolloutEndsOn } : {}),
    ...(deriveScript ? { deriveScript } : {}),
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
  if (typeof status !== "string") {
    return false;
  }
  const normalized = status.trim().toLowerCase();
  return (TERMINAL_STATUSES as readonly string[]).includes(normalized);
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
  const spawn = {
    env: buildScrubbedGitEnv(params.env),
    encoding: "utf8",
    timeout: GATE_CHILD_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
  } as const;
  try {
    await execFileAsync(
      "git",
      [
        "--no-optional-locks",
        "-C",
        params.mainRoot,
        "rev-parse",
        "--verify",
        `${params.mainRef}^{commit}`,
      ],
      spawn,
    );
    const { stdout } = await execFileAsync(
      "git",
      ["--no-optional-locks", "-C", params.mainRoot, "status", "--porcelain=v1"],
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

/** Claim inputs the gate forwards to derive_completion_claim.py. */
export type ClaimEvidence = {
  cardId: string;
  buildSha?: string;
  branch?: string;
  allowedFiles: string[];
};

/**
 * Numeric metrics a derived-number cell may publish.
 *
 * `value` is the collected-case count (`runtime_cases`); the other three are
 * the line/file counts (`diff_numstat`). A claim naming a metric outside this
 * set has nothing to diff against on its own basis, which is fail-closed.
 */
export const TRACKED_COUNT_METRICS = ["value", "additions", "deletions", "files_touched"] as const;

/** One command-of-record cell as published by derive_completion_claim.py. */
export type DerivedNumberCell = {
  basis: string;
  command: string;
  commandArgv: string[];
  available: boolean;
  metrics: Record<string, number>;
  predicate: string;
  detail: string;
  error: string;
};

/** The `derived_numbers` block: basis -> cell, as published by the script. */
export type DerivedNumbers = {
  schemaVersion: number | undefined;
  cells: Record<string, DerivedNumberCell>;
  unavailable: string[];
  complete: boolean;
};

/** A number the completer asserted, tagged with the basis it asserted it on. */
export type NumericClaim = {
  basis: string;
  metric: string;
  value: number;
  source: string;
};

export type NumbersDiff =
  | { admitted: true; signals: string[] }
  | { admitted: false; code: string; message: string; signals: string[] };

/** Upper bound on claims parsed from one payload; guards pathological input. */
const MAX_NUMERIC_CLAIMS = 64;

/**
 * Basis-tagged numeric assertions, e.g. `runtime_cases=30`,
 * `runtime_cases.value=30`, `diff_numstat=+120/-30`,
 * `diff_numstat.files_touched=4`. A bare number carries no basis and is not a
 * claim: it cannot be diffed without guessing which command produced it.
 */
const NUMERIC_CLAIM_PATTERN =
  /\b([A-Za-z_][A-Za-z0-9_]*)(?:\.([A-Za-z_][A-Za-z0-9_]*))?[ \t]*[:=][ \t]*([+-]?\d+)(?:[ \t]*\/[ \t]*([+-]?\d+))?/g;

function readClaimEvidence(rawParams: unknown): ClaimEvidence | undefined {
  const record = asOptionalRecord(rawParams);
  if (!record) {
    return undefined;
  }
  const cardId =
    readTrimmedString(record, "id") ?? readTrimmedString(record, "cardId") ?? undefined;
  if (!cardId) {
    return undefined;
  }
  const allowed = Array.isArray(record.allowed_files)
    ? record.allowed_files.filter((entry): entry is string => typeof entry === "string")
    : Array.isArray(record.allowedFiles)
      ? record.allowedFiles.filter((entry): entry is string => typeof entry === "string")
      : [];
  return {
    cardId,
    buildSha: readTrimmedString(record, "buildSha"),
    branch: readTrimmedString(record, "branch"),
    allowedFiles: allowed.map((entry) => entry.trim()).filter(Boolean),
  };
}

/**
 * Run derive_completion_claim.py and map its outcome to a verdict.
 *
 * Fail-closed on every failure mode: a relative script path (the gate never
 * resolves evidence tooling from CWD), a spawn error, a timeout, or any
 * non-zero exit that is not the script's own `refused` code.
 */
export async function deriveCompletionClaim(params: {
  scriptPath: string;
  evidence: ClaimEvidence;
  mainRoot: string;
  mainRef: string;
  /** Completion payload prose carrying basis-tagged numeric claims. */
  claimText?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<CompletionGateVerdict> {
  const { scriptPath, evidence } = params;
  if (!scriptPath.startsWith("/")) {
    return {
      admitted: false,
      code: "derive_script_not_absolute",
      message: `completionGate.deriveScript must be an absolute path, got "${scriptPath}".`,
    };
  }
  try {
    accessSync(scriptPath, constants.F_OK);
  } catch {
    return {
      admitted: false,
      code: "derive_script_failed",
      message: `completion gate: derive script not found: "${scriptPath}".`,
    };
  }
  const argv = [
    scriptPath,
    "--card-id",
    evidence.cardId,
    "--main-root",
    params.mainRoot,
    "--main-ref",
    params.mainRef,
    ...(evidence.buildSha ? ["--build-sha", evidence.buildSha] : []),
    ...(evidence.branch ? ["--branch", evidence.branch] : []),
    ...evidence.allowedFiles.flatMap((file) => ["--allowed-file", file]),
    // The script emits its machine-readable record (including derived_numbers)
    // to stdout ALONE under --json; without it stdout is the ADMITTED line.
    "--json",
  ];
  try {
    const result = await execFileAsync("python3", argv, {
      env: buildScrubbedGitEnv(params.env),
      encoding: "utf8",
      timeout: GATE_CHILD_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    } as const);
    const record = asOptionalRecord(safeJsonParse(result.stdout));
    const reason = typeof record?.reason === "string" ? record.reason : "claim-admitted";
    const claims = extractNumericClaims(params.claimText);
    const diff = diffClaimsAgainstDerived(claims, parseDerivedNumbers(record));
    if (!diff.admitted) {
      return { admitted: false, code: diff.code, message: diff.message };
    }
    if (diff.signals.length > 0) {
      return { admitted: true, reason: `claim:${reason}`, signals: diff.signals };
    }
    return { admitted: true, reason: `claim:${reason}` };
  } catch (error) {
    const failure = error as { code?: unknown; stderr?: unknown; killed?: unknown };
    const stderr = typeof failure.stderr === "string" ? failure.stderr.trim() : "";
    const predicate = /\[([a-z_]+)\]/.exec(stderr)?.[1];
    if (typeof failure.code === "number" && failure.code === 3) {
      return {
        admitted: false,
        code: "claim_refused",
        message: stderr || "derive_completion_claim.py refused the claim.",
      };
    }
    if (typeof failure.code === "number" && failure.code !== undefined) {
      return {
        admitted: false,
        code: predicate ? `claim_${predicate}` : "claim_probe_failed",
        message: stderr || `derive_completion_claim.py exited ${String(failure.code)}.`,
      };
    }
    return {
      admitted: false,
      code: "derive_script_failed",
      message: `completion gate: claim derivation failed: ${
        failure.killed ? `timed out after ${GATE_CHILD_TIMEOUT_MS}ms` : describeProbeFailure(error)
      }`,
    };
  }
}

/**
 * Parse the `derived_numbers` block out of a script result record.
 *
 * Returns undefined when the block is absent, so callers can distinguish
 * "script published no command-of-record" from "cell says unavailable".
 */
export function parseDerivedNumbers(record: unknown): DerivedNumbers | undefined {
  const numbers = asOptionalRecord(readPath(record, "derived_numbers"));
  if (!numbers) {
    return undefined;
  }
  const cells: Record<string, DerivedNumberCell> = {};
  for (const [key, value] of Object.entries(asOptionalRecord(numbers.cells) ?? {})) {
    const cell = asOptionalRecord(value);
    if (!cell) {
      continue;
    }
    const declared = readTrimmedString(cell, "count_basis");
    const basis = declared ?? key;
    const metrics: Record<string, number> = {};
    for (const metric of TRACKED_COUNT_METRICS) {
      const raw = cell[metric];
      if (typeof raw === "number" && Number.isFinite(raw)) {
        metrics[metric] = raw;
      }
    }
    cells[basis] = {
      basis,
      command: readTrimmedString(cell, "command") ?? "",
      commandArgv: Array.isArray(cell.command_argv)
        ? cell.command_argv.filter((entry): entry is string => typeof entry === "string")
        : [],
      available: cell.available === true,
      metrics,
      predicate: readTrimmedString(cell, "predicate") ?? "",
      detail: typeof cell.detail === "string" ? cell.detail : "",
      error: typeof cell.error === "string" ? cell.error : "",
    };
  }
  const unavailable = Array.isArray(numbers.unavailable)
    ? numbers.unavailable.filter((entry): entry is string => typeof entry === "string")
    : [];
  return {
    schemaVersion: typeof numbers.schema_version === "number" ? numbers.schema_version : undefined,
    cells,
    unavailable,
    complete: numbers.complete === true,
  };
}

/**
 * Extract basis-tagged numeric claims from a completion payload's prose.
 *
 * Only explicit `<basis>[.<metric>]=<n>` forms count. A bare "30 tests" is not
 * a claim because the gate has no way to know which command produced the 30,
 * and diffing it against a cell would compare across differing commands.
 */
export function extractNumericClaims(text: string | undefined): NumericClaim[] {
  if (!text) {
    return [];
  }
  const claims: NumericClaim[] = [];
  for (const match of text.matchAll(NUMERIC_CLAIM_PATTERN)) {
    if (claims.length >= MAX_NUMERIC_CLAIMS) {
      break;
    }
    const [source, rawBasis, rawMetric, rawValue, rawSecond] = match;
    const basis = rawBasis;
    const magnitude = rawValue;
    const second = rawSecond;
    if (!basis || !magnitude) {
      continue;
    }
    if (second !== undefined) {
      // `basis=+120/-30` is the numstat shape: additions and deletions.
      claims.push({
        basis,
        metric: "additions",
        value: Math.abs(Number.parseInt(magnitude, 10)),
        source,
      });
      claims.push({
        basis,
        metric: "deletions",
        value: Math.abs(Number.parseInt(second, 10)),
        source,
      });
      continue;
    }
    claims.push({
      basis,
      metric: rawMetric ?? "value",
      value: Math.abs(Number.parseInt(magnitude, 10)),
      source,
    });
  }
  return claims;
}

/** Read the summary/proof-note prose that carries numeric claims. */
export function readCompletionClaimText(rawParams: unknown): string | undefined {
  const record = asOptionalRecord(rawParams);
  if (!record) {
    return undefined;
  }
  const parts = [
    readTrimmedString(record, "summary"),
    readTrimmedString(asOptionalRecord(record.proof) ?? {}, "note"),
  ].filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
  return parts.length > 0 ? parts.join("\n") : undefined;
}

/**
 * Diff claimed numbers against the published cells on their own basis.
 *
 * Fail-closed ordering: an unavailable cell refuses before any cross-basis
 * lookup, so an unverifiable number is never rescued by a coincidental match
 * in an unrelated cell.
 */
export function diffClaimsAgainstDerived(
  claims: readonly NumericClaim[],
  derived: DerivedNumbers | undefined,
): NumbersDiff {
  const signals: string[] = [];
  if (claims.length === 0) {
    return { admitted: true, signals };
  }
  if (!derived) {
    return {
      admitted: false,
      code: "numbers_unavailable_vs_claimed",
      message:
        "completion gate: the payload asserts numeric claim(s) but derive_completion_claim.py published no derived_numbers command-of-record to diff them against.",
      signals,
    };
  }
  for (const claim of claims) {
    const cell = derived.cells[claim.basis];
    if (!cell) {
      // Basis the gate does not publish: nothing to verify against, and a
      // guessed basis would be a diff across differing commands.
      continue;
    }
    if (!cell.available) {
      return {
        admitted: false,
        code: "numbers_unavailable_vs_claimed",
        message: `completion gate: claimed ${claim.basis}.${claim.metric}=${String(claim.value)} but the gate could not derive ${claim.basis} (${cell.predicate || "unavailable"}): ${cell.error || cell.detail || "no detail"}. Re-run the published command manually: ${cell.command || "command unavailable"}`,
        signals,
      };
    }
    const derivedValue = cell.metrics[claim.metric];
    if (derivedValue === undefined) {
      return {
        admitted: false,
        code: `numbers_mismatch:${claim.basis}`,
        message: `completion gate: claimed ${claim.basis}.${claim.metric}=${String(claim.value)} but ${claim.basis} publishes no ${claim.metric} metric (command: ${cell.command}); the claim cannot be reproduced on its own basis.`,
        signals,
      };
    }
    if (derivedValue === claim.value) {
      continue;
    }
    // The number is real but attributed to the wrong command. Signal it; do
    // not refuse, and never use the other cell to certify the claim.
    //
    // The lookup spans ALL of the other cell's metrics, not just the metric
    // name used by the claim: the bases publish disjoint metric namespaces
    // (`runtime_cases` publishes only `value`, `diff_numstat` publishes only
    // additions/deletions/files_touched), so a same-metric-name lookup could
    // never fire. Matching any published metric is exactly the question being
    // asked — is this number published under a different command?
    const elsewhere = Object.values(derived.cells).filter(
      (other) =>
        other.available &&
        other.basis !== claim.basis &&
        Object.values(other.metrics).includes(claim.value),
    );
    if (elsewhere.length > 0) {
      signals.push(
        `basis_diverged:${claim.basis}.${claim.metric}=${String(claim.value)} is published under ${elsewhere
          .map((other) => other.basis)
          .join(
            ",",
          )} not ${claim.basis} (${String(derivedValue)}); command of record: ${cell.command}`,
      );
      continue;
    }
    return {
      admitted: false,
      code: `numbers_mismatch:${claim.basis}`,
      message: `completion gate: claimed ${claim.basis}.${claim.metric}=${String(claim.value)} but the same command derived ${String(derivedValue)} (command: ${cell.command}). Re-run the published command manually or correct the claim.`,
      signals,
    };
  }
  return { admitted: true, signals };
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
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
  if (!config.deriveScript) {
    // Phase 0 scaffold: the probe proves the state is knowable. Enforcement
    // activates only once deriveScript is configured.
    return { admitted: true, reason: "scaffold-probe-passed" };
  }
  const evidence = readClaimEvidence(rawParams);
  if (!evidence) {
    return {
      admitted: false,
      code: "missing_claim_evidence",
      message:
        "completionGate.deriveScript is configured but the transition carries no card id to derive a claim from.",
    };
  }
  if (!evidence.buildSha && !evidence.branch) {
    return {
      admitted: false,
      code: "missing_build_identity",
      message:
        "completion gate: no buildSha or branch on the transition, so the claim cannot be anchored.",
    };
  }
  return await deriveCompletionClaim({
    scriptPath: config.deriveScript,
    evidence,
    mainRoot,
    mainRef: config.mainRef,
    claimText: readCompletionClaimText(rawParams),
  });
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
