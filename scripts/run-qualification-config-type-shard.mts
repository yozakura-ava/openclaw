import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [name, config, rawIndex, rawCount, rawLimit] = process.argv.slice(2);
if (
  process.argv.length !== 7 ||
  !name ||
  !config ||
  !/^\d+$/u.test(rawIndex ?? "") ||
  !/^\d+$/u.test(rawCount ?? "") ||
  !/^\d+$/u.test(rawLimit ?? "")
) {
  throw new Error(
    "usage: run-qualification-config-type-shard.mts <name> <config> <index> <count> <max-roots>",
  );
}

const index = Number(rawIndex);
const count = Number(rawCount);
const maxRoots = Number(rawLimit);
if (!Number.isSafeInteger(index) || !Number.isSafeInteger(count) || index < 0 || index >= count) {
  throw new Error("Type shard index must be within the configured shard count");
}
if (!Number.isSafeInteger(maxRoots) || maxRoots < 1) {
  throw new Error("Type shard root limit must be positive");
}

const root = process.cwd();
const showConfig = spawnSync(
  process.execPath,
  ["scripts/run-tsgo.mjs", "--showConfig", "-p", config],
  { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
);
if (showConfig.error || showConfig.status !== 0) {
  throw showConfig.error ?? new Error(`tsgo --showConfig exited ${showConfig.status}`);
}
const resolved = JSON.parse(showConfig.stdout) as { files?: unknown };
if (!Array.isArray(resolved.files) || resolved.files.some((file) => typeof file !== "string")) {
  throw new Error(`tsgo --showConfig returned an invalid root inventory for ${config}`);
}
const configDirectory = path.dirname(path.resolve(root, config));
const files = (resolved.files as string[])
  .map((file) =>
    path.isAbsolute(file) ? path.normalize(file) : path.resolve(configDirectory, file),
  )
  .toSorted();
if (files.length === 0 || new Set(files).size !== files.length) {
  throw new Error(`Type roots for ${config} must be nonempty and unique`);
}
const commonFiles = files.filter((file) => {
  if (/\.d\.(?:ts|mts|cts)$/u.test(file)) return true;
  const source = fs.readFileSync(file, "utf8");
  return /\bdeclare\s+(?:global|module|namespace)\b/u.test(source);
});
const commonFileSet = new Set(commonFiles);
const sources = files.filter((file) => !commonFileSet.has(file));
const sourceChunks: string[][] = [];
for (let offset = 0; offset < sources.length; offset += maxRoots) {
  sourceChunks.push(sources.slice(offset, offset + maxRoots));
}
const shards = sourceChunks.length > 0 ? sourceChunks : [commonFiles];
if (shards.length !== count || shards.some((shard) => shard.length > maxRoots)) {
  throw new Error(
    `Expected ${count} nonempty shards capped at ${maxRoots} roots for ${config}; found ${shards.length}`,
  );
}

const suffix = String(index + 1).padStart(2, "0");
const outputRoot = path.resolve(".artifacts/qualification/config-typeconfigs", name);
const configPath = path.join(outputRoot, `${name}-${suffix}.json`);
const buildInfoPath = path.resolve(
  `.artifacts/tsgo-cache/qualification-${name}-${suffix}.tsbuildinfo`,
);
fs.mkdirSync(outputRoot, { recursive: true });
fs.writeFileSync(
  configPath,
  `${JSON.stringify(
    {
      extends: path.resolve(root, config),
      compilerOptions: { rootDir: root, tsBuildInfoFile: buildInfoPath, incremental: true },
      files: [...new Set([...commonFiles, ...shards[index]!])].toSorted(),
      include: [],
    },
    null,
    2,
  )}\n`,
);
process.stdout.write(
  `[qualification:${name}] shard=${index + 1}/${count} roots=${shards[index]!.length} commonDeclarations=${commonFiles.length}\n`,
);

const compiler = spawnSync(
  process.execPath,
  ["scripts/run-tsgo.mjs", "-p", configPath, "--incremental", "--tsBuildInfoFile", buildInfoPath],
  { cwd: root, stdio: "inherit" },
);
if (compiler.error) throw compiler.error;
process.exitCode = compiler.status ?? 1;
