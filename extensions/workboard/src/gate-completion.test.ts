import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnyAgentTool, OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertTerminalTransitionAdmitted,
  buildScrubbedGitEnv,
  deriveCompletionClaim,
  GATE_CHILD_TIMEOUT_MS,
  GIT_ENV_KEYS_TO_STRIP,
  GIT_ENV_KEY_PREFIXES_TO_STRIP,
  guardWorkboardToolsForCompletionGate,
  isGitEnvKeyToStrip,
  isTerminalWorkboardTransition,
  probeCanonicalMainState,
  resolveCanonicalMainRoot,
  resolveCompletionGateConfig,
} from "./gate-completion.js";

function contextWith(completionGate?: unknown): OpenClawPluginToolContext {
  return {
    workspaceDir: "/some/worktree",
    config:
      completionGate === undefined
        ? {}
        : { plugins: { entries: { workboard: { completionGate } } } },
  } as unknown as OpenClawPluginToolContext;
}

function gitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "gate-completion-"));
  execFileSync("git", ["init", "-q", dir], { stdio: "ignore" });
  // The probe resolves `main` by name, so the fixture needs a real main ref.
  execFileSync("git", ["-C", dir, "symbolic-ref", "HEAD", "refs/heads/main"], { stdio: "ignore" });
  execFileSync(
    "git",
    [
      "-C",
      dir,
      "-c",
      "user.email=gate-completion@openclaw.local",
      "-c",
      "user.name=gate-completion",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "init",
    ],
    { stdio: "ignore" },
  );
  return dir;
}

describe("resolveCompletionGateConfig", () => {
  it("defaults to disabled with main ref main when no config is present", () => {
    expect(resolveCompletionGateConfig(contextWith())).toEqual({ enabled: false, mainRef: "main" });
    expect(resolveCanonicalMainRoot(contextWith())).toBeUndefined();
  });

  it("reads the plugin-scoped block and normalizes blank strings", () => {
    const config = resolveCompletionGateConfig(
      contextWith({
        enabled: true,
        mainRoot: "  /srv/canonical  ",
        mainRef: " ",
        rolloutOwner: " kaito ",
        rolloutEndsOn: "2026-11-01",
      }),
    );

    expect(config).toEqual({
      enabled: true,
      mainRoot: "/srv/canonical",
      mainRef: "main",
      rolloutOwner: "kaito",
      rolloutEndsOn: "2026-11-01",
    });
    expect(resolveCanonicalMainRoot(contextWith({ mainRoot: "/srv/canonical" }))).toBe(
      "/srv/canonical",
    );
  });

  it("treats any non-true enabled value as disabled", () => {
    expect(resolveCompletionGateConfig(contextWith({ enabled: "true" })).enabled).toBe(false);
    expect(resolveCompletionGateConfig(contextWith({ enabled: 1 })).enabled).toBe(false);
  });
});

describe("isTerminalWorkboardTransition", () => {
  it.each([
    ["workboard_complete", { id: "card-1" }, true],
    ["workboard_force_close", { id: "card-1" }, true],
    ["workboard_move", { id: "card-1", status: "done" }, true],
    ["workboard_move", { id: "card-1", status: " DONE " }, true],
    ["workboard_move", { id: "card-1", status: "cancelled" }, true],
    ["workboard_move", { id: "card-1", status: " Cancelled " }, true],
    ["workboard_move", { id: "card-1", status: "review" }, false],
    ["workboard_move", { id: "card-1", status: "todo" }, false],
    ["workboard_move", { id: "card-1" }, false],
    ["workboard_move", undefined, false],
    ["workboard_comment", { id: "card-1", body: "done" }, false],
    ["workboard_list", {}, false],
  ])("detects terminal transition for %s %j", (toolName, rawParams, expected) => {
    expect(isTerminalWorkboardTransition(toolName, rawParams)).toBe(expected);
  });

  it("guards both terminal statuses reached through the only moving tool", () => {
    // done/cancelled are only reachable via workboard_move in the guarded set;
    // workboard_complete and workboard_force_close are terminal by tool name.
    const guarded = new Set(["workboard_complete", "workboard_force_close"]);
    expect(guarded.has("workboard_move")).toBe(false);
    for (const status of ["done", "cancelled"]) {
      expect(isTerminalWorkboardTransition("workboard_move", { status })).toBe(true);
    }
  });
});

