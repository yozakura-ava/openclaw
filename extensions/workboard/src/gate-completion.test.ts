import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnyAgentTool, OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertTerminalTransitionAdmitted,
  buildScrubbedGitEnv,
  GIT_ENV_KEYS_TO_STRIP,
  guardWorkboardToolsForCompletionGate,
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
    ["workboard_move", { id: "card-1", status: "review" }, false],
    ["workboard_move", { id: "card-1" }, false],
    ["workboard_move", undefined, false],
    ["workboard_comment", { id: "card-1", body: "done" }, false],
    ["workboard_list", {}, false],
  ])("detects terminal transition for %s %j", (toolName, rawParams, expected) => {
    expect(isTerminalWorkboardTransition(toolName, rawParams)).toBe(expected);
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
