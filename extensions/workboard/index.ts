// Workboard plugin entrypoint registers its OpenClaw integration.
import { definePluginEntry } from "./api.js";
import { registerWorkboardGatewayMethods } from "./runtime-api.js";
import { createWorkboardAutomationNudgeService } from "./src/automation-nudge.js";
import { createWorkboardChangeEventService } from "./src/change-events.js";
import { registerWorkboardCommand } from "./src/command.js";
import {
  createWorkboardLifecycleService,
  readWorkboardLifecycleSessions,
  syncWorkboardAgentEnded,
  syncWorkboardSubagentEnded,
} from "./src/lifecycle-sync.js";
import { normalizeMaxConcurrentClaimsPerOwner } from "./src/store-constants.js";
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
function parseForceCloseAgentsEnv(
  value: string | undefined,
): string[] | undefined {
  if (!value) return undefined;
  const parsed = value
    .split(",")
    .map((agent) => agent.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : undefined;
}

/**
 * activeRunLookup adapter (card 32d1c50d REWORK gap #2).
 *
 * The Aug 24 graveyard dist used a `bqes.findActiveByCardId(cardId, queue)`
 * helper to reject force-closes when a durable DBOS run is in flight. The
 * canonical source does not yet have a BQES service, and the
 * PostgresDbosClient in extensions/dbos-runtime exposes only admit/start/
 * fail/complete — no equivalent list/find method.
 *
 * Until either (a) BQES is ported to the canonical source or (b)
 * PostgresDbosClient gains a `findActiveByCardId` RPC, the lookup
 * intentionally returns undefined and the force-close rejection falls back
 * to the in-memory `execution.status === "running"` + `latestRunningAttempt`
 * check. That still catches every locally-active run; only durable runs that
 * exist purely on the DBOS authority and have no local card projection are
 * not blocked. Flagged in the card as a follow-up dependency on the BQES
 * port.
 */
function createActiveRunLookup(
  _api: unknown,
): (cardId: string, queue?: string) => Promise<string | undefined> {
  return async (_cardId: string, _queue?: string) => {
    // Intentionally no-op until BQES / findActiveByCardId is ported.
    // The store will still block on locally-active execution and on the
    // latest running attempt metadata; this only affects durable-only runs.
    return undefined;
  };
}

export default definePluginEntry({
  id: "workboard",
  name: "Workboard",
  description: "Dashboard workboard for agent-owned issues and sessions.",
  register(api) {
    // force-close wiring (card 32d1c50d REWORK gap #2):
    // 1. OPENCLAW_WORKBOARD_FORCE_CLOSE_AGENTS — env-supplied comma-separated
    //    allowlist that REPLACES the built-in DEFAULT_FORCE_CLOSE_AGENTS.
    //    Empty/missing env falls back to the default unchanged.
    // 2. activeRunLookup — optional durable-run lookup callback (BQES /
    //    DBOS adapter). The store rejects force-closes when the lookup
    //    returns a run id, matching the Aug 24 design's "no override over
    //    an active durable run" guard. When no live queue is registered
    //    the lookup is left undefined and the rejection falls back to the
    //    in-memory execution / running-attempt check, which still catches
    //    every locally-active run.
    const configuredForceCloseAgents = parseForceCloseAgentsEnv(
      process.env.OPENCLAW_WORKBOARD_FORCE_CLOSE_AGENTS,
    );
    const store = WorkboardStore.openSqlite({
      ...(configuredForceCloseAgents
        ? { forceCloseAllowedAgents: configuredForceCloseAgents }
        : {}),
      activeRunLookup: createActiveRunLookup(api),
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
    api.on("gateway_start", () => lifecycleSync.onGatewayStart());
    api.on("gateway_stop", () => lifecycleSync.onGatewayStop());
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
