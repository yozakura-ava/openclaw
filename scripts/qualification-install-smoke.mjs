#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const packageDir = path.resolve(".artifacts/qualification/package");
const prefix = path.resolve(".artifacts/qualification/install");
const packages = fs
  .readdirSync(packageDir)
  .filter((name) => name.endsWith(".tgz"))
  .toSorted();
if (packages.length !== 1)
  throw new Error(`Expected exactly one packed archive, found ${packages.length}`);
fs.mkdirSync(prefix, { recursive: true });
const result = spawnSync(
  "npm",
  [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--prefix",
    prefix,
    path.join(packageDir, packages[0]),
  ],
  { stdio: "inherit" },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exitCode = result.status ?? 1;
const manifestPath = path.join(prefix, "node_modules/openclaw/package.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
if (typeof manifest.name !== "string" || typeof manifest.version !== "string") {
  throw new Error("Isolated package installation has no name/version identity");
}
process.stdout.write(`${JSON.stringify({ name: manifest.name, version: manifest.version })}\n`);
