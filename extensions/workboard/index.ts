// Workboard plugin entrypoint registers its OpenClaw integration.
import { createProductionDbosAuthority } from "@openclaw/dbos-runtime";
import { definePluginEntry } from "./api.js";
import { registerWorkboardGatewayMethods } from "./runtime-api.js";
import { createWorkboardAutomationNudgeService } from "./src/automation-nudge.js";
import {
  createWorkboardChangeEventService,
  type WorkboardChangeEventService,
} from "./src/change-events.js";
import { registerWorkboardCommand } from "./src/command.js";
import {
  createWorkboardLifecycleService,
  readWorkboardLifecycleSessions,
  syncWorkboardAgentEnded,
  syncWorkboardSubagentEnded,
} from "./src/lifecycle-sync.js";
import { normalizeMaxConcurrentClaimsPerOwner } from "./src/store-constants.js";
import { createGuardedWorkboardStore, WorkboardStoreGuard } from "./src/store-guard.js";
import { WorkboardStore } from "./src/store.js";
import { createWorkboardTools } from "./src/tools.js";
import {
  guardWorkboardToolsForWorkspaceAccess,
  WORKBOARD_TOOL_NAMES,
} from "./src/workspace-access.js";

/** Parse the optional deployment override into a clean allowlist. */
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

/**
 * Use the PostgreSQL DBOS authority as the durable force-close fence. A
 * missing/unconfigured authority is intentionally an error: force-close must
 * fail closed instead of treating an unqueryable durable run as absent.
 */
function createActiveRunLookup(): (cardId: string, queue?: string) => Promise<string | undefined> {
  const authority = createProductionDbosAuthority();
  return async (cardId: string, queue?: string) =>
    await authority.findActiveByCardId(cardId, queue);
}

export default definePluginEntry({
  id: "workboard",
  name: "Workboard",
  description: "Dashboard workboard for agent-owned issues and sessions.",
  register(api) {
    // Force-close is exceptional and fail-closed. The default policy lives in
    // store-constants.ts; the optional env override is only an explicit
    // deployment choice. Durable-run state always comes from PostgreSQL DBOS.
    const configuredForceCloseAgents = parseForceCloseAgentsEnv(
      process.env.OPENCLAW_WORKBOARD_FORCE_CLOSE_AGENTS,
    );
    const storeGuard = new WorkboardStoreGuard({
      open: () =>
        WorkboardStore.openSqlite({
          ...(configuredForceCloseAgents
            ? { forceCloseAllowedAgents: configuredForceCloseAgents }
            : {}),
          activeRunLookup: createActiveRunLookup(),
        }),
    });
    const gatewayStore = createGuardedWorkboardStore(storeGuard, "gateway");
    const toolStore = createGuardedWorkboardStore(storeGuard, "tool");
    const lifecycleStore = createGuardedWorkboardStore(storeGuard, "lifecycle");
    const automationNudge = createWorkboardAutomationNudgeService({
      store: lifecycleStore,
      gateway: api.runtime.gateway,
      isStoreAvailable: () => storeGuard.isAvailable(),
      onStoreFailure: (error) => storeGuard.reportFailure(error, { source: "lifecycle" }),
    });
    const lifecycleSync = createWorkboardLifecycleService({
      store: lifecycleStore,
      worktrees: api.runtime.worktrees,
      isStoreAvailable: () => storeGuard.isAvailable(),
      onStoreFailure: (error) => storeGuard.reportFailure(error, { source: "lifecycle" }),
      readSessions: async (options) =>
        await readWorkboardLifecycleSessions(api.runtime.gateway, options),
    });
    const changeEvents: WorkboardChangeEventService = createWorkboardChangeEventService({
      store: lifecycleStore,
      isStoreAvailable: () => storeGuard.isAvailable(),
      onStoreFailure: (error) => storeGuard.reportFailure(error, { source: "lifecycle" }),
    });
    storeGuard.onAvailable(() => {
      changeEvents.onStoreAvailable();
      lifecycleSync.onStoreAvailable();
    });
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
    registerWorkboardGatewayMethods({ api, store: gatewayStore });
    registerWorkboardCommand({ api, store: gatewayStore });
    api.registerService({
      id: "workboard-store-availability",
      start(ctx) {
        storeGuard.start(ctx.logger);
      },
      stop() {
        storeGuard.stop();
      },
    });
    api.registerService(changeEvents);
    api.registerService(automationNudge);
    api.registerService(lifecycleSync);
    api.on("gateway_start", () => lifecycleSync.onGatewayStart());
    api.on("gateway_stop", () => lifecycleSync.onGatewayStop());
    api.on("subagent_ended", async (event) => {
      const activeStore = storeGuard.get();
      if (!activeStore) {
        return;
      }
      try {
        await syncWorkboardSubagentEnded({
          store: activeStore,
          worktrees: api.runtime.worktrees,
          event,
          onMatched: automationNudge.nudge,
        });
      } catch (error) {
        storeGuard.reportFailure(error, { source: "lifecycle" });
      }
    });
    api.on("agent_end", async (event, context) => {
      const activeStore = storeGuard.get();
      if (!activeStore) {
        return;
      }
      try {
        await syncWorkboardAgentEnded({
          store: activeStore,
          event,
          context,
          onMatched: automationNudge.nudge,
        });
      } catch (error) {
        storeGuard.reportFailure(error, { source: "lifecycle" });
      }
    });
    api.registerCli(
      async ({ program }) => {
        const { registerWorkboardCli } = await import("./src/cli.js");
        registerWorkboardCli({ program, store: gatewayStore });
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
            store: toolStore,
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
