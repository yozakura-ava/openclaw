import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { getProcessSupervisor } from "../process/supervisor/index.js";
import {
  NODE_WORKSPACE_QUIESCENCE_COMMAND,
  parseNodeWorkerWorkspaceExecInput,
  type NodeWorkerWorkspaceQuiescenceInput,
} from "../worker/node-workspace-protocol.js";
import * as processIdentity from "./node-worker-process-identity.js";
import { NodeWorkerWorkspaceRuntime } from "./node-worker-workspace.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const workspaces: NodeWorkerWorkspaceRuntime[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const runtime of workspaces.splice(0)) {
    await runtime.quiescence.close();
    await runtime.processes.close();
  }
});
function spyOnSpawn() {
  const spy = vi.spyOn(childProcess, "spawn");
  syncBuiltinESMExports();
  return spy;
}
const identity = {
  gatewayNamespace: "gateway-watchdog",
  environmentId: "worker-watchdog",
  sessionId: "session-watchdog",
  generation: 1,
};
const nonce = "a".repeat(32);
function fixture() {
  const root = fs.realpathSync(tempDirs.make("node-watchdog-acceptance-"));
  const hash = (text: string, size: number) =>
    createHash("sha256").update(text).digest("hex").slice(0, size);
  const home = path.join(
    root,
    identity.gatewayNamespace,
    "workspaces",
    hash(identity.environmentId, 16),
    hash(identity.sessionId, 32),
  );
  const workspaceDir = path.join(home, "1");
  fs.mkdirSync(workspaceDir, { recursive: true });
  const runtime = new NodeWorkerWorkspaceRuntime({
    root,
    env: { PATH: process.env.PATH, HOME: root },
  });
  workspaces.push(runtime);
  const input = (operation: NodeWorkerWorkspaceQuiescenceInput) => ({
    ...identity,
    argv: [NODE_WORKSPACE_QUIESCENCE_COMMAND, workspaceDir],
    quiescence: operation,
  });
  const command = (operation: NodeWorkerWorkspaceQuiescenceInput) =>
    runtime.exec(parseNodeWorkerWorkspaceExecInput(JSON.stringify(input(operation))));
  const leasePath = path.join(
    home,
    ".openclaw-worker",
    "quiescence",
    hash(workspaceDir, 64) + "." + nonce + ".json",
  );
  const readLease = () =>
    JSON.parse(fs.readFileSync(leasePath, "utf8")) as {
      nonce: string;
      sharedHost: boolean;
      processes: unknown[];
      watchdog: { pid: number; start: string };
      expiresAtMs: number;
    };
  const collect = (sequence: number) =>
    runtime.applyRetainSnapshot(
      {
        version: 1,
        gatewayNamespace: identity.gatewayNamespace,
        controllerId: "watchdog-proof",
        sequence,
        retain: [],
      },
      async () => [],
    );
  return { runtime, input, command, workspaceDir, leasePath, readLease, collect };
}
const acquire = { action: "acquire", nonce, timeoutMs: 30_000 } as const;
const renew = { action: "renew", nonce, timeoutMs: 30_000, validationMode: "final" } as const;
const release = { action: "release", nonce } as const;

