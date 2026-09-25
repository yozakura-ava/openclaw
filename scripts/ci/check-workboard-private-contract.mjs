#!/usr/bin/env node
// check-workboard-private-contract.mjs — PR-K RC#1 gate.
//
// Fails the build if @openclaw/workboard-contract slips back into
// extensions/workboard/package.json `dependencies` or
// `optionalDependencies`. The contract is a private workspace package and
// MUST stay in `devDependencies` (postmortem 2026-09-24 RC#1).
//
// Extracted from deploy-bundle.yml so shellcheck can parse the workflow
// without confusing the embedded JavaScript inside `node -e '...'`.
//
// Exit codes:
//   0 — pinned to devDependencies
//   1 — leaked into dependencies / optionalDependencies
//   2 — package.json missing or unreadable
//   3 — @openclaw/workboard-contract missing entirely from devDependencies

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const PACKAGE_JSON_PATH = resolve(process.cwd(), "extensions/workboard/package.json");

function fail(message, code = 1) {
  process.stderr.write(`[RC#1] ${message}\n`);
  process.exit(code);
}

let pkg;
try {
  const text = readFileSync(PACKAGE_JSON_PATH, "utf8");
  pkg = JSON.parse(text);
} catch (err) {
  fail(`cannot read ${PACKAGE_JSON_PATH}: ${err.message}`, 2);
}

const runtimeDeps = {
  ...(pkg.dependencies ?? {}),
  ...(pkg.optionalDependencies ?? {}),
};

if (runtimeDeps["@openclaw/workboard-contract"]) {
  fail("@openclaw/workboard-contract must be in devDependencies, not dependencies", 1);
}

const devDep = pkg.devDependencies?.["@openclaw/workboard-contract"];
if (!devDep) {
  fail("@openclaw/workboard-contract missing from devDependencies entirely", 3);
}

process.stdout.write(`OK: @openclaw/workboard-contract pinned to devDependencies (${devDep})\n`);
