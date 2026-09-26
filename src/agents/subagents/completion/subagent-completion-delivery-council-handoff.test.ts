import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { resolvePreferredOpenClawTmpDir } from "../../../infra/tmp-openclaw-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../../state/openclaw-state-db.js";
import type { TaskRecord } from "../../../tasks/task-registry.types.js";
import { resetTaskRegistryForTests } from "../../../tasks/task-runtime.test-helpers.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import { settleSubagentCompletionDelivery } from "./subagent-completion-admission.store.js";
import {
  admitCorrelatedSubagentSessionDelivery,
  CouncilHandoffSanitizationError,
} from "./subagent-completion-delivery.js";

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

function persistTerminalSubagent(params: {
  name: string;
  resultText: string;
  taskRunId: string;
  deliveryDisposition: "permanent_failure" | "delivered";
}): { task: TaskRecord; subagentRunId: string } {
  const now = Date.now();
  const task: TaskRecord = {
    taskId: `task-${params.name}`,
    runId: params.taskRunId,
    runtime: "subagent",
    requesterSessionKey: "agent:main:main",
    ownerKey: "agent:main:main",
    scopeKind: "session",
    childSessionKey: "agent:main:subagent:shared",
    task: `finish ${params.name} work`,
    status: "succeeded",
    deliveryStatus: params.deliveryDisposition === "permanent_failure" ? "failed" : "delivered",
    terminalOutcome: params.deliveryDisposition === "permanent_failure" ? "blocked" : "succeeded",
    progressSummary: `${params.name} result`,
    notifyPolicy: "done_only",
    createdAt: now - 10_000,
    endedAt: now - 1_000,
    lastEventAt: now,
    cleanupAfter: now + 7 * 24 * 60 * 60_000,
  };
  const subagent = createSubagentRunRecord({
    runId: params.taskRunId,
    childSessionKey: task.childSessionKey,
    task: task.task,
    createdAt: task.createdAt,
    endedAt: task.endedAt,
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
  settleSubagentCompletionDelivery({
    subagent,
    task,
    databaseOptions: { database: stateDb },
  });
  subagentRuns.set(subagent.runId, subagent);
  return { task, subagentRunId: subagent.runId };
}

let stateDb: OpenClawStateDatabase;
let workspaceDir: string;
let logPath: string;

beforeEach(() => {
  workspaceDir = tempDirs.make("council-handoff-delivery-", resolvePreferredOpenClawTmpDir());
  logPath = path.join(workspaceDir, "data", "ops", "dispatch_sanitizer_blocks.jsonl");
  process.env.OPENCLAW_WORKSPACE = workspaceDir;
  process.env.OPENCLAW_STATE_DIR = workspaceDir;
  stateDb = openOpenClawStateDatabase();
});

afterEach(() => {
  subagentRuns.clear();
  resetTaskRegistryForTests({ persist: false });
  closeOpenClawStateDatabaseForTest();
  delete process.env.OPENCLAW_WORKSPACE;
  delete process.env.OPENCLAW_STATE_DIR;
});

describe("admitCorrelatedSubagentSessionDelivery council-handoff sanitizer", () => {
  it("refuses admission when the terminal reply carries a memory/private path", () => {
    const dirtyResult =
      "I read memory/private/canary_journal.md and the response is RELOS-CANARY-JOURNAL-2d4e6a8c.";
    const { task, subagentRunId } = persistTerminalSubagent({
      name: "dirty-path",
      resultText: dirtyResult,
      taskRunId: "run-dirty-path",
      deliveryDisposition: "permanent_failure",
    });

    expect(() =>
      admitCorrelatedSubagentSessionDelivery({
        runId: subagentRunId,
        payload: buildQueuedPayload(),
      }),
    ).toThrow(CouncilHandoffSanitizationError);

    // Audit log row written under OPENCLAW_WORKSPACE/data/ops.
    expect(fs.existsSync(logPath)).toBe(true);
    const rows = fs
      .readFileSync(logPath, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(rows.length).toBe(1);
    expect(rows[0].surface).toBe("council_handoff");
    expect(rows[0].envelope_id).toBe(subagentRunId);
    expect(rows[0].hit_count).toBeGreaterThan(0);
    const patterns = rows[0].hits.map((h: { pattern: string }) => h.pattern).sort();
    expect(patterns).toContain("memory_private_path");
    expect(patterns).toContain("canary");

    // Task was not admitted: no delivery_queue_entries row exists for
    // this runId (the sanitizer threw before prepareClaimedSessionDelivery
    // could persist anything).
    const queueRows = stateDb.db
      .prepare("SELECT id FROM delivery_queue_entries WHERE queue_name = ? AND entry_json LIKE ?")
      .all("session", `%${subagentRunId}%`) as { id: string }[];
    expect(queueRows.length).toBe(0);

    // Defensive: the original task record is unchanged.
    const persistedTask = stateDb.db
      .prepare("SELECT delivery_status FROM task_runs WHERE task_id = ?")
      .get(task.taskId) as { delivery_status: string } | undefined;
    expect(persistedTask?.delivery_status).not.toBe("session_queued");
  });

  it("refuses admission when the terminal reply carries a privacy_tier marker", () => {
    const { subagentRunId } = persistTerminalSubagent({
      name: "dirty-tier",
      resultText: "metadata: privacy_tier=private_relationship",
      taskRunId: "run-dirty-tier",
      deliveryDisposition: "permanent_failure",
    });

    expect(() =>
      admitCorrelatedSubagentSessionDelivery({
        runId: subagentRunId,
        payload: buildQueuedPayload(),
      }),
    ).toThrow(CouncilHandoffSanitizationError);

    const rows = fs
      .readFileSync(logPath, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(rows.length).toBe(1);
    expect(rows[0].hits.some((h: { pattern: string }) => h.pattern === "privacy_tier")).toBe(true);
  });

  it("admits a clean terminal reply without writing an audit row", () => {
    const { subagentRunId } = persistTerminalSubagent({
      name: "clean",
      resultText: "Validated the cron fix; targeted tests passed.",
      taskRunId: "run-clean",
      deliveryDisposition: "delivered",
    });

    const result = admitCorrelatedSubagentSessionDelivery({
      runId: subagentRunId,
      payload: buildQueuedPayload(),
    });
    expect(typeof result.id).toBe("string");
    expect(result.id.length).toBeGreaterThan(0);
    expect(result.claimed).toBe(true);

    expect(fs.existsSync(logPath)).toBe(false);
  });

  it("does not false-positive on sibling namespaces", () => {
    const { subagentRunId } = persistTerminalSubagent({
      name: "sibling",
      resultText: "See memory/private_archive/notes.md for the prior reference.",
      taskRunId: "run-sibling",
      deliveryDisposition: "delivered",
    });

    const result = admitCorrelatedSubagentSessionDelivery({
      runId: subagentRunId,
      payload: buildQueuedPayload(),
    });
    expect(typeof result.id).toBe("string");
    expect(result.id.length).toBeGreaterThan(0);
    expect(result.claimed).toBe(true);
  });
});

// Avoid an "unused import" lint failure when this test file is the only
// consumer of these helpers in some configurations.
void os;
