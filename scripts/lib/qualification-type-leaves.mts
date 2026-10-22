import { QUALIFICATION_CORE_TYPE_SHARD_COUNT } from "./qualification-core-type-shards.mts";
import { TSGO_CI_GRAPHS, TSGO_ROOT_TEST_SHARDS } from "./tsgo-core-test-shards.mts";

const node = process.execPath;
const configTypeShard = (
  name: string,
  config: string,
  count: number,
  maxRoots: number,
  idPrefix = `types-${name}`,
) =>
  Array.from({ length: count }, (_, index) => {
    const suffix = String(index + 1).padStart(2, "0");
    return {
      id: `${idPrefix}-${suffix}`,
      command: [
        node,
        "--import",
        "./scripts/tsx.mjs",
        "scripts/run-qualification-config-type-shard.mts",
        name,
        config,
        String(index),
        String(count),
        String(maxRoots),
      ],
      outputs: [
        `.artifacts/qualification/config-typeconfigs/${name}/${name}-${suffix}.json`,
        `.artifacts/tsgo-cache/qualification-${name}-${suffix}.tsbuildinfo`,
      ],
    };
  });
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
  ...TSGO_CI_GRAPHS.filter(
    (graph) =>
      graph.name !== "core" &&
      graph.name !== "test-root" &&
      graph.name !== "extensions" &&
      graph.name !== "core-test-gateway-root" &&
      graph.name !== "core-test-gateway-server" &&
      graph.name !== "extensions-test",
  ).map((graph) => typeLeaf(graph.name, graph.config)),
  ...configTypeShard("extensions", "tsconfig.extensions.json", 20, 300),
  ...configTypeShard("extensions-test", "test/tsconfig/tsconfig.extensions.test.json", 14, 300),
  ...configTypeShard(
    "gateway-root",
    "test/tsconfig/tsconfig.core.test.gateway-root.json",
    6,
    120,
    "types-core-test-gateway-root",
  ),
  ...configTypeShard(
    "gateway-server",
    "test/tsconfig/tsconfig.core.test.gateway-server.json",
    10,
    60,
    "types-core-test-gateway-server",
  ),
  ...TSGO_ROOT_TEST_SHARDS.map((graph) => typeLeaf(graph.name, graph.config)),
];

const expectedTypeLeafCount =
  QUALIFICATION_CORE_TYPE_SHARD_COUNT +
  TSGO_CI_GRAPHS.length -
  6 +
  20 +
  14 +
  TSGO_ROOT_TEST_SHARDS.length +
  6 +
  10;
if (qualificationTypeLeaves.length !== expectedTypeLeafCount) {
  throw new Error(
    `Expected ${expectedTypeLeafCount} compiler type leaves, found ${qualificationTypeLeaves.length}`,
  );
}
