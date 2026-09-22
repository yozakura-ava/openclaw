export type SubagentRunOutcome = {
  status: "ok" | "error" | "timeout" | "unknown" | "exited-early";
  error?: string;
  startedAt?: number;
  endedAt?: number;
  elapsedMs?: number;
};
