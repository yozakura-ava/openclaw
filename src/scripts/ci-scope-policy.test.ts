import { describe, expect, it } from "vitest";
import {
  CI_MATRIX_BUDGETS,
  classifyCiScope,
  isGlobalCiPath,
} from "../../scripts/lib/ci-scope-policy.mjs";

describe("CI scope policy", () => {
  it.each([
    ["small TypeScript source", ["src/config/defaults.ts"]],
    ["test-only change", ["src/config/defaults.test.ts"]],
    ["UI change", ["ui/src/pages/chat/chat.tsx"]],
    ["native change", ["apps/ios/Sources/RootTabs.swift"]],
    ["security-sensitive source", ["src/security/audit.ts"]],
    ["docs-only change", ["docs/ci.md", "README.md"]],
  ])("keeps %s affected-path scoped", (_label, changedPaths) => {
    expect(
      classifyCiScope({
        eventName: "pull_request",
        repository: "openclaw/openclaw",
        changedPaths,
      }).scope,
    ).toBe("scoped");
  });

  it.each([
    "package.json",
    "pnpm-lock.yaml",
    ".github/workflows/ci.yml",
    "path/that/has/no/known/surface.ts",
  ])("uses fallback for global or unknown path %s", (changedPath) => {
    expect(isGlobalCiPath(changedPath)).toBe(true);
    expect(
      classifyCiScope({
        eventName: "pull_request",
        repository: "openclaw/openclaw",
        changedPaths: [changedPath],
      }),
    ).toMatchObject({ scope: "fallback" });
  });

  it("uses bounded fallback when changed paths are unavailable", () => {
    expect(classifyCiScope({ eventName: "pull_request", changedPaths: null })).toMatchObject({
      scope: "fallback",
    });
    expect(CI_MATRIX_BUDGETS.fallback.node).toBe(120);
  });

  it.each([
    [
      "push to main",
      { eventName: "push", repository: "openclaw/openclaw", ref: "refs/heads/main" },
    ],
    ["manual dispatch", { eventName: "workflow_dispatch", manualScope: "full" }],
    ["ci/full label", { eventName: "pull_request", fullLabel: true }],
  ])("selects full validation for %s", (_label, input) => {
    expect(classifyCiScope(input).scope).toBe("full");
  });
});
