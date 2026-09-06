import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertRuntimeSnapshotTopology,
  inspectRuntimeSnapshotTopology,
} from "./check-runtime-snapshot-topology.mts";

const temporaryRoots: string[] = [];

function createFixture(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-runtime-topology-"));
  temporaryRoots.push(root);
  for (const [relativePath, source] of Object.entries(files)) {
    const target = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source, "utf8");
  }
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("runtime snapshot topology", () => {
  const markers = {
    config: "//#region src/config/runtime-snapshot.ts",
    secrets: "//#region src/secrets/runtime-state.ts",
    plugin: "//#region src/plugin-sdk/plugin-config-runtime.ts",
  };

  it("accepts one implementation of each runtime singleton", () => {
    const root = createFixture({
      "gateway.js": `${markers.config}\n${markers.secrets}\n${markers.plugin}`,
      "runtime-snapshot.js": "export {};",
    });
    expect(
      assertRuntimeSnapshotTopology(root).implementations["config runtime snapshot"],
    ).toHaveLength(1);
  });

  it("rejects mixed artifacts with duplicate implementations", () => {
    const root = createFixture({
      "gateway.js": `${markers.config}\n${markers.secrets}\n${markers.plugin}`,
      "telegram.js": markers.config,
    });
    expect(() => assertRuntimeSnapshotTopology(root)).toThrow(/config runtime snapshot/);
    expect(
      inspectRuntimeSnapshotTopology(root).implementations["config runtime snapshot"],
    ).toHaveLength(2);
  });
});
