// Vitest coverage for the scoped ts_verify file→project mapping logic.
// Covers the spec exactly: directory mapping + .d.ts propagation (Tomoe fix a).

import { describe, expect, it } from "vitest";
import {
  ALL_TSGO_PROJECTS,
  formatProjectPlan,
  mapFilesToProjects,
  TSGO_PROJECT_PNPM_SCRIPT,
  type TsgoProject,
} from "../../scripts/ts_verify.mapping.mts";

function sorted(projects: ReadonlySet<TsgoProject>): TsgoProject[] {
  return [...projects].sort((a, b) => ALL_TSGO_PROJECTS.indexOf(a) - ALL_TSGO_PROJECTS.indexOf(b));
}

describe("mapFilesToProjects — directory mapping (tsconfig include rules)", () => {
  it("returns empty set for non-TS files (markdown, docs, json, lockfiles)", () => {
    const projects = mapFilesToProjects([
      "README.md",
      "docs/spec.md",
      "package.json",
      "pnpm-lock.yaml",
      ".gitignore",
      "openclaw.mjs",
    ]);
    expect(projects.size).toBe(0);
  });

  it("routes src/**/*.ts to core only", () => {
    expect(sorted(mapFilesToProjects(["src/foo/bar.ts"]))).toEqual(["core"]);
  });

  it("routes packages/**/*.ts (non-mermaid) to core only", () => {
    expect(
      sorted(mapFilesToProjects(["packages/gateway-protocol/src/foo.ts"])),
    ).toEqual(["core"]);
  });

  it("routes ui/**/* (non d.ts) to ui only", () => {
    expect(sorted(mapFilesToProjects(["ui/src/pages/chat/foo.tsx"]))).toEqual(["ui"]);
  });

  it("routes packages/mermaid-renderer/** to ui (not core, even though core excludes it)", () => {
    expect(
      sorted(mapFilesToProjects(["packages/mermaid-renderer/src/foo.ts"])),
    ).toEqual(["ui"]);
  });

  it("regression: mermaid-renderer does not get silently swallowed by core's packages/ include", () => {
    // Without the PATH_MERMAID-before-PATH_SRC_OR_PACKAGES_TS ordering, the
    // packages/.+ alternation would route this to core and continue, hiding
    // the ui inclusion rule.
    const projects = mapFilesToProjects(["packages/mermaid-renderer/src/foo.ts"]);
    expect(projects.has("ui")).toBe(true);
    expect(projects.has("core")).toBe(false);
  });

  it("routes src/plugin-sdk/control-ui.ts to core AND ui (core excludes it, ui pulls it in)", () => {
    const projects = mapFilesToProjects(["src/plugin-sdk/control-ui.ts"]);
    expect(projects.has("core")).toBe(true);
    expect(projects.has("ui")).toBe(true);
    expect(projects.has("extensions")).toBe(false);
    expect(projects.has("scripts")).toBe(false);
  });

  it("routes src/plugin-sdk/control-ui-components.ts to core AND ui", () => {
    const projects = mapFilesToProjects(["src/plugin-sdk/control-ui-components.ts"]);
    expect(projects.has("core")).toBe(true);
    expect(projects.has("ui")).toBe(true);
  });

  it("does NOT route non-control-ui files under src/plugin-sdk/ into ui", () => {
    const projects = mapFilesToProjects(["src/plugin-sdk/foo.ts"]);
    expect(sorted(projects)).toEqual(["core"]);
  });

  it("routes extensions/**/* to extensions only", () => {
    expect(
      sorted(mapFilesToProjects(["extensions/discord/src/foo.ts"])),
    ).toEqual(["extensions"]);
  });

  it("routes scripts/**/* to scripts only", () => {
    expect(sorted(mapFilesToProjects(["scripts/build.mts"]))).toEqual(["scripts"]);
  });
});

