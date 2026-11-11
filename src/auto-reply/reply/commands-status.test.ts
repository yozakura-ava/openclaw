// Tests status command rendering for sessions, agents, diagnostics, and model defaults.
import fs from "node:fs";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeTestText } from "../../../test/helpers/normalize-text.js";
import { saveAuthProfileStore } from "../../agents/auth-profiles/store-runtime.js";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import { clearAgentHarnesses, registerAgentHarness } from "../../agents/harness/registry.js";
import type { AgentHarness } from "../../agents/harness/types.js";
import {
  seedSubagentRunForReadTest,
  resetSubagentRegistryForTests,
} from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { ModelDefinitionConfig } from "../../config/types.models.js";
import * as logger from "../../logger.js";
import type { ProviderThinkingProfile } from "../../plugins/provider-thinking.types.js";
import * as statusText from "../../status/status-text.js";
import { buildStatusPluginsReply, buildStatusText } from "./commands-status.js";
import { buildKiraStatusReply, buildStatusReplyForTest } from "./commands-status.test-support.js";
import { baseCommandTestConfig, buildCommandTestParams } from "./commands.test-harness.js";

// Tests status command rendering for sessions, agents, and diagnostics.

type LoadProviderUsageSummary =
  typeof import("../../infra/provider-usage.js").loadProviderUsageSummary;

const providerUsageMock = vi.hoisted(() => ({
  loadProviderUsageSummary: vi.fn<LoadProviderUsageSummary>(async () => ({
    updatedAt: Date.now(),
    providers: [],
  })),
}));
const activeProviderThinkingMock = vi.hoisted(() => ({
  resolveThinkingProfile: vi.fn<
    (params: {
      provider: string;
      context: { modelId: string };
    }) => ProviderThinkingProfile | null | undefined
  >(() => undefined),
}));
type StatusPluginHealthSnapshot =
  import("../../status/status-plugin-health.js").StatusPluginHealthSnapshot;

const pluginHealthRuntimeMock = vi.hoisted(() => ({
  collectInstalledPluginHealthSnapshot: vi.fn(async (): Promise<StatusPluginHealthSnapshot> => ({
    plugins: [],
    diagnostics: [],
    contextEngineQuarantines: [],
    runtimeToolQuarantines: [],
    channelPluginFailures: [],
  })),
  collectRuntimePluginHealthSnapshot: vi.fn((): StatusPluginHealthSnapshot => ({
    plugins: [],
    diagnostics: [],
    contextEngineQuarantines: [],
    runtimeToolQuarantines: [],
    channelPluginFailures: [],
  })),
}));

vi.mock("../../infra/provider-usage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/provider-usage.js")>();
  return {
    ...actual,
    loadProviderUsageSummary: providerUsageMock.loadProviderUsageSummary,
  };
});

vi.mock("../../plugins/provider-thinking-active.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/provider-thinking-active.js")>()),
  resolveActiveProviderThinkingProfile: activeProviderThinkingMock.resolveThinkingProfile,
}));

vi.mock("../../status/status-plugin-health.runtime.js", () => pluginHealthRuntimeMock);

vi.mock("../../agents/harness/builtin-openclaw.js", () => ({
  createOpenClawAgentHarness: () => ({
    id: "openclaw",
    label: "OpenClaw Default",
    supports: () => ({ supported: true, priority: 0 }),
    runAttempt: async () => {
      throw new Error("not used in status tests");
    },
  }),
}));

const baseCfg = baseCommandTestConfig;
const expectedCodexRuntimeUsageAuth = [
  {
    provider: "openai",
    token: "codex-app-server",
    hookProvider: "codex",
  },
];
const codexStatusModel: ModelDefinitionConfig = {
  id: "gpt-5.5",
  name: "GPT-5.5",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_050_000,
  contextTokens: 1_000_000,
  maxTokens: 128_000,
};

type StatusTextParams = Parameters<typeof buildStatusText>[0];

function createStatusSessionParams(statusChannel = "mobilechat") {
  return {
    sessionKey: "agent:main:main",
    parentSessionKey: "agent:main:main",
    sessionScope: "per-sender",
    statusChannel,
  } satisfies Partial<StatusTextParams>;
}

function createStatusDisplayParams(
  resolvedFastMode = false,
  resolveDefaultThinkingLevel: StatusTextParams["resolveDefaultThinkingLevel"] = async () =>
    undefined,
) {
  return {
    resolvedFastMode,
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolveDefaultThinkingLevel,
    isGroup: false,
    defaultGroupActivation: () => "mention",
  } satisfies Partial<StatusTextParams>;
}

function registerStatusCodexHarness(): void {
  const codexProviders = new Set(["codex", "openai"]);
  const harness: AgentHarness = {
    id: "codex",
    label: "Codex",
    autoSelection: { providerIds: [...codexProviders] },
    supports: (ctx) =>
      codexProviders.has(ctx.provider.trim().toLowerCase())
        ? { supported: true, priority: 100 }
        : { supported: false },
    runAttempt: async () => {
      throw new Error("not used in status tests");
    },
  };
  registerAgentHarness(harness, { ownerPluginId: "codex" });
}

