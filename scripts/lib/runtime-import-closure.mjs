// Collects bare (package) import specifiers from built runtime files and
// checks each against the staged dependency tree. Prevention for the
// missing-package class of 2026-09-24 (smol-toml / acpx / workboard-contract):
// a generated runtime file that imports a package absent from the staged
// production dependency tree fails the gate instead of failing at launch.
import fs from "node:fs";
import { builtinModules as BUILTIN_MODULE_LIST, createRequire } from "node:module";
import path from "node:path";
import { visitJavaScriptStatements } from "./javascript-statements.mjs";

const JS_FILE_RE = /\.(?:cjs|js|mjs)$/u;

function stripSpecifierSuffix(value) {
  return value.replace(/[?#].*$/u, "");
}

function literal(node) {
  if (node?.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  return node?.type === "TemplateLiteral" && node.expressions.length === 0
    ? node.quasis[0].value.cooked
    : undefined;
}

function isBarePackageSpecifier(specifier) {
  if (typeof specifier !== "string" || specifier === "") {
    return false;
  }
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("#")) {
    return false;
  }
  // Builtins (fs, node:fs, ...) never need a staged dependency entry.
  return !(
    specifier.startsWith("node:") || BUILTIN_MODULES.has(specifier.split("/", 1)[0] ?? specifier)
  );
}

/** Collect bare package specifiers per JavaScript file under a dist tree. */
export function collectBareImports({ files, readText }) {
  const imports = [];
  for (const file of files) {
    if (!JS_FILE_RE.test(file) || /(?:^|\/)node_modules\//u.test(file)) {
      continue;
    }
    const source = readText(file);
    if (!source) {
      continue;
    }
    const specifiers = new Set();
    const visit = (node) => {
      let specifier;
      if (
        ["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"].includes(node.type)
      ) {
        specifier = literal(node.source);
      } else if (node.type === "ImportExpression") {
        specifier = literal(node.source);
      } else if (
        node.type === "CallExpression" &&
        node.callee.type === "Identifier" &&
        node.callee.name === "require" &&
        node.arguments.length === 1
      ) {
        specifier = literal(node.arguments[0]);
      }
      if (isBarePackageSpecifier(specifier)) {
        specifiers.add(stripSpecifierSuffix(specifier));
      }
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) {
          for (const child of value) {
            if (child && typeof child.type === "string") {
              visit(child);
            }
          }
        } else if (value && typeof value.type === "string") {
          visit(value);
        }
      }
    };
    // Node detects ESM syntax in .js files without an explicit package type;
    // try module first, fall back to script on a parse error.
    const scan = (sourceType) => {
      visitJavaScriptStatements(
        source,
        { sourceType, allowReturnOutsideFunction: true },
        (statements) => {
          for (const statement of statements) {
            visit(statement);
          }
        },
      );
    };
    try {
      scan("module");
    } catch (error) {
      if (!(error instanceof SyntaxError)) {
        throw error;
      }
      specifiers.clear();
      scan("script");
    }
    for (const specifier of specifiers) {
      imports.push({ file, specifier });
    }
  }
  return imports;
}

/** Files under rootDir (posix-relative paths), skipping node_modules. */
export function listRuntimeFiles(rootDir) {
  const files = [];
  const visit = (absolute, relative) => {
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") {
          continue;
        }
        visit(path.join(absolute, entry.name), childRelative);
      } else if (entry.isFile() && JS_FILE_RE.test(entry.name)) {
        files.push(childRelative);
      }
    }
  };
  visit(rootDir, "");
  return files.toSorted();
}

/**
 * Returns error strings for bare specifiers that do not resolve in the staged
 * dependency tree rooted at stagedRoot (which must contain node_modules/).
 */
export function collectRuntimeImportClosureErrors({ files, readText, stagedRoot }) {
  if (!fs.existsSync(path.join(stagedRoot, "node_modules"))) {
    return [`staged root has no node_modules (run the production install first): ${stagedRoot}`];
  }
  const require = createRequire(path.join(path.resolve(stagedRoot), "package.json"));
  const resolutionCache = new Map();
  const errors = [];
  for (const { file, specifier } of collectBareImports({ files, readText })) {
    let cached = resolutionCache.get(specifier);
    if (cached === undefined) {
      try {
        require.resolve(specifier, { paths: [path.resolve(stagedRoot)] });
        cached = true;
      } catch {
        cached = false;
      }
      resolutionCache.set(specifier, cached);
    }
    if (!cached) {
      errors.push(`${file} imports ${specifier}: absent from the staged dependency tree`);
    }
  }
  return errors;
}

const BUILTIN_MODULES = new Set(BUILTIN_MODULE_LIST);
