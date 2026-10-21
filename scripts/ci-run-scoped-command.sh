#!/usr/bin/env bash
set -euo pipefail

if [[ -n "${OPENCLAW_QUALIFICATION_SCOPE_FILE:-}" ]]; then
  node --input-type=commonjs -e '
    const fs = require("node:fs");
    const { spawnSync } = require("node:child_process");
    const group = fs.readFileSync("/proc/self/cgroup", "utf8").split("\n").find((line) => line.startsWith("0::"))?.slice(3);
    if (!group) throw new Error("unified cgroup membership is unavailable");
    const root = `/sys/fs/cgroup${group}`;
    const memoryMax = fs.readFileSync(`${root}/memory.max`, "utf8").trim();
    const swapMax = fs.readFileSync(`${root}/memory.swap.max`, "utf8").trim();
    const cpuMax = fs.readFileSync(`${root}/cpu.max`, "utf8").trim();
    const oomPolicy = process.env.OPENCLAW_CI_OOM_POLICY || "kill";
    const expectedAffinity = process.env.OPENCLAW_QUALIFICATION_SCOPE_EXPECTED_CPUS;
    const probe = spawnSync("taskset", ["-pc", String(process.pid)], { encoding: "utf8" });
    if (probe.status !== 0) throw new Error(`taskset affinity verification failed: ${probe.stderr}`);
    const cpuAffinity = probe.stdout.trim().split(": ").at(-1);
    if (memoryMax !== String(6 * 1024 ** 3) || swapMax !== "0" || cpuMax.split(" ")[0] !== "200000") {
      throw new Error(`qualification cgroup mismatch: memory=${memoryMax}, swap=${swapMax}, cpu=${cpuMax}`);
    }
    if (cpuAffinity !== expectedAffinity) {
      throw new Error(`qualification CPU affinity mismatch: expected=${expectedAffinity}, actual=${cpuAffinity}`);
    }
    fs.writeFileSync(process.env.OPENCLAW_QUALIFICATION_SCOPE_FILE, JSON.stringify({
      memoryMaxBytes: Number(memoryMax), swapMaxBytes: Number(swapMax), cpuMax,
      cpuAffinity, oomPolicy,
    }) + "\n", { flag: "wx" });
  '
fi
exec "$@"
