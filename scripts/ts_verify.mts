#!/usr/bin/env node
// scripts/ts_verify — scoped local TypeScript verification for agent lanes.
//
// Computes changed files vs merge-base (default: origin/main), maps them to
// the affected tsgo projects using the tsconfig include maps (see
// scripts/ts_verify.mapping.mts), and runs ONLY the affected per-project
// incremental scripts. This replaces agent-run full-tree `tsc --noEmit`,
// which was the root cause of the 2026-09-14 three-compiler CPU pileup and
// one OOM during simultaneous agent runs.
//
// Per Tomoe fix a, .d.ts changes propagate broadly:
//   src/**/*.d.ts      → all four projects
//   packages/**/*.d.ts → core + ui + scripts
//   ui/src/**/*.d.ts   → extensions
//
// Exports OPENCLAW_LOCAL_CHECK=throttled so scripts/lib/local-check-runtime.mts
// applies --singleThreaded --checkers 1 (existing infra).
//
// Per-worktree cache stays as-is: .artifacts/ is gitignored (see .gitignore
// .artifacts/) so caches do not leak between worktrees.

import { spawnSync } from "node:child_process";
import {
  ALL_TSGO_PROJECTS,
  mapFilesToProjects,
  formatProjectPlan,
  TSGO_PROJECT_PNPM_SCRIPT,
  type TsgoProject,
} from "./ts_verify.mapping.mts";

const DEFAULT_BASE_REF = "origin/main";
const DEFAULT_HEAD_REF = "HEAD";
const MAX_BUFFER = 16 * 1024 * 1024;

type CliArgs = {
  base: string;
  head: string;
  dryRun: boolean;
  showHelp: boolean;
};

function parseArgs(argv: readonly string[]): CliArgs {
  let base = DEFAULT_BASE_REF;
  let head = DEFAULT_HEAD_REF;
  let dryRun = false;
  let showHelp = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--base") {
      const value = argv[++i];
      if (typeof value !== "string" || value.length === 0) {
        throw new Error("[ts_verify] --base requires a value");
      }
      base = value;
    } else if (arg?.startsWith("--base=")) {
      base = arg.slice("--base=".length);
    } else if (arg === "--head") {
      const value = argv[++i];
      if (typeof value !== "string" || value.length === 0) {
        throw new Error("[ts_verify] --head requires a value");
      }
      head = value;
    } else if (arg?.startsWith("--head=")) {
      head = arg.slice("--head=".length);
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      showHelp = true;
    } else if (arg !== undefined && arg.length > 0) {
      throw new Error(`[ts_verify] unknown argument: ${arg}`);
    }
  }
  return { base, head, dryRun, showHelp };
}

function printHelp(): void {
  console.log(
    `Usage: ts_verify [--base <ref>] [--head <ref>] [--dry-run]

Scoped local TypeScript verification for agent lanes. Replaces full-tree
\`tsc --noEmit\`. Only the tsgo projects affected by your diff run.

Options:
  --base <ref>    Merge-base ref to diff against (default: ${DEFAULT_BASE_REF})
  --head <ref>    Head ref to diff from (default: ${DEFAULT_HEAD_REF})
  --dry-run       Print the plan without running tsgo
  -h, --help      Show this help

Exit codes:
  0   OK — all affected projects passed (or nothing to run)
  1   tsgo failed or git command failed
  2   invalid arguments

Environment:
  OPENCLAW_LOCAL_CHECK=throttled is exported into each spawned tsgo invocation.`,
  );
}

function resolveMergeBase(base: string, head: string, cwd: string): string {
  const out = spawnSync("git", ["merge-base", base, head], {
    cwd,
    stdio: ["ignore", "pipe", "ignore"],
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
  });
  if (out.status !== 0) {
    throw new Error(
      `[ts_verify] failed to resolve merge-base for ${base}..${head}: ` +
        `${(out.stderr || "").trim() || out.error?.message || "unknown error"}`,
    );
  }
  const sha = (out.stdout || "").trim();
  if (!sha) {
    throw new Error(`[ts_verify] merge-base returned empty for ${base}..${head}`);
  }
  return sha;
}

function listChangedFiles(mergeBase: string, head: string, cwd: string): string[] {
  const out = spawnSync("git", ["diff", "--name-only", `${mergeBase}...${head}`], {
    cwd,
    stdio: ["ignore", "pipe", "ignore"],
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
  });
  if (out.status !== 0) {
    throw new Error(
      `[ts_verify] git diff failed for ${mergeBase}...${head}: ` +
        `${(out.stderr || "").trim() || out.error?.message || "unknown error"}`,
    );
  }
  return (out.stdout || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function runTsgoProject(project: TsgoProject, cwd: string): number {
  const script = TSGO_PROJECT_PNPM_SCRIPT[project];
  console.log(`[ts_verify] running pnpm ${script}`);
  const result = spawnSync("pnpm", [script], {
    cwd,
    stdio: "inherit",
    env: {
      ...process.env,
      OPENCLAW_LOCAL_CHECK: "throttled",
    },
  });
  if (result.signal) {
    return 1;
  }
  return result.status ?? 1;
}

function printSkipReason(project: TsgoProject, projects: ReadonlySet<TsgoProject>): void {
  // Reason text matches the spec language: "Print which projects ran/skipped and why".
  if (!projects.has(project)) {
    console.log(`[ts_verify] skipping ${project} (no matching changes in diff)`);
  }
}

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    printHelp();
    process.exitCode = 2;
    return;
  }
  if (args.showHelp) {
    printHelp();
    return;
  }

  const cwd = process.cwd();
  console.log(`[ts_verify] base=${args.base} head=${args.head} cwd=${cwd}`);

  let mergeBase: string;
  try {
    mergeBase = resolveMergeBase(args.base, args.head, cwd);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }
  console.log(`[ts_verify] merge-base: ${mergeBase.slice(0, 12)}`);

  let files: string[];
  try {
    files = listChangedFiles(mergeBase, args.head, cwd);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }
  if (files.length === 0) {
    console.log("[ts_verify] no changed files vs merge-base; CI covers full check");
    return;
  }

  const projects = mapFilesToProjects(files);
  console.log(
    `[ts_verify] changed files: ${files.length}; tsgo projects: ${formatProjectPlan(projects)}`,
  );

  if (projects.size === 0) {
    console.log(
      "[ts_verify] no TS source files in diff (only docs/markdown/json/etc.); CI covers full check",
    );
    return;
  }

  if (args.dryRun) {
    console.log(
      `[ts_verify] dry-run: would run ${projects.size} project(s) in order ${ALL_TSGO_PROJECTS.filter((p) => projects.has(p)).join(", ")}`,
    );
    return;
  }

  let firstFailure = 0;
  for (const project of ALL_TSGO_PROJECTS) {
    if (!projects.has(project)) {
      printSkipReason(project, projects);
      continue;
    }
    const code = runTsgoProject(project, cwd);
    if (code !== 0 && firstFailure === 0) {
      firstFailure = code;
    }
  }

  if (firstFailure !== 0) {
    console.error(`[ts_verify] FAILED with exit code ${firstFailure}`);
    process.exitCode = firstFailure;
    return;
  }

  console.log("[ts_verify] OK — all affected projects passed");
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
