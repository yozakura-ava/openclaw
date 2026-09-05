import { describe, expect, it, vi } from "vitest";
import { SqliteAuthorityLifecycle } from "./sqlite-authority-lifecycle.js";

const context = {
  operation: "workboard.write",
  source: "gateway",
  databaseIdentity: "workboard.sqlite@generation-7",
  primaryErrorCode: "SQLITE_BUSY",
  extendedErrorCode: "SQLITE_BUSY_TIMEOUT",
  storeGeneration: "generation-7",
  retryCount: 1,
  queueDepth: 2,
  transactionHoldTimeMs: 14,
  eventLoopLagMs: 3,
};

describe("SqliteAuthorityLifecycle", () => {
  it("emits one structured record per state transition", () => {
    const records: Array<Record<string, unknown>> = [];
    const lifecycle = new SqliteAuthorityLifecycle({
      onRecord: (record) => records.push(record),
    });

    const record = lifecycle.transition("contention", context);

    expect(record).toMatchObject({
      kind: "transition",
      from: "healthy",
      to: "contention",
      operation: context.operation,
      source: context.source,
      databaseIdentity: context.databaseIdentity,
      primaryErrorCode: context.primaryErrorCode,
      extendedErrorCode: context.extendedErrorCode,
      storeGeneration: context.storeGeneration,
      retryCount: context.retryCount,
      queueDepth: context.queueDepth,
      transactionHoldTimeMs: context.transactionHoldTimeMs,
      eventLoopLagMs: context.eventLoopLagMs,
    });
    expect(records).toHaveLength(1);
    expect(record.correlationId).toEqual(expect.any(String));
    expect(record.timestamp).toEqual(expect.any(String));
  });

  it("makes retry scheduling visible and restores health only after the probe", async () => {
    vi.useFakeTimers();
    try {
      const records: Array<Record<string, unknown>> = [];
      const lifecycle = new SqliteAuthorityLifecycle({
        onRecord: (record) => records.push(record),
      });
      lifecycle.transition("degraded", context);
      const attempt = vi.fn().mockResolvedValue(true);
      expect(lifecycle.scheduleRetry({ delayMs: 10, context, attempt })).toBe(true);
      expect(records.at(-1)).toMatchObject({
        kind: "retry_scheduled",
        recoveryResult: "retry_scheduled",
      });
      await vi.advanceTimersByTimeAsync(10);
      vi.runAllTicks();
      expect(attempt).toHaveBeenCalledTimes(1);
      expect(lifecycle.currentState).toBe("healthy");
      expect(records.map((record) => record.to)).toEqual([
        "degraded",
        "degraded",
        "recovering",
        "healthy",
      ]);
      lifecycle.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
