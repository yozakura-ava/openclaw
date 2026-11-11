import { deserialize } from "node:v8";
import { MessagePort } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
<<<<<<< HEAD
import { observeCronStoreCommits } from "../../../test/helpers/cron/runtime-mutation.js";
import {
  createCronRegressionState,
  createDueIsolatedJob,
  noopLogger,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { runWithSqliteBusyTimeout } from "../../infra/sqlite-busy-timeout.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import * as workerCpu from "../../infra/worker-cpu.js";
import { tryBeginGatewaySuspendAdmission } from "../../process/gateway-work-admission.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { loadCronStore, saveCronStore } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import { releaseLocalCronRunReceiptOwnership } from "../store/run-receipt-store.js";
import type { CronRuntimeMutationType } from "../store/runtime-worker.types.js";
import { start, stop } from "./ops-lifecycle.js";
import { claimCronRecoveryReceipt } from "./run-recovery.test-support.js";
import { MIN_REFIRE_GAP_MS } from "./timer-execution-timeout.js";
import { onTimer } from "./timer-scheduler.js";

function delayCronAdmission(
  type: CronRuntimeMutationType,
  stage: "transaction" | "commit",
  count = 1,
) {
  const held = createDeferred();
  const delayed: Array<() => void> = [];
  const nonces = new Set<string>();
  const restores: Array<() => void> = [];
  const create = workerCpu.createCpuTrackedWorker;
  const created = vi.spyOn(workerCpu, "createCpuTrackedWorker").mockImplementation((...args) => {
    const worker = create(...args);
    const post = worker.postMessage.bind(worker);
    const posted = vi.spyOn(worker, "postMessage").mockImplementation((message, transferList) => {
      const request: unknown = message;
      if (isRecord(request) && request.type === "execute" && request.input instanceof Uint8Array) {
        const command: unknown = deserialize(request.input);
        if (
          isRecord(command) &&
          command.type === type &&
          isRecord(command.input) &&
          typeof command.input.nonce === "string"
        ) {
          nonces.add(command.input.nonce);
        }
      }
      return post(message, transferList);
    });
    restores.push(() => posted.mockRestore());
=======
import {
  createCronRegressionState,
  createDueIsolatedJob,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import {
  createUpdateRun,
  getUpdateRun,
  recordUpdateRunStep,
} from "../../infra/update-run-ledger.js";
import * as workerCpu from "../../infra/worker-cpu.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { loadCronStore, saveCronStore } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import { stop } from "./ops-lifecycle.js";
import { runMissedJobs } from "./timer.test-support.js";

function stallCronHostCallbacks() {
  const submitted = createDeferred();
  const held = createDeferred();
  const delayed: Array<() => void> = [];
  const ports = new WeakMap<MessagePort, { paused: boolean }>();
  const restores: Array<() => void> = [];
  let stalling = true;
  const mutationTypes = new Set([
    "cron.schedulerStart",
    "cron.requestRuns",
    "cron.drainQueue",
    "cron.finalizeRuns",
    "cron.cancelRequests",
  ]);
  const createWorker = workerCpu.createCpuTrackedWorker;
  const workers = vi.spyOn(workerCpu, "createCpuTrackedWorker").mockImplementation((...args) => {
    const worker = createWorker(...args);
    const nativePost = worker.postMessage.bind(worker);
    const nativeEmit = worker.emit.bind(worker);
    const requests = new Set<number>();
    const reply = vi.spyOn(worker, "emit").mockImplementation((event, ...eventArgs) => {
      const message: unknown = eventArgs[0];
      if (
        stalling &&
        event === "message" &&
        isRecord(message) &&
        typeof message.id === "number" &&
        requests.has(message.id) &&
        message.ok === true &&
        message.value instanceof Uint8Array
      ) {
        delayed.push(() => nativeEmit(event, ...eventArgs));
        held.resolve();
        return true;
      }
      return nativeEmit(event, ...eventArgs);
    });
    const post = vi.spyOn(worker, "postMessage").mockImplementation((message, transferList) => {
      const request: unknown = message;
      const command: unknown =
        isRecord(request) && request.type === "execute" && request.input instanceof Uint8Array
          ? deserialize(request.input)
          : undefined;
      const cronMutation =
        isRecord(command) && typeof command.type === "string" && mutationTypes.has(command.type);
      if (cronMutation && isRecord(request) && typeof request.id === "number") {
        requests.add(request.id);
      }
      if (cronMutation && isRecord(request) && request.operationAdmission instanceof MessagePort) {
        const receiver = ports.get(request.operationAdmission);
        if (receiver) {
          receiver.paused = true;
        }
      }
      nativePost(message, transferList);
      if (cronMutation) {
        submitted.resolve();
      }
    });
    restores.push(() => reply.mockRestore());
    restores.push(() => post.mockRestore());
>>>>>>> 97b6e87616f
    return worker;
  });
  const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
  const admissions = vi
    .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
<<<<<<< HEAD
    .mockImplementation((admit, attachment) => {
=======
    .mockImplementation((...args) => {
      const receiver = { paused: false };
>>>>>>> 97b6e87616f
      const listening = vi.spyOn(MessagePort.prototype, "on").mockImplementation(function (
        this: MessagePort,
        event,
        listener,
      ) {
        if (event !== "message") {
          return this.addListener(event, listener);
        }
        return this.addListener("message", function (this: MessagePort, message: unknown) {
          if (
<<<<<<< HEAD
            delayed.length < count &&
            isRecord(message) &&
            message.stage === stage &&
            isRecord(message.facts) &&
            typeof message.facts.nonce === "string" &&
            nonces.has(message.facts.nonce)
          ) {
            // Delay the receiver, preserving the worker's real shared decision and rollback.
=======
            stalling &&
            receiver.paused &&
            isRecord(message) &&
            (message.stage === "transaction" || message.stage === "commit")
          ) {
            // Hold the real receiver; the worker keeps its actual SQLite transaction and decision.
>>>>>>> 97b6e87616f
            delayed.push(() => listener.call(this, message));
            held.resolve();
            return;
          }
          listener.call(this, message);
        });
      });
      try {
<<<<<<< HEAD
        return createAdmission(admit, attachment);
=======
        const admission = createAdmission(...args);
        ports.set(admission.port, receiver);
        return admission;
>>>>>>> 97b6e87616f
      } finally {
        listening.mockRestore();
      }
    });
  return {
<<<<<<< HEAD
    held: held.promise,
    get count() {
      return delayed.length;
    },
    release() {
=======
    submitted: submitted.promise,
    held: held.promise,
    release() {
      stalling = false;
>>>>>>> 97b6e87616f
      for (const deliver of delayed.splice(0)) {
        deliver();
      }
    },
    restore() {
      admissions.mockRestore();
<<<<<<< HEAD
      created.mockRestore();
=======
      workers.mockRestore();
>>>>>>> 97b6e87616f
      for (const restore of restores.toReversed()) {
        restore();
      }
    },
  };
}

<<<<<<< HEAD
for (const { phase, type, stage } of [
  { phase: "startup settlement", type: "cron.releaseReservations", stage: "transaction" },
  { phase: "startup settlement", type: "cron.releaseReservations", stage: "commit" },
  { phase: "startup recovery", type: "cron.repairRun", stage: "commit" },
] as const) {
  it(`retries ${phase} after delayed ${stage} admission without losing a one-shot`, async ({
    signal,
  }) => {
    await withOpenClawTestState({ label: "cron-startup-admission-timeout" }, async (fixture) => {
      const fault = delayCronAdmission(type, stage);
      const now = Date.now();
      const clock = createGatewaySchedulerClock(now);
      const scheduler = createTestGatewayScheduler(clock.clock);
      const storePath = fixture.statePath("cron", "jobs.json");
      const job = createDueIsolatedJob({ id: "delayed-startup", nowMs: now, nextRunAtMs: now });
      if (phase === "startup recovery") {
        job.state.runningAtMs = now;
      }
      const log = { ...noopLogger, warn: vi.fn() };
      const runner = vi.fn(async () => ({ status: "ok" as const }));
      const state = createCronRegressionState({
        scheduler,
        storePath,
        nowMs: clock.clock.now,
        defaultAgentId: "main",
        startupDeferredMissedAgentJobDelayMs: 0,
        missedJobStaggerMs: 0,
        runIsolatedAgentJob: runner,
        log,
      });
      try {
        await saveCronStore(storePath, { version: 1, jobs: [job] });
        if (phase === "startup recovery") {
          releaseLocalCronRunReceiptOwnership(
            claimCronRecoveryReceipt(storePath, job, now, "main"),
          );
        }
        const database = openOpenClawStateDatabase().db;
        const started = start(state);
        await withinTest(fault.held, signal);
        // MAIN cannot service admission while this competing native writer waits.
        runWithSqliteBusyTimeout(database, 2_000, () => {
          database.exec("BEGIN IMMEDIATE");
          database.exec("ROLLBACK");
        });
        await withinTest(started, signal);
        expect(fault.count).toBe(1);
        expect(log.warn).toHaveBeenCalledWith(
          { err: expect.stringContaining("admission") },
          "cron: startup admission delayed; retrying later",
        );
        expect(runner).not.toHaveBeenCalled();
        const pending = (await loadCronStore(storePath)).jobs[0];
        expect(pending?.enabled).toBe(true);
        expect(pending?.state.nextRunAtMs).toBe(now);
        fault.release();
        fault.restore();
        if (phase === "startup recovery") {
          const scheduled = vi.fn();
          state.deps.runSchedulerOwned = async (run) => {
            scheduled();
            return await run();
          };
          const suspension = tryBeginGatewaySuspendAdmission(() => {});
          try {
            expect(suspension?.commit()).toBe(true);
            const retry = clock.advanceBy(MIN_REFIRE_GAP_MS);
            expect(scheduled).not.toHaveBeenCalled();
            expect(runner).not.toHaveBeenCalled();
            expect(suspension?.release()).toBe(true);
            await retry;
            expect(scheduled).toHaveBeenCalledOnce();
          } finally {
            suspension?.release();
            suspension?.rollback();
          }
        } else {
          await clock.advanceBy(MIN_REFIRE_GAP_MS);
        }
        await clock.advanceBy(MIN_REFIRE_GAP_MS);
        expect(runner).toHaveBeenCalledTimes(1);
        expect((await loadCronStore(storePath)).jobs[0]?.state.lastRunStatus).toBe("ok");
        expect(state.startupCatchup).toBeUndefined();
      } finally {
        fault.release();
        fault.restore();
        stop(state);
        await scheduler.stop();
      }
    });
  });
}

it("recovers queued work after both reservation cleanup attempts time out", async ({ signal }) => {
  await withOpenClawTestState({ label: "cron-release-admission-timeout" }, async (fixture) => {
    const fault = delayCronAdmission("cron.releaseReservations", "commit", 3);
    const now = Date.now();
    const clock = createGatewaySchedulerClock(now);
    const scheduler = createTestGatewayScheduler(clock.clock);
    const storePath = fixture.statePath("cron", "jobs.json");
    const job = createDueIsolatedJob({ id: "delayed-release", nowMs: now, nextRunAtMs: now });
    const log = { ...noopLogger, warn: vi.fn() };
    const runner = vi.fn(async () => ({ status: "ok" as const }));
    const state = createCronRegressionState({
      scheduler,
      storePath,
      nowMs: clock.clock.now,
      defaultAgentId: "main",
      runIsolatedAgentJob: runner,
      log,
    });
    let stopObserving: (() => void) | undefined;
    try {
      await saveCronStore(storePath, { version: 1, jobs: [job] });
      const database = openOpenClawStateDatabase().db;
      stopObserving = observeCronStoreCommits(storePath, () => {
        if (!state.queuedRunReservationsByJobId.has(job.id)) {
          database
            .prepare(
              "UPDATE cron_jobs SET state_json = json_set(state_json, '$.nextRunAtMs', ?) WHERE store_key = ? AND job_id = ?",
            )
            .run(now + 60_000, cronStoreKey(storePath), job.id);
        }
      });
      const tick = onTimer(state);
      await withinTest(fault.held, signal);
      await withinTest(tick, signal);
      expect(fault.count).toBe(3);
      database.exec("BEGIN IMMEDIATE");
      database.exec("ROLLBACK");
      expect(runner).not.toHaveBeenCalled();
      expect(state.queuedRunReservationsByJobId.size).toBe(0);
      expect((await loadCronStore(storePath)).jobs[0]?.state.queuedAtMs).toBe(now);
      expect(log.warn).toHaveBeenCalledWith(
        { err: expect.stringContaining("admission") },
        "cron: worker admission delayed; retrying later",
      );
      stopObserving();
      fault.release();
      fault.restore();
      await clock.advanceBy(60_000);
      expect(runner).toHaveBeenCalledTimes(1);
      expect((await loadCronStore(storePath)).jobs[0]?.state.lastRunStatus).toBe("ok");
    } finally {
      stopObserving?.();
      fault.release();
      fault.restore();
      stop(state);
      await scheduler.stop();
=======
it("finishes startup, state writes, and update history while cron host callbacks are stalled", async ({
  signal,
}) => {
  await withOpenClawTestState({ label: "cron-startup-independent-writers" }, async (fixture) => {
    const fault = stallCronHostCallbacks();
    const now = 1_800_000_000_000;
    const storePath = fixture.statePath("cron", "jobs.json");
    const deferred = createDueIsolatedJob({ id: "deferred-startup", nowMs: now, nextRunAtMs: now });
    const immediate = createDueIsolatedJob({
      id: "immediate-startup",
      nowMs: now,
      nextRunAtMs: now,
    });
    immediate.payload = { kind: "command", argv: ["echo", "synthetic"] };
    const runCommandJob = vi.fn(async () => ({ status: "ok" as const }));
    const state = createCronRegressionState({
      storePath,
      defaultAgentId: "main",
      nowMs: () => now,
      runCommandJob,
      runIsolatedAgentJob: async () => {
        throw new Error("Deferred startup must not execute the payload");
      },
    });
    let settled: Promise<unknown> | undefined;
    try {
      await saveCronStore(storePath, { version: 1, jobs: [deferred, immediate] });
      const options = { env: fixture.env, busyTimeoutMs: 0 };
      const update = createUpdateRun({ trigger: "cli" }, options);
      const startup = runMissedJobs(state, { deferAgentWork: true });
      settled = startup.then(
        () => ({ ok: true }),
        (error: unknown) => ({ ok: false, error }),
      );
      await withinTest(
        awaitGateBeforeSettlement(fault.submitted, startup, "Startup skipped its worker mutation"),
        signal,
      );
      await withinTest(
        awaitGateBeforeSettlement(
          fault.held,
          startup,
          "Startup completed without pausing its host",
        ),
        signal,
      );
      // A pending host response must never retain the writer needed by state and update history.
      runOpenClawStateWriteTransaction(
        ({ db }) => {
          db.prepare(
            "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, ?)",
          ).run("cron-independent-writer", JSON.stringify("saved"), now);
        },
        { env: fixture.env },
        { busyTimeoutMs: 0 },
      );
      recordUpdateRunStep(
        update.runId,
        { step: "cron-independent-history", status: "completed", endedAtMs: now },
        options,
      );
      fault.release();
      expect(await withinTest(settled, signal)).toEqual({ ok: true });
      expect(runCommandJob).toHaveBeenCalledOnce();
      const jobs = (await loadCronStore(storePath)).jobs;
      expect(jobs.find(({ id }) => id === deferred.id)?.state.startupCatchupAtMs).toBeGreaterThan(
        now,
      );
      expect(jobs.find(({ id }) => id === immediate.id)?.state.lastRunStatus).toBe("ok");
      expect(
        openOpenClawStateDatabase()
          .db.prepare("SELECT value_json FROM config_machine_state WHERE state_key = ?")
          .get("cron-independent-writer"),
      ).toEqual({ value_json: JSON.stringify("saved") });
      expect(getUpdateRun(update.runId, options)?.steps).toContainEqual(
        expect.objectContaining({ step: "cron-independent-history", status: "completed" }),
      );
      expect(
        openOpenClawStateDatabase()
          .db.prepare("SELECT status FROM cron_run_receipts WHERE store_key = ? AND job_id = ?")
          .all(cronStoreKey(storePath), immediate.id),
      ).toEqual([{ status: "ok" }]);
    } finally {
      fault.release();
      fault.restore();
      stop(state);
      await settled;
      await state.op;
>>>>>>> 97b6e87616f
    }
  });
});
