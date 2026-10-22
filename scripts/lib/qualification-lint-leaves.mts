import { createOxlintShards } from "../run-oxlint-shards.mts";

const typeAwareEnv = {
  OPENCLAW_OXLINT_SKIP_PREPARE: "1",
  OPENCLAW_CI_GOMEMLIMIT: "2GiB",
  OPENCLAW_OXLINT_SHARD_TIMEOUT_MS: String(45 * 60 * 1000),
  OPENCLAW_OXLINT_EXTENSION_CHUNK_SIZE: "1",
};
const lintOutputs = [
  ".artifacts/extension-package-boundary",
  ".artifacts/qualification/oxlint-tsconfigs",
  "packages/plugin-sdk/dist",
];
const tsx = (script: string, ...args: string[]) => [
  process.execPath,
  "--import",
  "./scripts/tsx.mjs",
  script,
  ...args,
];

// Qualification pins the resource model rather than inheriting the host's
// physical-memory view. Split the core into smaller deterministic stripes than
// the default 6-GiB check path, whose 15-minute aggregate stripe timed out.
const shards = createOxlintShards({
  cwd: process.cwd(),
  env: {
    CI: "true",
    OPENCLAW_OXLINT_SHARDS_SERIAL: "1",
    OPENCLAW_OXLINT_EXTENSION_CHUNK_SIZE: "1",
  },
  platform: "linux",
  hostResources: {
    logicalCpuCount: 2,
    totalMemoryBytes: 6 * 1024 ** 3,
    memoryCapacityBytes: 6 * 1024 ** 3,
  },
  splitCore: true,
  splitExtensions: true,
  splitScripts: true,
});
const coreStripeCount = 10;
const extensionStripeCount = shards.filter((shard) => shard.name.startsWith("extensions:")).length;
if (extensionStripeCount < 1 || !shards.some((shard) => shard.name.startsWith("scripts"))) {
  throw new Error("Qualification lint shard inventory is incomplete");
}

export const qualificationLintLeaves = [
  {
    id: "lint-i18n",
    command: tsx("scripts/control-ui-i18n-verify.ts", "verify"),
    outputs: ["ui/src"],
  },
  ...Array.from({ length: coreStripeCount }, (_, index) => {
    const stripe = index + 1;
    return {
      id: `lint-core-${stripe}`,
      command: tsx(
        "scripts/run-oxlint-shards.mts",
        "--only=core",
        "--split-core",
        `--core-stripe=${stripe}/${coreStripeCount}`,
        "--threads=1",
      ),
      outputs: lintOutputs,
      env: typeAwareEnv,
    };
  }),
  ...Array.from({ length: extensionStripeCount }, (_, index) => {
    const stripe = index + 1;
    return {
      id: `lint-extensions-${stripe}`,
      command: tsx(
        "scripts/run-oxlint-shards.mts",
        "--only=extensions",
        `--extension-stripe=${stripe}/${extensionStripeCount}`,
        "--threads=1",
      ),
      outputs: lintOutputs,
      env: typeAwareEnv,
    };
  }),
  ...shards
    .filter((shard) => shard.name.startsWith("scripts:"))
    .map((shard) => ({
      id: `lint-${shard.name.replace(":", "-")}`,
      command: tsx(
        "scripts/run-oxlint-shards.mts",
        "--only=scripts",
        "--split-scripts",
        "--files-json",
        JSON.stringify(shard.args.slice(2)),
        "--threads=1",
      ),
      outputs: lintOutputs,
      env: typeAwareEnv,
    })),
  {
    id: "lint-stylelint",
    command: tsx(
      "scripts/run-stylelint.mts",
      "ui/src/**/*.css",
      "ui/src/**/*.ts",
      "ui/public/themes/*.css",
    ),
    outputs: ["ui/src", "ui/public/themes"],
  },
];
