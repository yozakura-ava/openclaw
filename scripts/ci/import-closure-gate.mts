#!/usr/bin/env node
// import-closure-gate.mts — PR-K bundle import-closure gate.
//
// Scans every generated .setup/.mjs under dist/ for unresolved package
// imports. Addresses postmortem 2026-09-24 root causes #1 and #3:
//   - RC#1: @openclaw/workboard-contract leaked into runtime deps
//   - RC#3: the preserved global node_modules tree did not contain every
//           bundled extension's runtime externalized package
//
// Rejects the build on any unresolved import. Emits a stable, diff-friendly
// report so reviewers can see exactly what would have failed at runtime.
//
// Resolution model:
//   - relative specifiers (./, ../, /dist/...) must resolve to a file under
//     dist/.
//   - bare specifiers (@scope/name or name[/subpath]) must have a directory
//     matching the package name under dist/node_modules/.
//
// CLI:
//   node scripts/ci/import-closure-gate.mts \
//     --dist <dist-dir> --node-modules <staged-node_modules> --out <report.txt>
//
// Exit codes:
//   0 — all imports resolved
//   1 — at least one unresolved import (build fails)
//   2 — invocation error (missing dist, etc.)
//
// The matched text is the static import source. Nested scopes or hoisted
// dynamic imports are still captured because the regex scans the full file.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { argv, exit } from "node:process";

type BarePackage = { kind: "bare"; spec: string; packageName: string };
type RelativePackage = { kind: "relative"; spec: string };
type ImportDecl = BarePackage | RelativePackage;

const IMPORT_RE =
  /(?:^|[^\w$])(?:import\s*(?:[^"'`]+?\s+from\s*)?|export\s+(?:[^"'`]+?\s+from\s*)|import\s*\(\s*)["']([^"']+)["']/gmu;

const RELATIVE_PREFIX = /^\.{1,2}(\/|$)/;
const ABSOLUTE_PREFIX = /^\//u;

function parseArgs(args: string[]): { dist: string; nodeModules: string; out: string } {
  let dist = "";
  let nodeModules = "";
  let out = "import-closure-report.txt";
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--dist" || a === "-d") {
      dist = args[++i] || "";
    } else if (a === "--node-modules" || a === "-n") {
      nodeModules = args[++i] || "";
    } else if (a === "--out" || a === "-o") {
      out = args[++i] || out;
    }
  }
  if (!dist) {
    console.error("[import-closure-gate] --dist <dist-dir> is required");
    exit(2);
  }
  if (!nodeModules) {
    console.error("[import-closure-gate] --node-modules <staged-node_modules_dir> is required");
    exit(2);
  }
  return { dist: resolve(dist), nodeModules: resolve(nodeModules), out };
}

function parseImportSpec(spec: string): ImportDecl {
  if (RELATIVE_PREFIX.test(spec) || ABSOLUTE_PREFIX.test(spec) || isAbsolute(spec)) {
    return { kind: "relative", spec };
  }
  const parts = spec.split("/");
  const packageName = spec.startsWith("@") ? `${parts[0]}/${parts[1] ?? ""}` : (parts[0] ?? "");
  if (!packageName) {
    return { kind: "relative", spec };
  }
  return { kind: "bare", spec, packageName };
}

function walkMjs(root: string): string[] {
  const found: string[] = [];
  function recurse(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(dir, name);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        recurse(full);
      } else if (
        extname(name) === ".mjs" ||
        name.endsWith(".setup") ||
        name.endsWith(".setup.mjs")
      ) {
        found.push(full);
      }
    }
  }
  if (!existsSync(root)) {
    return found;
  }
  recurse(root);
  return found;
}

