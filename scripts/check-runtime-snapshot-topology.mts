#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

export const RUNTIME_SINGLETON_IMPLEMENTATIONS = [
  {
    id: "config runtime snapshot",
    marker: "//#region src/config/runtime-snapshot.ts",
  },
  {
    id: "secrets runtime state",
    marker: "//#region src/secrets/runtime-state.ts",
  },
  {
    id: "plugin config runtime",
    marker: "//#region src/plugin-sdk/plugin-config-runtime.ts",
  },
] as const;

type RuntimeSnapshotTopology = {
  root: string;
  implementations: Record<string, string[]>;
};

function walkJavaScriptFiles(root: string): string[] {
  const files: string[] = [];
  const visited = new Set<string>();
  const walk = (directory: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(target);
        continue;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) {
        continue;
      }
      if (!/\.(?:c|m)?js$/u.test(entry.name)) {
        continue;
      }
      let realTarget: string;
      try {
        realTarget = fs.realpathSync(target);
      } catch {
        continue;
      }
      if (visited.has(realTarget)) {
        continue;
      }
      visited.add(realTarget);
      files.push(target);
    }
  };
  walk(root);
  return files.toSorted();
}

export function inspectRuntimeSnapshotTopology(root: string): RuntimeSnapshotTopology {
  const implementations: Record<string, string[]> = {};
  for (const definition of RUNTIME_SINGLETON_IMPLEMENTATIONS) {
    implementations[definition.id] = [];
  }
  for (const file of walkJavaScriptFiles(root)) {
    let source: string;
    try {
      source = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const definition of RUNTIME_SINGLETON_IMPLEMENTATIONS) {
      if (source.includes(definition.marker)) {
        implementations[definition.id]?.push(path.relative(root, file));
      }
    }
  }
  return { root, implementations };
}

export function assertRuntimeSnapshotTopology(root: string): RuntimeSnapshotTopology {
  const result = inspectRuntimeSnapshotTopology(root);
  const failures = RUNTIME_SINGLETON_IMPLEMENTATIONS.flatMap((definition) => {
    const files = result.implementations[definition.id] ?? [];
    return files.length === 1
      ? []
      : [
          `${definition.id}: expected exactly one implementation, found ${files.length} (${files.join(", ") || "none"})`,
        ];
  });
  if (failures.length > 0) {
    throw new Error(`runtime snapshot topology check failed for ${root}\n${failures.join("\n")}`);
  }
  return result;
}

function readRoot(argv: string[]): string {
  const index = argv.findIndex((arg) => arg === "--root");
  if (index >= 0) {
    const value = argv[index + 1];
    if (!value || value.startsWith("-")) {
      throw new Error("--root requires a build output directory");
    }
    return path.resolve(value);
  }
  const equals = argv.find((arg) => arg.startsWith("--root="));
  return path.resolve(equals ? equals.slice("--root=".length) : "dist");
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("check-runtime-snapshot-topology.mts")
) {
  assertRuntimeSnapshotTopology(readRoot(process.argv.slice(2)));
}
