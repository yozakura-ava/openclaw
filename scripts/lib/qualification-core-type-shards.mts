import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type QualificationCoreTypeShard = {
  index: number;
  files: string[];
};

const CORE_SOURCE_PREFIXES = ["src/", "packages/"] as const;
export const QUALIFICATION_CORE_TYPE_SHARD_COUNT = 40;
export const QUALIFICATION_CORE_TYPE_MAX_FILES_PER_SHARD = 500;

export function findQualificationCoreCommonDeclarationFiles(
  files: readonly string[],
  root = process.cwd(),
): string[] {
  return files.filter((file) => {
    const source = fs.readFileSync(path.resolve(root, file), "utf8");
    return /\bdeclare\s+(?:global|module|namespace)\b/u.test(source);
  });
}

function normalizeCoreTypeFile(file: string): string {
  const normalized = file.replaceAll("\\", "/").replace(/^\.\//u, "");
  if (!CORE_SOURCE_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    throw new Error(`Unexpected core type root file: ${file}`);
  }
  return normalized;
}

function splitDirectoryGroups(files: string[], maxFilesPerShard: number): string[][] {
  const split = (items: string[], segmentIndex: number): string[][] => {
    if (items.length <= maxFilesPerShard) {
      return [items.toSorted()];
    }
    const bySegment = new Map<string, string[]>();
    for (const file of items) {
      const segment = file.split("/")[segmentIndex];
      const key = segment ?? file;
      const group = bySegment.get(key) ?? [];
      group.push(file);
      bySegment.set(key, group);
    }
    if (bySegment.size === 1) {
      const sorted = items.toSorted();
      const chunks: string[][] = [];
      for (let offset = 0; offset < sorted.length; offset += maxFilesPerShard) {
        chunks.push(sorted.slice(offset, offset + maxFilesPerShard));
      }
      return chunks;
    }
    return [...bySegment.values()].flatMap((group) =>
      group.length > maxFilesPerShard ? split(group, segmentIndex + 1) : [group.toSorted()],
    );
  };

  const byModule = new Map<string, string[]>();
  for (const file of files) {
    const moduleRoot = file.split("/").slice(0, 2).join("/");
    const group = byModule.get(moduleRoot) ?? [];
    group.push(file);
    byModule.set(moduleRoot, group);
  }
  return [...byModule.values()].flatMap((group) =>
    group.length > maxFilesPerShard ? split(group, 2) : [group.toSorted()],
  );
}

/**
 * Assign every root source exactly once to a bounded shard while keeping
 * directory-local files together where possible. Ambient declarations are
 * repeated in every compiler program so module/global augmentation semantics
 * do not depend on the shard that owns the declaration.
 */
export function partitionQualificationCoreTypeFiles(
  inputFiles: readonly string[],
  options: {
    shardCount?: number;
    maxFilesPerShard?: number;
    commonDeclarationFiles?: readonly string[];
  } = {},
): { files: string[]; commonFiles: string[]; shards: QualificationCoreTypeShard[] } {
  const shardCount = options.shardCount ?? QUALIFICATION_CORE_TYPE_SHARD_COUNT;
  const maxFilesPerShard = options.maxFilesPerShard ?? QUALIFICATION_CORE_TYPE_MAX_FILES_PER_SHARD;
  if (!Number.isSafeInteger(shardCount) || shardCount < 1) {
    throw new Error("Core type shard count must be a positive integer");
  }
  if (!Number.isSafeInteger(maxFilesPerShard) || maxFilesPerShard < 1) {
    throw new Error("Core type shard file limit must be a positive integer");
  }

  const files = inputFiles.map(normalizeCoreTypeFile).toSorted();
  if (files.length === 0 || new Set(files).size !== files.length) {
    throw new Error("Core type roots must be nonempty and unique");
  }
  const commonFiles = [
    ...new Set([
      ...files.filter((file) => /\.d\.(?:ts|mts|cts)$/u.test(file)),
      ...(options.commonDeclarationFiles ?? []).map(normalizeCoreTypeFile),
    ]),
  ].toSorted();
  if (commonFiles.some((file) => !files.includes(file))) {
    throw new Error("Common declaration roots must belong to the core root inventory");
  }
  const groups = splitDirectoryGroups(files, maxFilesPerShard).toSorted(
    (left, right) => right.length - left.length || left[0]!.localeCompare(right[0]!),
  );
  const shards: QualificationCoreTypeShard[] = Array.from({ length: shardCount }, (_, index) => ({
    index,
    files: [],
  }));
  const sizes = Array.from({ length: shardCount }, () => 0);
  for (const group of groups) {
    const shardIndex = sizes
      .map((size, index) => ({ size, index }))
      .filter(({ size }) => size + group.length <= maxFilesPerShard)
      .toSorted((left, right) => left.size - right.size || left.index - right.index)[0]?.index;
    if (shardIndex === undefined) {
      throw new Error(
        `Core type roots do not fit ${shardCount} shards capped at ${maxFilesPerShard} files`,
      );
    }
    shards[shardIndex]!.files.push(...group);
    sizes[shardIndex]! += group.length;
  }
  for (const shard of shards) {
    shard.files.sort();
  }

  const ownedFiles = shards.flatMap((shard) => shard.files).toSorted();
  if (
    JSON.stringify(ownedFiles) !== JSON.stringify(files) ||
    shards.some((shard) => shard.files.length > maxFilesPerShard)
  ) {
    throw new Error("Core type shard assignment does not exactly cover the root inventory");
  }
  return { files, commonFiles, shards };
}

export function qualificationCoreTypeConfigFiles(
  shard: QualificationCoreTypeShard,
  commonFiles: readonly string[],
): string[] {
  return [...new Set([...commonFiles, ...shard.files])].toSorted();
}

export function assertQualificationCoreTypeShardArtifacts(args: {
  manifest: unknown;
  plan: ReturnType<typeof partitionQualificationCoreTypeFiles>;
  configs: readonly unknown[];
  root?: string;
}): void {
  const root = args.root ?? process.cwd();
  const sourceDigest = createHash("sha256").update(args.plan.files.join("\n")).digest("hex");
  const expectedManifest = {
    version: 1,
    sourceDigest,
    sourceFiles: args.plan.files.length,
    shardCount: QUALIFICATION_CORE_TYPE_SHARD_COUNT,
    maxFilesPerShard: QUALIFICATION_CORE_TYPE_MAX_FILES_PER_SHARD,
    commonFiles: args.plan.commonFiles,
    shards: args.plan.shards.map((shard) => ({ index: shard.index, files: shard.files })),
  };
  if (JSON.stringify(args.manifest) !== JSON.stringify(expectedManifest)) {
    throw new Error("Core type shard manifest does not exactly cover the compiler root inventory");
  }
  if (args.configs.length !== args.plan.shards.length) {
    throw new Error("Core type shard config inventory is incomplete");
  }
  for (const shard of args.plan.shards) {
    const suffix = String(shard.index + 1).padStart(2, "0");
    const config = args.configs[shard.index] as
      | {
          extends?: unknown;
          compilerOptions?: { rootDir?: unknown; tsBuildInfoFile?: unknown };
          files?: unknown;
          include?: unknown;
        }
      | undefined;
    const expectedFiles = qualificationCoreTypeConfigFiles(shard, args.plan.commonFiles)
      .map((file) => path.resolve(root, file))
      .toSorted();
    const expectedBuildInfo = path.resolve(
      root,
      `.artifacts/tsgo-cache/qualification-core-${suffix}.tsbuildinfo`,
    );
    if (
      !config ||
      config.extends !== path.join(root, "tsconfig.core.json") ||
      config.compilerOptions?.rootDir !== root ||
      config.compilerOptions.tsBuildInfoFile !== expectedBuildInfo ||
      JSON.stringify(config.files) !== JSON.stringify(expectedFiles) ||
      JSON.stringify(config.include) !== "[]"
    ) {
      throw new Error(`Invalid generated core type config for shard ${suffix}`);
    }
  }
}

export function verifyQualificationCoreTypeShardArtifacts(root = process.cwd()) {
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
    throw new Error("Could not resolve the compiler's complete core root-file inventory");
  }
  const roots = resolved.files as string[];
  const plan = partitionQualificationCoreTypeFiles(roots, {
    commonDeclarationFiles: findQualificationCoreCommonDeclarationFiles(roots, root),
  });
  const configRoot = path.resolve(root, ".artifacts/qualification/core-typeconfigs");
  const manifest = JSON.parse(fs.readFileSync(path.join(configRoot, "manifest.json"), "utf8"));
  const configs = Array.from({ length: QUALIFICATION_CORE_TYPE_SHARD_COUNT }, (_, index) =>
    JSON.parse(
      fs.readFileSync(
        path.join(configRoot, `core-${String(index + 1).padStart(2, "0")}.json`),
        "utf8",
      ),
    ),
  );
  assertQualificationCoreTypeShardArtifacts({ manifest, plan, configs, root });
  return {
    sourceFiles: plan.files.length,
    commonFiles: plan.commonFiles.length,
    shardCount: plan.shards.length,
    shardRootCounts: plan.shards.map((shard) => shard.files.length),
    sourceDigest: createHash("sha256").update(plan.files.join("\n")).digest("hex"),
  };
}
