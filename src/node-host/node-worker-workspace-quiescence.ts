import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  REMOTE_WORKSPACE_QUIESCE_JS,
  REMOTE_WORKSPACE_RENEW_QUIESCENCE_JS,
  REMOTE_WORKSPACE_RESUME_JS,
} from "../gateway/worker-environments/workspace-quiescence-scripts.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { getProcessSupervisor } from "../process/supervisor/index.js";
import { createDeferredCore } from "../shared/deferred.js";
import type {
  NodeWorkerWorkspaceExecInput,
  NodeWorkerWorkspaceQuiescenceInput,
} from "../worker/node-workspace-protocol.js";
import {
  inspectNodeWorkerProcessIdentity,
  requireNodeWorkerProcessIdentity,
  type NodeWorkerProcessIdentity,
} from "./node-worker-process-identity.js";

type LeaseContext = {
  input: NodeWorkerWorkspaceExecInput;
  workspaceDir: string;
  env: NodeJS.ProcessEnv;
  retainWorkspace: () => () => void;
};
type Lease = {
  key: string;
  nonce: string;
  context: LeaseContext;
  child: ChildProcess;
  identity?: NodeWorkerProcessIdentity;
  ready: Promise<void>;
  done: Promise<void>;
  started: Promise<void>;
  operations: Promise<unknown>;
  exited: boolean;
  retirementRecorded: boolean;
  releaseFinished: boolean;
  releaseWorkspace: () => void;
  releasing?: Promise<void>;
};

/** Infrastructure leases outlive commands and environment-owned preview processes. */
export class NodeWorkerWorkspaceQuiescence {
  private readonly leases = new Map<string, Lease>();
  private readonly supervisor = getProcessSupervisor();
  private closed = false;

  hasActiveWork(): boolean {
    return this.leases.size > 0;
  }

  async execute(context: LeaseContext, signal?: AbortSignal): Promise<string> {
    const assertCurrent = () => {
      signal?.throwIfAborted();
      if (this.closed) throw new Error("workspace quiescence owner is closed");
    };
    assertCurrent();
    const operation = context.input.quiescence!;
    // Windows already uses a shared-host SQLite lease without freezing or a detached child.
    if (process.platform === "win32") {
      return this.runScript(context, operation, signal);
    }
    const key = JSON.stringify([
      context.input.gatewayNamespace,
      context.input.environmentId,
      context.input.sessionId,
      context.input.generation,
      context.workspaceDir,
      context.env.HOME,
    ]);
    let lease = this.leases.get(key);
    if (operation.action === "acquire") {
      if (lease?.exited && lease.nonce !== operation.nonce) {
        // A fresh authorized capture can recover a failed prior helper, never a live lease.
        await this.release(lease);
        lease = undefined;
      }
      if (lease && lease.nonce !== operation.nonce) {
        throw new Error("workspace quiescence lease is already active");
      }
      assertCurrent();
      lease ??= this.acquire(key, context, operation);
      await racePromiseWithAbortSignal(lease.ready, signal);
      assertCurrent();
      this.assertActive(lease);
      return "quiesced " + lease.nonce + "\n";
    }
    if (!lease || lease.nonce !== operation.nonce) {
      // Release is idempotent after expiry, but cannot borrow another lease's watchdog.
      if (!lease && operation.action === "release") return "";
      throw new Error("workspace quiescence lease is no longer active");
    }
    if (operation.action === "release") {
      await this.release(lease, signal);
      return "";
    }
    const owned = lease;
    const renewal = owned.operations.then(async () => {
      assertCurrent();
      this.assertActive(owned);
      const result = await this.runScript(context, operation, signal);
      assertCurrent();
      this.assertActive(owned);
      return result;
    });
    owned.operations = renewal.catch(() => undefined);
    return renewal;
  }

