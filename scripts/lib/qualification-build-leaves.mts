import { BOUNDARY_PLUGIN_UNITS } from "./extension-boundary-inputs.mts";
import { TSDOWN_PACKAGE_OUTPUT_ROOTS } from "./tsdown-output-roots.mts";

const node = (script: string, ...args: string[]) => [process.execPath, script, ...args];
const tsx = (script: string, ...args: string[]) => [
  process.execPath,
  "--import",
  "./scripts/tsx.mjs",
  script,
  ...args,
];
const outputs = ["dist", "dist-runtime", "packages"];
const build = (id: string, command: string[], out = outputs, env?: NodeJS.ProcessEnv) => ({
  id,
  command,
  outputs: out,
  ...(env ? { env } : {}),
});

export const qualificationBuildLeaves = [
  build("build-native-protocol", node("scripts/prepare-native-protocol.mjs"), [
    "apps/shared/OpenClawKit/.build/protocol",
    "apps/android/app/build/generated/openclaw-protocol",
  ]),
  build("build-plugin-assets", tsx("scripts/bundled-plugin-assets.mts", "--phase", "build"), [
    "extensions",
  ]),
  build(
    "build-tsdown-ai-runtime",
    tsx("scripts/tsdown-build.mts", "--config", "tsdown.ai.config.ts"),
    ["packages/ai/dist"],
    { OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "1" },
  ),
  build(
    "build-tsdown-ai-declarations",
    tsx("scripts/tsdown-build.mts", "--config", "tsdown.ai.config.ts"),
    ["packages/ai/dist"],
    { OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "0" },
  ),
  build(
    "build-tsdown-unified-runtime",
    tsx(
      "scripts/tsdown-build.mts",
      "--config",
      "tsdown.config.ts",
      "--filter",
      "openclaw-unified",
      "--concurrency",
      "1",
    ),
    ["dist"],
    { OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "1", OPENCLAW_PRESERVE_CLI_STARTUP_METADATA: "1" },
  ),
  build(
    "build-tsdown-packages-runtime",
    tsx(
      "scripts/tsdown-build.mts",
      "--config",
      "tsdown.config.ts",
      "--filter",
      "openclaw-packages",
    ),
    TSDOWN_PACKAGE_OUTPUT_ROOTS,
    { OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "1" },
  ),
  build(
    "build-tsdown-packages-declarations",
    tsx(
      "scripts/tsdown-build.mts",
      "--config",
      "tsdown.config.ts",
      "--filter",
      "openclaw-packages",
    ),
    TSDOWN_PACKAGE_OUTPUT_ROOTS,
    { OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "0" },
  ),
  // The canonical build writes unified declarations before external plugin
  // output, postbuild, and stamps; preserve that ordering in the leaf graph.
  build("build-main-declarations", tsx("scripts/write-unified-entry-dts.ts"), ["dist"]),
  build("build-external-plugin-dist", tsx("scripts/build-external-plugin-local-dist.mts"), [
    "extensions",
  ]),
  build("build-cli-bootstrap-check", tsx("scripts/check-cli-bootstrap-imports.mts"), ["dist"]),
  build("build-copy-plugin-assets", tsx("scripts/bundled-plugin-assets.mts", "--phase", "copy"), [
    "dist",
  ]),
  build("build-runtime-postbuild", tsx("scripts/runtime-postbuild.mts"), ["dist", "dist-runtime"]),
  build("build-stamp", tsx("scripts/build-stamp.mts"), ["dist"]),
  build("build-runtime-postbuild-stamp", tsx("scripts/runtime-postbuild-stamp.mts"), ["dist"]),
  build(
    "build-plugin-sdk-declarations",
    tsx("scripts/write-plugin-sdk-entry-dts.ts"),
    ["dist/plugin-sdk"],
    { OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB: "4608" },
  ),
  build("build-plugin-sdk-exports", tsx("scripts/check-plugin-sdk-exports.mts"), [
    "dist/plugin-sdk",
  ]),
  build(
    "boundary-plugin-sdk",
    tsx("scripts/prepare-extension-package-boundary-artifacts.mts", "--unit=plugin-sdk"),
    ["packages/plugin-sdk/dist"],
    { OPENCLAW_PLUGIN_SDK_BOUNDARY_ROOT_SHIMS_TIMEOUT_MS: "900000" },
  ),
  ...BOUNDARY_PLUGIN_UNITS.map(([id]) =>
    build(
      `boundary-${id}`,
      tsx("scripts/prepare-extension-package-boundary-artifacts.mts", `--unit=${id}`),
      [`.artifacts/extension-package-boundary/plugins/${id}`, "packages/plugin-sdk/dist"],
    ),
  ),
  build("build-ui", node("scripts/ui.js", "build"), ["dist/control-ui"]),
  build("build-info", tsx("scripts/write-build-info.ts"), ["dist"]),
  build("build-cli-startup-metadata", tsx("scripts/write-cli-startup-metadata.ts"), ["dist"]),
  build("format-check", ["pnpm", "format:check"], [".artifacts"]),
  build("create-package", node("scripts/qualification-pack.mjs"), [
    ".artifacts/qualification/package",
  ]),
  build("install-smoke", node("scripts/qualification-install-smoke.mjs"), [
    ".artifacts/qualification/install",
  ]),
];
