import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { selectQualificationGroup } from "./lib/qualification-groups.mts";
import { QUALIFICATION_LEAVES } from "./lib/qualification-leaves.mts";

const evidenceRoot = path.resolve(".artifacts/qualification");
const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && !args[0]!.startsWith("--group="))) {
  throw new Error("usage: node scripts/run-qualification-gate.mts [--group=<qualification-group>]");
}
const groupArgument = args[0];
const group = groupArgument?.slice("--group=".length);
if (groupArgument !== undefined && !group) {
  throw new Error("qualification group name must not be empty");
}
const leaves = group ? selectQualificationGroup(group) : QUALIFICATION_LEAVES;
fs.rmSync(path.join(evidenceRoot, "receipts"), { recursive: true, force: true });
fs.rmSync(path.join(evidenceRoot, "scopes"), { recursive: true, force: true });
fs.rmSync(path.join(evidenceRoot, "output-digests"), { recursive: true, force: true });
fs.rmSync(path.join(evidenceRoot, "aggregate.json"), { force: true });
const runId = process.env.OPENCLAW_QUALIFICATION_RUN_ID ?? randomUUID();
for (const leaf of leaves) {
  process.stdout.write(`[qualification] ${leaf.id} (${leaf.command.join(" ")})\n`);
  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "./scripts/tsx.mjs", "scripts/run-qualification-leaf.mts", leaf.id],
      { stdio: "inherit", env: { ...process.env, OPENCLAW_QUALIFICATION_RUN_ID: runId } },
    );
    child.once("error", reject);
    child.once("close", (status, signal) => resolve(status ?? (signal ? 1 : 0)));
  });
  if (code !== 0) {
    throw new Error(`Qualification stopped at ${leaf.id} with exit ${code}`);
  }
}
