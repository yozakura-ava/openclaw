import { expect, it, vi } from "vitest";
import {
  createSubagentRunRecord,
  expectRecordFields,
  mockGatewayMethods,
  waitForFast,
  type SubagentRegistryHarness,
} from "../../subagent-test-fixtures.test-helpers.js";
import { observeRootWork } from "./subagent-registry.browser-cleanup.test-support.js";
import { createSubagentRegistryMockState } from "./subagent-registry.mock-state.test-support.js";

export function registerRestoredRunDeadlineSettlementTests({
  getRegistry,
  mocks,
  hydrateAndActivateRegistry,
}: {
  getRegistry: () => SubagentRegistryHarness;
  mocks: Pick<
    ReturnType<typeof createSubagentRegistryMockState>,
    | "resolveAgentTimeoutMs"
    | "restoreSubagentRunsFromDisk"
    | "callGateway"
    | "runSubagentAnnounceFlow"
  >;
  hydrateAndActivateRegistry: () => void;
}): void {
  const findRequesterRun = (runId: string) =>
    getRegistry()
      .listSubagentRunsForRequester("agent:main:main")
      .find((entry) => entry.runId === runId);
  it.each([
    {
      name: "prefers explicit run timeout over late restored agent.wait success",
      runId: "run-resumed-late-success",
      task: "resume after explicit timeout",
      waitStartedAfterMs: 0,
      waitEndedAfterMs: 61_000,
      expected: { status: "timeout", startedAfterMs: 0, endedAfterMs: 60_000, elapsedMs: 60_000 },
      label: "late restored wait success timeout outcome",
    },
    {
      name: "uses observed agent.wait start time when applying explicit run deadline",
      runId: "run-resumed-observed-start",
      task: "respect observed start",
      waitStartedAfterMs: 10_000,
      waitEndedAfterMs: 65_000,
      expected: { status: "ok", startedAfterMs: 10_000, endedAfterMs: 65_000, elapsedMs: 55_000 },
      label: "observed start success outcome",
    },
  ] as const)(
    "$name",
    async ({ runId, task, waitStartedAfterMs, waitEndedAfterMs, expected, label }) => {
      const createdAt = Date.parse("2026-03-24T11:59:00Z");
      vi.setSystemTime(createdAt + waitEndedAfterMs);
      mocks.resolveAgentTimeoutMs.mockReturnValue(60_000);
      mocks.restoreSubagentRunsFromDisk.mockImplementation(((params: {
        runs: Map<string, unknown>;
        mergeOnly?: boolean;
      }) => {
        params.runs.set(
          runId,
          createSubagentRunRecord({
            runId,
            task,
            runTimeoutSeconds: 60,
            createdAt,
            startedAt: createdAt,
            sessionStartedAt: createdAt,
          }),
        );
        return 1;
      }) as never);
      mockGatewayMethods(mocks.callGateway, {
        "agent.wait": {
          status: "ok",
          startedAt: createdAt + waitStartedAfterMs,
          endedAt: createdAt + waitEndedAfterMs,
        },
      });

      const settleRootWork = observeRootWork();
      try {
        hydrateAndActivateRegistry();

        await waitForFast(() => {
          const completedRun = findRequesterRun(runId);
          expect(completedRun?.execution.endedAt).toBe(createdAt + expected.endedAfterMs);
          expectRecordFields(
            completedRun?.execution.outcome,
            {
              status: expected.status,
              startedAt: createdAt + expected.startedAfterMs,
              endedAt: createdAt + expected.endedAfterMs,
              elapsedMs: expected.elapsedMs,
            },
            label,
          );
        });
      } finally {
        await settleRootWork();
      }
      expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
    },
  );
}
