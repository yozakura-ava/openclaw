#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const destination = path.resolve(".artifacts/qualification/package");
fs.rmSync(destination, { recursive: true, force: true });
fs.mkdirSync(destination, { recursive: true });
const result = spawnSync("pnpm", ["pack", "--ignore-scripts", "--pack-destination", destination], {
  stdio: "inherit",
});
if (result.error) throw result.error;
if (result.status !== 0) process.exitCode = result.status ?? 1;
const archives = fs.readdirSync(destination).filter((name) => name.endsWith(".tgz"));
if (archives.length !== 1) throw new Error(`Expected one packed archive, found ${archives.length}`);
