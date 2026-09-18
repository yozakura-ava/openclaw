export type MemorySearchTelemetryStatus = "ok" | "unavailable" | "error";

export type MemorySearchTelemetryEvent = {
  agentId: string;
  durationMs: number;
  resultCount: number;
  status: MemorySearchTelemetryStatus;
};

export type MemorySearchTelemetryLogger = {
  info(message: string): void;
  warn(message: string): void;
};

type Sample = MemorySearchTelemetryEvent & { at: number };

const WINDOW_MS = 5 * 60_000;
const MAX_SAMPLES = 512;
const MIN_ALERT_SAMPLES = 20;
const P95_ALERT_MS = 5_000;
const ERROR_RATE_ALERT = 0.01;

export function createMemorySearchTelemetry(params: {
  logger: MemorySearchTelemetryLogger;
  now?: () => number;
}) {
  const samples: Sample[] = [];
  const now = params.now ?? Date.now;

  return {
    record(event: MemorySearchTelemetryEvent) {
      const at = now();
      samples.push({ ...event, at });
      while (samples.length > MAX_SAMPLES || samples[0]!.at < at - WINDOW_MS) {
        samples.shift();
      }
      params.logger.info(
        JSON.stringify({
          tool: "memory_search",
          agentId: event.agentId,
          duration_ms: Math.max(0, Math.round(event.durationMs)),
          status: event.status,
          result_count: Math.max(0, Math.trunc(event.resultCount)),
        }),
      );

      if (samples.length < MIN_ALERT_SAMPLES) {
        return;
      }
      const orderedDurations = samples.map((sample) => sample.durationMs).sort((a, b) => a - b);
      const p95Index = Math.ceil(orderedDurations.length * 0.95) - 1;
      const p95Ms = Math.max(0, orderedDurations[p95Index] ?? 0);
      const errorRate =
        samples.filter((sample) => sample.status === "error").length / samples.length;
      if (p95Ms > P95_ALERT_MS || errorRate > ERROR_RATE_ALERT) {
        params.logger.warn(
          JSON.stringify({
            tool: "memory_search",
            window_ms: WINDOW_MS,
            sample_count: samples.length,
            p95_duration_ms: Math.round(p95Ms),
            error_rate: Number(errorRate.toFixed(4)),
            thresholds: { p95_duration_ms: P95_ALERT_MS, error_rate: ERROR_RATE_ALERT },
          }),
        );
      }
    },
    reset() {
      samples.length = 0;
    },
  };
}
