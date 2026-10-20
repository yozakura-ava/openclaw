#!/usr/bin/env bash

# Build deployment artifacts as independently capped phases. Each invocation
# gets its own kernel-enforced 2-CPU/6-GiB/no-swap scope, so native bundler and
# compiler allocations cannot accumulate across completed phases.
set -euo pipefail

if [[ "${1:-}" != "runtime" || $# -ne 1 ]]; then
  echo "usage: scripts/ci-run-staged-build.sh runtime" >&2
  exit 64
fi

run_scoped() {
  scripts/ci-run-scoped-build.sh "$@"
}

run_scoped node scripts/prepare-native-protocol.mjs
run_scoped node --import ./scripts/tsx.mjs scripts/bundled-plugin-assets.mts --phase build

# ciArtifacts intentionally skips declarations for the runtime graph. Split
# the tsdown groups explicitly because the unfiltered driver admits multiple
# native bundler processes under one scope.
run_scoped env OPENCLAW_RUN_NODE_SKIP_DTS_BUILD=1 OPENCLAW_PRESERVE_CLI_STARTUP_METADATA=1 \
  node --import ./scripts/tsx.mjs scripts/tsdown-build.mts \
  --config tsdown.ai.config.ts
run_scoped env OPENCLAW_RUN_NODE_SKIP_DTS_BUILD=1 OPENCLAW_PRESERVE_CLI_STARTUP_METADATA=1 \
  node --import ./scripts/tsx.mjs scripts/tsdown-build.mts \
  --config tsdown.config.ts --filter openclaw-unified
run_scoped env OPENCLAW_RUN_NODE_SKIP_DTS_BUILD=1 OPENCLAW_PRESERVE_CLI_STARTUP_METADATA=1 \
  node --import ./scripts/tsx.mjs scripts/tsdown-build.mts \
  --config tsdown.config.ts --filter openclaw-packages

run_scoped node --import ./scripts/tsx.mjs scripts/build-external-plugin-local-dist.mts
run_scoped node --import ./scripts/tsx.mjs scripts/check-cli-bootstrap-imports.mts
run_scoped node --import ./scripts/tsx.mjs scripts/bundled-plugin-assets.mts --phase copy
run_scoped node --import ./scripts/tsx.mjs scripts/runtime-postbuild.mts
run_scoped node --import ./scripts/tsx.mjs scripts/build-stamp.mts
run_scoped node --import ./scripts/tsx.mjs scripts/runtime-postbuild-stamp.mts

run_scoped env OPENCLAW_RUN_NODE_SKIP_DTS_BUILD=0 \
  node --import ./scripts/tsx.mjs scripts/write-plugin-sdk-entry-dts.ts
run_scoped node --import ./scripts/tsx.mjs scripts/check-plugin-sdk-exports.mts
run_scoped node scripts/ui.js build
run_scoped node --import ./scripts/tsx.mjs scripts/write-build-info.ts
run_scoped node --import ./scripts/tsx.mjs scripts/write-cli-startup-metadata.ts
