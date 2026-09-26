import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import ts from "typescript";
import { resolveRepoRoot } from "./lib/repo-root.mjs";

const packageRoot = path.join(resolveRepoRoot(import.meta.url), "packages/gateway-protocol");
const normalizationCoreRoot = path.join(
  resolveRepoRoot(import.meta.url),
  "packages/normalization-core",
);
const normalizationCoreSrcRoot = path.join(normalizationCoreRoot, "src");
// Read every @openclaw/normalization-core/* subpath from package.json `exports`
// so the paths below stay in sync with future subpath additions. Programmatic
// paths in `ts.CompilerOptions` do not honour the tsconfig-style `*` wildcard
// the way a tsconfig.json on disk does, so we enumerate explicitly.
const normalizationCoreExports = ((): Record<string, unknown> => {
  const raw = JSON.parse(
    readFileSync(path.join(normalizationCoreRoot, "package.json"), "utf8"),
  ) as { exports?: Record<string, unknown> };
  return raw.exports ?? {};
})();
const fixturePath = path.join(packageRoot, "protocol-registry-mutability.contract.mts");
const requireFromPackage = createRequire(path.join(packageRoot, "package.json"));
const publicModule: unknown = await import(
  pathToFileURL(requireFromPackage.resolve("@openclaw/gateway-protocol/schema")).href
);
if (!isRecord(publicModule) || !isRecord(publicModule.ProtocolSchemas)) {
  throw new Error("Public emitted ProtocolSchemas runtime registry was not resolved");
}
const runtimeKeys = Object.keys(publicModule.ProtocolSchemas).toSorted();
const writable = new Set([
  "ProgressCardStepStatus",
  "ProgressCardStep",
  "ProgressCard",
  "ProgressCardGetParams",
  "ProgressCardGetResult",
  "ProgressCardPutParams",
  "ProgressCardPutResult",
  "ProgressCardChangedEvent",
]);
// Pin the bare specifier resolution to the package SOURCE via compiler `paths` —
// build-order-proof (no dist dependency) and pnpm-layout-proof. The runtime
// createRequire check above still verifies the real public subpath emit.
const prelude = 'import { ProtocolSchemas } from "@openclaw/gateway-protocol/schema"';

/**
 * Build the compiler `paths` overrides for @openclaw/normalization-core/*. Each
 * exported subpath in the package's `exports` map is pinned to the matching
 * source file under packages/normalization-core/src/, so the fixture program
 * resolves the workspace package via TypeScript source rather than the dist
 * emit. This keeps the check build-order-proof: it no longer depends on the
 * dist surface existing when the script runs (see git log for the prior
 * regression where the recursive `pnpm -r build` resolved
 * `@openclaw/normalization-core/{json-schema,record-coerce,root}` against a
 * not-yet-emitted dist and produced a cascade of TS2307 + mutability failures).
 *
 * Programmatic paths in `ts.CompilerOptions` do not honour the tsconfig-style
 * `*` wildcard the way a tsconfig.json on disk does, so we enumerate the
 * exports map explicitly and look up the matching `.ts` source by basename.
 */
function buildNormalizationCorePaths(
  srcRoot: string,
  exportsMap: Record<string, unknown>,
): Record<string, string[]> {
  const paths: Record<string, string[]> = {};
  for (const [subpath, target] of Object.entries(exportsMap)) {
    if (!subpath.startsWith("./")) {
      continue;
    }
    const entry = (target as { types?: string; import?: string; default?: string }) ?? {};
    const typesTarget = entry.types ?? entry.import ?? entry.default;
    if (typeof typesTarget !== "string") {
      continue;
    }
    const baseName = path.posix
      .basename(typesTarget)
      .replace(/\.d\.mts$/, "")
      .replace(/\.mjs$/, "");
    const specifier =
      subpath === "."
        ? "@openclaw/normalization-core"
        : `@openclaw/normalization-core/${subpath.slice(2)}`;
    paths[specifier] = [path.join(srcRoot, `${baseName}.ts`)];
  }
  return paths;
}

