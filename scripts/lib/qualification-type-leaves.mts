import { QUALIFICATION_CORE_TYPE_SHARD_COUNT } from "./qualification-core-type-shards.mts";
import { TSGO_CI_GRAPHS, TSGO_ROOT_TEST_SHARDS } from "./tsgo-core-test-shards.mts";

const node = process.execPath;
const typeLeaf = (name: string, config: string) => {
  const buildInfo = `.artifacts/tsgo-cache/qualification-${name}.tsbuildinfo`;
  return {
    id: `types-${name}`,
    command: [
      node,
      "scripts/run-tsgo.mjs",
      "-p",
      config,
      "--incremental",
      "--tsBuildInfoFile",
      buildInfo,
    ],
    outputs: [buildInfo],
  };
};

export const qualificationTypeLeaves = [
  ...Array.from({ length: QUALIFICATION_CORE_TYPE_SHARD_COUNT }, (_, index) => {
    const shard = index + 1;
    const suffix = String(shard).padStart(2, "0");
    return {
      id: `types-core-${suffix}`,
      command: [
        node,
        "--import",
        "./scripts/tsx.mjs",
        "scripts/run-qualification-core-type-shard.mts",
        String(index),
      ],
      outputs: [
        `.artifacts/qualification/core-typeconfigs/core-${suffix}.json`,
        `.artifacts/tsgo-cache/qualification-core-${suffix}.tsbuildinfo`,
      ],
    };
  }),
  ...TSGO_CI_GRAPHS.filter((graph) => graph.name !== "core" && graph.name !== "test-root").map(
    (graph) => typeLeaf(graph.name, graph.config),
  ),
  ...TSGO_ROOT_TEST_SHARDS.map((graph) => typeLeaf(graph.name, graph.config)),
];

const expectedTypeLeafCount =
  QUALIFICATION_CORE_TYPE_SHARD_COUNT + TSGO_CI_GRAPHS.length - 2 + TSGO_ROOT_TEST_SHARDS.length;
if (qualificationTypeLeaves.length !== expectedTypeLeafCount) {
  throw new Error(
    `Expected ${expectedTypeLeafCount} compiler type leaves, found ${qualificationTypeLeaves.length}`,
  );
}
