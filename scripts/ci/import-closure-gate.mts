import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { resolve as resolvePackageImport } from "import-meta-resolve";
import { visitJavaScriptStatements } from "../lib/javascript-statements.mjs";
import { collectPackageDistImportErrors } from "../lib/package-dist-imports.mjs";

const JavaScriptFile = /\.(?:cjs|js|mjs)$/u;

type AstNode = import("acorn").Node;
type PackageImport = { filePath: string; specifier: string };

function isAstNode(value: unknown): value is AstNode {
  return (
    typeof value === "object" && value !== null && "type" in value && typeof value.type === "string"
  );
}

function usage() {
  return "Usage: import-closure-gate --dist <dist> --node-modules <node_modules> --out <report>";
}

function parseArgs(argv: string[]) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--help" || option === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (!option?.startsWith("--") || index + 1 >= argv.length) {
      throw new Error(`Invalid arguments. ${usage()}`);
    }
    values.set(option.slice(2), argv[++index]);
  }
  const dist = values.get("dist");
  const nodeModules = values.get("node-modules");
  const out = values.get("out");
  if (!dist || !nodeModules || !out || values.size !== 3) {
    throw new Error(`Missing or unknown arguments. ${usage()}`);
  }
  return { dist: resolve(dist), nodeModules: resolve(nodeModules), out: resolve(out) };
}

function collectFiles(root: string) {
  const files: string[] = [];
  const pending: string[] = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) {
      continue;
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") {
          pending.push(entryPath);
        }
      } else if (entry.isFile()) {
        files.push(entryPath);
      }
    }
  }
  return files.toSorted();
}

function literal(node: AstNode | undefined) {
  const record = node as (Record<string, unknown> & { type: string }) | undefined;
  return record?.type === "Literal" && typeof record.value === "string" ? record.value : undefined;
}

function collectBarePackageImports(source: string, filePath: string): PackageImport[] {
  const imports: PackageImport[] = [];
  const visit = (node: AstNode): void => {
    const record = node as unknown as Record<string, unknown>;
    let specifier;
    if (
      record.type === "ImportDeclaration" ||
      record.type === "ExportNamedDeclaration" ||
      record.type === "ExportAllDeclaration"
    ) {
      specifier = literal(isAstNode(record.source) ? record.source : undefined);
    } else if (record.type === "ImportExpression") {
      specifier = literal(isAstNode(record.source) ? record.source : undefined);
    } else if (
      record.type === "CallExpression" &&
      isAstNode(record.callee) &&
      record.callee.type === "Identifier" &&
      (record.callee as unknown as Record<string, unknown>).name === "require"
    ) {
      const args = Array.isArray(record.arguments) ? record.arguments : [];
      specifier = literal(isAstNode(args[0]) ? args[0] : undefined);
    }
    if (
      specifier &&
      !specifier.startsWith(".") &&
      !specifier.startsWith("/") &&
      !specifier.startsWith("#") &&
      !isBuiltin(specifier)
    ) {
      imports.push({ filePath, specifier });
    }
    for (const value of Object.values(record)) {
      if (Array.isArray(value)) {
        for (const child of value) {
          if (isAstNode(child)) {
            visit(child);
          }
        }
      } else if (isAstNode(value)) {
        visit(value);
      }
    }
  };

  const sourceType = filePath.endsWith(".cjs") ? "script" : "module";
  try {
    visitJavaScriptStatements(
      source,
      { sourceType, allowReturnOutsideFunction: true },
      (statements) => {
        for (const statement of statements) {
          visit(statement);
        }
      },
    );
  } catch (error) {
    if (!filePath.endsWith(".js")) {
      throw error;
    }
    imports.length = 0;
    visitJavaScriptStatements(
      source,
      { sourceType: "script", allowReturnOutsideFunction: true },
      (statements) => {
        for (const statement of statements) {
          visit(statement);
        }
      },
    );
  }
  return imports;
}

function reportPath(root: string, filePath: string) {
  return relative(root, filePath).split(sep).join("/");
}

function collectRuntimeFiles(dist: string) {
  const roots = ["extensions", "runtime"]
    .map((directory) => join(dist, directory))
    .filter((directory) => existsSync(directory));
  return roots.flatMap((root) => collectFiles(root)).toSorted();
}

let options: ReturnType<typeof parseArgs>;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}

const files = collectFiles(options.dist);
const runtimeFiles = collectRuntimeFiles(options.dist);
const relativeFiles = files.map((file) => reportPath(options.dist, file));
const failures = [];

if (!existsSync(options.nodeModules)) {
  failures.push(`production node_modules directory is missing: ${options.nodeModules}`);
}

try {
  failures.push(
    ...collectPackageDistImportErrors({
      files: relativeFiles,
      readText(relativePath) {
        return readFileSync(join(options.dist, relativePath), "utf8");
      },
    }).map((failure) => `relative ${failure}`),
  );
} catch (error) {
  failures.push(
    `relative import scan failed: ${error instanceof Error ? error.message : String(error)}`,
  );
}

const packageImports = [];
for (const filePath of runtimeFiles.filter((file) => JavaScriptFile.test(file))) {
  try {
    packageImports.push(...collectBarePackageImports(readFileSync(filePath, "utf8"), filePath));
  } catch (error) {
    failures.push(
      `${reportPath(options.dist, filePath)}: JavaScript parse failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// Resolve against the deployed tree, not the checkout's development tree. The
// generated files are scanned from `dist`, while `pnpm deploy` places the
// production dependency graph under the sibling `staging-tmp/node_modules`.
// Prefer the copied dist file when it exists so package self-references and
// package.json `type`/`exports` scopes are evaluated exactly as staged.
const stagingRoot = dirname(options.nodeModules);
const stagedDist = join(stagingRoot, options.dist.split(sep).at(-1) ?? "dist");
const resolutionBase = pathToFileURL(join(stagedDist, "__import-closure-gate__.mjs")).href;
for (const { filePath, specifier } of packageImports) {
  try {
    const stagedFile = join(stagedDist, reportPath(options.dist, filePath));
    const parent = existsSync(stagedFile) ? pathToFileURL(stagedFile).href : resolutionBase;
    resolvePackageImport(specifier, parent);
  } catch (error) {
    failures.push(
      `package ${reportPath(options.dist, filePath)} imports unresolved ${specifier}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

mkdirSync(dirname(options.out), { recursive: true });
const report = [
  `dist=${options.dist}`,
  `node_modules=${options.nodeModules}`,
  `files=${files.length}`,
  `runtime_files=${runtimeFiles.length}`,
  `package_imports=${packageImports.length}`,
  `failures=${failures.length}`,
  ...failures.map((failure) => `- ${failure}`),
  "",
].join("\n");
writeFileSync(options.out, report);

if (failures.length > 0) {
  console.error(`import-closure-gate: ${failures.length} failure(s)`);
  process.exitCode = 1;
} else {
  console.log(
    `import-closure-gate: checked ${files.length} files and ${packageImports.length} package imports`,
  );
}
