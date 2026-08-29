#!/usr/bin/env node

// Build the PostgreSQL DBOS authority as an explicit deployment artifact.
// The normal gateway tsdown entry does not include this standalone server.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolvePnpmRunner } from "./pnpm-runner.mts";

const root = process.cwd();
const stage = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-dbos-authority-build-"));
const output = path.join(root, "dist");

try {
  const runner = resolvePnpmRunner({
    cwd: root,
    pnpmArgs: [
      "exec",
      "tsdown",
      "extensions/dbos-runtime/src/server.ts",
      "--no-config",
      "--format",
      "esm",
      "--platform",
      "node",
      "--out-dir",
      stage,
      "--no-clean",
      "--logLevel",
      "warn",
    ],
  });
  const result = spawnSync(runner.command, runner.args, {
    cwd: root,
    env: process.env,
    stdio: "inherit",
    shell: runner.shell ?? false,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`DBOS authority build exited with ${result.status}`);
  }

  const server = path.join(stage, "server.mjs");
  if (!fs.existsSync(server)) {
    throw new Error("DBOS authority build did not produce server.mjs");
  }
  fs.mkdirSync(output, { recursive: true });
  for (const entry of fs.readdirSync(stage, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name.endsWith(".d.mts")) {
      continue;
    }
    const targetName = entry.name === "server.mjs" ? "dbos-authority.mjs" : entry.name;
    fs.copyFileSync(path.join(stage, entry.name), path.join(output, targetName));
  }
  console.log("[build-dbos-authority] wrote dist/dbos-authority.mjs and helper chunks");
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}
