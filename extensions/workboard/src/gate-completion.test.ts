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
  diffClaimsAgainstDerived,
  extractNumericClaims,
  GATE_CHILD_TIMEOUT_MS,
  GIT_ENV_KEYS_TO_STRIP,
  GIT_ENV_KEY_PREFIXES_TO_STRIP,
  guardWorkboardToolsForCompletionGate,
  isGitEnvKeyToStrip,
  isTerminalWorkboardTransition,
  parseDerivedNumbers,
  probeCanonicalMainState,
  readCompletionClaimText,
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
        // The record (and its derived_numbers cells) only reaches stdout under
        // --json; without it the script prints the ADMITTED line instead.
        "--json",
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

describe("derived-numbers same-basis diff (Part B)", () => {
  let scratch: string;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "gate-numbers-"));
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  function stubScript(body: string): string {
    const path = join(scratch, "derive_stub.py");
    writeFileSync(path, body, "utf8");
    return path;
  }

  /**
   * Record shaped exactly like derive_completion_claim.py --json stdout:
   * every cell carries command, command_argv, count_basis, available, value.
   */
  function numbersRecord(opts?: {
    runtimeValue?: number;
    runtimeAvailable?: boolean;
    additions?: number;
    deletions?: number;
    files?: number;
    numstatAvailable?: boolean;
  }): Record<string, unknown> {
    const runtimeAvailable = opts?.runtimeAvailable ?? true;
    const numstatAvailable = opts?.numstatAvailable ?? true;
    return {
      admitted: true,
      reason: "ancestry_verified",
      derived_numbers: {
        schema_version: 1,
        build_sha: "a".repeat(40),
        authority: "gate-published",
        cells: {
          runtime_cases: {
            count_basis: "runtime_cases",
            command: "pytest --collect-only -q tests",
            command_argv: ["pytest", "--collect-only", "-q", "tests"],
            scope: "tests",
            value: opts?.runtimeValue ?? 30,
            available: runtimeAvailable,
            predicate: runtimeAvailable ? "runtime_cases_derived" : "runtime_cases_unavailable",
            detail: runtimeAvailable ? "30 test(s) collected under tests" : "",
            error: runtimeAvailable ? "" : "pytest --collect-only exited 5: collection failed",
          },
          diff_numstat: {
            count_basis: "diff_numstat",
            command: `git --no-optional-locks diff --numstat ${"a".repeat(40)}^1 ${"a".repeat(40)}`,
            command_argv: ["git", "--no-optional-locks", "diff", "--numstat"],
            diff_base: "first_parent",
            additions: opts?.additions ?? 120,
            deletions: opts?.deletions ?? 30,
            files_touched: opts?.files ?? 4,
            available: numstatAvailable,
            predicate: numstatAvailable ? "diff_numstat_derived" : "diff_numstat_unavailable",
            detail: numstatAvailable ? "+120/-30 across 4 file(s)" : "",
            error: numstatAvailable ? "" : "exit 128: bad revision",
          },
        },
        unavailable: [
          ...(runtimeAvailable ? [] : ["runtime_cases"]),
          ...(numstatAvailable ? [] : ["diff_numstat"]),
        ],
        complete: runtimeAvailable && numstatAvailable,
      },
    };
  }

  function scriptPrinting(record: Record<string, unknown>): string {
    // Embedded as a quoted Python string literal: raw JSON is not valid Python
    // source (`true`/`false`/`null` are not literals).
    const literal = JSON.stringify(JSON.stringify(record));
    return `import sys\nsys.stdout.write(${literal})\n`;
  }

  describe("parseDerivedNumbers", () => {
    it("indexes both published cells by count_basis with their commands", () => {
      const parsed = parseDerivedNumbers(numbersRecord());

      expect(parsed).toBeDefined();
      expect(Object.keys(parsed!.cells).toSorted()).toEqual(["diff_numstat", "runtime_cases"]);
      expect(parsed!.cells.runtime_cases!.metrics.value).toBe(30);
      expect(parsed!.cells.runtime_cases!.command).toBe("pytest --collect-only -q tests");
      expect(parsed!.cells.diff_numstat!.metrics).toMatchObject({
        additions: 120,
        deletions: 30,
        files_touched: 4,
      });
      expect(parsed!.complete).toBe(true);
    });

    it("returns undefined when the script published no command-of-record", () => {
      expect(parseDerivedNumbers({ admitted: true, reason: "ancestry_verified" })).toBeUndefined();
      expect(parseDerivedNumbers(undefined)).toBeUndefined();
    });
  });

  describe("extractNumericClaims", () => {
    it("reads basis-tagged claims and the numstat +/- pair", () => {
      const claims = extractNumericClaims(
        "runtime_cases=30 and diff_numstat=+120/-30 over diff_numstat.files_touched=4",
      );

      expect(claims).toEqual([
        { basis: "runtime_cases", metric: "value", value: 30, source: "runtime_cases=30" },
        { basis: "diff_numstat", metric: "additions", value: 120, source: "diff_numstat=+120/-30" },
        { basis: "diff_numstat", metric: "deletions", value: 30, source: "diff_numstat=+120/-30" },
        {
          basis: "diff_numstat",
          metric: "files_touched",
          value: 4,
          source: "diff_numstat.files_touched=4",
        },
      ]);
    });

    it("ignores bare numbers that name no basis", () => {
      expect(extractNumericClaims("30/30 tests passed, QG PASS, 120 insertions")).toEqual([]);
      expect(extractNumericClaims(undefined)).toEqual([]);
      expect(extractNumericClaims("")).toEqual([]);
    });
  });

  describe("readCompletionClaimText", () => {
    it("joins the completion summary and the proof note", () => {
      expect(
        readCompletionClaimText({
          id: "card-1",
          summary: "runtime_cases=30",
          proof: { note: "QG PASS" },
        }),
      ).toBe("runtime_cases=30\nQG PASS");
      expect(readCompletionClaimText({ id: "card-1" })).toBeUndefined();
      expect(readCompletionClaimText(undefined)).toBeUndefined();
    });

    it("reads only the proof note when no summary is present", () => {
      expect(readCompletionClaimText({ proof: { note: "runtime_cases=30" } })).toBe(
        "runtime_cases=30",
      );
    });
  });

  describe("diffClaimsAgainstDerived", () => {
    it("admits a claim that matches its own basis", () => {
      const diff = diffClaimsAgainstDerived(
        extractNumericClaims("runtime_cases=30"),
        parseDerivedNumbers(numbersRecord()),
      );

      expect(diff).toEqual({ admitted: true, signals: [] });
    });

    it("refuses a same-basis mismatch with the basis in the predicate", () => {
      const diff = diffClaimsAgainstDerived(
        extractNumericClaims("runtime_cases=31"),
        parseDerivedNumbers(numbersRecord()),
      );

      expect(diff.admitted).toBe(false);
      expect(diff).toMatchObject({ code: "numbers_mismatch:runtime_cases" });
      expect(diff.admitted === false && diff.message).toContain("pytest --collect-only -q tests");
    });

    it("signals basis_diverged without refusing when the number is right but mislabelled", () => {
      const diff = diffClaimsAgainstDerived(
        extractNumericClaims("runtime_cases=4"),
        parseDerivedNumbers(numbersRecord()),
      );

      expect(diff.admitted).toBe(true);
      expect(diff.admitted === true && diff.signals[0]).toMatch(/^basis_diverged:/);
      expect(diff.admitted === true && diff.signals[0]).toContain("diff_numstat");
    });

    it("refuses an unavailable cell even when the number matches another basis", () => {
      const derived = parseDerivedNumbers(numbersRecord({ runtimeAvailable: false, files: 4 }))!;
      expect(derived.cells.runtime_cases!.available).toBe(false);

      const diff = diffClaimsAgainstDerived(extractNumericClaims("runtime_cases=4"), derived);

      expect(diff.admitted).toBe(false);
      expect(diff).toMatchObject({ code: "numbers_unavailable_vs_claimed" });
      expect(diff.admitted === false && diff.message).toContain("runtime_cases_unavailable");
    });

    it("refuses a claim whose metric its own basis never publishes", () => {
      const diff = diffClaimsAgainstDerived(
        extractNumericClaims("diff_numstat=120"),
        parseDerivedNumbers(numbersRecord()),
      );

      expect(diff.admitted).toBe(false);
      expect(diff).toMatchObject({ code: "numbers_mismatch:diff_numstat" });
    });

    it("refuses when the script published no derived_numbers at all", () => {
      const diff = diffClaimsAgainstDerived(extractNumericClaims("runtime_cases=30"), undefined);

      expect(diff).toMatchObject({ admitted: false, code: "numbers_unavailable_vs_claimed" });
    });

    it("ignores a basis the gate does not publish", () => {
      const diff = diffClaimsAgainstDerived(
        extractNumericClaims("lint_errors=7"),
        parseDerivedNumbers(numbersRecord()),
      );

      expect(diff).toEqual({ admitted: true, signals: [] });
    });

    it("admits a payload with no numeric claims at all", () => {
      expect(diffClaimsAgainstDerived([], parseDerivedNumbers(numbersRecord()))).toEqual({
        admitted: true,
        signals: [],
      });
    });
  });

  describe("deriveCompletionClaim end to end", () => {
    async function run(
      record: Record<string, unknown>,
      claimText?: string,
    ): Promise<{
      admitted: boolean;
      code?: string;
      message?: string;
      signals?: string[];
      reason?: string;
    }> {
      const repo = gitRepo();
      const script = stubScript(scriptPrinting(record));
      try {
        return (await deriveCompletionClaim({
          scriptPath: script,
          evidence: { cardId: "card-1", buildSha: "a".repeat(40), allowedFiles: [] },
          mainRoot: repo,
          mainRef: "main",
          ...(claimText === undefined ? {} : { claimText }),
        })) as never;
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    }

    it("admits a matching claim with no signals", async () => {
      const verdict = await run(numbersRecord(), "runtime_cases=30; QG PASS");

      expect(verdict).toEqual({ admitted: true, reason: "claim:ancestry_verified" });
    });

    it("refuses a drifted count", async () => {
      const verdict = await run(numbersRecord(), "runtime_cases=29");

      expect(verdict.admitted).toBe(false);
      expect(verdict.code).toBe("numbers_mismatch:runtime_cases");
    });

    it("refuses when the claimed basis was never derivable", async () => {
      const verdict = await run(numbersRecord({ runtimeAvailable: false }), "runtime_cases=30");

      expect(verdict.admitted).toBe(false);
      expect(verdict.code).toBe("numbers_unavailable_vs_claimed");
    });

    it("admits with a basis_diverged signal on the verdict record", async () => {
      const verdict = await run(numbersRecord(), "runtime_cases=4");

      expect(verdict.admitted).toBe(true);
      expect(verdict.reason).toBe("claim:ancestry_verified");
      expect(verdict.signals?.[0]).toMatch(/^basis_diverged:/);
    });

    it("leaves claim-free completions byte-identical to the scaffold shape", async () => {
      const verdict = await run(numbersRecord(), "card done, QG PASS, no numbers here");

      expect(verdict).toEqual({ admitted: true, reason: "claim:ancestry_verified" });
    });
  });

  describe("assertTerminalTransitionAdmitted numbers wiring", () => {
    async function completeWith(
      record: Record<string, unknown>,
      params: Record<string, unknown>,
    ): Promise<{ admitted: boolean; code?: string; signals?: string[] }> {
      const repo = gitRepo();
      const script = stubScript(scriptPrinting(record));
      try {
        return (await assertTerminalTransitionAdmitted(
          "workboard_complete",
          { id: "card-1", buildSha: "a".repeat(40), ...params },
          contextWith({ enabled: true, mainRoot: repo, mainRef: "main", deriveScript: script }),
        )) as never;
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    }

    it("diffs the completion summary against the published cell", async () => {
      const verdict = await completeWith(numbersRecord(), { summary: "runtime_cases=30" });

      expect(verdict).toEqual({ admitted: true, reason: "claim:ancestry_verified" });
    });

    it("diffs the proof note when the summary carries no numbers", async () => {
      const verdict = await completeWith(numbersRecord(), {
        summary: "all good",
        proof: { status: "passed", note: "runtime_cases=99" },
      });

      expect(verdict.admitted).toBe(false);
      expect(verdict.code).toBe("numbers_mismatch:runtime_cases");
    });

    it("diffs the numstat pair asserted in the proof note", async () => {
      const verdict = await completeWith(numbersRecord(), {
        proof: { note: "diff_numstat=+120/-30 across diff_numstat.files_touched=4" },
      });

      expect(verdict).toEqual({ admitted: true, reason: "claim:ancestry_verified" });
    });
  });
});
