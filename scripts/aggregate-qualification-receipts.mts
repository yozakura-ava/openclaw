import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { verifyQualificationCoreTypeShardArtifacts } from "./lib/qualification-core-type-shards.mts";
import { digestQualificationPaths } from "./lib/qualification-digest.mts";
import { QUALIFICATION_LEAVES } from "./lib/qualification-leaves.mts";

const receiptRoot = path.resolve(".artifacts/qualification/receipts");
const receiptNames = fs
  .readdirSync(receiptRoot)
  .filter((name) => name.endsWith(".json"))
  .toSorted();
const expectedNames = QUALIFICATION_LEAVES.map((leaf) => `${leaf.id}.json`).toSorted();
if (JSON.stringify(receiptNames) !== JSON.stringify(expectedNames)) {
  throw new Error("Qualification receipt inventory differs from the complete expected manifest");
}
const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (
  execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    encoding: "utf8",
  }).length !== 0
) {
  throw new Error("Qualification aggregate requires a clean worktree at the recorded SHA");
}
const lockDigest = digestQualificationPaths(["pnpm-lock.yaml"]);
const coreShardVerification = verifyQualificationCoreTypeShardArtifacts();
const runId = JSON.parse(fs.readFileSync(path.join(receiptRoot, expectedNames[0]!), "utf8")).runId;
if (typeof runId !== "string" || !/^[0-9a-f-]{36}$/u.test(runId)) {
  throw new Error("Qualification receipts do not belong to a run");
}
const toolchain = {
  nodeVersion: null as string | null,
  pnpmVersion: null as string | null,
  tsgoVersion: null as string | null,
};
const receipts = QUALIFICATION_LEAVES.map((leaf) => {
  const receipt = JSON.parse(fs.readFileSync(path.join(receiptRoot, `${leaf.id}.json`), "utf8"));
  const digestSnapshot = path.resolve(`.artifacts/qualification/output-digests/${leaf.id}.sha256`);
  const snapshotDigest = fs.existsSync(digestSnapshot)
    ? fs.readFileSync(digestSnapshot, "utf8").trim()
    : null;
  const completedAt =
    typeof receipt.completedAt === "string" ? Date.parse(receipt.completedAt) : Number.NaN;
  if (toolchain.nodeVersion === null) {
    toolchain.nodeVersion = receipt.nodeVersion;
    toolchain.pnpmVersion = receipt.pnpmVersion;
    toolchain.tsgoVersion = receipt.tsgoVersion;
  }
  if (
    receipt.version !== 1 ||
    receipt.runId !== runId ||
    receipt.id !== leaf.id ||
    receipt.sha !== sha ||
    JSON.stringify(receipt.command) !== JSON.stringify(leaf.command) ||
    JSON.stringify(receipt.environment) !== JSON.stringify(leaf.env ?? {}) ||
    receipt.exitStatus !== 0 ||
    receipt.signal !== null ||
    receipt.cleanWorktree !== true ||
    receipt.dependencyLockDigest !== lockDigest ||
    !/^[a-f0-9]{64}$/u.test(receipt.artifactDigest) ||
    snapshotDigest !== receipt.artifactDigest ||
    typeof receipt.nodeVersion !== "string" ||
    typeof receipt.pnpmVersion !== "string" ||
    typeof receipt.tsgoVersion !== "string" ||
    receipt.nodeVersion !== toolchain.nodeVersion ||
    receipt.pnpmVersion !== toolchain.pnpmVersion ||
    receipt.tsgoVersion !== toolchain.tsgoVersion ||
    !Number.isFinite(completedAt) ||
    !receipt.resourceLimits ||
    receipt.resourceLimits.memoryMaxBytes !== 6 * 1024 ** 3 ||
    receipt.resourceLimits.swapMaxBytes !== 0 ||
    receipt.resourceLimits.cpuMax !== "200000 100000" ||
    receipt.resourceLimits.oomPolicy !== "continue" ||
    !/^[0-9]+,[0-9]+$/u.test(receipt.resourceLimits.cpuAffinity)
  ) {
    throw new Error(`Invalid or failed qualification receipt: ${leaf.id}`);
  }
  return receipt;
});
const digest = createHash("sha256")
  .update(receipts.map((receipt) => JSON.stringify(receipt)).join("\n"))
  .digest("hex");
const aggregate = {
  version: 1,
  sha,
  dependencyLockDigest: lockDigest,
  toolchain,
  expectedLeaves: expectedNames.map((name) => name.slice(0, -".json".length)),
  completedLeaves: receipts.length,
  receiptsDigest: digest,
  coreTypecheck: coreShardVerification,
  status: "PASS",
};
const output = path.resolve(".artifacts/qualification/aggregate.json");
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(aggregate, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(aggregate, null, 2)}\n`);
