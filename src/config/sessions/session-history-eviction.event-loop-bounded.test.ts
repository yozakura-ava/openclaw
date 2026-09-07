// Regression test for issue #20 — sessions.cleanup blocks the gateway event loop.
// Proves that `enforceSqliteSessionHistoryDiskBudget` yields between candidates
// so a heartbeat timer keeps firing while historical eviction is in flight.

import fs from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { measureSessionPhysicalDiskUsage } from "./disk-budget.js";
import {
  appendTranscriptMessage,
  replaceSessionEntry,
  resetSessionEntryLifecycle,
} from "./session-accessor.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import { enforceSqliteSessionHistoryDiskBudget } from "./session-history-eviction.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";

const HEARTBEAT_INTERVAL_MS = 5;
// Generous bound: a pre-fix run that synchronously holds the loop across the
// candidate eviction pass fails this assertion by orders of magnitude.
const HEARTBEAT_THRESHOLD_MS = 250;

describe("sessions.cleanup event-loop bounding (#20)", () => {
  let testState: OpenClawTestState;
  let storePath: string;
  let tempDir: string;

  beforeEach(async () => {
    testState = await createOpenClawTestState({
      prefix: "openclaw-cleanup-event-loop-",
      layout: "state-only",
    });
    tempDir = testState.sessionsDir();
    fs.mkdirSync(tempDir, { recursive: true });
    storePath = `${tempDir}/sessions.json`;
  });

  afterEach(async () => {
    closeOpenClawAgentDatabasesForTest();
    await testState.cleanup();
  });

  it("yields between candidate evictions so a heartbeat timer keeps firing", async () => {
    // Stage enough historical sessions to force multiple eviction iterations.
    // Each iteration creates a session entry, a transcript event, retires it
    // via a reset lifecycle mutation, and pushes the updated_at far into the
    // past so the disk-budget sweep treats it as historical eviction pressure.
    const HISTORICAL_COUNT = 6;
    for (let i = 0; i < HISTORICAL_COUNT; i += 1) {
      const sessionKey = `agent:main:history-${i}`;
      const sessionId = `history-${i}-old`;
      const nextSessionId = `history-${i}-live`;
      await replaceSessionEntry({ sessionKey, storePath }, { sessionId, updatedAt: 1 });
      await appendTranscriptMessage(
        { sessionId, sessionKey, storePath },
        { message: { role: "user", content: "x".repeat(16 * 1024) } },
      );
      await resetSessionEntryLifecycle({
        storePath,
        target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
        buildNextEntry: () => ({ sessionId: nextSessionId, updatedAt: 2 }),
      });
      setSessionUpdatedAt(sessionId, 1);
    }

    const before = await measureSessionPhysicalDiskUsage(storePath);
    expect(before.totalBytes).toBeGreaterThan(0);

    // Heartbeat probe: tick faster than any reasonable per-iteration cost so
    // we can detect a stall. We record each tick timestamp; the max gap
    // between consecutive ticks is the longest time the event loop was held
    // by synchronous work without yielding.
    const tickTimestamps: number[] = [];
    let stopped = false;
    const heartbeat = setInterval(() => {
      if (stopped) {
        return;
      }
      tickTimestamps.push(Date.now());
    }, HEARTBEAT_INTERVAL_MS);
    heartbeat.unref?.();

    try {
      await enforceSqliteSessionHistoryDiskBudget({
        storePath,
        mode: "enforce",
        maintenance: {
          maxDiskBytes: 1,
          highWaterBytes: 1,
        },
      });
    } finally {
      stopped = true;
      clearInterval(heartbeat);
    }

    // Allow trailing ticks to flush before we inspect the timeline.
    await delay(HEARTBEAT_INTERVAL_MS * 4);

    expect(tickTimestamps.length).toBeGreaterThan(2);
    const maxGapMs = tickTimestamps
      .slice(1)
      .reduce((max, ts, index) => Math.max(max, ts - tickTimestamps[index]!), 0);
    expect(maxGapMs).toBeLessThan(HEARTBEAT_THRESHOLD_MS);
  });

  function database() {
    const target = resolveSqliteTargetFromSessionStorePath(storePath);
    if (!target.path) {
      throw new Error("expected SQLite database path");
    }
    return openOpenClawAgentDatabase({
      agentId: target.agentId ?? "main",
      path: target.path,
    });
  }

  function setSessionUpdatedAt(sessionId: string, updatedAt: number): void {
    const owner = database();
    const db = getSessionKysely(owner.db);
    executeSqliteQuerySync(
      owner.db,
      db
        .updateTable("session_windows")
        .set({ updated_at: updatedAt })
        .where("session_id", "=", sessionId),
    );
  }
});
