#!/usr/bin/env -S node --import tsx

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  collectWorkboardArchiveErrors,
  collectWorkboardDeploymentContractErrors,
  readGitCommit,
  readWorkboardBuildIdentity,
} from "./lib/workboard-deployment-contract.mts";

type Arguments = {
  archive?: string;
  artifactRoot: string;
  json: boolean;
  sourceRoot: string;
  writeReport?: string;
};

function usage(): string {
  return [
    "Usage: node --import tsx scripts/verify-workboard-deployment.mts [options]",
    "",
    "Options:",
    "  --source-root PATH    Git checkout containing the source contract (default: cwd)",
    "  --artifact-root PATH  Staged deployment/package root (default: source root)",
    "  --archive PATH        Package archive to check (tar/tgz)",
    "  --write-report PATH   Write the JSON verification record to PATH",
    "  --json                Print machine-readable JSON",
  ].join("\n");
}

function parseArgs(argv: string[]): Arguments {
  const args: Arguments = {
    artifactRoot: process.cwd(),
    json: false,
    sourceRoot: process.cwd(),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (arg === "--json") {
      args.json = true;
      continue;
    }
    const readValue = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error(`Missing value for ${arg}`);
      }
      index += 1;
      return value;
    };
    if (arg === "--source-root") {
      args.sourceRoot = path.resolve(readValue());
    } else if (arg === "--artifact-root") {
      args.artifactRoot = path.resolve(readValue());
    } else if (arg === "--archive") {
      args.archive = path.resolve(readValue());
    } else if (arg === "--write-report") {
      args.writeReport = path.resolve(readValue());
    } else {
      throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
    }
  }
  return args;
}

function readArchiveEntries(archivePath: string): string[] {
  const output = execFileSync("tar", ["-tzf", archivePath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }) as string;
  return output.split(/\r?\n/u).filter(Boolean);
}

function main(): number {
  let args: Arguments;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }

  const errors = collectWorkboardDeploymentContractErrors({
    artifactRoot: args.artifactRoot,
    sourceRoot: args.sourceRoot,
  });
  const sourceCommit = readGitCommit(args.sourceRoot) ?? null;
  const artifactIdentity = readWorkboardBuildIdentity(args.artifactRoot);
  let archiveEntries: string[] | undefined;
  if (args.archive) {
    try {
      archiveEntries = readArchiveEntries(args.archive);
      errors.push(...collectWorkboardArchiveErrors(archiveEntries));
    } catch (error) {
      errors.push(`Cannot inspect Workboard deployment archive ${args.archive}: ${String(error)}`);
    }
  }

  const report = {
    artifactRoot: args.artifactRoot,
    artifactCommit: artifactIdentity.buildInfoCommit ?? null,
    artifactStampCommit: artifactIdentity.buildStampCommit ?? null,
    archive: args.archive ?? null,
    archiveEntryCount: archiveEntries?.length ?? null,
    errors,
    ok: errors.length === 0,
    sourceCommit,
    sourceRoot: args.sourceRoot,
  };
  const serialized = JSON.stringify(report, null, 2);
  if (args.writeReport) {
    fs.mkdirSync(path.dirname(args.writeReport), { recursive: true });
    fs.writeFileSync(args.writeReport, `${serialized}\n`);
  }
  if (args.json) {
    console.log(serialized);
  } else if (errors.length > 0) {
    console.error(errors.map((error) => `FAIL: ${error}`).join("\n"));
  } else {
    console.log("Workboard deployment contract passed.");
  }
  return report.ok ? 0 : 1;
}

process.exitCode = main();