describe("mapFilesToProjects — .d.ts propagation (Tomoe fix a, CRITICAL)", () => {
  it("src/**/*.d.ts → ALL FOUR projects (the false-negative bug Tomoe warned about)", () => {
    const projects = mapFilesToProjects(["src/foo/bar.d.ts"]);
    expect(sorted(projects)).toEqual(["core", "extensions", "scripts", "ui"]);
  });

  it("src/foo.d.ts (top-level src) → ALL FOUR projects (spec demo case)", () => {
    const projects = mapFilesToProjects(["src/foo.d.ts"]);
    expect(sorted(projects)).toEqual(["core", "extensions", "scripts", "ui"]);
    expect(formatProjectPlan(projects)).toBe("core, ui, extensions, scripts");
  });

  it("packages/**/*.d.ts → core + ui + scripts (NOT extensions)", () => {
    const projects = mapFilesToProjects(["packages/sdk/src/types.d.ts"]);
    expect(sorted(projects)).toEqual(["core", "scripts", "ui"]);
    expect(projects.has("extensions")).toBe(false);
  });

  it("ui/src/**/*.d.ts → extensions only", () => {
    expect(sorted(mapFilesToProjects(["ui/src/types.d.ts"]))).toEqual(["extensions"]);
  });

  it("src/plugin-sdk/foo.d.ts still routes to all four (src/**/*.d.ts rule wins over control-ui guard)", () => {
    const projects = mapFilesToProjects(["src/plugin-sdk/api.d.ts"]);
    expect(sorted(projects)).toEqual(["core", "extensions", "scripts", "ui"]);
  });

  it("ui/non-src/types.d.ts routes to ui (tsconfig.ui.json includes ui/**/*)", () => {
    // tsconfig.ui.json includes ui/**/*; a .d.ts outside ui/src/ is still a
    // ui file (not the special ui/src/.d.ts → extensions propagation).
    expect(sorted(mapFilesToProjects(["ui/non-src/types.d.ts"]))).toEqual(["ui"]);
  });
});

describe("mapFilesToProjects — mixed diff", () => {
  it("unions projects across many files (per-file mapping)", () => {
    const projects = mapFilesToProjects([
      "src/foo.ts",
      "extensions/discord/src/bar.ts",
      "scripts/build.mts",
      "ui/src/types.d.ts",
      "docs/readme.md",
    ]);
    // ui/src/types.d.ts → extensions only (per Tomoe fix), so ui is absent.
    expect(sorted(projects)).toEqual(["core", "extensions", "scripts"]);
  });

  it("a src/**/*.d.ts propagator forces all four projects in the union", () => {
    const projects = mapFilesToProjects([
      "src/foo.ts",
      "extensions/discord/src/bar.ts",
      "scripts/build.mts",
      "ui/src/types.d.ts",
      "src/foo.d.ts",
      "docs/readme.md",
    ]);
    expect(sorted(projects)).toEqual(["core", "ui", "extensions", "scripts"]);
  });

  it("ignores empty and whitespace-only entries", () => {
    expect(sorted(mapFilesToProjects(["", "  ", "src/foo.ts", ""]))).toEqual(["core"]);
  });

  it("a single packages/sdk/src/types.d.ts only fans out to core + ui + scripts (NOT extensions)", () => {
    // Real-world regression case: bumping a package type must not trigger a
    // full extensions recompile.
    const projects = mapFilesToProjects(["packages/sdk/src/types.d.ts"]);
    expect(projects.has("extensions")).toBe(false);
    expect(projects.size).toBe(3);
  });
});

describe("formatProjectPlan", () => {
  it("renders the canonical core, ui, extensions, scripts order regardless of insertion order", () => {
    expect(formatProjectPlan(new Set(["ui", "core"]))).toBe("core, ui");
    expect(formatProjectPlan(new Set(["scripts", "extensions", "core"]))).toBe(
      "core, extensions, scripts",
    );
    expect(formatProjectPlan(new Set(["extensions", "scripts", "ui", "core"]))).toBe(
      "core, ui, extensions, scripts",
    );
  });

  it("returns (none) for empty set", () => {
    expect(formatProjectPlan(new Set())).toBe("(none)");
  });
});

describe("TSGO_PROJECT_PNPM_SCRIPT — wrong entrypoints excluded (Tomoe fix)", () => {
  it("maps each project to its per-project incremental script", () => {
    expect(TSGO_PROJECT_PNPM_SCRIPT.core).toBe("tsgo:core");
    expect(TSGO_PROJECT_PNPM_SCRIPT.ui).toBe("tsgo:ui");
    expect(TSGO_PROJECT_PNPM_SCRIPT.extensions).toBe("tsgo:extensions");
    expect(TSGO_PROJECT_PNPM_SCRIPT.scripts).toBe("tsgo:scripts");
  });

  it("does not include any -b composite (tsgo:extensions:all uses -b)", () => {
    const all = Object.values(TSGO_PROJECT_PNPM_SCRIPT);
    expect(all.some((s) => s.includes(":all"))).toBe(false);
  });

  it("does not include tsgo:extensions:all specifically (Tomoe flagged as wrong entrypoint)", () => {
    expect(TSGO_PROJECT_PNPM_SCRIPT.extensions).not.toBe("tsgo:extensions:all");
  });
});
