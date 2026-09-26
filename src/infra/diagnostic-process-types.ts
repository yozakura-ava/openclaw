export type DiagnosticMemoryUsage = {
  rssBytes: number;
  heapTotalBytes: number;
  heapUsedBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
  workerCount?: number;
  workerHeapSampledCount?: number;
  workerHeapTotalBytes?: number;
  workerHeapUsedBytes?: number;
  workerExternalBytes?: number;
  workerArrayBuffersBytes?: number;
  workerArrayBuffersSampledCount?: number;
  workerMemoryScope?: "direct";
  workerMemoryCoverage?: "complete" | "partial" | "unavailable";
  workerMemoryMissing?: {
    script: string;
    threadId: number;
    reason: "pending" | "stale" | "unavailable";
  }[];
  /** Live, fresh isolate samples; script is an allowlisted basename or "other". */
  workerHeaps?: {
    script: string;
    heapUsed: number;
    heapTotal: number;
    threadId?: number;
    external?: number;
    arrayBuffers?: number;
    sampleAgeMs?: number;
  }[];
  /** Cumulative process-owned counts; script and reason come from fixed allowlists. */
  workerLifecycle?: {
    script: string;
    started: number;
    retired: { reason: string; count: number }[];
  }[];
};

export type DiagnosticChildProcessSpawnFields = {
  type: "diagnostic.child_process.spawn";
  family: string;
  count: number;
  intervalMs: number;
};