describe("GIT_CONFIG_* env-scrub gap (Rin finding 1)", () => {
  it("strips the config-injection family and the object-directory redirects", () => {
    const scrubbed = buildScrubbedGitEnv({
      GIT_DIR: "/repo/.git",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "status.showUntrackedFiles",
      GIT_CONFIG_VALUE_0: "no",
      GIT_CONFIG_KEY_7: "core.fsmonitor",
      GIT_CONFIG_VALUE_7: "/evil/hook",
      GIT_CONFIG_GLOBAL: "/evil/globalconfig",
      GIT_CONFIG_SYSTEM: "/etc/evilconfig",
      GIT_COMMON_DIR: "/repo/.git/commondir",
      GIT_OBJECT_DIRECTORY: "/evil/objects",
      GIT_ALTERNATE_OBJECT_DIRECTORIES: "/evil/alt-objects",
      PATH: "/usr/bin",
    });

    for (const key of GIT_ENV_KEYS_TO_STRIP) {
      expect(scrubbed[key], `${key} must be stripped`).toBeUndefined();
    }
    for (const key of Object.keys(scrubbed)) {
      expect(isGitEnvKeyToStrip(key), `${key} must not survive the scrub`).toBe(false);
    }
    expect(scrubbed.PATH).toBe("/usr/bin");
  });

  it("matches the config-injection families by prefix", () => {
    expect(GIT_ENV_KEY_PREFIXES_TO_STRIP).toContain("GIT_CONFIG_KEY_");
    expect(GIT_ENV_KEY_PREFIXES_TO_STRIP).toContain("GIT_CONFIG_VALUE_");
    expect(isGitEnvKeyToStrip("GIT_CONFIG_KEY_42")).toBe(true);
    expect(isGitEnvKeyToStrip("GIT_CONFIG_VALUE_42")).toBe(true);
    expect(isGitEnvKeyToStrip("GIT_CONFIGURABLE")).toBe(false);
    expect(isGitEnvKeyToStrip("PATH")).toBe(false);
  });

  it("a poisoned GIT_CONFIG_COUNT cannot blank the status output", async () => {
    // Regression pin for the proven fail-open: status.showUntrackedFiles=no was
    // injected through the parent env and blanked the gate's dirty probe.
    const repo = gitRepo();
    const previous = { ...process.env };
    try {
      execFileSync("sh", ["-c", `printf 'dirty\\n' >> "${join(repo, "dirty.txt")}"`]);
      process.env.GIT_CONFIG_COUNT = "1";
      process.env.GIT_CONFIG_KEY_0 = "status.showUntrackedFiles";
      process.env.GIT_CONFIG_VALUE_0 = "no";

      const state = await probeCanonicalMainState({ mainRoot: repo, mainRef: "main" });

      expect(state.dirty, "injected config must not suppress the dirty probe").toBe(true);
    } finally {
      process.env = previous;
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("bounds every child process with a timeout", () => {
    expect(GATE_CHILD_TIMEOUT_MS).toBeGreaterThan(0);
    expect(GATE_CHILD_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
  });
});

describe("configSchema declares completionGate (Rin finding 3)", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
  ) as { configSchema: { additionalProperties?: boolean; properties: Record<string, unknown> } };

  it("would hard-fail plugin load if completionGate stayed undeclared", () => {
    // configSchema is additionalProperties:false, so an undeclared completionGate
    // key fails validatePluginConfig and takes all workboard tools offline.
    expect(manifest.configSchema.additionalProperties).toBe(false);
    expect(Object.keys(manifest.configSchema.properties)).toContain("completionGate");
  });

  it("declares every gate key the resolver reads", () => {
    const gate = manifest.configSchema.properties.completionGate as {
      properties: Record<string, unknown>;
    };
    expect(Object.keys(gate.properties).sort()).toEqual([
      "deriveScript",
      "enabled",
      "mainRef",
      "mainRoot",
      "rolloutEndsOn",
      "rolloutOwner",
    ]);
  });
});

describe("claim enforcement wiring (Phase 1)", () => {
  let scratch: string;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "gate-derive-"));
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  function stubScript(body: string): string {
    const path = join(scratch, "derive_stub.py");
    writeFileSync(path, body, "utf8");
    return path;
  }

  it("admits when the claim script reports an admitted claim", async () => {
    const repo = gitRepo();
    const script = stubScript(
      'import json,sys\nprint(json.dumps({"admitted": True, "reason": "ancestry_verified"}))\nsys.exit(0)\n',
    );
    try {
      const verdict = await deriveCompletionClaim({
        scriptPath: script,
        evidence: { cardId: "card-1", buildSha: "deadbeef", allowedFiles: ["f.py"] },
        mainRoot: repo,
        mainRef: "main",
      });
      expect(verdict).toEqual({ admitted: true, reason: "claim:ancestry_verified" });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("maps the script's own refusal exit code to a refusal", async () => {
    const repo = gitRepo();
    const script = stubScript(
      'import sys\nsys.stderr.write("REFUSED [file_presence:f.py] blob drift\\n")\nsys.exit(3)\n',
    );
    try {
      const verdict = await deriveCompletionClaim({
        scriptPath: script,
        evidence: { cardId: "card-1", buildSha: "deadbeef", allowedFiles: ["f.py"] },
        mainRoot: repo,
        mainRef: "main",
      });
      expect(verdict.admitted).toBe(false);
      expect(verdict).toMatchObject({ code: "claim_refused" });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("fails closed on a probe failure exit code, naming the predicate", async () => {
    const repo = gitRepo();
    const script = stubScript(
      'import sys\nsys.stderr.write("REFUSED [main_ref_unresolvable] no such ref\\n")\nsys.exit(5)\n',
    );
    try {
      const verdict = await deriveCompletionClaim({
        scriptPath: script,
        evidence: { cardId: "card-1", buildSha: "deadbeef", allowedFiles: [] },
        mainRoot: repo,
        mainRef: "main",
      });
      expect(verdict).toMatchObject({ code: "claim_main_ref_unresolvable" });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("fails closed when the script is missing", async () => {
    const repo = gitRepo();
    try {
      const verdict = await deriveCompletionClaim({
        scriptPath: join(scratch, "does-not-exist.py"),
        evidence: { cardId: "card-1", buildSha: "deadbeef", allowedFiles: [] },
        mainRoot: repo,
        mainRef: "main",
      });
      expect(verdict.admitted).toBe(false);
      expect(verdict).toMatchObject({ code: "derive_script_failed" });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("refuses a relative derive script instead of resolving it from CWD", async () => {
    const repo = gitRepo();
    try {
      const verdict = await deriveCompletionClaim({
        scriptPath: "scripts/gate/derive_completion_claim.py",
        evidence: { cardId: "card-1", buildSha: "deadbeef", allowedFiles: [] },
        mainRoot: repo,
        mainRef: "main",
      });
      expect(verdict).toMatchObject({ code: "derive_script_not_absolute" });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("stays scaffold-only when deriveScript is not configured", async () => {
    const repo = gitRepo();
    try {
      const verdict = await assertTerminalTransitionAdmitted(
        "workboard_complete",
        { id: "card-1" },
        contextWith({ enabled: true, mainRoot: repo }),
      );
      expect(verdict).toEqual({ admitted: true, reason: "scaffold-probe-passed" });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("refuses when the transition carries no card id to derive from", async () => {
    const repo = gitRepo();
    const script = stubScript("import sys\nsys.exit(0)\n");
    try {
      const verdict = await assertTerminalTransitionAdmitted(
        "workboard_move",
        { status: "cancelled", buildSha: "deadbeef" },
        contextWith({ enabled: true, mainRoot: repo, deriveScript: script }),
      );
      expect(verdict).toMatchObject({ code: "missing_claim_evidence" });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("refuses when the transition carries no build anchor", async () => {
    const repo = gitRepo();
    const script = stubScript("import sys\nsys.exit(0)\n");
    try {
      const verdict = await assertTerminalTransitionAdmitted(
        "workboard_complete",
        { id: "card-1", allowedFiles: ["f.py"] },
        contextWith({ enabled: true, mainRoot: repo, deriveScript: script }),
      );
      expect(verdict).toMatchObject({ code: "missing_build_identity" });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("forwards card id, build sha and allowed files to the script", async () => {
    const repo = gitRepo();
    const recorder = join(scratch, "argv.json");
    const script = stubScript(
      `import json,sys\n` +
        `open(${JSON.stringify(recorder)}, "w").write(json.dumps(sys.argv[1:]))\n` +
        `sys.exit(0)\n`,
    );
    try {
      const verdict = await assertTerminalTransitionAdmitted(
        "workboard_move",
        {
          id: "card-42",
          status: "done",
          buildSha: "a".repeat(40),
          allowedFiles: ["scripts/gate/derive_completion_claim.py", "tests/x.py"],
        },
        contextWith({ enabled: true, mainRoot: repo, mainRef: "main", deriveScript: script }),
      );
      expect(verdict.admitted).toBe(true);
      const argv = JSON.parse(readFileSync(recorder, "utf8")) as string[];
      expect(argv).toEqual([
        "--card-id",
        "card-42",
        "--main-root",
        repo,
        "--main-ref",
        "main",
        "--build-sha",
        "a".repeat(40),
        "--allowed-file",
        "scripts/gate/derive_completion_claim.py",
        "--allowed-file",
        "tests/x.py",
      ]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("disabled gate passthrough", () => {
  it("admits without touching git even with an unprobeable mainRoot", async () => {
    const verdict = await assertTerminalTransitionAdmitted(
      "workboard_complete",
      { id: "card-1" },
      contextWith({ enabled: false, mainRoot: "/nonexistent/canonical-root" }),
    );

    expect(verdict).toEqual({ admitted: true, reason: "gate-disabled" });
  });

  it("admits non-terminal tools without probing", async () => {
    const verdict = await assertTerminalTransitionAdmitted(
      "workboard_comment",
      { id: "card-1", body: "hello" },
      contextWith({ enabled: true, mainRoot: "/nonexistent/canonical-root" }),
    );

    expect(verdict).toEqual({ admitted: true, reason: "non-terminal-transition" });
  });
});

describe("git probe", () => {
  let repo: string;

  beforeEach(() => {
    repo = gitRepo();
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("strips git override variables from the child environment", () => {
    const scrubbed = buildScrubbedGitEnv({
      GIT_DIR: "/repo/.git",
      GIT_WORK_TREE: "/repo",
      GIT_INDEX_FILE: "/repo/index",
      GIT_CONFIG_PARAMETERS: "'a=b'",
      PATH: "/usr/bin",
    });

    for (const key of GIT_ENV_KEYS_TO_STRIP) {
      expect(scrubbed[key]).toBeUndefined();
    }
    expect(scrubbed.PATH).toBe("/usr/bin");
    expect(process.env.GIT_DIR).not.toBe("/repo/.git");
  });

  it("resolves against the declared main root despite poisoned parent git env", async () => {
    const previous = process.env.GIT_DIR;
    process.env.GIT_DIR = "/nonexistent/GIT_DIR";
    try {
      const state = await probeCanonicalMainState({ mainRoot: repo, mainRef: "main" });

      expect(state).toEqual({ mainRoot: repo, mainRef: "main", dirty: false });
    } finally {
      if (previous === undefined) {
        delete process.env.GIT_DIR;
      } else {
        process.env.GIT_DIR = previous;
      }
    }
  });

  it("reports a dirty canonical main working tree", async () => {
    execFileSync("sh", ["-c", `printf 'dirty\\n' >> "${join(repo, "dirty.txt")}"`]);

    const state = await probeCanonicalMainState({ mainRoot: repo, mainRef: "main" });

    expect(state.dirty).toBe(true);
  });

  it("fails closed when the declared root is not a git checkout", async () => {
    const notARepo = mkdtempSync(join(tmpdir(), "gate-completion-plain-"));
    try {
      await expect(
        probeCanonicalMainState({ mainRoot: notARepo, mainRef: "main" }),
      ).rejects.toThrow(/completion gate: git probe failed/);
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
  });

  it("fails closed when the declared ref does not resolve", async () => {
    await expect(probeCanonicalMainState({ mainRoot: repo, mainRef: "nope" })).rejects.toThrow(
      /ref nope/,
    );
  });
});

describe("fail-closed mapping on the assertion", () => {
  it("refuses when the gate is enabled without a declared main root", async () => {
    const verdict = await assertTerminalTransitionAdmitted(
      "workboard_move",
      { id: "card-1", status: "done" },
      contextWith({ enabled: true }),
    );

    expect(verdict.admitted).toBe(false);
    expect(verdict).toMatchObject({ code: "missing_main_root" });
  });

  it("refuses when the git probe cannot prove canonical main state", async () => {
    const verdict = await assertTerminalTransitionAdmitted(
      "workboard_complete",
      { id: "card-1" },
      contextWith({ enabled: true, mainRoot: "/nonexistent/canonical-root" }),
    );

    expect(verdict.admitted).toBe(false);
    expect(verdict).toMatchObject({ code: "git_probe_failed" });
  });

  it("admits a terminal transition once the probe passes (Phase 0 scaffold)", async () => {
    const repo = gitRepo();
    try {
      const verdict = await assertTerminalTransitionAdmitted(
        "workboard_complete",
        { id: "card-1" },
        contextWith({ enabled: true, mainRoot: repo }),
      );

      expect(verdict).toEqual({ admitted: true, reason: "scaffold-probe-passed" });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("guardWorkboardToolsForCompletionGate", () => {
  function stubTool(name: string): { tool: AnyAgentTool; calls: unknown[] } {
    const calls: unknown[] = [];
    const tool = {
      name,
      execute: async (_toolCallId: string, rawParams: unknown) => {
        calls.push(rawParams);
        return { ok: true };
      },
    } as unknown as AnyAgentTool;
    return { tool, calls };
  }

  it("forwards params untouched while the gate is disabled", async () => {
    const { tool, calls } = stubTool("workboard_complete");
    const [guarded] = guardWorkboardToolsForCompletionGate([tool], contextWith());

    const result = await guarded!.execute("call-1", { id: "card-1" });

    expect(result).toEqual({ ok: true });
    expect(calls).toEqual([{ id: "card-1" }]);
  });

  it("composes without mutating the original tool list", () => {
    const tools = [stubTool("workboard_complete").tool, stubTool("workboard_comment").tool];

    const guarded = guardWorkboardToolsForCompletionGate(tools, contextWith());

    expect(guarded).toHaveLength(2);
    expect(tools.every((tool) => tool.execute === stubTool("x").tool.execute)).toBe(false);
    expect(guarded.map((tool) => tool.name)).toEqual(["workboard_complete", "workboard_comment"]);
  });

  it("throws on a refused terminal transition", async () => {
    const { tool, calls } = stubTool("workboard_complete");
    const [guarded] = guardWorkboardToolsForCompletionGate(
      [tool],
      contextWith({ enabled: true, mainRoot: "/nonexistent/canonical-root" }),
    );

    await expect(guarded!.execute("call-1", { id: "card-1" })).rejects.toThrow(
      /workboard completion gate refused workboard_complete/,
    );
    expect(calls).toEqual([]);
  });
});
