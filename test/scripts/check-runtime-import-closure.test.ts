import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectBareImports,
  collectRuntimeImportClosureErrors,
  listRuntimeFiles,
} from "../../scripts/lib/runtime-import-closure.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const CHECK_SCRIPT = "scripts/check-runtime-import-closure.mjs";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function makeStagedRoot(extra: Record<string, string> = {}) {
  const root = tempDirs.make("openclaw-runtime-import-closure-");
  mkdirSync(path.join(root, "node_modules", "smol-toml"), { recursive: true });
  writeFileSync(
    path.join(root, "node_modules", "smol-toml", "package.json"),
    JSON.stringify({ name: "smol-toml", main: "./index.js" }),
  );
  writeFileSync(path.join(root, "node_modules", "smol-toml", "index.js"), "module.exports = {};\n");
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "openclaw", dependencies: { "smol-toml": "^1.0.0" } }),
  );
  for (const [file, source] of Object.entries(extra)) {
    writeFileSync(path.join(root, file), source);
  }
  return root;
}

function makeDist(sources: Record<string, string>) {
  const dist = tempDirs.make("openclaw-runtime-import-closure-dist-");
  for (const [file, source] of Object.entries(sources)) {
    mkdirSync(path.join(dist, path.dirname(file)), { recursive: true });
    writeFileSync(path.join(dist, file), source);
  }
  return dist;
}

function checkDist(sources: Record<string, string>, stagedRoot: string) {
  const dist = makeDist(sources);
  return spawnSync(process.execPath, [CHECK_SCRIPT, dist, "--staged-root", stagedRoot], {
    encoding: "utf8",
  });
}

describe("collectBareImports", () => {
  it("collects bare package specifiers and skips relative, node:, and builtin imports", () => {
    const sources: Record<string, string> = {
      "index.mjs": [
        "import x from 'smol-toml';",
        "import { a } from '@openclaw-workboard-contract/client';",
        "import fs from 'node:fs';",
        "import { b } from './relative.js';",
        "import path from 'path';",
        "export { c } from 'acpx/runtime';",
      ].join("\n"),
      "chunk.setup.js": "const y = require('smol-toml');",
    };
    const imports = collectBareImports({
      files: Object.keys(sources),
      readText: (file) => sources[file]!,
    });
    const specifiers = imports.map((entry) => entry.specifier).toSorted();
    expect(specifiers).toEqual([
      "@openclaw-workboard-contract/client",
      "acpx/runtime",
      "smol-toml",
      "smol-toml",
    ]);
    expect(imports.some((entry) => entry.file === "chunk.setup.js")).toBe(true);
  });

  it("skips node_modules files and non-JS files", () => {
    const sources: Record<string, string> = {
      "node_modules/pkg/index.js": "require('missing-package');",
      "data.json": '{"imports":true}',
    };
    const imports = collectBareImports({
      files: Object.keys(sources),
      readText: (file) => sources[file]!,
    });
    expect(imports).toEqual([]);
  });
});

describe("listRuntimeFiles", () => {
  it("walks nested directories and excludes node_modules", () => {
    const dist = makeDist({
      "a.js": "",
      "ext/setup/chunk.cjs": "",
      "node_modules/pkg/index.js": "",
      "notes.txt": "",
    });
    expect(listRuntimeFiles(dist)).toEqual(["a.js", "ext/setup/chunk.cjs"]);
  });
});

describe("collectRuntimeImportClosureErrors", () => {
  it("passes when every bare import resolves in the staged tree", () => {
    const stagedRoot = makeStagedRoot();
    const errors = collectRuntimeImportClosureErrors({
      files: ["index.mjs"],
      readText: () => "import { parse } from 'smol-toml';\n",
      stagedRoot,
    });
    expect(errors).toEqual([]);
  });

  it("fails with importer and specifier for absent packages (postmortem 2026-09-24 class)", () => {
    const stagedRoot = makeStagedRoot();
    const errors = collectRuntimeImportClosureErrors({
      files: ["dist/extension.setup.js"],
      readText: () => "import '@openclaw-workboard-contract/client';\n",
      stagedRoot,
    });
    expect(errors).toEqual([
      "dist/extension.setup.js imports @openclaw-workboard-contract/client: absent from the staged dependency tree",
    ]);
  });

  it("fails closed when the staged root has no node_modules", () => {
    const stagedRoot = makeStagedRoot();
    const errors = collectRuntimeImportClosureErrors({
      files: ["index.mjs"],
      readText: () => "import 'smol-toml';\n",
      stagedRoot: path.join(stagedRoot, "does-not-exist"),
    });
    expect(errors[0]).toContain("staged root has no node_modules");
  });
});

describe("check-runtime-import-closure.mjs CLI", () => {
  it("exits 0 when the closure is complete", () => {
    const stagedRoot = makeStagedRoot();
    const result = checkDist({ "index.mjs": "import 'smol-toml';\n" }, stagedRoot);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("import-closure gate passed");
  });

  it("exits 1 listing the missing package", () => {
    const stagedRoot = makeStagedRoot();
    const result = checkDist({ "index.mjs": "import 'acpx';\n" }, stagedRoot);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("index.mjs imports acpx");
  });

  it("rejects a missing dist directory", () => {
    const stagedRoot = makeStagedRoot();
    const result = spawnSync(
      process.execPath,
      [CHECK_SCRIPT, path.join(stagedRoot, "no-dist"), "--staged-root", stagedRoot],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("dist directory not found");
  });
});
