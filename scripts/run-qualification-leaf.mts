// Executes one build or compiler leaf under the enforced Linux resource envelope.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { digestQualificationPaths } from "./lib/qualification-digest.mts";
import { QUALIFICATION_LEAVES } from "./lib/qualification-leaves.mts";

async function run(command: string[], env: NodeJS.ProcessEnv) {
  return await new Promise<{ exitCode: number; signal: string | null }>((resolve, reject) => {
    const child = spawn(command[0]!, command.slice(1), { env, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code, signal) =>
      resolve({ exitCode: code ?? (signal ? 128 : 1), signal }),
    );
  });
}

function parseLeafId(argv: string[]) {
  if (argv.length !== 1 || !/^[a-z0-9][a-z0-9-]+$/u.test(argv[0]!)) {
    throw new Error("usage: node --import tsx scripts/run-qualification-leaf.mts <leaf-id>");
  }
  const leaf = QUALIFICATION_LEAVES.find((candidate) => candidate.id === argv[0]);
  if (!leaf) throw new Error(`Unknown qualification leaf: ${argv[0]}`);
  return leaf;
}

const leaf = parseLeafId(process.argv.slice(2));
const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const cleanAtStart =
  execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    encoding: "utf8",
  }).length === 0;
const pnpmVersion = execFileSync("pnpm", ["--version"], { encoding: "utf8" }).trim();
const tsgoVersion = JSON.parse(
  fs.readFileSync("node_modules/typescript/package.json", "utf8"),
).version;
const scopeFile = path.resolve(`.artifacts/qualification/scopes/${leaf.id}.json`);
fs.mkdirSync(path.dirname(scopeFile), { recursive: true });
fs.rmSync(scopeFile, { force: true });
const result = await run(["scripts/ci-run-scoped-build.sh", ...leaf.command], {
  ...process.env,
  ...leaf.env,
  OPENCLAW_CI_OOM_POLICY: "continue",
  OPENCLAW_QUALIFICATION_SCOPE_FILE: scopeFile,
});
const cleanAtCompletion =
  execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    encoding: "utf8",
  }).length === 0;
const scope = fs.existsSync(scopeFile) ? JSON.parse(fs.readFileSync(scopeFile, "utf8")) : null;
const receipt = {
  version: 1,
  runId: process.env.OPENCLAW_QUALIFICATION_RUN_ID ?? null,
  id: leaf.id,
  sha,
  command: leaf.command,
  environment: leaf.env ?? {},
  resourceLimits: scope,
  exitStatus: result.exitCode,
  signal: result.signal,
  artifactDigest: digestQualificationPaths(leaf.outputs),
  dependencyLockDigest: digestQualificationPaths(["pnpm-lock.yaml"]),
  nodeVersion: process.version,
  pnpmVersion,
  tsgoVersion,
  cleanWorktree: cleanAtStart && cleanAtCompletion,
  completedAt: new Date().toISOString(),
};
const digestSnapshot = path.resolve(`.artifacts/qualification/output-digests/${leaf.id}.sha256`);
fs.mkdirSync(path.dirname(digestSnapshot), { recursive: true });
fs.writeFileSync(digestSnapshot, `${receipt.artifactDigest}\n`, { flag: "wx" });
const receiptPath = path.resolve(`.artifacts/qualification/receipts/${leaf.id}.json`);
fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
if (result.exitCode !== 0 || !scope || leaf.outputs.some((item) => !fs.existsSync(item))) {
  process.exitCode = result.exitCode || 1;
}
