#!/usr/bin/env node
// Standalone node:test runner for scripts/ts_verify.mapping.mts.
// Mirrors the cases in test/scripts/ts_verify.mapping.test.ts so we can verify
// the mapping logic on this machine even though the repo-wide vitest setup
// has a known native-runner bug (#132859) that breaks the vitest CLI. The
// vitest file is still shipped for Rin to run on a working environment.
//
// Test expectations follow the order produced by sorted() — which is the
// canonical ALL_TSGO_PROJECTS order: core, ui, extensions, scripts.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ALL_TSGO_PROJECTS,
  formatProjectPlan,
  mapFilesToProjects,
  TSGO_PROJECT_PNPM_SCRIPT,
  type TsgoProject,
} from "./ts_verify.mapping.mts";

function sorted(projects: ReadonlySet<TsgoProject>): TsgoProject[] {
  return [...projects].sort((a, b) => ALL_TSGO_PROJECTS.indexOf(a) - ALL_TSGO_PROJECTS.indexOf(b));
}

// --- Directory mapping ------------------------------------------------------

test("non-TS files produce empty project set", () => {
  const projects = mapFilesToProjects([
    "README.md",
    "docs/spec.md",
    "package.json",
    "pnpm-lock.yaml",
    ".gitignore",
    "openclaw.mjs",
  ]);
  assert.equal(projects.size, 0);
});

test("src/**/*.ts routes to core only", () => {
  assert.deepEqual(sorted(mapFilesToProjects(["src/foo/bar.ts"])), ["core"]);
});

// R1 finding (MEDIUM): .tsx, .mts, .cts under src/ and packages/ must also
// route to core (every TS-compilable extension — tsconfig.core.json globs
// include all of them, not just .ts).
test("src/**/*.tsx routes to core (R1 regression)", () => {
  assert.deepEqual(sorted(mapFilesToProjects(["src/components/Foo.tsx"])), ["core"]);
});

test("src/**/*.mts routes to core (R1 regression)", () => {
  assert.deepEqual(sorted(mapFilesToProjects(["src/scripts/build.mts"])), ["core"]);
});

test("src/**/*.cts routes to core (R1 regression)", () => {
  assert.deepEqual(sorted(mapFilesToProjects(["src/legacy/foo.cts"])), ["core"]);
});

test("packages/**/*.tsx routes to core (R1 regression)", () => {
  assert.deepEqual(
    sorted(mapFilesToProjects(["packages/plugin-sdk/src/Button.tsx"])),
    ["core"],
  );
});

test("packages/**/*.mts routes to core (R1 regression)", () => {
  assert.deepEqual(
    sorted(mapFilesToProjects(["packages/gateway-protocol/src/index.mts"])),
    ["core"],
  );
});

test("packages/**/*.cts routes to core (R1 regression)", () => {
  assert.deepEqual(sorted(mapFilesToProjects(["packages/legacy/foo.cts"])), ["core"]);
});

test("packages/**/*.ts (non-mermaid) routes to core only", () => {
  assert.deepEqual(
    sorted(mapFilesToProjects(["packages/gateway-protocol/src/foo.ts"])),
    ["core"],
  );
});

test("ui/**/* (non-d.ts) routes to ui only", () => {
  assert.deepEqual(sorted(mapFilesToProjects(["ui/src/pages/chat/foo.tsx"])), ["ui"]);
});

test("ui/**/* with .mts routes to ui", () => {
  assert.deepEqual(sorted(mapFilesToProjects(["ui/src/build.mts"])), ["ui"]);
});

test("ui/**/* with .cts routes to ui", () => {
  assert.deepEqual(sorted(mapFilesToProjects(["ui/src/legacy.cts"])), ["ui"]);
});

test("packages/mermaid-renderer/** routes to ui", () => {
  assert.deepEqual(
    sorted(mapFilesToProjects(["packages/mermaid-renderer/src/foo.ts"])),
    ["ui"],
  );
});

test("packages/mermaid-renderer/** with .tsx still routes to ui (not core)", () => {
  assert.deepEqual(
    sorted(mapFilesToProjects(["packages/mermaid-renderer/src/Diagram.tsx"])),
    ["ui"],
  );
});

test("src/plugin-sdk/control-ui.ts routes to core AND ui", () => {
  const projects = mapFilesToProjects(["src/plugin-sdk/control-ui.ts"]);
  assert.equal(projects.has("core"), true);
  assert.equal(projects.has("ui"), true);
  assert.equal(projects.has("extensions"), false);
  assert.equal(projects.has("scripts"), false);
});

test("src/plugin-sdk/control-ui-components.ts routes to core AND ui", () => {
  const projects = mapFilesToProjects(["src/plugin-sdk/control-ui-components.ts"]);
  assert.equal(projects.has("core"), true);
  assert.equal(projects.has("ui"), true);
});

test("non-control-ui src/plugin-sdk/*.ts does not fan out to ui", () => {
  assert.deepEqual(sorted(mapFilesToProjects(["src/plugin-sdk/foo.ts"])), ["core"]);
});

test("extensions/**/* routes to extensions only", () => {
  assert.deepEqual(
    sorted(mapFilesToProjects(["extensions/discord/src/foo.ts"])),
    ["extensions"],
  );
});

test("extensions/**/* with .tsx/.mts/.cts routes to extensions (already-globs-all-edges regression)", () => {
  assert.deepEqual(sorted(mapFilesToProjects(["extensions/feishu/src/Panel.tsx"])), ["extensions"]);
  assert.deepEqual(sorted(mapFilesToProjects(["extensions/irc/src/bot.mts"])), ["extensions"]);
  assert.deepEqual(sorted(mapFilesToProjects(["extensions/matrix/src/legacy.cts"])), ["extensions"]);
});

