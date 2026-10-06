import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import { clearRuntimeConfigSnapshot } from "../config/config.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db-lifecycle.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import type { Logger } from "./service/state.js";
import { sweepCronHistorySessions as sweepCronHistorySessionsImpl } from "./session-reaper.js";
import { resetReaperThrottle } from "./session-reaper.test-support.js";

function sweepCronHistorySessions(
  params: Omit<Parameters<typeof sweepCronHistorySessionsImpl>[0], "agentId">,
) {
  return sweepCronHistorySessionsImpl({ ...params, agentId: "main" });
}

type SeededWindow = {
  sessionId: string;
  sessionKey: string;
  /** Updated-at timestamp in ms. */
  updatedAt: number;
  /** When true, this is the current window for its session_key. */
  isCurrent?: boolean;
};

async function seedSessionWindows(storePath: string, windows: SeededWindow[]): Promise<void> {
  const db = openOpenClawAgentDatabase({ agentId: "main", path: storePath });
  try {
    const insertWindow = db.db.prepare(
      "INSERT OR REPLACE INTO session_windows (session_id, session_key, created_at, updated_at, reason, session_scope, session_entry_provenance) VALUES (?, ?, ?, ?, 'initial', 'conversation', 0)",
    );
    const upsertNode = db.db.prepare(
      "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(session_key) DO UPDATE SET current_session_id = excluded.current_session_id, updated_at = excluded.updated_at",
    );
    for (const w of windows) {
      const currentSessionId =
        windows.find((candidate) => candidate.sessionKey === w.sessionKey && candidate.isCurrent)
          ?.sessionId ?? w.sessionId;
      upsertNode.run(w.sessionKey, currentSessionId, JSON.stringify({}), w.updatedAt);
      insertWindow.run(w.sessionId, w.sessionKey, w.updatedAt, w.updatedAt);
      if (w.isCurrent) {
        upsertNode.run(
          w.sessionKey,
          w.sessionId,
          JSON.stringify({ sessionId: w.sessionId, updatedAt: w.updatedAt }),
          w.updatedAt,
        );
      }
    }
  } finally {
    db.db.close();
  }
}

function readSessionWindows(storePath: string): Array<{ session_id: string; session_key: string }> {
  const db = openOpenClawAgentDatabase({ agentId: "main", path: storePath });
  try {
    return db.db
      .prepare(
        "SELECT session_id, session_key FROM session_windows ORDER BY session_key, session_id",
      )
      .all() as Array<{ session_id: string; session_key: string }>;
  } finally {
    db.db.close();
  }
}

function createTestLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

