import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "./auth-profiles/runtime-snapshots.js";
import { testing as cliBackendsTesting } from "./cli-backends.test-support.js";
import { createModelCatalogDecisions } from "./model-catalog-decisions.js";

const cliMetadata = createPluginMetadataSnapshotFixture({
  plugins: [
    {
      id: "anthropic",
      providers: ["anthropic"],
      cliBackends: ["claude-cli"],
      providerAuthChoices: [
        {
          provider: "anthropic",
          method: "cli",
          choiceId: "anthropic-cli",
          deprecatedChoiceIds: ["claude-cli"],
          choiceLabel: "Anthropic Claude CLI",
        },
      ],
    },
  ],
});

describe("model catalog CLI wildcard auth", () => {
  afterEach(() => {
    clearRuntimeAuthProfileStoreSnapshots();
    cliBackendsTesting.resetDepsForTest();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("lights up the Claude CLI sign-in wildcard only for models the Claude CLI catalog lists", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async (state) => {
      cliBackendsTesting.setDepsForTest({
        resolvePluginSetupCliBackend: () => undefined,
        resolveRuntimeCliBackends: () => [
          {
            id: "claude-cli",
            modelProvider: "anthropic",
            pluginId: "anthropic",
            config: { command: "claude" },
          },
          {
            id: "google-gemini-cli",
            modelProvider: "google",
            pluginId: "google",
            config: { command: "gemini" },
          },
        ],
      });
      const decisions = (pinned: boolean) =>
        createModelCatalogDecisions({
          cfg: {
            agents: {
              defaults: {
                models: {
                  "anthropic/*": { agentRuntime: { id: "claude-cli" } },
                  "anthropic/claude-pinned": { agentRuntime: { id: "claude-cli" } },
                  "anthropic/claude-http": { agentRuntime: { id: "openclaw" } },
                  "anthropic/claude-typed": {},
                  "google/*": { agentRuntime: { id: "google-gemini-cli" } },
                },
              },
            },
          },
          agentId: "main",
          workspaceDir: state.workspaceDir,
          snapshot: {
            entries: [
              { provider: "claude-cli", id: "claude-listed", name: "Listed" },
              { provider: "google-gemini-cli", id: "gemini-listed", name: "Listed" },
            ],
            routeVariants: [],
          },
          metadataSnapshot: cliMetadata,
          preparedAuthStore: {
            version: 1,
            profiles: pinned
              ? { "anthropic:work": { type: "api_key", provider: "anthropic", key: "synthetic" } }
              : {},
          },
          preparedRuntimeAuthModes: { "claude-cli": "oauth", "google-gemini-cli": "oauth" },
          preparedSyntheticAuthComplete: true,
          ...(pinned
            ? { preferredProfileId: "anthropic:work", pinnedProfileId: "anthropic:work" }
            : {}),
        });
      const owner = decisions(false);
      const availability = (provider: string, id: string) =>
        owner.evaluateEntry({ provider, id }).availability;

      expect(availability("anthropic", "claude-listed")).toBe(true);
      // API-only rows stay out of a Claude CLI picker without a sign-in prompt.
      const apiOnly = owner.evaluateEntry({ provider: "anthropic", id: "claude-mythos-5" });
      expect(apiOnly.availability).toBe(false);
      expect(apiOnly.unavailableReason).toBeUndefined();
      expect(availability("anthropic", "claude-pinned")).toBe(true);
      expect(availability("anthropic", "claude-typed")).toBe(true);
      // An exact override to another runtime stays with ordinary provider auth, not Claude CLI.
      expect(owner.evaluateEntry({ provider: "anthropic", id: "claude-http" }).evidence).not.toBe(
        "runtime",
      );
      // User-authored wildcards to other CLI backends are unchanged.
      expect(availability("google", "gemini-unlisted")).toBe(true);
      // A pinned API-key account, not the Claude CLI login, answers for its own models.
      const account = decisions(true);
      const mythos = { provider: "anthropic", id: "claude-mythos-5" };
      const host = account.evaluateEntry(mythos);
      expect(host).toMatchObject({ availability: true, selectedProfileId: "anthropic:work" });
      expect(
        account.evaluateNative({ ...mythos, name: "Claude Mythos 5" }, host).availability,
      ).toBe(true);
      expect(
        owner.evaluateNative({ ...mythos, name: "Claude Mythos 5" }, apiOnly).availability,
      ).toBe(false);
    });
  });
});
