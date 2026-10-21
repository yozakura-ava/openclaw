import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { QUALIFICATION_LEAVES } from "./lib/qualification-leaves.mts";

const evidenceRoot = path.resolve(".artifacts/qualification");
fs.rmSync(path.join(evidenceRoot, "receipts"), { recursive: true, force: true });
fs.rmSync(path.join(evidenceRoot, "scopes"), { recursive: true, force: true });
fs.rmSync(path.join(evidenceRoot, "output-digests"), { recursive: true, force: true });
fs.rmSync(path.join(evidenceRoot, "aggregate.json"), { force: true });
const runId = randomUUID();
for (const leaf of QUALIFICATION_LEAVES) {
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
