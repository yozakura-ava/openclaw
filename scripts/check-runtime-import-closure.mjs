#!/usr/bin/env node
// Import-closure gate: fails if any generated runtime file under a dist tree
// (including extension .setup chunks) imports a package absent from the
// staged production dependency tree. Postmortem 2026-09-24 prevention #1.
import fs from "node:fs";
import path from "node:path";
import {
  collectRuntimeImportClosureErrors,
  listRuntimeFiles,
} from "./lib/runtime-import-closure.mjs";

function usage() {
  return "Usage: node scripts/check-runtime-import-closure.mjs <dist-dir> [--staged-root <dir>]";
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv) {
  const positional = [];
  let stagedRoot;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      return { help: true };
    }
    if (argument === "--staged-root") {
      stagedRoot = argv[++index];
      continue;
    }
    if (argument.startsWith("-")) {
      throw new Error(`Unexpected option: ${argument}`);
    }
    positional.push(argument);
  }
  if (positional.length !== 1 || (stagedRoot !== undefined && !stagedRoot.trim())) {
    throw new Error("Expected exactly one dist directory (and at most --staged-root)");
  }
  return {
    help: false,
    distDir: path.resolve(positional[0]),
    stagedRoot: stagedRoot ?? path.resolve(positional[0]),
  };
}

let cliArgs;
try {
  cliArgs = parseArgs(process.argv.slice(2));
} catch (error) {
  fail(`${error instanceof Error ? error.message : String(error)}\n${usage()}`);
}

if (cliArgs.help) {
  console.log(usage());
  process.exit(0);
}

const { distDir, stagedRoot } = cliArgs;
if (!fs.existsSync(distDir) || !fs.statSync(distDir).isDirectory()) {
  fail(`dist directory not found: ${distDir}`);
}

const files = listRuntimeFiles(distDir);
const readText = (file) => fs.readFileSync(path.join(distDir, file), "utf8");
const errors = collectRuntimeImportClosureErrors({ files, readText, stagedRoot });

if (errors.length > 0) {
  console.error(`import-closure gate failed with ${errors.length} error(s):`);
  for (const error of errors) {
    console.error(`  - ${error}`);
  }
  process.exit(1);
}
console.log(
  `import-closure gate passed: ${files.length} runtime file(s), all bare imports staged.`,
);
