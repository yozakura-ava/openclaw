// Workboard plugin entrypoint registers its OpenClaw integration.
import { definePluginEntry } from "./api.js";
import { registerWorkboardGatewayMethods } from "./runtime-api.js";
import { createWorkboardAutomationNudgeService } from "./src/automation-nudge.js";
import { BqesService } from "./src/bqes.js";
import { createWorkboardChangeEventService } from "./src/change-events.js";
import { registerWorkboardCommand } from "./src/command.js";
import {
  createWorkboardLifecycleService,
  readWorkboardLifecycleSessions,
  syncWorkboardAgentEnded,
  syncWorkboardSubagentEnded,
} from "./src/lifecycle-sync.js";
import { createWorkboardStoreAuthorityGuard } from "./src/store-authority-guard.js";
import { normalizeMaxConcurrentClaimsPerOwner } from "./src/store-constants.js";
import { registerWorkboardStoreLifecycle } from "./src/store-lifecycle.js";
import { WorkboardStore } from "./src/store.js";
import { createWorkboardTools } from "./src/tools.js";
import {
  guardWorkboardToolsForWorkspaceAccess,
  WORKBOARD_TOOL_NAMES,
} from "./src/workspace-access.js";

/**
 * Parse the OPENCLAW_WORKBOARD_FORCE_CLOSE_AGENTS env var into a clean
 * allowlist. Whitespace + empty entries are filtered; per the Aug 24
 * runbook, an env-supplied list REPLACES the built-in default rather than
 * extending it, so the consumer of this helper must compare length to 0
 * before treating it as a real override.
 */
function parseForceCloseAgentsEnv(value: string | undefined): string[] | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = value
    .split(",")
    .map((agent) => agent.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : undefined;
}

export default definePluginEntry({
  id: "workboard",
  name: "Workboard",
  description: "Dashboard workboard for agent-owned issues and sessions.",
  register(api) {
    // Force-close wiring:
    // 1. OPENCLAW_WORKBOARD_FORCE_CLOSE_AGENTS — env-supplied comma-separated
    //    allowlist that REPLACES the built-in DEFAULT_FORCE_CLOSE_AGENTS.
    //    Empty/missing env falls back to the default unchanged.
    // 2. activeRunLookup — BQES is the durable-run lookup and remains the
    //    authority for active admissions that were not projected locally.
    const configuredForceCloseAgents = parseForceCloseAgentsEnv(
      process.env.OPENCLAW_WORKBOARD_FORCE_CLOSE_AGENTS,
    );
    const bqes = new BqesService();
    const store = WorkboardStore.openSqlite({
      ...(configuredForceCloseAgents
        ? { forceCloseAllowedAgents: configuredForceCloseAgents }
        : {}),
      activeRunLookup: async (cardId, queue) => bqes.findActiveByCardId(cardId, queue)?.runId,
    });
    const automationNudge = createWorkboardAutomationNudgeService({
      store,
      gateway: api.runtime.gateway,
    });
    const lifecycleSync = createWorkboardLifecycleService({
      store,
      worktrees: api.runtime.worktrees,
      readSessions: async (options) =>
        await readWorkboardLifecycleSessions(api.runtime.gateway, options),
    });
    const storeAuthorityGuard = createWorkboardStoreAuthorityGuard(store);
    // Start the authority probe during registration as well as through the
    // host service lifecycle. A missed gateway_start/service-start callback
    // must not leave Workboard without a recovery guard.
    storeAuthorityGuard.startGuard(api.logger);
    registerWorkboardStoreLifecycle(api, store, () => storeAuthorityGuard.stop());
    api.session.controls.registerControlUiDescriptor({
      surface: "tab",
      id: "workboard",
      label: "Workboard",
      placement: "route:workboard",
      icon: "kanban",
      group: "control",
      requiredScopes: ["operator.read"],
    });
    api.session.controls.registerControlUiDescriptor({
      surface: "widget",
      id: "board",
      label: "Workboard board",
      requiredScopes: ["operator.read"],
    });
    api.session.controls.registerControlUiDescriptor({
      surface: "widget",
      id: "card",
      label: "Workboard card",
      requiredScopes: ["operator.write"],
    });
    api.session.controls.registerControlUiDescriptor({
      surface: "widget",
      id: "mini",
      label: "Workboard summary",
      requiredScopes: ["operator.read"],
    });
    registerWorkboardGatewayMethods({ api, store });
    registerWorkboardCommand({ api, store });
    api.registerService(createWorkboardChangeEventService(store));
    api.registerService(automationNudge);
    api.registerService(lifecycleSync);
    api.registerService(storeAuthorityGuard);
    api.on("gateway_start", () => lifecycleSync.onGatewayStart());
    api.on("gateway_stop", () => lifecycleSync.onGatewayStop());
    api.on("gateway_stop", () => bqes.close());
    api.on("subagent_ended", async (event) => {
      await syncWorkboardSubagentEnded({
        store,
        worktrees: api.runtime.worktrees,
        event,
        onMatched: automationNudge.nudge,
      });
    });
    api.on("agent_end", async (event, context) => {
      await syncWorkboardAgentEnded({
        store,
        event,
        context,
        onMatched: automationNudge.nudge,
      });
    });
    api.registerCli(
      async ({ program }) => {
        const { registerWorkboardCli } = await import("./src/cli.js");
        registerWorkboardCli({ program, store });
      },
      {
        descriptors: [
          {
            name: "workboard",
            description: "Manage Workboard cards and worker dispatch",
            hasSubcommands: true,
          },
        ],
      },
    );
    const failLoudOwner =
      (api.pluginConfig as { failLoudOwner?: boolean } | undefined)?.failLoudOwner === true;
    const maxConcurrentClaimsPerOwner = normalizeMaxConcurrentClaimsPerOwner(
      (api.pluginConfig as { maxConcurrentClaimsPerOwner?: unknown } | undefined)
        ?.maxConcurrentClaimsPerOwner,
    );
    api.registerTool(
      (context) =>
        guardWorkboardToolsForWorkspaceAccess(
          createWorkboardTools({
            api,
            context,
            store,
            failLoudOwner,
            maxConcurrentClaimsPerOwner,
          }),
          context,
          api.runtime.sandbox.resolveWorkspaceAuthority,
        ),
      {
        names: [...WORKBOARD_TOOL_NAMES],
        optional: true,
      },
    );
  },
});