describe("sweepCronHistorySessions", () => {
  const tempDirs: string[] = [];
  let tmpDir: string;
  let storePath: string;
  const log = createTestLogger();

  beforeEach(async () => {
    resetReaperThrottle();
    tmpDir = makeTempDir(tempDirs, "cron-history-reaper-");
    storePath = path.join(tmpDir, "sessions.sqlite");
  });

  afterEach(async () => {
    await closeOpenClawAgentDatabasesAsync();
    clearRuntimeConfigSnapshot();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    cleanupTempDirs(tempDirs);
  });

  it("prunes earlier windows of cron job-level keys while preserving the current window", async () => {
    const now = 2_000_000;
    const jobKey = "agent:main:cron:b239b2c9-fd52-4ec2-8fa4-03be3f895309";
    await seedSessionWindows(storePath, [
      { sessionId: "current", sessionKey: jobKey, updatedAt: now, isCurrent: true },
      { sessionId: "old-1", sessionKey: jobKey, updatedAt: now - 10 * 86_400_000 },
      { sessionId: "old-2", sessionKey: jobKey, updatedAt: now - 30 * 86_400_000 },
    ]);

    const result = await sweepCronHistorySessions({
      sessionStorePath: storePath,
      nowMs: now,
      log,
    });

    expect(result.swept).toBe(true);
    expect(result.pruned).toBe(2);
    expect(readSessionWindows(storePath).map((r) => r.session_id)).toEqual(["current"]);
  });

  it("prunes earlier windows of heartbeat keys while preserving the current window", async () => {
    const now = 2_000_000;
    const hbKey = "agent:main:main:heartbeat";
    await seedSessionWindows(storePath, [
      { sessionId: "current", sessionKey: hbKey, updatedAt: now, isCurrent: true },
      { sessionId: "hb-old-1", sessionKey: hbKey, updatedAt: now - 60 * 86_400_000 },
      { sessionId: "hb-old-2", sessionKey: hbKey, updatedAt: now - 90 * 86_400_000 },
    ]);

    const result = await sweepCronHistorySessions({
      sessionStorePath: storePath,
      nowMs: now,
      log,
      cronConfig: { heartbeatRetention: "30d" },
    });

    expect(result.swept).toBe(true);
    expect(result.pruned).toBe(2);
    expect(readSessionWindows(storePath).map((r) => r.session_id)).toEqual(["current"]);
  });

  it("does not prune windows of cron :run: keys (those are sweepCronRunSessions's job)", async () => {
    const now = 2_000_000;
    const runKey = "agent:main:cron:job1:run:abc";
    await seedSessionWindows(storePath, [
      { sessionId: "run-current", sessionKey: runKey, updatedAt: now, isCurrent: true },
      { sessionId: "run-old", sessionKey: runKey, updatedAt: now - 60 * 86_400_000 },
    ]);

    const result = await sweepCronHistorySessions({
      sessionStorePath: storePath,
      nowMs: now,
      log,
    });

    expect(result.swept).toBe(true);
    expect(result.pruned).toBe(0);
    expect(
      readSessionWindows(storePath)
        .map((r) => r.session_id)
        .toSorted(),
    ).toEqual(["run-current", "run-old"]);
  });

  it("does not prune unrelated session keys", async () => {
    const now = 2_000_000;
    const dmKey = "agent:main:telegram:dm:123";
    await seedSessionWindows(storePath, [
      { sessionId: "dm-current", sessionKey: dmKey, updatedAt: now, isCurrent: true },
      { sessionId: "dm-old", sessionKey: dmKey, updatedAt: now - 365 * 86_400_000 },
    ]);

    const result = await sweepCronHistorySessions({
      sessionStorePath: storePath,
      nowMs: now,
      log,
    });

    expect(result.pruned).toBe(0);
    expect(readSessionWindows(storePath).length).toBe(2);
  });

  it("returns swept:false and does nothing when both retentions resolve to disabled", async () => {
    const now = 2_000_000;
    const jobKey = "agent:main:cron:job1";
    await seedSessionWindows(storePath, [
      { sessionId: "current", sessionKey: jobKey, updatedAt: now, isCurrent: true },
      { sessionId: "old", sessionKey: jobKey, updatedAt: now - 365 * 86_400_000 },
    ]);

    const result = await sweepCronHistorySessions({
      sessionStorePath: storePath,
      nowMs: now,
      log,
      cronConfig: { historyRetention: false, heartbeatRetention: false },
    });

    expect(result).toEqual({ swept: false, pruned: 0 });
    expect(readSessionWindows(storePath).length).toBe(2);
  });

  it("respects historyRetention: false but still prunes heartbeat windows", async () => {
    const now = 2_000_000;
    const jobKey = "agent:main:cron:job1";
    const hbKey = "agent:main:main:heartbeat";
    await seedSessionWindows(storePath, [
      { sessionId: "job-current", sessionKey: jobKey, updatedAt: now, isCurrent: true },
      { sessionId: "job-old", sessionKey: jobKey, updatedAt: now - 365 * 86_400_000 },
      { sessionId: "hb-current", sessionKey: hbKey, updatedAt: now, isCurrent: true },
      { sessionId: "hb-old", sessionKey: hbKey, updatedAt: now - 365 * 86_400_000 },
    ]);

    const result = await sweepCronHistorySessions({
      sessionStorePath: storePath,
      nowMs: now,
      log,
      cronConfig: { historyRetention: false, heartbeatRetention: "7d" },
    });

    expect(result.swept).toBe(true);
    expect(result.pruned).toBe(1);
    expect(
      readSessionWindows(storePath)
        .map((r) => r.session_id)
        .toSorted(),
    ).toEqual(["hb-current", "job-current", "job-old"]);
  });

  it("keeps windows that are inside the retention window (recent)", async () => {
    const now = 2_000_000;
    const jobKey = "agent:main:cron:job1";
    await seedSessionWindows(storePath, [
      { sessionId: "current", sessionKey: jobKey, updatedAt: now, isCurrent: true },
      { sessionId: "recent", sessionKey: jobKey, updatedAt: now - 1 * 86_400_000 },
      { sessionId: "old", sessionKey: jobKey, updatedAt: now - 30 * 86_400_000 },
    ]);

    const result = await sweepCronHistorySessions({
      sessionStorePath: storePath,
      nowMs: now,
      log,
    });

    expect(result.swept).toBe(true);
    expect(result.pruned).toBe(1);
    expect(
      readSessionWindows(storePath)
        .map((r) => r.session_id)
        .toSorted(),
    ).toEqual(["current", "recent"]);
  });

  it("skips unavailable agent", async () => {
    const result = await sweepCronHistorySessions({
      sessionStorePath: storePath,
      nowMs: 2_000_000,
      log,
      isAgentAvailable: () => false,
    });
    expect(result.swept).toBe(false);
    expect(result.pruned).toBe(0);
  });
});