  async close(): Promise<void> {
    this.closed = true;
    const outcomes = await Promise.allSettled(
      [...this.leases.values()].map((lease) => this.release(lease)),
    );
    const failures = outcomes.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length) throw new AggregateError(failures, "workspace quiescence recovery failed");
  }

  private assertActive(lease: Lease): void {
    if (
      this.closed ||
      this.leases.get(lease.key) !== lease ||
      lease.exited ||
      lease.releasing ||
      !lease.identity ||
      inspectNodeWorkerProcessIdentity(lease.identity) !== "live"
    ) {
      throw new Error("workspace quiescence watchdog identity changed unexpectedly");
    }
  }

  private retire(lease: Lease): void {
    if (!lease.exited || (!lease.retirementRecorded && !lease.releaseFinished)) return;
    if (this.leases.get(lease.key) !== lease) return;
    this.leases.delete(lease.key);
    lease.releaseWorkspace();
  }

  private acquire(
    key: string,
    context: LeaseContext,
    operation: Extract<NodeWorkerWorkspaceQuiescenceInput, { action: "acquire" }>,
  ): Lease {
    const ready = createDeferredCore();
    const done = createDeferredCore();
    const started = createDeferredCore();
    const releaseWorkspace = context.retainWorkspace();
    let child: ChildProcess;
    try {
      // Fixed recovery-only code, owned directly by this persistent native runtime.
      // Never spawn it below a command anchor or install the harness PID as its watchdog.
      child = spawn(
        process.execPath,
        [
          "-e",
          REMOTE_WORKSPACE_QUIESCE_JS,
          context.workspaceDir,
          String(operation.timeoutMs),
          "shared-host",
          "owned",
          operation.nonce,
        ],
        { cwd: context.workspaceDir, env: context.env, stdio: ["ignore", "pipe", "pipe", "ipc"] },
      );
    } catch (error) {
      releaseWorkspace();
      throw error;
    }
    const lease: Lease = {
      key,
      context,
      nonce: operation.nonce,
      child,
      ready: ready.promise,
      done: done.promise,
      started: started.promise,
      operations: Promise.resolve(),
      exited: false,
      retirementRecorded: false,
      releaseFinished: false,
      releaseWorkspace,
    };
    this.leases.set(key, lease);
    void lease.ready.catch(() => undefined);
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-16_384);
    });
    child.stdout?.resume();
    child.once("spawn", () => {
      try {
        lease.identity = requireNodeWorkerProcessIdentity(child.pid!);
      } catch (error) {
        ready.reject(error);
      }
    });
    child.on("message", (message: unknown) => {
      if (!isRecord(message) || message.nonce !== lease.nonce) return;
      if (message.type === "workspace-quiescence-ready") {
        started.resolve();
        try {
          this.assertActive(lease);
          ready.resolve();
        } catch (error) {
          ready.reject(error);
        }
      } else if (message.type === "workspace-quiescence-retired") {
        lease.retirementRecorded = true;
      }
    });
    child.once("error", (error) => ready.reject(error));
    child.once("close", (code) => {
      lease.exited = true;
      started.resolve();
      // A spawn refusal never acquired a watchdog or created its lease.
      if (!child.pid) lease.releaseFinished = true;
      if (code !== 0) lease.retirementRecorded = false;
      ready.reject(new Error(stderr || "workspace quiescence watchdog exited before readiness"));
      this.retire(lease);
      done.resolve();
    });
    return lease;
  }

  private release(lease: Lease, signal?: AbortSignal): Promise<void> {
    lease.releasing ??= (async () => {
      await lease.operations;
      await racePromiseWithAbortSignal(lease.started, signal);
      await this.runScript(lease.context, { action: "release", nonce: lease.nonce }, signal);
      // Resume deliberately does not signal a recorded PID. Retire only this retained channel.
      if (!lease.exited && lease.child.connected) {
        await new Promise<void>((resolve, reject) => {
          lease.child.send({ type: "workspace-quiescence-retire", nonce: lease.nonce }, (error) => {
            if (error && !lease.exited) reject(error);
            else resolve();
          });
        });
      }
      await lease.done;
      lease.releaseFinished = true;
      this.retire(lease);
    })().catch((error: unknown) => {
      lease.releasing = undefined;
      throw error;
    });
    return lease.releasing;
  }

  private async runScript(
    context: LeaseContext,
    operation: NodeWorkerWorkspaceQuiescenceInput,
    signal?: AbortSignal,
  ): Promise<string> {
    const args =
      operation.action === "acquire"
        ? [
            REMOTE_WORKSPACE_QUIESCE_JS,
            context.workspaceDir,
            String(operation.timeoutMs),
            "shared-host",
            "owned",
            operation.nonce,
          ]
        : operation.action === "renew"
          ? [
              REMOTE_WORKSPACE_RENEW_QUIESCENCE_JS,
              context.workspaceDir,
              operation.nonce,
              String(operation.timeoutMs),
              operation.validationMode,
              "shared-host",
            ]
          : [REMOTE_WORKSPACE_RESUME_JS, context.workspaceDir, operation.nonce, "owned"];
    const runId = randomUUID();
    const scopeKey = "workspace-quiescence-control:" + runId;
    const cleanup = this.supervisor.acquireScopeCleanup(scopeKey, { processTree: "required-all" });
    const abort = () => this.supervisor.cancel(runId);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      signal?.throwIfAborted();
      const run = await this.supervisor.spawn({
        mode: "child",
        runId,
        scopeKey,
        argv: [process.execPath, "-e", ...args],
        cwd: context.workspaceDir,
        env: context.env,
        exactEnv: true,
        stdinMode: "pipe-closed",
        timeoutMs: context.input.timeoutMs ?? 120_000,
        maxCapturedOutputChars: 16_384,
        assertCurrent: () => signal?.throwIfAborted(),
      });
      if (signal?.aborted) abort();
      const result = await run.wait();
      if (result.exitCode !== 0 || result.exitSignal !== null) {
        throw new Error(result.stderr || "workspace quiescence operation failed");
      }
      return result.stdout;
    } finally {
      signal?.removeEventListener("abort", abort);
      await cleanup();
    }
  }
}
