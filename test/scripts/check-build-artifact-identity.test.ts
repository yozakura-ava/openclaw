import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertBuildArtifactIdentity,
  readBuildArtifactIdentity,
} from "../../scripts/check-build-artifact-identity.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createFixture(uiBuildId: string, runtimeBuildId = uiBuildId): string {
  const root = tempDirs.make("openclaw-build-identity-");
  const controlUi = path.join(root, "dist/control-ui");
  fs.mkdirSync(path.join(controlUi, "assets"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "dist/build-info.json"),
    `${JSON.stringify({
      version: "2026.8.2",
      commit: "0123456789abcdef0123456789abcdef01234567",
      builtAt: "2026-07-10T12:34:56.789Z",
      buildId: runtimeBuildId,
    })}\n`,
  );
  fs.writeFileSync(
    path.join(controlUi, "sw.js"),
    `const EMBEDDED_CACHE_VERSION = "${uiBuildId}";\n`,
  );
  fs.writeFileSync(
    path.join(controlUi, "assets/control-ui-core.js"),
    `const buildInfo = { buildId: \`${uiBuildId}\` };\n`,
  );
  return root;
}

describe("build artifact identity", () => {
  it("accepts a runtime, service worker, and UI bundle with one identity", () => {
    const buildId = "2026.8.2-0123456789ab-2026-07-10T12-34-56.789Z";
    const root = createFixture(buildId);

    expect(assertBuildArtifactIdentity(root).runtime.buildId).toBe(buildId);
    expect(readBuildArtifactIdentity(root).serviceWorkerBuildId).toBe(buildId);
  });

  it("rejects a stale UI identity even when runtime build-info is newer", () => {
    const root = createFixture(
      "2026.8.2-0123456789ab-2026-07-10T11-00-00.000Z",
      "2026.8.2-0123456789ab-2026-07-10T12-34-56.789Z",
    );

    expect(() => assertBuildArtifactIdentity(root)).toThrow(/runtime\/UI build identity mismatch/u);
  });
});
