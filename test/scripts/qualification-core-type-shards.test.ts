import { createHash } from "node:crypto";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertQualificationCoreTypeShardArtifacts,
  partitionQualificationCoreTypeFiles,
  qualificationCoreTypeConfigFiles,
  QUALIFICATION_CORE_TYPE_MAX_FILES_PER_SHARD,
  QUALIFICATION_CORE_TYPE_SHARD_COUNT,
} from "../../scripts/lib/qualification-core-type-shards.mts";

describe("qualification core type shards", () => {
  it("covers every compiler root once within the configured source cap", () => {
    const roots = [
      ...Array.from({ length: 7 }, (_, index) => `src/agents/worker/worker-${index}.ts`),
      ...Array.from({ length: 5 }, (_, index) => `src/gateway/methods/method-${index}.ts`),
      "src/types/runtime.d.ts",
    ];
    const plan = partitionQualificationCoreTypeFiles(roots, {
      shardCount: 3,
      maxFilesPerShard: 5,
    });
    const assigned = plan.shards.flatMap((shard) => shard.files).toSorted();
    expect(assigned).toEqual(plan.files);
    expect(plan.shards).toHaveLength(3);
    expect(plan.shards.every((shard) => shard.files.length <= 5)).toBe(true);
    expect(plan.commonFiles).toEqual(["src/types/runtime.d.ts"]);
    expect(qualificationCoreTypeConfigFiles(plan.shards[0]!, plan.commonFiles)).toContain(
      "src/types/runtime.d.ts",
    );
  });

  it("rejects duplicate or non-core roots and impossible shard budgets", () => {
    expect(() => partitionQualificationCoreTypeFiles(["src/a.ts", "./src/a.ts"])).toThrow(
      "nonempty and unique",
    );
    expect(() => partitionQualificationCoreTypeFiles(["test/a.test.ts"])).toThrow(
      "Unexpected core type root file",
    );
    expect(() =>
      partitionQualificationCoreTypeFiles(["src/a.ts", "src/b.ts"], {
        shardCount: 1,
        maxFilesPerShard: 1,
      }),
    ).toThrow("do not fit");
  });

  it("repeats ambient declaration roots without losing unique ownership", () => {
    const plan = partitionQualificationCoreTypeFiles(
      ["src/a.ts", "packages/sdk/index.ts", "src/types/globals.d.ts"],
      { shardCount: 2, maxFilesPerShard: 2 },
    );
    expect(plan.shards.flatMap((shard) => shard.files).toSorted()).toEqual(plan.files);
    for (const shard of plan.shards) {
      expect(qualificationCoreTypeConfigFiles(shard, plan.commonFiles)).toContain(
        "src/types/globals.d.ts",
      );
    }
  });

  it("validates that generated configs and the manifest match the full root inventory", () => {
    const roots = [
      ...Array.from(
        { length: QUALIFICATION_CORE_TYPE_SHARD_COUNT },
        (_, index) => `src/feature-${index}/index.ts`,
      ),
      "src/types/globals.d.ts",
      "src/shared/module-augmentation.ts",
    ];
    const plan = partitionQualificationCoreTypeFiles(roots, {
      commonDeclarationFiles: ["src/shared/module-augmentation.ts"],
    });
    const sourceDigest = createHash("sha256").update(plan.files.join("\n")).digest("hex");
    const manifest = {
      version: 1,
      sourceDigest,
      sourceFiles: plan.files.length,
      shardCount: QUALIFICATION_CORE_TYPE_SHARD_COUNT,
      maxFilesPerShard: QUALIFICATION_CORE_TYPE_MAX_FILES_PER_SHARD,
      commonFiles: plan.commonFiles,
      shards: plan.shards.map((shard) => ({ index: shard.index, files: shard.files })),
    };
    const root = "/worktree";
    const configs = plan.shards.map((shard) => {
      const suffix = String(shard.index + 1).padStart(2, "0");
      return {
        extends: path.join(root, "tsconfig.core.json"),
        compilerOptions: {
          rootDir: root,
          tsBuildInfoFile: path.resolve(
            root,
            `.artifacts/tsgo-cache/qualification-core-${suffix}.tsbuildinfo`,
          ),
        },
        files: qualificationCoreTypeConfigFiles(shard, plan.commonFiles).map((file) =>
          path.resolve(root, file),
        ),
        include: [],
      };
    });
    expect(() =>
      assertQualificationCoreTypeShardArtifacts({ manifest, plan, configs, root }),
    ).not.toThrow();
    configs[0]!.files = [];
    expect(() =>
      assertQualificationCoreTypeShardArtifacts({ manifest, plan, configs, root }),
    ).toThrow("Invalid generated core type config");
  });
});
