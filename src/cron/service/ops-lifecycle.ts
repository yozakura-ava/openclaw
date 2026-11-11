<<<<<<< HEAD
import { isAbortError, racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { SqliteWorkerAdmissionTimeoutError } from "../../infra/sqlite-worker-contract.js";
import {
  beginGatewayRootWorkAdmissionWhenOpen,
  GatewayDrainingError,
} from "../../process/gateway-work-admission.js";
import { runInDetachedAsyncContext } from "../../shared/detached-async-context.js";
import type { CronRunRecoveryProposal } from "../store/run-recovery-read.types.js";
import type { CronRunRecoveryResult, InterruptedStartupRun } from "../store/run-recovery.types.js";
import {
  configureForeignReceiptMonitor,
  enrollForeignReceipt,
  listForeignReceipts,
  removeForeignReceipt,
  resumeForeignReceiptMonitor,
  stopForeignReceiptMonitor,
  waitForForeignReceipt,
} from "./foreign-receipt-monitor.js";
import { nextWakeAtMs } from "./jobs-scheduling.js";
=======
>>>>>>> 97b6e87616f
import { locked } from "./locked.js";
import { stopCronRunQueue, drainCronRunQueue, waitForCronRunQueue } from "./run-queue.js";
import { recoverCronRuns } from "./run-recovery.js";
import { refreshCronScheduler, startCronScheduler, stopCronScheduler } from "./scheduler-actor.js";
import type { CronServiceState } from "./state.js";
<<<<<<< HEAD
import { ensureLoaded, runPostPersistCronNotifications } from "./store.js";
import { MIN_REFIRE_GAP_MS } from "./timer-execution-timeout.js";
import { armTimer, runMissedJobs, stopTimer } from "./timer.js";
=======
import { ensureLoaded } from "./store.js";
>>>>>>> 97b6e87616f

/** Recover committed state before the worker starts dispatching new requests. */
export async function start(state: CronServiceState): Promise<void> {
<<<<<<< HEAD
  const generation = state.lifecycleGeneration;
  try {
    await startOnce(state);
  } catch (error) {
    if (!(error instanceof SqliteWorkerAdmissionTimeoutError)) {
      throw error;
    }
    if (state.stopped || state.lifecycleGeneration !== generation) {
      return;
    }
    state.deps.log.warn({ err: String(error) }, "cron: startup admission delayed; retrying later");
    stopTimer(state);
    // Recovery must retain startup semantics for interrupted one-shots until it completes.
    const retry = {};
    state.startupCatchup = retry;
    const scheduler = state.schedulerScope;
    scheduler.schedule({
      id: `cron:${state.deps.storePath}:startup`,
      delayMs: MIN_REFIRE_GAP_MS,
      run: async () => {
        if (
          state.stopped ||
          state.lifecycleGeneration !== generation ||
          state.startupCatchup !== retry
        ) {
          return;
        }
        await runInDetachedAsyncContext(async () => {
          let admission;
          try {
            admission = await beginGatewayRootWorkAdmissionWhenOpen(
              "cron:startup-retry",
              scheduler.signal,
            );
          } catch (admissionError) {
            if (
              admissionError instanceof GatewayDrainingError ||
              (scheduler.signal.aborted && isAbortError(admissionError))
            ) {
              return;
            }
            throw admissionError;
          }
          try {
            if (
              state.stopped ||
              state.lifecycleGeneration !== generation ||
              state.startupCatchup !== retry
            ) {
              return;
            }
            state.startupCatchup = undefined;
            const resume = () => start(state);
            await admission.run(() =>
              state.deps.runSchedulerOwned ? state.deps.runSchedulerOwned(resume) : resume(),
            );
          } finally {
            admission.release();
          }
        });
      },
    });
  }
}

async function startOnce(state: CronServiceState): Promise<void> {
=======
  if (state.schedulerStarted) {
    return;
  }
  const generation = state.lifecycleGeneration;
  await state.schedulerDrain;
  if (state.lifecycleGeneration !== generation) {
    return;
  }
>>>>>>> 97b6e87616f
  if (state.schedulerScope.signal.aborted) {
    state.schedulerScope = state.deps.scheduler.scope();
  }
  state.stopped = false;
  const skipJobIds = await locked(state, async () => {
    await ensureLoaded(state);
    return await recoverCronRuns(state);
  });
  if (state.stopped || state.lifecycleGeneration !== generation) {
    return;
  }
<<<<<<< HEAD
  try {
    await runMissedJobs(state, {
      skipJobIds: skipJobIds.size > 0 ? skipJobIds : undefined,
      deferAgentWork: true,
    });
  } catch (err) {
    if (err instanceof SqliteWorkerAdmissionTimeoutError) {
      throw err;
    }
    // Catch-up releases its timer fence even when a terminal write fails.
    // Keep future jobs live without hiding that failure from the caller.
    if (!state.stopped && state.lifecycleGeneration === generation) {
      state.schedulerStarted = true;
      try {
        armTimer(state);
        resumeForeignReceiptMonitor(state);
      } catch (armError) {
        state.deps.log.warn(
          { err: String(armError) },
          "cron: failed to arm scheduling after startup catch-up failed",
        );
      }
    }
    throw err;
=======
  await startCronScheduler(state, skipJobIds);
  if (state.stopped || state.lifecycleGeneration !== generation) {
    await stopCronScheduler(state);
    return;
>>>>>>> 97b6e87616f
  }
  state.deps.log.info(
    { enabled: state.deps.cronEnabled, jobs: state.store?.jobs.length ?? 0 },
    "cron: started",
  );
}

/** Close dispatch synchronously, then join execution and the retained worker lease. */
export function stop(state: CronServiceState) {
  state.lifecycleGeneration += 1;
  state.stopped = true;
  state.schedulerStarted = false;
  state.schedulerDrain = Promise.allSettled([
    state.schedulerDrain,
    stopCronScheduler(state),
    stopCronRunQueue(state),
    waitForCronRunQueue(state),
    state.schedulerScope.stop(),
  ]).then((outcomes) => {
    const errors = outcomes
      .filter((outcome) => outcome.status === "rejected")
      .map((outcome) => String(outcome.reason));
    if (errors.length > 0) {
      state.deps.log.warn({ errors }, "cron: shutdown left work for recovery");
    }
  });
}

export function pauseScheduling(state: CronServiceState) {
  state.schedulingPaused = true;
  refreshCronScheduler(state);
}

export function resumeScheduling(state: CronServiceState) {
  if (!state.schedulingPaused) {
    return;
  }
  state.schedulingPaused = false;
  if (state.schedulerStarted) {
    refreshCronScheduler(state);
    void drainCronRunQueue(state);
  }
}