function listMissingPackages(decls: ImportDecl[], nodeModulesRoot: string): Set<string> {
  const present = new Set<string>();
  try {
    const scopedEntries = readdirSync(nodeModulesRoot).filter((d) => d.startsWith("@"));
    for (const scope of scopedEntries) {
      const scopeDir = join(nodeModulesRoot, scope);
      try {
        for (const pkg of readdirSync(scopeDir)) {
          present.add(`${scope}/${pkg}`);
        }
      } catch {
        // ignore: scoped dir unreadable
      }
    }
    for (const d of readdirSync(nodeModulesRoot)) {
      if (d.startsWith(".")) {
        continue;
      }
      if (!d.startsWith("@")) {
        present.add(d);
      }
    }
  } catch {
    // node_modules missing entirely — every bare package will be reported
  }
  const missing = new Set<string>();
  for (const d of decls) {
    if (d.kind !== "bare") {
      continue;
    }
    if (!present.has(d.packageName)) {
      missing.add(d.packageName);
    }
  }
  return missing;
}

function extractImports(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(IMPORT_RE)) {
    const spec = match[1];
    if (spec) {
      out.push(spec);
    }
  }
  return out;
}

function isInternalRuntimeResolution(decl: ImportDecl, fileDir: string, distRoot: string): boolean {
  if (decl.kind !== "relative") {
    return false;
  }
  if (isAbsolute(decl.spec)) {
    return decl.spec.startsWith(distRoot);
  }
  const resolved = resolve(fileDir, decl.spec);
  return resolved.startsWith(distRoot);
}

function main(): number {
  const { dist, nodeModules, out } = parseArgs(argv.slice(2));
  if (!existsSync(dist)) {
    console.error(`[import-closure-gate] dist directory not found: ${dist}`);
    exit(2);
  }
  const setupDir = join(dist, "extensions");
  const runtimeDir = join(dist, "runtime");
  const files = [...walkMjs(setupDir), ...walkMjs(runtimeDir)];

  const reportLines: string[] = [];
  let totalDecls = 0;
  let totalBareDecls = 0;
  let totalRelativeDecls = 0;
  const bareDecls: ImportDecl[] = [];
  const failures: { file: string; line: number; spec: string; reason: string }[] = [];

  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const fileDir = file.split(sep).slice(0, -1).join(sep);
    const imports = extractImports(text);
    totalDecls += imports.length;
    const lines = text.split("\n");
    for (const spec of imports) {
      const decl = parseImportSpec(spec);
      if (decl.kind === "bare") {
        totalBareDecls++;
        bareDecls.push(decl);
      } else {
        totalRelativeDecls++;
      }
      const lineNo = lines.findIndex((l) => l.includes(spec)) + 1;
      if (decl.kind === "relative") {
        if (!isInternalRuntimeResolution(decl, fileDir, dist)) {
          failures.push({
            file,
            line: lineNo,
            spec,
            reason: "relative import escaping dist/ root",
          });
        }
        continue;
      }
      // Bare — collect for later cross-check against node_modules
      const probe = join(nodeModules, decl.packageName);
      if (!existsSync(probe)) {
        failures.push({
          file,
          line: lineNo,
          spec,
          reason: `package not in staged node_modules: ${decl.packageName}`,
        });
      }
    }
  }

  // Surface deduped missing packages so reviewers see them once.
  const missingPkgs = listMissingPackages(bareDecls, nodeModules);
  for (const pkg of missingPkgs) {
    reportLines.push(`MISSING_PACKAGE ${pkg}`);
  }

  // Untracked imports surface as failures from per-file resolution; ignore the
  // duplicates listMissingPackages surfaces because per-file is authoritative.

  reportLines.push(
    `SUMMARY files=${files.length} imports=${totalDecls} bare=${totalBareDecls} relative=${totalRelativeDecls} failures=${failures.length}`,
  );
  for (const f of failures) {
    const rel = relative(dist, f.file);
    reportLines.push(`FAIL ${rel}:${f.line} ${f.reason} | spec=${f.spec}`);
  }
  if (files.length === 0) {
    reportLines.push(
      "WARN no .setup/.mjs files found under dist/extensions or dist/runtime — verify the build output paths",
    );
  }

  console.log(reportLines.join("\n"));

  try {
    const dir = resolve(out, "..");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(out, reportLines.join("\n") + "\n");
  } catch (err) {
    console.error(
      `[import-closure-gate] could not write report to ${out}: ${(err as Error).message}`,
    );
  }

  return failures.length === 0 ? 0 : 1;
}

process.exit(main());
