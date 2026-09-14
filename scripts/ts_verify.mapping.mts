// Scoped ts_verify file→project mapping logic.
//
// Project include maps (from tsconfig.{core,ui,extensions,scripts}.json):
//   core       = src/**/*  + packages/**/*          (excl. mermaid-renderer/**,
//                                                     src/plugin-sdk/control-ui*.ts)
//   ui         = ui/**/* + packages/mermaid-renderer/**/* +
//                src/plugin-sdk/control-ui*.ts +
//                src/**/*.d.ts + packages/**/*.d.ts
//   extensions = extensions/**/* + src/**/*.d.ts + ui/src/**/*.d.ts
//   scripts    = scripts/**/* + src/**/*.d.ts + packages/**/*.d.ts
//
// CRITICAL (Tomoe fix a): .d.ts files propagate broadly because TypeScript
// treats ambient declaration changes as cross-project fan-out. A directory-only
// mapping (e.g. "src/foo.d.ts" → core only) is a false-negative bug.
//
//   src/**/*.d.ts       → core + ui + extensions + scripts (all four)
//   packages/**/*.d.ts  → core + ui + scripts              (NOT extensions)
//   ui/src/**/*.d.ts    → extensions only
//
// All three propagation rules are unit-tested in test/scripts/ts_verify.mapping.test.ts.

export type TsgoProject = "core" | "ui" | "extensions" | "scripts";

export const ALL_TSGO_PROJECTS: readonly TsgoProject[] = [
  "core",
  "ui",
  "extensions",
  "scripts",
] as const;

// Per Tomoe: each project must run via its per-project incremental script
// (`pnpm tsgo:core|ui|extensions|scripts`) — NOT `-b` and NOT `:all`. The
// all-scripts fan-out (`tsgo:extensions:all`, `tsgo:core:all`, `tsgo:all`)
// is the wrong entrypoint that originally piled up three tsgo processes.
export const TSGO_PROJECT_PNPM_SCRIPT: Record<TsgoProject, string> = {
  core: "tsgo:core",
  ui: "tsgo:ui",
  extensions: "tsgo:extensions",
  scripts: "tsgo:scripts",
};

const D_TS_SRC = /^src\/.+\.d\.ts$/u;
const D_TS_PACKAGES = /^packages\/.+\.d\.ts$/u;
const D_TS_UI_SRC = /^ui\/src\/.+\.d\.ts$/u;

// .ts, .tsx, .mts, .cts — every TS-compilable source extension. The
// tsconfig.{core,ui,extensions,scripts}.json "include" globs match any file
// under their directory, so the mapping MUST recognize every extension
// (.tsx, .mts, .cts) that tsgo will pick up. R1 finding (MEDIUM): the prior
// `.ts$` anchor silently dropped .tsx/.mts/.cts under src/ and packages/,
// letting required core checks be skipped.
const TS_SOURCE_EXTENSION_REGEX = /\.(?:ts|tsx|mts|cts)$/u;

const PATH_SRC_OR_PACKAGES_TS = new RegExp(
  `^(?:src|packages)\\/[^/]+(?:\\/[^/]+)*${TS_SOURCE_EXTENSION_REGEX.source}`,
  "u",
);
const PATH_UI = /^ui\/.+/u;
const PATH_MERMAID = /^packages\/mermaid-renderer\/.+/u;
const PATH_CONTROL_UI_TS = /^src\/plugin-sdk\/control-ui[^/]*\.ts$/u;
const PATH_EXTENSIONS = /^extensions\/.+/u;
const PATH_SCRIPTS = /^scripts\/.+/u;

export function mapFilesToProjects(files: readonly string[]): Set<TsgoProject> {
  const projects = new Set<TsgoProject>();
  for (const raw of files) {
    const file = raw.trim();
    if (!file) {
      continue;
    }
    if (D_TS_SRC.test(file)) {
      // src/**/*.d.ts → all four projects.
      for (const project of ALL_TSGO_PROJECTS) {
        projects.add(project);
      }
      continue;
    }
    if (D_TS_PACKAGES.test(file)) {
      // packages/**/*.d.ts → core + ui + scripts (NOT extensions).
      projects.add("core");
      projects.add("ui");
      projects.add("scripts");
      continue;
    }
    if (D_TS_UI_SRC.test(file)) {
      // ui/src/**/*.d.ts → extensions only (control-ui plugin SDK ambient types).
      projects.add("extensions");
      continue;
    }
    // mermaid-renderer must be checked before PATH_SRC_OR_PACKAGES_TS because
    // its paths also match the `packages/.+` alternation; without this order
    // tsconfig.core.json's exclude would silently swallow them.
    if (PATH_MERMAID.test(file)) {
      projects.add("ui");
      continue;
    }
    if (PATH_SRC_OR_PACKAGES_TS.test(file)) {
      // src/**/*.ts and packages/**/*.ts → core. control-ui*.ts additionally
      // participates in the ui project because tsconfig.ui.json pulls it in.
      projects.add("core");
      if (PATH_CONTROL_UI_TS.test(file)) {
        projects.add("ui");
      }
      continue;
    }
    if (PATH_UI.test(file)) {
      projects.add("ui");
      continue;
    }
    if (PATH_EXTENSIONS.test(file)) {
      projects.add("extensions");
      continue;
    }
    if (PATH_SCRIPTS.test(file)) {
      projects.add("scripts");
      continue;
    }
    // Anything else (markdown, docs, json, lockfiles, root dotfiles) is not a
    // TS source path and intentionally produces no project. The CLI surfaces
    // this case with "no TS files in diff" so agents know CI still covers it.
  }
  return projects;
}

export function formatProjectPlan(projects: ReadonlySet<TsgoProject>): string {
  const ordered = ALL_TSGO_PROJECTS.filter((p) => projects.has(p));
  return ordered.length === 0 ? "(none)" : ordered.join(", ");
}