function saveStatusTestAuthProfile(params: {
  dir: string;
  profileId: string;
  provider: "openai" | "anthropic";
}): void {
  saveStatusTestAuthProfiles({
    dir: params.dir,
    profiles: [{ profileId: params.profileId, provider: params.provider }],
  });
}

function saveStatusTestAuthProfiles(params: {
  dir: string;
  profiles: Array<{ profileId: string; provider: "openai" | "anthropic" }>;
}): void {
  const agentDir = path.join(params.dir, ".openclaw", "agents", "main", "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  saveAuthProfileStore(
    {
      version: 1,
      profiles: Object.fromEntries(
        params.profiles.map((profile) => [
          profile.profileId,
          profile.provider === "openai"
            ? {
                type: "oauth",
                provider: profile.provider,
                access: "access-token",
                refresh: "refresh-token",
                expires: Date.now() + 60 * 60_000,
              }
            : {
                type: "api_key",
                provider: "anthropic",
                key: "anthropic-api-key",
              },
        ]),
      ),
    },
    agentDir,
    { filterExternalAuthProfiles: false, syncExternalCli: false },
  );
}

afterEach(() => {
  clearRuntimeConfigSnapshot();
  cliBackendsTesting.resetDepsForTest();
  clearAgentHarnesses();
  providerUsageMock.loadProviderUsageSummary.mockReset();
  providerUsageMock.loadProviderUsageSummary.mockResolvedValue({
    updatedAt: Date.now(),
    providers: [],
  });
  activeProviderThinkingMock.resolveThinkingProfile.mockReset();
  activeProviderThinkingMock.resolveThinkingProfile.mockReturnValue(undefined);
  pluginHealthRuntimeMock.collectInstalledPluginHealthSnapshot.mockReset();
  pluginHealthRuntimeMock.collectInstalledPluginHealthSnapshot.mockResolvedValue({
    plugins: [],
    diagnostics: [],
    contextEngineQuarantines: [],
    runtimeToolQuarantines: [],
    channelPluginFailures: [],
  });
  pluginHealthRuntimeMock.collectRuntimePluginHealthSnapshot.mockReset();
  pluginHealthRuntimeMock.collectRuntimePluginHealthSnapshot.mockReturnValue({
    plugins: [],
    diagnostics: [],
    contextEngineQuarantines: [],
    runtimeToolQuarantines: [],
    channelPluginFailures: [],
  });
});

describe("buildStatusReply subagent summary", () => {
  beforeEach(async () => {
    setRuntimeConfigSnapshot(baseCfg);
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupRegistry: () => ({
        providers: [],
        cliBackends: [],
        configMigrations: [],
        autoEnableProbes: [],
        diagnostics: [],
      }),
      resolveRuntimeCliBackends: () => [
        {
          id: "claude-cli",
          pluginId: "claude-cli",
          modelProvider: "anthropic",
          config: { command: "claude" },
          bundleMcp: false,
        },
      ],
    });
    await resetSubagentRegistryForTests({ persist: false });
  });

  afterEach(async () => {
    await resetSubagentRegistryForTests({ persist: false });
  });

  it("counts ended orchestrators with active descendants as active", async () => {
    const parentKey = "agent:main:subagent:status-ended-parent";
    seedSubagentRunForReadTest({
      runId: "run-status-ended-parent",
      childSessionKey: parentKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "status orchestrator",
      cleanup: "keep",
      createdAt: Date.now() - 120_000,
      startedAt: Date.now() - 120_000,
      endedAt: Date.now() - 110_000,
      outcome: { status: "ok" },
    });
    seedSubagentRunForReadTest({
      runId: "run-status-active-child",
      childSessionKey: "agent:main:subagent:status-ended-parent:subagent:child",
      requesterSessionKey: parentKey,
      requesterDisplayKey: "subagent:status-ended-parent",
      task: "status child still running",
      cleanup: "keep",
      createdAt: Date.now() - 60_000,
      startedAt: Date.now() - 60_000,
    });

    const reply = await buildStatusReplyForTest({});

    expect(reply?.text).toContain("🤖 Subagents: 1 active");
  });

  it("dedupes stale rows in the verbose subagent status summary", async () => {
    const childSessionKey = "agent:main:subagent:status-dedupe-worker";
    seedSubagentRunForReadTest({
      runId: "run-status-current",
      childSessionKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "current status worker",
      cleanup: "keep",
      createdAt: Date.now() - 60_000,
      startedAt: Date.now() - 60_000,
    });
    seedSubagentRunForReadTest({
      runId: "run-status-stale",
      childSessionKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "stale status worker",
      cleanup: "keep",
      createdAt: Date.now() - 120_000,
      startedAt: Date.now() - 120_000,
      endedAt: Date.now() - 90_000,
      outcome: { status: "ok" },
    });

    const reply = await buildStatusReplyForTest({ verbose: true });

    expect(reply?.text).toContain("🤖 Subagents: 1 active");
    expect(reply?.text).not.toContain("· 1 done");
  });