for (const exactOptionalPropertyTypes of [true, false]) {
  const options: ts.CompilerOptions = {
    strict: true,
    noUncheckedIndexedAccess: true,
    exactOptionalPropertyTypes,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.NodeNext,
    paths: {
      // Pin bare-specifier resolution to package SOURCE so the check is
      // build-order-proof (no dist dependency) and pnpm-layout-proof, exactly
      // matching the existing `@openclaw/gateway-protocol/schema` pin above.
      // The runtime createRequire check at the top of this file still verifies
      // the real public subpath emit, so the dist surface remains authoritative
      // at the package boundary.
      "@openclaw/gateway-protocol/schema": [path.join(packageRoot, "src", "schema.ts")],
      ...buildNormalizationCorePaths(normalizationCoreSrcRoot, normalizationCoreExports),
    },
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noEmit: true,
    skipLibCheck: false,
    // The schema barrel re-exports theme.ts, which uses an explicit
    // `.ts`-suffixed type-only import (a repo-wide convention also enabled in
    // the root tsconfig.json). `noEmit: true` above satisfies the option's
    // requirement; without this flag, tsc rejects the .ts-extension import
    // with TS5097 even though the path resolves cleanly.
    allowImportingTsExtensions: true,
    types: [],
  };
  let fixture = `${prelude}\ntype Registry = typeof ProtocolSchemas;\n`;
  const host = ts.createCompilerHost(options);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) =>
    path.resolve(fileName) === fixturePath
      ? ts.createSourceFile(fileName, fixture, languageVersion, true)
      : originalGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
  const inspect = ts.createProgram([fixturePath], options, host);
  const inputErrors = ts.getPreEmitDiagnostics(inspect);
  if (inputErrors.length) {
    throw new Error(
      ts.formatDiagnosticsWithColorAndContext(inputErrors, {
        getCanonicalFileName: (fileName) => fileName,
        getCurrentDirectory: () => packageRoot,
        getNewLine: () => "\n",
      }),
    );
  }
  const source = inspect.getSourceFile(fixturePath);
  const declaration = source?.statements.find(ts.isTypeAliasDeclaration);
  if (!declaration) {
    throw new Error("Public ProtocolSchemas type was not resolved");
  }
  const checker = inspect.getTypeChecker();
  const registry = checker.getTypeAtLocation(declaration);
  const keys = checker
    .getPropertiesOfType(registry)
    .map((symbol) => symbol.name)
    .toSorted();
  if (JSON.stringify(keys) !== JSON.stringify(runtimeKeys)) {
    throw new Error("Public emitted registry keys differ between runtime and declarations");
  }
  if (
    !keys.length ||
    [...writable].some((key) => !keys.includes(key)) ||
    checker.getIndexInfosOfType(registry).length !== 0
  ) {
    throw new Error("Expected named registry properties with the eight writable ProgressCard keys");
  }

  const lines = [prelude];
  const readonlyLines = new Set<number>();
  const expectedReadonly = keys.length - writable.size;
  for (const key of keys) {
    lines.push(
      `ProtocolSchemas[${JSON.stringify(key)}] = ProtocolSchemas[${JSON.stringify(key)}];`,
    );
    if (!writable.has(key)) {
      readonlyLines.add(lines.length);
    }
  }
  fixture = `${lines.join("\n")}\n`;
  // These consumer assignments are compiled in memory and never executed or emitted.
  const proof = ts.createProgram([fixturePath], options, host);
  const observedReadonly = new Set<number>();
  const unexpected = ts.getPreEmitDiagnostics(proof).filter((diagnostic) => {
    if (
      diagnostic.file &&
      path.resolve(diagnostic.file.fileName) === fixturePath &&
      diagnostic.start !== undefined
    ) {
      const line = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1;
      if (diagnostic.code === 2540 && readonlyLines.has(line)) {
        observedReadonly.add(line);
        return false;
      }
    }
    return true;
  });
  if (unexpected.length || observedReadonly.size !== expectedReadonly) {
    const formatted = ts.formatDiagnosticsWithColorAndContext(unexpected, {
      getCanonicalFileName: (fileName) => fileName,
      getCurrentDirectory: () => packageRoot,
      getNewLine: () => "\n",
    });
    throw new Error(
      `Registry mutability mismatch (exactOptionalPropertyTypes=${exactOptionalPropertyTypes}): ` +
        `${observedReadonly.size}/${expectedReadonly} readonly assignments rejected; ${unexpected.length} unexpected diagnostics\n` +
        formatted,
    );
  }
}
console.log("protocol registry public mutability contract passed in both optional-property modes");