describe.runIf(process.platform === "linux")("native watchdog lifecycle", () => {
  it("keeps the exact helper identity through foreground cleanup and environment-app shutdown, and retains custody until release", async () => {
    const f = fixture();
    const spawned = spyOnSpawn();
    await f.command(acquire);
    const lease = f.readLease();
    const exact = processIdentity.requireNodeWorkerProcessIdentity(lease.watchdog.pid);
    expect(lease).toMatchObject({ nonce, sharedHost: true, processes: [] });
    expect(lease.watchdog.pid).not.toBe(process.pid);
    const helper = spawned.mock.results.flatMap((result) =>
      result.type === "return" && result.value.pid === lease.watchdog.pid ? [result.value] : [],
    )[0]!;
    expect(helper).toBeDefined();
    expect(fs.readFileSync("/proc/" + helper.pid + "/status", "utf8")).toContain(
      "PPid:\t" + process.pid,
    );
    await f.runtime.exec({
      ...identity,
      argv: [path.basename(process.execPath), "-e", "process.stdout.write('command-cleanup')"],
    });
    expect(processIdentity.requireNodeWorkerProcessIdentity(lease.watchdog.pid)).toEqual(exact);
    await f.runtime.exec({
      ...identity,
      argv: [
        path.basename(process.execPath),
        "-e",
        'require("node:net").createServer().listen(0, "127.0.0.1")',
      ],
      process: { action: "start", processId: "owned-app" },
    });
    await f.runtime.processes.stopEnvironment({
      gatewayNamespace: identity.gatewayNamespace,
      environmentId: identity.environmentId,
      ownerEpoch: 1,
    });
    expect(f.runtime.processes.hasActiveWork()).toBe(false);
    expect(f.runtime.quiescence.hasActiveWork()).toBe(true);
    await f.command(renew);
    expect(f.readLease().watchdog).toEqual(lease.watchdog);
    expect(processIdentity.requireNodeWorkerProcessIdentity(lease.watchdog.pid)).toEqual(exact);
    await f.collect(1);
    expect(fs.existsSync(f.workspaceDir)).toBe(true);
    const done = once(helper, "close");
    await f.command(release);
    await done;
    expect(processIdentity.inspectNodeWorkerProcessIdentity(exact)).not.toBe("live");
    expect(f.runtime.quiescence.hasActiveWork()).toBe(false);
    expect(fs.existsSync(f.leasePath)).toBe(false);
    await f.collect(2);
    expect(fs.existsSync(f.workspaceDir)).toBe(false);
  });

  it("rejects nonce, namespace, root and incompatible input without borrowing or retiring the live helper", async () => {
    const f = fixture();
    await f.command(acquire);
    const lease = f.readLease();
    for (const action of ["acquire", "renew", "release"] as const) {
      const operation = action === "acquire" ? acquire : action === "renew" ? renew : release;
      await expect(f.command({ ...operation, nonce: "b".repeat(32) })).rejects.toThrow(
        /already active|no longer active/,
      );
    }
    await expect(
      f.runtime.exec({ ...f.input(renew), gatewayNamespace: "gateway-other" }),
    ).rejects.toThrow("root does not match its owner");
    await expect(
      f.runtime.exec({
        ...f.input(renew),
        argv: [NODE_WORKSPACE_QUIESCENCE_COMMAND, path.dirname(f.workspaceDir)],
      }),
    ).rejects.toThrow("root does not match its owner");
    for (const extra of [
      { input: "caller-script" },
      { resetWorkspace: true },
      { process: { action: "start", processId: "app" } },
    ]) {
      expect(() =>
        parseNodeWorkerWorkspaceExecInput(JSON.stringify({ ...f.input(acquire), ...extra })),
      ).toThrow();
    }
    await f.command(renew);
    expect(f.readLease().watchdog).toEqual(lease.watchdog);
  });

  it.each(["reused", "unknown"] as const)(
    "fails closed and retains workspace custody for a %s helper identity",
    async (state) => {
      const f = fixture();
      await f.command(acquire);
      const lease = f.readLease();
      const inspect = processIdentity.inspectNodeWorkerProcessIdentity;
      const mocked = vi
        .spyOn(processIdentity, "inspectNodeWorkerProcessIdentity")
        .mockImplementation((observed) =>
          observed.pid === lease.watchdog.pid ? state : inspect(observed),
        );
      await expect(f.command(renew)).rejects.toThrow("watchdog identity changed");
      expect(f.runtime.quiescence.hasActiveWork()).toBe(true);
      await f.collect(1);
      expect(fs.existsSync(f.workspaceDir)).toBe(true);
      mocked.mockRestore();
      await f.command(renew);
    },
  );

  it("keeps unexpected helper death in custody until authorized recovery", async () => {
    const f = fixture();
    const spawned = spyOnSpawn();
    await f.command(acquire);
    const lease = f.readLease();
    const helper = spawned.mock.results.flatMap((result) =>
      result.type === "return" && result.value.pid === lease.watchdog.pid ? [result.value] : [],
    )[0]!;
    const done = once(helper, "close");
    helper.kill("SIGKILL");
    await done;
    await expect(f.command(renew)).rejects.toThrow("watchdog identity changed");
    expect(f.runtime.quiescence.hasActiveWork()).toBe(true);
    await f.collect(1);
    expect(fs.existsSync(f.workspaceDir)).toBe(true);
    await f.command(release);
    expect(f.runtime.quiescence.hasActiveWork()).toBe(false);
    expect(fs.existsSync(f.leasePath)).toBe(false);
    await f.collect(2);
    expect(fs.existsSync(f.workspaceDir)).toBe(false);
  });

  it("joins an in-flight renewal before closing the native lease and releases its hold", async () => {
    const f = fixture();
    await f.command(acquire);
    const supervisor = getProcessSupervisor();
    const original = supervisor.spawn.bind(supervisor);
    const entered = createDeferred();
    const unblock = createDeferred();
    const spy = vi.spyOn(supervisor, "spawn").mockImplementationOnce(async (input) => {
      entered.resolve();
      await unblock.promise;
      return original(input);
    });
    const renewal = f.command(renew);
    await entered.promise;
    const closing = f.runtime.quiescence.close();
    const observedRenewal = expect(renewal).rejects.toThrow(/closed|identity changed/);
    try {
      expect(f.runtime.quiescence.hasActiveWork()).toBe(true);
      expect(fs.existsSync(f.leasePath)).toBe(true);
    } finally {
      // A failed assertion must not leave teardown waiting on this test-owned gate.
      unblock.resolve();
      await Promise.all([observedRenewal, closing]);
    }
    expect(spy).toHaveBeenCalledTimes(2);
    expect(f.runtime.quiescence.hasActiveWork()).toBe(false);
    expect(fs.existsSync(f.leasePath)).toBe(false);
    await f.collect(1);
    expect(fs.existsSync(f.workspaceDir)).toBe(false);
  });

  it("joins startup before close removes the lease and retained child", async () => {
    const f = fixture();
    const original = childProcess.spawn;
    const entered = createDeferred();
    spyOnSpawn().mockImplementation((...args: Parameters<typeof childProcess.spawn>) => {
      const child = original(...args);
      entered.resolve();
      return child;
    });
    const acquiring = f.command(acquire);
    const rejected = expect(acquiring).rejects.toThrow(/closed|identity changed/);
    await entered.promise;
    await f.runtime.quiescence.close();
    await rejected;
    expect(f.runtime.quiescence.hasActiveWork()).toBe(false);
    expect(fs.existsSync(f.leasePath)).toBe(false);
    await f.collect(1);
    expect(fs.existsSync(f.workspaceDir)).toBe(false);
  });

  it.each([false, true])(
    "joins expiry IPC and actual child close before surrendering workspace custody (release race: %s)",
    async (releaseRaces) => {
      const f = fixture();
      const preload = path.join(path.dirname(f.workspaceDir), "expiry-clock.cjs");
      fs.writeFileSync(
        preload,
        `const now = Date.now;
let elapsed = 0;
let deadline;
Date.now = () => now() + elapsed;
global.setTimeout = (callback) => { deadline = callback; return { unref() {} }; };
process.on("message", (message) => {
  if (message?.type === "acceptance-expire") { elapsed += 60_000; deadline(); }
});`,
      );
      const original = childProcess.spawn;
      const spawned = spyOnSpawn().mockImplementation(
        (...args: Parameters<typeof childProcess.spawn>) => {
          const [command, argv, options] = args;
          return original(command, ["--require", preload, ...argv], options);
        },
      );
      await f.command(acquire);
      const lease = f.readLease();
      const helper = spawned.mock.results.flatMap((result) =>
        result.type === "return" && result.value.pid === lease.watchdog.pid ? [result.value] : [],
      )[0]!;
      const retired = once(helper, "message");
      const closed = once(helper, "close");
      helper.send({ type: "acceptance-expire" });
      expect((await retired)[0]).toEqual({ type: "workspace-quiescence-retired", nonce });
      expect(f.runtime.quiescence.hasActiveWork()).toBe(true);
      const releasing = releaseRaces ? f.command(release) : Promise.resolve();
      await closed;
      await releasing;
      expect(f.runtime.quiescence.hasActiveWork()).toBe(false);
      expect(fs.existsSync(f.leasePath)).toBe(false);
      await f.collect(1);
      expect(fs.existsSync(f.workspaceDir)).toBe(false);
    },
  );
});