<<<<<<< HEAD
  it("does not count a child session that moved to a newer parent in the old parent's status", async () => {
    const oldParentKey = "agent:main:subagent:status-old-parent";
    const newParentKey = "agent:main:subagent:status-new-parent";
    const childSessionKey = "agent:main:subagent:status-shared-child";
    seedSubagentRunForReadTest({
      runId: "run-status-old-parent",
      childSessionKey: oldParentKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "old parent",
      cleanup: "keep",
      createdAt: Date.now() - 120_000,
      startedAt: Date.now() - 120_000,
    });
    seedSubagentRunForReadTest({
      runId: "run-status-new-parent",
      childSessionKey: newParentKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "new parent",
      cleanup: "keep",
      createdAt: Date.now() - 90_000,
      startedAt: Date.now() - 90_000,
    });
    seedSubagentRunForReadTest({
      runId: "run-status-child-stale-old-parent",
      childSessionKey,
      requesterSessionKey: oldParentKey,
      requesterDisplayKey: oldParentKey,
      controllerSessionKey: oldParentKey,
      task: "stale old parent child",
      cleanup: "keep",
      createdAt: Date.now() - 60_000,
      startedAt: Date.now() - 60_000,
    });
    seedSubagentRunForReadTest({
      runId: "run-status-child-current-new-parent",
      childSessionKey,
      requesterSessionKey: newParentKey,
      requesterDisplayKey: newParentKey,
      controllerSessionKey: newParentKey,
      task: "current new parent child",
      cleanup: "keep",
      createdAt: Date.now() - 30_000,
      startedAt: Date.now() - 30_000,
    });

    const reply = await buildStatusReplyForTest({ sessionKey: oldParentKey, verbose: true });

    expect(reply?.text).not.toContain("🤖 Subagents: 1 active");
    expect(reply?.text).not.toContain("stale old parent child");
  });

  it("counts controller-owned runs even when the latest child requester differs", async () => {
    seedSubagentRunForReadTest({
      runId: "run-status-controller-owned",
      childSessionKey: "agent:main:subagent:status-controller-owned",
      requesterSessionKey: "agent:main:requester-only",
      requesterDisplayKey: "requester-only",
      controllerSessionKey: "agent:main:main",
      task: "controller-owned status worker",
      cleanup: "keep",
      createdAt: Date.now() - 60_000,
      startedAt: Date.now() - 60_000,
    });

    const reply = await buildStatusReplyForTest({});

    expect(reply?.text).toContain("🤖 Subagents: 1 active");
  });

  it("uses transcript usage fallback in /status output", async () => {
    await withTempHome(async (dir) => {
      const sessionId = "sess-status-transcript";
      await writeTranscriptUsageLog({
        dir,
        agentId: "main",
        sessionId,
        usage: {
          input: 1,
          output: 2,
          cacheRead: 1000,
          cacheWrite: 0,
          totalTokens: 1003,
        },
      });

      const text = await buildStatusText({
        cfg: baseCfg,
        sessionEntry: {
          sessionId,
          updatedAt: 0,
          totalTokens: 3,
          contextTokens: 32_000,
        },
        ...createStatusSessionParams(),
        provider: "anthropic",
        model: "claude-opus-4-5",
        contextTokens: 32_000,
        ...createStatusDisplayParams(),
        modelAuthOverride: "api-key",
        activeModelAuthOverride: "api-key",
      });

      expect(normalizeTestText(text)).toContain("Context: 1.0k/?");
    });
  });

  it("uses a prepared context window in ordinary /status text and presentation", async () => {
    const commandParams = buildCommandTestParams("/status", baseCfg);
    const reply = await buildStatusReply({
      cfg: baseCfg,
      command: commandParams.command,
      sessionEntry: {
        sessionId: "sess-status-prepared-context",
        updatedAt: 0,
        totalTokens: 45_000,
        totalTokensFresh: true,
        totalTokensVersion: 1,
      },
      sessionKey: commandParams.sessionKey,
      parentSessionKey: commandParams.sessionKey,
      sessionScope: commandParams.sessionScope,
      storePath: commandParams.storePath,
      provider: "deepseek",
      model: "deepseek-v4-flash",
      contextTokens: 1_000_000,
      thinkingCatalog: [
        {
          provider: "deepseek",
          id: "deepseek-v4-flash",
          contextWindow: 1_000_000,
          contextTokens: 1_000_000,
        },
      ],
      resolvedFastMode: false,
      resolvedVerboseLevel: "off",
      resolvedReasoningLevel: "off",
      resolveDefaultThinkingLevel: async () => undefined,
      isGroup: false,
      defaultGroupActivation: () => "mention",
      modelAuthOverride: "api-key",
      activeModelAuthOverride: "api-key",
    });
    expect(reply?.presentationTextMode).toBe("fallback");
    const table = reply?.presentation?.blocks.find((block) => block.type === "table");

    expect(normalizeTestText(reply?.text ?? "")).toContain("Context: 45k/1.0m");
    expect(table?.type === "table" ? table.rows : []).toContainEqual([
      "📚 Context",
      expect.stringContaining("45k/1.0m"),
    ]);
  });

  it.each([
    {
      name: "binds a bare transcript model to its prepared provider entry",
      sessionId: "sess-status-recovered-bare-model-context",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      transcriptModel: "small-model",
      thinkingCatalog: [
        {
          provider: "deepseek",
          id: "deepseek-v4-flash",
          contextWindow: 1_000_000,
          contextTokens: 1_000_000,
        },
        {
          provider: "deepseek",
          id: "small-model",
          contextWindow: 128_000,
          contextTokens: 128_000,
        },
      ],
      expectedContext: "Context: 45k/128k",
      rejectedContext: "Context: 45k/1.0m",
    },
    {
      name: "binds a qualified transcript model to its exact prepared entry",
      sessionId: "sess-status-recovered-qualified-model-context",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      transcriptModel: "deepseek/deepseek-v4-flash",
      thinkingCatalog: [
        {
          provider: "deepseek",
          id: "deepseek-v4-flash",
          contextWindow: 1_000_000,
          contextTokens: 1_000_000,
        },
      ],
      expectedContext: "Context: 45k/1.0m",
      rejectedContext: "Context: 45k/200k",
    },
    {
      name: "binds a provider-local slash transcript model to its admitted catalog entry",
      sessionId: "sess-status-recovered-cross-route-model-context",
      provider: "openrouter",
      model: "google/gemini-2.5-pro",
      transcriptModel: "google/gemini-2.5-pro",
      thinkingCatalog: [
        {
          provider: "openrouter",
          id: "google/gemini-2.5-pro",
          contextWindow: 1_000_000,
          contextTokens: 1_000_000,
        },
      ],
      expectedContext: "Context: 45k/1.0m",
      rejectedContext: "Context: 45k/200k",
    },
  ])("$name", async (testCase) => {
    await withTempHome(async (dir) => {
      await writeTranscriptUsageLog({
        dir,
        agentId: "main",
        sessionId: testCase.sessionId,
        model: testCase.transcriptModel,
        usage: {
          input: 45_000,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 45_000,
        },
      });

      const text = await buildStatusText({
        cfg: baseCfg,
        sessionEntry: {
          sessionId: testCase.sessionId,
          updatedAt: 0,
          modelSelectionLocked: true,
        },
        ...createStatusSessionParams(),
        provider: testCase.provider,
        model: testCase.model,
        contextTokens: 1_000_000,
        thinkingCatalog: testCase.thinkingCatalog,
        ...createStatusDisplayParams(),
        modelAuthOverride: "api-key",
        activeModelAuthOverride: "api-key",
      });

      expect(normalizeTestText(text)).toContain(testCase.expectedContext);
      expect(normalizeTestText(text)).not.toContain(testCase.rejectedContext);
    });
  });

  it("ignores stale live contextTokens when /status displays the current default model", async () => {
    const text = await buildStatusText({
      cfg: {
        ...baseCfg,
        models: {
          providers: {
            "ollama-cloud": {
              baseUrl: "https://ollama.com",
              models: [
                {
                  id: "deepseek-v4-pro",
                  name: "DeepSeek V4 Pro",
                  reasoning: true,
                  input: ["text", "image"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 1_000_000,
                  maxTokens: 128_000,
                },
                {
                  id: "kimi-k2.7-code",
                  name: "Kimi K2.7 Code",
                  reasoning: true,
                  input: ["text", "image"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 262_144,
                  maxTokens: 128_000,
                },
              ],
            },
          },
        },
      },
      sessionEntry: {
        sessionId: "sess-status-stale-live-context",
        updatedAt: 0,
        modelProvider: "ollama-cloud",
        model: "kimi-k2.7-code",
        totalTokens: 0,
        totalTokensFresh: true,
        totalTokensVersion: 1 as const,
      },
      ...createStatusSessionParams(),
      provider: "ollama-cloud",
      model: "deepseek-v4-pro",
      contextTokens: 262_144,
      ...createStatusDisplayParams(),
      modelAuthOverride: "api-key",
      activeModelAuthOverride: "api-key",
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Model: ollama-cloud/deepseek-v4-pro");
    expect(normalized).toContain("Context: 0/1.0m");
    expect(normalized).not.toContain("kimi-k2.7-code");
    expect(normalized).not.toContain("Context: 0/262k");
    expect(normalized).not.toContain("/262k");
  });

  it("shows gateway and system uptime in /status output", async () => {
    vi.spyOn(process, "uptime").mockReturnValue(2 * 60 * 60 + 5 * 60);
    vi.spyOn(os, "uptime").mockReturnValue(4 * 24 * 60 * 60 + 3 * 60 * 60);

    const text = await buildStatusText({
      cfg: baseCfg,
      sessionEntry: {
        sessionId: "sess-status-uptime",
        updatedAt: 0,
        contextTokens: 32_000,
      },
      ...createStatusSessionParams(),
      provider: "anthropic",
      model: "claude-opus-4-5",
      contextTokens: 32_000,
      ...createStatusDisplayParams(),
      modelAuthOverride: "api-key",
      activeModelAuthOverride: "api-key",
    });

    expect(normalizeTestText(text)).toContain("Uptime: gateway 2h 5m · system 4d 3h");
  });

  it("renders compact plugin health from the runtime snapshot", async () => {
    pluginHealthRuntimeMock.collectRuntimePluginHealthSnapshot.mockReturnValue({
      plugins: [],
      diagnostics: [],
      contextEngineQuarantines: [],
      runtimeToolQuarantines: [],
      channelPluginFailures: [
        {
          channelId: "broken",
          message: "failed to load setup entry: boom",
          source: "diagnostic",
        },
      ],
    });

    const text = await buildStatusText({
      cfg: baseCfg,
      sessionEntry: {
        sessionId: "sess-status-plugin-health",
        updatedAt: 0,
        contextTokens: 32_000,
      },
      ...createStatusSessionParams(),
      workspaceDir: "/tmp/status-plugin-health-workspace",
      provider: "anthropic",
      model: "claude-opus-4-5",
      contextTokens: 32_000,
      ...createStatusDisplayParams(),
      modelAuthOverride: "api-key",
      activeModelAuthOverride: "api-key",
    });

    // Compact status reads only the runtime snapshot; no config-driven
    // channel inspection happens on this path.
    expect(pluginHealthRuntimeMock.collectRuntimePluginHealthSnapshot).toHaveBeenCalledWith();
    expect(normalizeTestText(text)).toContain("Plugins: 1 channel plugin failure");
  });

=======
>>>>>>> 97b6e87616f
  it("gates /status plugins behind the plugin command flag", async () => {
    const commandParams = buildCommandTestParams("/status plugins", {
      ...baseCfg,
      commands: { text: true, plugins: false },
    });

    const reply = await buildStatusPluginsReply({
      cfg: commandParams.cfg,
      command: commandParams.command,
      workspaceDir: commandParams.workspaceDir,
    });

    expect(reply?.text).toBe(
      "⚠️ /status plugins is disabled. Set commands.plugins=true to enable.",
    );
    expect(pluginHealthRuntimeMock.collectInstalledPluginHealthSnapshot).not.toHaveBeenCalled();
  });

  it("does not read a legacy native credential file from an SDK status render", async () => {
    registerStatusCodexHarness();

    await withTempHome(
      async (dir) => {
        const agentDir = path.join(dir, ".openclaw", "agents", "main", "agent");
        const codexHome = path.join(agentDir, "codex-home");
        fs.mkdirSync(codexHome, { recursive: true });
        fs.writeFileSync(
          path.join(codexHome, "auth.json"),
          JSON.stringify({
            auth_mode: "chatgpt",
            tokens: {
              access_token: "codex-access-token",
              refresh_token: "codex-refresh-token",
            },
          }),
          "utf-8",
        );

        const text = await buildStatusText({
          cfg: {
            ...baseCfg,
            agents: {
              defaults: {
                models: { "openai/gpt-5.5": { agentRuntime: { id: "codex" } } },
              },
            },
          },
          sessionEntry: {
            sessionId: "sess-status-codex-home-oauth",
            updatedAt: 0,
          },
          ...createStatusSessionParams(),
          provider: "openai",
          model: "gpt-5.5",
          contextTokens: 32_000,
          ...createStatusDisplayParams(),
        });

        const normalized = normalizeTestText(text);
        expect(normalized).toContain("Model: openai/gpt-5.5");
        expect(normalized).toContain("Runtime: OpenAI Codex");
        expect(normalized).not.toContain("oauth (codex-cli)");
        expect(normalized).toContain("api-key (env: OPENAI_API_KEY)");
      },
      {
        env: {
          OPENAI_API_KEY: "status-env-key-placeholder",
          OPENAI_OAUTH_TOKEN: undefined,
        },
      },
    );
  });

  it("does not forward stale non-OpenAI profile overrides to Codex usage", async () => {
    registerStatusCodexHarness();
    providerUsageMock.loadProviderUsageSummary.mockResolvedValue({
      updatedAt: Date.now(),
      providers: [
        {
          provider: "openai",
          displayName: "OpenAI",
          windows: [{ label: "5h", usedPercent: 9 }],
        },
      ],
    });

    await withTempHome(
      async (dir) => {
        saveStatusTestAuthProfiles({
          dir,
          profiles: [
            { profileId: "openai:status", provider: "openai" },
            { profileId: "anthropic:work", provider: "anthropic" },
          ],
        });

        await buildStatusText({
          cfg: {
            ...baseCfg,
            agents: {
              defaults: {
                models: { "openai/gpt-5.5": { agentRuntime: { id: "codex" } } },
              },
            },
          },
          sessionEntry: {
            sessionId: "sess-status-codex-stale-profile",
            updatedAt: 0,
            authProfileOverride: "anthropic:work",
          },
          ...createStatusSessionParams(),
          provider: "openai",
          model: "gpt-5.5",
          contextTokens: 32_000,
          ...createStatusDisplayParams(),
        });

        const providerUsageCall = providerUsageMock.loadProviderUsageSummary.mock.calls.find(
          ([params]) => params?.providers?.includes("openai"),
        );
        expect(providerUsageCall?.[0]?.auth).toEqual(expectedCodexRuntimeUsageAuth);
      },
      { skipSessionCleanup: true, skipHomeCleanup: true },
    );
  });

<<<<<<< HEAD
  it("uses active fallback provider usage for legacy fallback notices", async () => {
    const fallbackModel: ModelDefinitionConfig = {
      id: "MiniMax-M2.7",
      name: "MiniMax M2.7",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 32_000,
    };
    const selectedModel: ModelDefinitionConfig = {
      id: "mimo-v2-flash",
      name: "MiMo V2 Flash",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_048_576,
      maxTokens: 32_000,
    };
    providerUsageMock.loadProviderUsageSummary.mockImplementation(async (options) => ({
      updatedAt: Date.now(),
      providers:
        options?.providers?.includes("minimax") === true
          ? [
              {
                provider: "minimax",
                displayName: "MiniMax",
                windows: [{ label: "day", usedPercent: 20 }],
              },
            ]
          : [],
    }));

    const text = await buildStatusText({
      cfg: {
        ...baseCfg,
        models: {
          providers: {
            "minimax-portal": {
              baseUrl: "https://api.minimax.test/v1",
              models: [fallbackModel],
            },
            xiaomi: {
              baseUrl: "https://api.xiaomi.test/v1",
              models: [selectedModel],
            },
          },
        },
      },
      sessionEntry: {
        sessionId: "sess-status-legacy-fallback-usage",
        updatedAt: 0,
        providerOverride: "xiaomi",
        modelOverride: "mimo-v2-flash",
        modelProvider: "minimax-portal",
        model: "MiniMax-M2.7",
        fallbackNotice: {
          kind: "active",
          selectedModel: "xiaomi/mimo-v2-flash",
          activeModel: "minimax-portal/MiniMax-M2.7",
          reason: "model not allowed",
        },
        totalTokens: 49_000,
        totalTokensFresh: true,
        totalTokensVersion: 1 as const,
        contextTokens: 1_048_576,
      },
      ...createStatusSessionParams(),
      provider: "xiaomi",
      model: "mimo-v2-flash",
      contextTokens: 1_048_576,
      ...createStatusDisplayParams(),
      modelAuthOverride: "api-key",
      activeModelAuthOverride: "api-key",
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Fallback: minimax-portal/MiniMax-M2.7");
    expect(normalized).toContain("Context: 49k/200k");
    expect(normalized).toContain("Usage: day 80% left");
    expect(providerUsageMock.loadProviderUsageSummary).toHaveBeenCalledWith(
      expect.objectContaining({ providers: ["minimax"] }),
    );
  });

  it("does not reuse stale live context for unresolved active fallback notices", async () => {
    const selectedModel: ModelDefinitionConfig = {
      id: "mimo-v2-flash",
      name: "MiMo V2 Flash",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_048_576,
      maxTokens: 32_000,
    };

    const text = await buildStatusText({
      cfg: {
        ...baseCfg,
        models: {
          providers: {
            xiaomi: {
              baseUrl: "https://api.xiaomi.test/v1",
              models: [selectedModel],
            },
          },
        },
      },
      sessionEntry: {
        sessionId: "sess-status-unresolved-fallback-context",
        updatedAt: 0,
        providerOverride: "xiaomi",
        modelOverride: "mimo-v2-flash",
        modelProvider: "custom-runtime",
        model: "unknown-fallback-model",
        fallbackNotice: {
          kind: "active",
          selectedModel: "xiaomi/mimo-v2-flash",
          activeModel: "custom-runtime/unknown-fallback-model",
          reason: "model not allowed",
        },
        totalTokens: 49_000,
        totalTokensFresh: true,
        totalTokensVersion: 1,
        contextTokens: 1_048_576,
      },
      ...createStatusSessionParams(),
      provider: "xiaomi",
      model: "mimo-v2-flash",
      contextTokens: 123_456,
      ...createStatusDisplayParams(),
      modelAuthOverride: "api-key",
      activeModelAuthOverride: "api-key",
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Fallback: custom-runtime/unknown-fallback-model");
    expect(normalized).toContain("Context: 49k/?");
    expect(normalized).not.toContain("Context: 49k/123k");
    expect(normalized).not.toContain("Context: 49k/1.0m");
  });

  it("shows DeepSeek balance summaries in /status output", async () => {
    registerStatusCodexHarness();
    providerUsageMock.loadProviderUsageSummary.mockResolvedValue({
      updatedAt: Date.now(),
      providers: [
        {
          provider: "deepseek",
          displayName: "DeepSeek",
          windows: [],
          summary: "Balance ¥42.50",
        },
      ],
    });

    const text = await buildStatusText({
      cfg: baseCfg,
      sessionEntry: {
        sessionId: "sess-status-deepseek-usage",
        updatedAt: 0,
      },
      ...createStatusSessionParams(),
      provider: "deepseek",
      model: "deepseek-v4-pro",
      contextTokens: 1_000_000,
      ...createStatusDisplayParams(),
      modelAuthOverride: "api-key",
      activeModelAuthOverride: "api-key",
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Model: deepseek/deepseek-v4-pro");
    expect(normalized).toContain("Usage: Balance ¥42.50");
    const providerUsageCall = providerUsageMock.loadProviderUsageSummary.mock.calls.find(
      ([params]) => params?.providers?.includes("deepseek"),
    );
    if (!providerUsageCall) {
      throw new Error("expected provider usage summary call for deepseek");
    }
    expect(providerUsageCall[0]?.providers).toEqual(["deepseek"]);
  });

  it("shows typed billing-only snapshots in /status output", async () => {
    providerUsageMock.loadProviderUsageSummary.mockResolvedValue({
      updatedAt: Date.now(),
      providers: [
        {
          provider: "openrouter",
          displayName: "OpenRouter",
          windows: [],
          billing: [{ type: "balance", label: "Account balance", amount: 12.5, unit: "USD" }],
        },
      ],
    });

    const text = await buildStatusText({
      cfg: baseCfg,
      sessionEntry: {
        sessionId: "sess-status-openrouter-billing",
        updatedAt: 0,
      },
      ...createStatusSessionParams(),
      provider: "openrouter",
      model: "openai/gpt-5.4",
      contextTokens: 1_000_000,
      ...createStatusDisplayParams(),
      modelAuthOverride: "api-key",
      activeModelAuthOverride: "api-key",
    });

    expect(normalizeTestText(text)).toContain("Usage: Account balance: $12.50");
  });

=======
>>>>>>> 97b6e87616f
  it("uses the session-selected provider for /status usage when runtime state is stale", async () => {
    const usageResetBase = Math.floor(Date.now() / 1000);
    providerUsageMock.loadProviderUsageSummary.mockImplementation(
      async ({ providers = [] } = {}) => ({
        updatedAt: Date.now(),
        providers: providers.map((provider) =>
          provider === "openai"
            ? {
                provider: "openai",
                displayName: "OpenAI",
                windows: [
                  {
                    label: "5h",
                    usedPercent: 9,
                    resetAt: (usageResetBase + 60 * 60) * 1000,
                  },
                ],
              }
            : {
                provider,
                displayName: "DeepSeek",
                windows: [],
                summary: "Balance ¥42.50",
              },
        ),
      }),
    );

    const text = await buildStatusText({
      cfg: {
        ...baseCfg,
        agents: {
          defaults: {
            model: "deepseek/deepseek-v4-flash",
          },
        },
      },
      sessionEntry: {
        sessionId: "sess-status-stale-runtime-selected-usage",
        updatedAt: 0,
        providerOverride: "openai",
        modelOverride: "gpt-5.5",
        modelOverrideSource: "user",
        modelProvider: "deepseek",
        model: "deepseek-v4-flash",
      },
      ...createStatusSessionParams("telegram"),
      provider: "deepseek",
      model: "deepseek-v4-flash",
      contextTokens: 1_000_000,
      ...createStatusDisplayParams(),
      modelAuthOverride: "oauth (openai:status)",
      activeModelAuthOverride: "api-key",
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Model: openai/gpt-5.5");
    expect(normalized).toContain("pinned session; config primary deepseek/deepseek-v4-flash");
    expect(normalized).toContain("clear /model default");
    expect(normalized).toContain("Usage: 5h 91% left");
    expect(normalized).not.toContain("Usage: Balance ¥42.50");
    expect(providerUsageMock.loadProviderUsageSummary).toHaveBeenCalledWith(
      expect.objectContaining({ providers: ["openai"] }),
    );
  });

  it("uses provider-qualified model overrides for /status usage lookup", async () => {
    await withTempHome(
      async (dir) => {
        saveStatusTestAuthProfile({ dir, profileId: "openai:status", provider: "openai" });

        const usageResetBase = Math.floor(Date.now() / 1000);
        providerUsageMock.loadProviderUsageSummary.mockImplementation(
          async ({ providers = [] } = {}) => ({
            updatedAt: Date.now(),
            providers: providers.map((provider) =>
              provider === "openai"
                ? {
                    provider: "openai",
                    displayName: "OpenAI",
                    windows: [
                      {
                        label: "5h",
                        usedPercent: 9,
                        resetAt: (usageResetBase + 60 * 60) * 1000,
                      },
                    ],
                  }
                : {
                    provider,
                    displayName: "DeepSeek",
                    windows: [],
                    summary: "Balance ¥42.50",
                  },
            ),
          }),
        );

        const text = await buildStatusText({
          cfg: {
            ...baseCfg,
            models: {
              providers: {
                openai: {
                  baseUrl: "https://chatgpt.com/backend-api/codex",
                  models: [{ ...codexStatusModel, contextWindow: 258_000, contextTokens: 258_000 }],
                },
              },
            },
            agents: {
              defaults: {
                model: "deepseek/deepseek-v4-flash",
              },
            },
            auth: {
              order: {
                openai: ["openai:status"],
              },
            },
          },
          sessionEntry: {
            sessionId: "sess-status-qualified-session-selected-usage",
            updatedAt: 0,
            modelOverride: "openai/gpt-5.5",
          },
          ...createStatusSessionParams("telegram"),
          provider: "deepseek",
          model: "deepseek-v4-flash",
          contextTokens: 1_000_000,
          ...createStatusDisplayParams(),
        });

        const normalized = normalizeTestText(text);
        expect(normalized).toContain("Model: openai/gpt-5.5");
        expect(normalized).toContain("pinned session; config primary deepseek/deepseek-v4-flash");
        expect(normalized).toContain("clear /model default");
        expect(normalized).toContain("oauth (openai:status)");
        expect(normalized).toContain("Context: ?/258k");
        expect(normalized).toContain("Usage: 5h 91% left");
        expect(normalized).not.toContain("Usage: Balance ¥42.50");
        expect(providerUsageMock.loadProviderUsageSummary).toHaveBeenCalledWith(
          expect.objectContaining({ providers: ["openai"] }),
        );
      },
      { env: { OPENAI_API_KEY: undefined } },
    );
  });

  it("clamps off to the active provider's always-thinking level", async () => {
    activeProviderThinkingMock.resolveThinkingProfile.mockReturnValue({
      levels: [{ id: "max", label: "max" }],
      defaultLevel: "max",
    });

    const text = await buildStatusText({
      cfg: baseCfg,
      sessionEntry: {
        sessionId: "sess-status-kimi-k3",
        updatedAt: 0,
        thinkingLevel: "off",
      },
      ...createStatusSessionParams(),
      provider: "moonshot",
      model: "kimi-k3",
      contextTokens: 262_144,
      resolvedThinkLevel: "off",
      ...createStatusDisplayParams(),
      modelAuthOverride: "api-key",
      activeModelAuthOverride: "api-key",
    });

    expect(normalizeTestText(text)).toContain("think max");
    expect(activeProviderThinkingMock.resolveThinkingProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "moonshot",
        context: expect.objectContaining({ modelId: "kimi-k3" }),
      }),
    );
  });
});

describe("buildStatusReply error handling", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("delivers a fixed generic reply and logs details when status rendering throws", async () => {
    const logError = vi.spyOn(logger, "logError").mockImplementation(() => {});
    vi.spyOn(statusText, "buildStatusReplyParts").mockRejectedValue(
      new Error("Unexpected rendering error"),
    );
    const reply = await buildStatusReplyForTest({});

    // Exact object equality also pins that no stale presentation or internal
    // error text reaches the channel; diagnostics belong to the log sink only.
    expect(reply).toEqual({ text: "⚠️ Status: error rendering response" });
    expect(logError).toHaveBeenCalledWith(expect.stringContaining("Unexpected rendering error"));
  });

  it("returns a generic reply and logs details when plugin health collection fails", async () => {
    const logError = vi.spyOn(logger, "logError").mockImplementation(() => {});
    pluginHealthRuntimeMock.collectInstalledPluginHealthSnapshot.mockRejectedValueOnce(
      new Error("Cannot find module 'internal/path'"),
    );

    const commandParams = buildCommandTestParams("/status plugins", {
      ...baseCfg,
      commands: { text: true, plugins: true },
    });
    const reply = await buildStatusPluginsReply({
      cfg: commandParams.cfg,
      command: commandParams.command,
      workspaceDir: commandParams.workspaceDir,
    });

    expect(reply?.text).toBe("⚠️ Plugins: health unavailable");
    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining("Cannot find module 'internal/path'"),
    );
  });
});
describe("buildStatusReply", () => {
  beforeAll(async () => {
    await buildKiraStatusReply({
      session: { mainKey: "main", scope: "per-sender" },
      agents: {
        defaults: {
          model: "openai/gpt-5.4",
        },
      },
      channels: {
        whatsapp: { allowFrom: ["*"] },
      },
    } as OpenClawConfig);
  });

  it("shows per-agent thinkingDefault in the status card", async () => {
    const cfg = {
      session: { mainKey: "main", scope: "per-sender" },
      agents: {
        defaults: {
          model: "openai/gpt-5.4",
        },
        entries: {
          kira: {
            model: "openai/gpt-5.4",
            thinkingDefault: "xhigh",
          },
        },
      },
      channels: {
        whatsapp: { allowFrom: ["*"] },
      },
    } as OpenClawConfig;

    const reply = await buildKiraStatusReply(cfg);

    expect(reply?.text).toContain("think xhigh");
  });
});