test("scripts/**/* routes to scripts only", () => {
  assert.deepEqual(sorted(mapFilesToProjects(["scripts/build.mts"])), ["scripts"]);
});

test("scripts/**/* with .cts/.tsx routes to scripts (already-globs-all-edges regression)", () => {
  assert.deepEqual(sorted(mapFilesToProjects(["scripts/lib/legacy.cts"])), ["scripts"]);
  assert.deepEqual(sorted(mapFilesToProjects(["scripts/web/StatusPage.tsx"])), ["scripts"]);
});

// --- .d.ts propagation (Tomoe fix a, CRITICAL) ------------------------------

test("src/**/*.d.ts → ALL FOUR projects (the false-negative bug)", () => {
  assert.deepEqual(
    sorted(mapFilesToProjects(["src/foo/bar.d.ts"])),
    ["core", "ui", "extensions", "scripts"],
  );
});

test("src/foo.d.ts → ALL FOUR projects (spec demo case for ts_verify demo run)", () => {
  const projects = mapFilesToProjects(["src/foo.d.ts"]);
  assert.deepEqual(sorted(projects), ["core", "ui", "extensions", "scripts"]);
  assert.equal(formatProjectPlan(projects), "core, ui, extensions, scripts");
});

test("packages/**/*.d.ts → core + ui + scripts (NOT extensions)", () => {
  const projects = mapFilesToProjects(["packages/sdk/src/types.d.ts"]);
  assert.deepEqual(sorted(projects), ["core", "ui", "scripts"]);
  assert.equal(projects.has("extensions"), false);
});

test("ui/src/**/*.d.ts → extensions only", () => {
  assert.deepEqual(sorted(mapFilesToProjects(["ui/src/types.d.ts"])), ["extensions"]);
});

test("src/plugin-sdk/api.d.ts still routes to all four (src/**/*.d.ts rule wins)", () => {
  assert.deepEqual(
    sorted(mapFilesToProjects(["src/plugin-sdk/api.d.ts"])),
    ["core", "ui", "extensions", "scripts"],
  );
});

test("ui/non-src/types.d.ts routes to ui (per tsconfig.ui.json ui/**/* include)", () => {
  // tsconfig.ui.json includes ui/**/*; a .d.ts outside ui/src/ is still a ui
  // file (not the special ui/src/.d.ts → extensions propagation).
  assert.deepEqual(sorted(mapFilesToProjects(["ui/non-src/types.d.ts"])), ["ui"]);
});

// --- Mixed diffs ------------------------------------------------------------

test("unions projects across many files (per-file mapping)", () => {
  // src/foo.ts → core; extensions/.../bar.ts → extensions;
  // scripts/build.mts → scripts; ui/src/types.d.ts → extensions only (per spec).
  const projects = mapFilesToProjects([
    "src/foo.ts",
    "extensions/discord/src/bar.ts",
    "scripts/build.mts",
    "ui/src/types.d.ts",
    "docs/readme.md",
  ]);
  assert.deepEqual(sorted(projects), ["core", "extensions", "scripts"]);
});

test("unions projects across many files including a src/foo.d.ts propagator", () => {
  // Same as above but with src/foo.d.ts in the mix — that one fans out to all
  // four projects, so the union is all four.
  const projects = mapFilesToProjects([
    "src/foo.ts",
    "extensions/discord/src/bar.ts",
    "scripts/build.mts",
    "ui/src/types.d.ts",
    "src/foo.d.ts",
    "docs/readme.md",
  ]);
  assert.deepEqual(sorted(projects), ["core", "ui", "extensions", "scripts"]);
});

test("ignores empty and whitespace-only entries", () => {
  assert.deepEqual(sorted(mapFilesToProjects(["", "  ", "src/foo.ts", ""])), ["core"]);
});

test("packages/sdk/src/types.d.ts only fans out to core + ui + scripts (NOT extensions)", () => {
  const projects = mapFilesToProjects(["packages/sdk/src/types.d.ts"]);
  assert.equal(projects.has("extensions"), false);
  assert.equal(projects.size, 3);
});

// --- formatProjectPlan ------------------------------------------------------

test("renders canonical core, ui, extensions, scripts order regardless of insertion", () => {
  assert.equal(formatProjectPlan(new Set(["ui", "core"])), "core, ui");
  assert.equal(
    formatProjectPlan(new Set(["scripts", "extensions", "core"])),
    "core, extensions, scripts",
  );
  assert.equal(
    formatProjectPlan(new Set(["extensions", "scripts", "ui", "core"])),
    "core, ui, extensions, scripts",
  );
});

test("returns (none) for empty set", () => {
  assert.equal(formatProjectPlan(new Set()), "(none)");
});

// --- TSGO_PROJECT_PNPM_SCRIPT (Tomoe fix: no -b, no :all) --------------------

test("maps each project to its per-project incremental script", () => {
  assert.equal(TSGO_PROJECT_PNPM_SCRIPT.core, "tsgo:core");
  assert.equal(TSGO_PROJECT_PNPM_SCRIPT.ui, "tsgo:ui");
  assert.equal(TSGO_PROJECT_PNPM_SCRIPT.extensions, "tsgo:extensions");
  assert.equal(TSGO_PROJECT_PNPM_SCRIPT.scripts, "tsgo:scripts");
});

test("does not include any :all (tsgo:extensions:all uses -b — wrong entrypoint)", () => {
  const all = Object.values(TSGO_PROJECT_PNPM_SCRIPT);
  assert.equal(all.some((s) => s.includes(":all")), false);
});

test("extensions is NOT routed to tsgo:extensions:all (Tomoe flagged)", () => {
  assert.notEqual(TSGO_PROJECT_PNPM_SCRIPT.extensions, "tsgo:extensions:all");
});
