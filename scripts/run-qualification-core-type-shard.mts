import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  QUALIFICATION_CORE_TYPE_MAX_FILES_PER_SHARD,
  QUALIFICATION_CORE_TYPE_SHARD_COUNT,
  findQualificationCoreCommonDeclarationFiles,
  partitionQualificationCoreTypeFiles,
  qualificationCoreTypeConfigFiles,
} from "./lib/qualification-core-type-shards.mts";

const SHARD_COUNT = QUALIFICATION_CORE_TYPE_SHARD_COUNT;
const MAX_FILES_PER_SHARD = QUALIFICATION_CORE_TYPE_MAX_FILES_PER_SHARD;
const root = process.cwd();
const outputRoot = path.resolve(".artifacts/qualification/core-typeconfigs");
const manifestPath = path.join(outputRoot, "manifest.json");

const rawIndex = process.argv[2];
if (process.argv.length !== 3 || !rawIndex || !(rawIndex === "--plan" || /^\d+$/u.test(rawIndex))) {
  throw new Error("usage: run-qualification-core-type-shard.mts <index|--plan>");
}
const planOnly = rawIndex === "--plan";
const shardIndex = planOnly ? 0 : Number(rawIndex);
if (
  !planOnly &&
  (!Number.isSafeInteger(shardIndex) || shardIndex < 0 || shardIndex >= SHARD_COUNT)
) {
  throw new Error(`Core type shard index must be between 0 and ${SHARD_COUNT - 1}`);
}

const showConfig = spawnSync(
  process.execPath,
  ["scripts/run-tsgo.mjs", "--showConfig", "-p", "tsconfig.core.json"],
  { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
);
if (showConfig.error || showConfig.status !== 0) {
  throw showConfig.error ?? new Error(`tsgo --showConfig exited ${showConfig.status}`);
}
const resolved = JSON.parse(showConfig.stdout) as { files?: unknown };
if (!Array.isArray(resolved.files) || resolved.files.some((file) => typeof file !== "string")) {
  throw new Error("tsgo --showConfig did not return a valid core root-file inventory");
}
const roots = resolved.files as string[];
const plan = partitionQualificationCoreTypeFiles(roots, {
  shardCount: SHARD_COUNT,
  maxFilesPerShard: MAX_FILES_PER_SHARD,
  commonDeclarationFiles: findQualificationCoreCommonDeclarationFiles(roots, root),
});
const sourceDigest = createHash("sha256").update(plan.files.join("\n")).digest("hex");
const manifest = {
  version: 1,
  sourceDigest,
  sourceFiles: plan.files.length,
  shardCount: SHARD_COUNT,
  maxFilesPerShard: MAX_FILES_PER_SHARD,
  commonFiles: plan.commonFiles,
  shards: plan.shards.map((shard) => ({ index: shard.index, files: shard.files })),
};
if (planOnly) {
  process.stdout.write(
    `${JSON.stringify(
      {
        sourceFiles: plan.files.length,
        commonFiles: plan.commonFiles.length,
        shardCount: plan.shards.length,
        shardRoots: plan.shards.map((shard) => shard.files.length),
        sourceDigest,
      },
      null,
      2,
    )}\n`,
  );
  process.exit(0);
}
fs.mkdirSync(outputRoot, { recursive: true });
if (shardIndex === 0) {
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
} else {
  if (!fs.existsSync(manifestPath)) {
    throw new Error("Core type shard manifest is missing; run shard 0 first");
  }
  const previous = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as typeof manifest;
  if (JSON.stringify(previous) !== JSON.stringify(manifest)) {
    throw new Error("Core type root inventory changed during qualification");
  }
}

const shard = plan.shards[shardIndex]!;
if (shard.files.length === 0) {
  throw new Error(`Core type shard ${shardIndex} is empty`);
}
const configPath = path.join(outputRoot, `core-${String(shardIndex + 1).padStart(2, "0")}.json`);
const buildInfoPath = path.resolve(
  `.artifacts/tsgo-cache/qualification-core-${String(shardIndex + 1).padStart(2, "0")}.tsbuildinfo`,
);
fs.writeFileSync(
  configPath,
  `${JSON.stringify(
    {
      extends: path.join(root, "tsconfig.core.json"),
      compilerOptions: { rootDir: root, tsBuildInfoFile: buildInfoPath },
      files: qualificationCoreTypeConfigFiles(shard, plan.commonFiles).map((file) =>
        path.resolve(root, file),
      ),
      include: [],
    },
    null,
    2,
  )}\n`,
);
process.stdout.write(
  `[qualification:types-core] shard=${shardIndex + 1}/${SHARD_COUNT} roots=${shard.files.length} common=${plan.commonFiles.length}\n`,
);

const compiler = spawnSync(
  process.execPath,
  ["scripts/run-tsgo.mjs", "-p", configPath, "--incremental", "--tsBuildInfoFile", buildInfoPath],
  { cwd: root, stdio: "inherit" },
);
if (compiler.error) throw compiler.error;
process.exitCode = compiler.status ?? 1;
