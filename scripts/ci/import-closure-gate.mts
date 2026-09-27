#!/usr/bin/env node
// Validate runtime imports in generated deploy output against the staged
// production dependency tree. This is intentionally a small CLI wrapper for
// the deploy workflow; source-side closure analysis remains in scripts/lib.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { argv, exit } from "node:process";

type ImportDecl =
  | { kind: "bare"; spec: string; packageName: string }
  | { kind: "relative"; spec: string };

const IMPORT_RE =
  /(?:^|[^\w$])(?:import\s*(?:[^"'`]+?\s+from\s*)?|export\s+(?:[^"'`]+?\s+from\s*)|import\s*\(\s*)["']([^"']+)["']/gmu;
const RELATIVE_PREFIX = /^\.{1,2}(\/|$)/;

function parseArgs(args: string[]) {
  let dist = "";
  let nodeModules = "";
  let out = "import-closure-report.txt";
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--dist" || arg === "-d") dist = args[++i] ?? "";
    else if (arg === "--node-modules" || arg === "-n") nodeModules = args[++i] ?? "";
    else if (arg === "--out" || arg === "-o") out = args[++i] ?? out;
  }
  if (!dist || !nodeModules) {
    console.error("[import-closure-gate] --dist and --node-modules are required");
    exit(2);
  }
  return { dist: resolve(dist), nodeModules: resolve(nodeModules), out };
}

function walkGenerated(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  for (const name of readdirSync(root)) {
    const file = join(root, name);
    let stat;
    try {
      stat = statSync(file);
    } catch {
      continue;
    }
    if (stat.isDirectory()) files.push(...walkGenerated(file));
    else if (extname(name) === ".mjs" || name.endsWith(".setup")) files.push(file);
  }
  return files;
}

function parseImport(spec: string): ImportDecl {
  if (RELATIVE_PREFIX.test(spec) || isAbsolute(spec)) return { kind: "relative", spec };
  const parts = spec.split("/");
  return {
    kind: "bare",
    spec,
    packageName: spec.startsWith("@") ? `${parts[0]}/${parts[1] ?? ""}` : (parts[0] ?? ""),
  };
}

function main(): number {
  const { dist, nodeModules, out } = parseArgs(argv.slice(2));
  const files = [
    ...walkGenerated(join(dist, "extensions")),
    ...walkGenerated(join(dist, "runtime")),
  ];
  const failures: string[] = [];
  const missing = new Set<string>();
  let imports = 0;
  let bare = 0;
  let relativeImports = 0;

  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const lineText = text.split("\n");
    for (const match of text.matchAll(IMPORT_RE)) {
      const spec = match[1];
      if (!spec) continue;
      if (spec.startsWith("node:")) continue;
      imports++;
      const decl = parseImport(spec);
      const line = text.slice(0, match.index ?? 0).split("\n").length;
      if (decl.kind === "relative") {
        relativeImports++;
        const target = isAbsolute(decl.spec) ? decl.spec : resolve(file, "..", decl.spec);
        if (!target.startsWith(`${dist}${sep}`) && target !== dist) {
          failures.push(
            `FAIL ${relative(dist, file)}:${line} relative import escaping dist/ root | spec=${spec}`,
          );
        }
      } else {
        bare++;
        if (!existsSync(join(nodeModules, decl.packageName))) {
          missing.add(decl.packageName);
          failures.push(
            `FAIL ${relative(dist, file)}:${line} package not in staged node_modules: ${decl.packageName} | spec=${spec}`,
          );
        }
      }
    }
  }

  const report = [
    ...[...missing].toSorted().map((pkg) => `MISSING_PACKAGE ${pkg}`),
    `SUMMARY files=${files.length} imports=${imports} bare=${bare} relative=${relativeImports} failures=${failures.length}`,
    ...failures,
  ];
  if (files.length === 0)
    report.push("WARN no .setup/.mjs files found under dist/extensions or dist/runtime");
  console.log(report.join("\n"));
  const outputDir = resolve(out, "..");
  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
  writeFileSync(out, `${report.join("\n")}\n`);
  return failures.length === 0 ? 0 : 1;
}

process.exit(main());
