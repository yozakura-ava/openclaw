import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  SKILL_COLLECTION_REVIEW_SWEEP_AGENT_ID,
  SKILL_COLLECTION_REVIEW_SWEEP_DECLARATION_KEY,
  SKILL_COLLECTION_REVIEW_SWEEP_SCRIPT,
  resolveSkillCollectionReviewMonitorSpecs,
} from "./skill-collection-review-monitor.js";

describe("resolveSkillCollectionReviewMonitorSpecs", () => {
  it("creates one stable seven-day job for every agent", () => {
    const cfg = {
      agents: {
        list: [
          { id: "main", default: true, workspace: "/tmp/openclaw-shared" },
          { id: "ops", workspace: "/tmp/openclaw-shared" },
          { id: "solo", workspace: "/tmp/openclaw-solo" },
        ],
        defaults: { model: "anthropic/claude-sonnet-4-6" },
      },
      skills: { workshop: { autonomous: { mode: "auto" } } },
    } as OpenClawConfig;

    const specs = Array.from(
      resolveSkillCollectionReviewMonitorSpecs(cfg, [], { schedulerSeed: "test-seed" }),
    );

    expect(specs.map(({ agentId }) => agentId)).toEqual(["main", "ops", "solo"]);
    expect(specs.map(({ input }) => input.declarationKey)).toEqual([
      "skill-collection-review:main",
      "skill-collection-review:ops",
      "skill-collection-review:solo",
    ]);
    expect(specs[0]?.input).toMatchObject({
      name: "skill-collection-review-main",
      displayName: "Skill collection review (main)",
      enabled: true,
      payload: {
        kind: "agentTurn",
        message: expect.any(String),
        toolsAllow: ["ls", "read", "write", "edit", "apply_patch", "exec", "process"],
      },
      schedule: {
        kind: "every",
        everyMs: 7 * 24 * 60 * 60_000,
        anchorMs: expect.any(Number),
      },
      sessionTarget: "isolated",
      delivery: { mode: "none" },
      wakeMode: "next-heartbeat",
    });
    expect(specs[0]?.input.payload).not.toHaveProperty("toolsAllowIsDefault");
    const repeated = Array.from(
      resolveSkillCollectionReviewMonitorSpecs(cfg, [], { schedulerSeed: "test-seed" }),
    );
    expect(repeated.map(({ input }) => input.schedule)).toEqual(
      specs.map(({ input }) => input.schedule),
    );
  });

  it("creates jobs for every agent in an explicit fleet", () => {
    const explicitFleet = {
      agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
    } as unknown as OpenClawConfig;
    expect(
      Array.from(
        resolveSkillCollectionReviewMonitorSpecs(explicitFleet, []),
        ({ agentId }) => agentId,
      ),
    ).toEqual(["ops", "research"]);

    const systemAgentFleet = {
      agents: {
        ownership: "explicit",
        entries: { ops: {}, research: {} },
        defaults: { systemAgent: { agentId: "research" } },
      },
    } as unknown as OpenClawConfig;
    expect(
      Array.from(
        resolveSkillCollectionReviewMonitorSpecs(systemAgentFleet, []),
        ({ agentId }) => agentId,
      ),
    ).toEqual(["ops", "research"]);
  });

  it("retains monitor rows while autonomous review is disabled", () => {
    const cfg = {
      agents: { list: [{ id: "main", workspace: "/tmp/openclaw-disabled" }] },
      skills: { workshop: { autonomous: { mode: "propose" } } },
    } as OpenClawConfig;

    const [spec] = resolveSkillCollectionReviewMonitorSpecs(cfg, [], {
      schedulerSeed: "test-seed",
    });
    expect(spec?.input.enabled).toBe(false);
    expect(spec?.input.displayName).not.toContain("no-rooted-runtime");
  });

  it("disables only agents whose complete configured chain cannot enforce the review root", () => {
    const cfg = {
      agents: {
        defaults: { model: "anthropic/claude-sonnet-4-6" },
        list: [
          {
            id: "blocked",
            model: {
              primary: "openai/gpt-blocked",
              fallbacks: ["openai/gpt-still-blocked"],
            },
            models: {
              "openai/gpt-blocked": { agentRuntime: { id: "codex" } },
              "openai/gpt-still-blocked": { agentRuntime: { id: "codex" } },
            },
          },
          {
            id: "fallback",
            model: {
              primary: "openai/gpt-blocked",
              fallbacks: ["anthropic/claude-sonnet-4-6"],
            },
            models: {
              "openai/gpt-blocked": { agentRuntime: { id: "codex" } },
            },
          },
          { id: "embedded", model: "anthropic/claude-sonnet-4-6" },
          { id: "implicit", model: "openai/gpt-5.2" },
          { id: "cli", model: "claude-cli/claude-opus-4-6" },
        ],
      },
      skills: { workshop: { autonomous: { mode: "auto" } } },
    } as OpenClawConfig;

    const byAgent = new Map(
      Array.from(resolveSkillCollectionReviewMonitorSpecs(cfg, []), (spec) => [
        spec.agentId,
        spec.input,
      ]),
    );

    expect(byAgent.get("blocked")).toMatchObject({
      enabled: false,
      displayName: expect.stringContaining("no-rooted-runtime"),
    });
    for (const agentId of ["fallback", "embedded", "implicit", "cli"]) {
      expect(byAgent.get(agentId)?.enabled).toBe(true);
      expect(byAgent.get(agentId)?.displayName).not.toContain("no-rooted-runtime");
    }
  });

  it("does not create session storage while projecting an existing monitor", async () => {
    const testState = await createOpenClawTestState({ label: "skill-review-projection" });
    try {
      const cfg: OpenClawConfig = {
        agents: {
          entries: {
            main: {
              model: "openai/gpt-blocked",
              models: { "openai/gpt-blocked": { agentRuntime: { id: "codex" } } },
            },
          },
        },
        skills: { workshop: { autonomous: { mode: "auto" } } },
      };
      const options = { schedulerSeed: "test-seed" };
      const [initial] = resolveSkillCollectionReviewMonitorSpecs(cfg, [], options);
      const [projected] = resolveSkillCollectionReviewMonitorSpecs(
        cfg,
        [
          {
            ...initial!.input,
            id: "existing-review",
            enabled: true,
            createdAtMs: 1,
            updatedAtMs: 1,
            state: {},
          },
        ],
        options,
      );
      expect(projected?.input.enabled).toBe(false);
      expect(await fs.readdir(testState.stateDir)).toEqual([]);
    } finally {
      await testState.cleanup();
    }
  });

  it("keeps an executable agent-scoped review alias enabled", () => {
    const cfg = {
      agents: {
        defaults: { model: "openai/gpt-blocked" },
        list: [
          {
            id: "reviewer",
            subagents: { model: "review" },
            models: {
              "openai/gpt-blocked": { agentRuntime: { id: "codex" } },
              "openai/review": { agentRuntime: { id: "codex" } },
              "anthropic/claude-sonnet-4-6": { alias: "review" },
            },
          },
        ],
      },
      skills: { workshop: { autonomous: { mode: "auto" } } },
    } as OpenClawConfig;
    const [spec] = resolveSkillCollectionReviewMonitorSpecs(cfg, []);
    expect(spec?.input.enabled).toBe(true);
    expect(spec?.input.displayName).not.toContain("no-rooted-runtime");
  });

  it("does not disable a runnable default when an advisory subagent model can be rejected", () => {
    const cfg = {
      agents: {
        defaults: { model: "anthropic/claude-sonnet-4-6" },
        list: [
          {
            id: "reviewer",
            subagents: { model: "openai/gpt-blocked" },
            modelPolicy: { allow: ["anthropic/claude-sonnet-4-6"] },
            models: { "openai/gpt-blocked": { agentRuntime: { id: "codex" } } },
          },
        ],
      },
      skills: { workshop: { autonomous: { mode: "auto" } } },
    } as OpenClawConfig;
    const [spec] = resolveSkillCollectionReviewMonitorSpecs(cfg, []);
    expect(spec?.input.enabled).toBe(true);
    expect(spec?.input.displayName).not.toContain("no-rooted-runtime");
  });

  // HR4 targeted test: the consolidated flag must collapse per-agent specs into
  // a single weekly script-driven sweep, with default behavior unchanged.
  describe("consolidated sweep flag (skills.workshop.consolidated)", () => {
    it("returns the per-agent fleet when the flag is absent or false (default behaviour)", () => {
      const cfg = {
        agents: {
          list: [
            { id: "main", default: true, workspace: "/tmp/openclaw-shared" },
            { id: "ops", workspace: "/tmp/openclaw-shared" },
            { id: "solo", workspace: "/tmp/openclaw-solo" },
          ],
          defaults: { model: "anthropic/claude-sonnet-4-6" },
        },
        skills: { workshop: { autonomous: { mode: "auto" } } },
      } as OpenClawConfig;

      const absent = Array.from(
        resolveSkillCollectionReviewMonitorSpecs(cfg, [], { schedulerSeed: "test-seed" }),
      );
      const explicitFalse = Array.from(
        resolveSkillCollectionReviewMonitorSpecs(
          { ...cfg, skills: { workshop: { autonomous: { mode: "auto" }, consolidated: false } } },
          [],
          { schedulerSeed: "test-seed" },
        ),
      );

      for (const specs of [absent, explicitFalse]) {
        expect(specs.map(({ agentId }) => agentId)).toEqual(["main", "ops", "solo"]);
        expect(specs.map(({ input }) => input.declarationKey)).toEqual([
          "skill-collection-review:main",
          "skill-collection-review:ops",
          "skill-collection-review:solo",
        ]);
        expect(specs[0]?.input.payload.kind).toBe("agentTurn");
      }
    });

    it("yields exactly one script-driven sweep spec when the flag is true", () => {
      const cfg = {
        agents: {
          list: [
            { id: "main", default: true, workspace: "/tmp/openclaw-shared" },
            { id: "ops", workspace: "/tmp/openclaw-shared" },
            { id: "solo", workspace: "/tmp/openclaw-solo" },
          ],
          defaults: { model: "anthropic/claude-sonnet-4-6" },
        },
        skills: {
          workshop: { autonomous: { mode: "auto" }, consolidated: true },
        },
      } as OpenClawConfig;

      const specs = Array.from(
        resolveSkillCollectionReviewMonitorSpecs(cfg, [], { schedulerSeed: "test-seed" }),
      );

      expect(specs).toHaveLength(1);
      const [spec] = specs;
      expect(spec?.agentId).toBe(SKILL_COLLECTION_REVIEW_SWEEP_AGENT_ID);
      expect(spec?.input.declarationKey).toBe(SKILL_COLLECTION_REVIEW_SWEEP_DECLARATION_KEY);
      expect(spec?.input.declarationKey).toBe("skill-collection-review:sweep");
      expect(spec?.input.name).toBe("skill-collection-review-sweep");
      expect(spec?.input.displayName).toBe("Skill collection review (sweep)");
      expect(spec?.input.enabled).toBe(true);
      expect(spec?.input.payload.kind).toBe("script");
      if (spec?.input.payload.kind === "script") {
        expect(spec.input.payload.script).toBe(SKILL_COLLECTION_REVIEW_SWEEP_SCRIPT);
        // The inline payload must reference the durable shell script so the
        // 28-agent census stays defined in exactly one place.
        expect(spec.input.payload.script).toContain(
          "/root/.openclaw/workspace/scripts/ops/skill_collection_sweep.sh",
        );
      }
      expect(spec?.input.schedule).toMatchObject({
        kind: "every",
        everyMs: 7 * 24 * 60 * 60_000,
        anchorMs: expect.any(Number),
      });
      expect(spec?.input.sessionTarget).toBe("isolated");
      expect(spec?.input.delivery).toEqual({ mode: "none" });
      expect(spec?.input.wakeMode).toBe("next-heartbeat");
    });

    it("does not produce per-agent specs when the flag is true even with a large fleet", () => {
      const fleet = Array.from({ length: 12 }, (_, i) => ({
        id: `agent-${i}`,
        workspace: `/tmp/openclaw-agent-${i}`,
      }));
      const cfg = {
        agents: {
          list: [{ id: "main", default: true, workspace: "/tmp/openclaw-shared" }, ...fleet],
          defaults: { model: "anthropic/claude-sonnet-4-6" },
        },
        skills: {
          workshop: { autonomous: { mode: "auto" }, consolidated: true },
        },
      } as OpenClawConfig;

      const specs = Array.from(resolveSkillCollectionReviewMonitorSpecs(cfg, []));
      expect(specs).toHaveLength(1);
      expect(specs[0]?.input.declarationKey).toBe(SKILL_COLLECTION_REVIEW_SWEEP_DECLARATION_KEY);
    });

    it("disables the sweep when autonomous mode is not 'auto' even with the flag on", () => {
      const cfg = {
        agents: {
          list: [{ id: "main", default: true, workspace: "/tmp/openclaw-shared" }],
          defaults: { model: "anthropic/claude-sonnet-4-6" },
        },
        skills: {
          workshop: { autonomous: { mode: "propose" }, consolidated: true },
        },
      } as OpenClawConfig;

      const [spec] = resolveSkillCollectionReviewMonitorSpecs(cfg, []);
      expect(spec?.agentId).toBe(SKILL_COLLECTION_REVIEW_SWEEP_AGENT_ID);
      expect(spec?.input.enabled).toBe(false);
      expect(spec?.input.declarationKey).toBe(SKILL_COLLECTION_REVIEW_SWEEP_DECLARATION_KEY);
    });
  });
});
