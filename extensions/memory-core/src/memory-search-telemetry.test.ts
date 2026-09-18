import { describe, expect, it, vi } from "vitest";
import { createMemorySearchTelemetry } from "./memory-search-telemetry.js";

function createLogger() {
  return { info: vi.fn(), warn: vi.fn() };
}

describe("memory search telemetry", () => {
  it("logs per-call duration, status, and result count without query content", () => {
    const logger = createLogger();
    const telemetry = createMemorySearchTelemetry({ logger, now: () => 10_000 });

    telemetry.record({
      agentId: "main",
      durationMs: 1234.6,
      resultCount: 3,
      status: "ok",
    });

    expect(logger.info).toHaveBeenCalledWith(
      JSON.stringify({
        tool: "memory_search",
        agentId: "main",
        duration_ms: 1235,
        status: "ok",
        result_count: 3,
      }),
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("alerts when the rolling five-minute p95 exceeds five seconds", () => {
    const logger = createLogger();
    const telemetry = createMemorySearchTelemetry({ logger, now: () => 10_000 });

    for (let index = 0; index < 20; index += 1) {
      telemetry.record({ agentId: "main", durationMs: 5_001, resultCount: 1, status: "ok" });
    }

    expect(logger.warn).toHaveBeenLastCalledWith(
      JSON.stringify({
        tool: "memory_search",
        window_ms: 300_000,
        sample_count: 20,
        p95_duration_ms: 5_001,
        error_rate: 0,
        thresholds: { p95_duration_ms: 5_000, error_rate: 0.01 },
      }),
    );
  });

  it("alerts when the rolling error rate exceeds one percent", () => {
    const logger = createLogger();
    const telemetry = createMemorySearchTelemetry({ logger, now: () => 10_000 });

    for (let index = 0; index < 19; index += 1) {
      telemetry.record({ agentId: "main", durationMs: 1, resultCount: 1, status: "ok" });
    }
    telemetry.record({ agentId: "main", durationMs: 1, resultCount: 0, status: "error" });

    expect(JSON.parse(logger.warn.mock.lastCall?.[0] ?? "{}")).toMatchObject({
      sample_count: 20,
      error_rate: 0.05,
    });
  });
});
