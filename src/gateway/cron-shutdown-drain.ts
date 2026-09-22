export type ActiveCronRunDrain = { drained: boolean; active: number };
const CRON_ACTIVE_RUN_ABORT_SETTLE_MS = 10_000;

export async function settleActiveCronRunsAfterShutdownDeadline(params: {
  activeRunDrain: ActiveCronRunDrain;
  waitForActiveCronTaskRuns: (timeoutMs: number) => Promise<ActiveCronRunDrain>;
  abortActiveCronTaskRuns: (reason: string) => number;
  warn: (
    details: {
      abortedRuns: number;
      activeRuns: number;
      settledAfterCancellation: boolean;
    },
    message: string,
  ) => void;
}): Promise<void> {
  if (params.activeRunDrain.drained) {
    return;
  }
  const abortedRuns = params.abortActiveCronTaskRuns("Gateway shutdown drain deadline elapsed.");
  const cancelledRunDrain = await params.waitForActiveCronTaskRuns(CRON_ACTIVE_RUN_ABORT_SETTLE_MS);
  params.warn(
    {
      abortedRuns,
      activeRuns: cancelledRunDrain.active,
      settledAfterCancellation: cancelledRunDrain.drained,
    },
    cancelledRunDrain.drained
      ? "cron: active runs were cancelled after the shutdown drain deadline"
      : "cron: active runs did not settle after the shutdown drain deadline",
  );
}
