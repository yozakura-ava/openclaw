import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { resolvePreferredOpenClawTmpDir } from "../../../infra/tmp-openclaw-dir.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import { seedSubagentCompletionDelivery } from "./subagent-completion-admission.test-helpers.js";
import { CouncilHandoffSanitizationError } from "./subagent-completion-delivery.js";

// Wire-up and admission-flow coverage for the council-handoff sanitizer. Each case
// owns a minimal native state fixture so the worker validates the same persisted
// completion owner that the test places in the in-memory registry.

vi.mock("../registry/subagent-registry-persistence.js", () => ({
  withSubagentRegistryWriteAuthority: async (
    _runIds: string[],
    _options: unknown,
    callback: (authority: unknown) => Promise<unknown>,
  ) =>
    callback({
      assertDatabase: () => {},
      assertCurrent: () => {},
      currentRunIds: () => [],
    }),
  assertSubagentRegistryWriteSourceCurrent: vi.fn(),
}));

vi.mock("../../../infra/session-delivery-queue-storage.js", () => ({
  withSessionDeliveryEnqueueAdmission: async (
    _payload: unknown,
    _context: unknown,
    callback: (assertCurrent: () => void) => Promise<unknown>,
  ) => callback(() => {}),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function buildQueuedPayload() {
  return {
    kind: "agentTurn" as const,
    sessionKey: "agent:main:main",
    agentId: "main",
    message: "outer message",
    messageId: "outer-msg-1",
    idempotencyKey: "outer-idem-1",
  };
}

function makeSubagent(params: { runId: string; resultText: string; taskRunId: string }) {
  const now = Date.now();
  return createSubagentRunRecord({
    runId: params.runId,
    taskRunId: params.taskRunId,
    childSessionKey: "agent:main:subagent:council-handoff",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "agent:main:main",
    requesterAgentId: "main",
    task: `finish ${params.runId} work`,
    createdAt: now - 2_000,
    endedAt: now - 1_000,
    outcome: { status: "ok" },
    expectsCompletionMessage: true,
    completion: {
      required: true,
      resultText: params.resultText,
      capturedAt: now,
    },
    delivery: {
      status: "pending",
      disposition: "pending",
      generation: 1,
    },
  });
}

describe("admitCorrelatedSubagentSessionDelivery council-handoff sanitizer", () => {
  let workspaceDir: string;
  let logPath: string;

  beforeEach(() => {
    workspaceDir = tempDirs.make("council-handoff-delivery-", resolvePreferredOpenClawTmpDir());
    logPath = path.join(workspaceDir, "data", "ops", "dispatch_sanitizer_blocks.jsonl");
    vi.stubEnv("OPENCLAW_STATE_DIR", workspaceDir);
    vi.stubEnv("OPENCLAW_WORKSPACE", workspaceDir);
  });

  afterEach(() => {
    subagentRuns.clear();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  async function seedAndAdmit(runId: string, resultText: string) {
    return await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const subagent = makeSubagent({
        runId,
        taskRunId: `task-${runId}`,
        resultText,
      });
      seedSubagentCompletionDelivery({ subagent });
      subagentRuns.set(subagent.runId, subagent);
      const mod = await import("./subagent-completion-delivery.js");
      return mod.admitCorrelatedSubagentSessionDelivery({
        runId: subagent.runId,
        payload: buildQueuedPayload(),
        queueContext: captureOpenClawStateWorkerContext(),
      });
    });
  }

  it("refuses admission when the terminal reply carries a memory/private path", async () => {
    const dirtyResult =
      "I read memory/private/canary_journal.md and the response is RELOS-CANARY-JOURNAL-2d4e6a8c.";
    const runId = "run-dirty-path";
    await expect(seedAndAdmit(runId, dirtyResult)).rejects.toBeInstanceOf(
      CouncilHandoffSanitizationError,
    );

    // Audit log row written under OPENCLAW_WORKSPACE/data/ops.
    expect(fs.existsSync(logPath)).toBe(true);
    const rows = fs
      .readFileSync(logPath, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(rows.length).toBe(1);
    expect(rows[0].surface).toBe("council_handoff");
    expect(rows[0].envelope_id).toBe(runId);
    expect(rows[0].hit_count).toBeGreaterThan(0);
    const patterns = rows[0].hits.map((h: { pattern: string }) => h.pattern).toSorted();
    expect(patterns).toContain("memory_private_path");
    expect(patterns).toContain("canary");
  });

  it("refuses admission when the terminal reply carries a privacy_tier marker", async () => {
    const runId = "run-dirty-tier";
    await expect(
      seedAndAdmit(runId, "metadata: privacy_tier=private_relationship"),
    ).rejects.toBeInstanceOf(CouncilHandoffSanitizationError);

    const rows = fs
      .readFileSync(logPath, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(rows.length).toBe(1);
    expect(rows[0].hits.some((h: { pattern: string }) => h.pattern === "privacy_tier")).toBe(true);
  });

  describe("admittance", () => {
    it("admits a clean terminal reply without writing an audit row", async () => {
      const runId = "run-clean";
      const result = await seedAndAdmit(runId, "Validated the cron fix; targeted tests passed.");
      expect(typeof result.id).toBe("string");
      expect(result.id.length).toBeGreaterThan(0);
      expect(result.claimed).toBe(true);

      expect(fs.existsSync(logPath)).toBe(false);
    });

    it("does not false-positive on sibling namespaces", async () => {
      const runId = "run-sibling";
      const result = await seedAndAdmit(
        runId,
        "See memory/private_archive/notes.md for the prior reference.",
      );
      expect(typeof result.id).toBe("string");
      expect(result.id.length).toBeGreaterThan(0);
      expect(result.claimed).toBe(true);
    });
  });
});
