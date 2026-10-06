import { cpSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import YAML from "yaml";

type JsonObject = Record<string, unknown>;
type PackageManifest = JsonObject & {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  packageManager?: unknown;
};
type LockEntry = { specifier?: unknown; [key: string]: unknown };
type LockImporter = {
  dependencies?: Record<string, LockEntry>;
  optionalDependencies?: Record<string, LockEntry>;
  [key: string]: unknown;
};
type Lockfile = {
  importers: Record<string, LockImporter>;
  packages: Record<string, unknown>;
  snapshots: Record<string, unknown>;
};
type RuntimeDependency = { optional: boolean; spec: string; extension: string };
type DependencySection = "dependencies" | "optionalDependencies";

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function usage() {
  return "Usage: prepare-deploy-dependencies --staging <staging directory>";
}

function parseArgs(argv: string[]) {
  if (argv.length !== 2 || argv[0] !== "--staging" || !argv[1]) {
    throw new Error(usage());
  }
  return { staging: resolve(argv[1]) };
}

function readJson(filePath: string): JsonObject {
  const value: unknown = JSON.parse(readFileSync(filePath, "utf8"));
  if (!isJsonObject(value)) {
    throw new Error(`Expected a JSON object in ${filePath}`);
  }
  return value;
}

function readLockfile(filePath: string): Lockfile {
  const documents = YAML.parseAllDocuments(readFileSync(filePath, "utf8"));
  const value: unknown = documents.at(-1)?.toJSON();
  if (
    !isJsonObject(value) ||
    !isJsonObject(value.importers) ||
    !isJsonObject(value.packages) ||
    !isJsonObject(value.snapshots)
  ) {
    throw new Error(`Invalid pnpm lockfile: ${filePath}`);
  }
  return value as Lockfile;
}

function collectExtensionRuntimeDependencies(stagedDist: string) {
  const dependencies = new Map<string, RuntimeDependency>();
  const extensionsRoot = join(stagedDist, "extensions");
  if (!existsSync(extensionsRoot)) {
    return dependencies;
  }
  for (const entry of readdirSync(extensionsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "node_modules") {
      continue;
    }
    const packagePath = join(extensionsRoot, entry.name, "package.json");
    if (!existsSync(packagePath)) {
      continue;
    }
    const packageJson = readJson(packagePath) as PackageManifest;
    for (const [section, optional] of [
      ["dependencies", false],
      ["optionalDependencies", true],
    ] as const) {
      const declarations = packageJson[section];
      if (!declarations) {
        continue;
      }
      for (const [name, spec] of Object.entries(declarations)) {
        if (typeof spec !== "string" || spec.startsWith("workspace:")) {
          continue;
        }
        const existing = dependencies.get(name);
        if (existing && existing.spec !== spec) {
          throw new Error(
            `Bundled extensions declare conflicting specs for ${name}: ${existing.spec} and ${spec}`,
          );
        }
        dependencies.set(name, { optional, spec, extension: entry.name });
      }
    }
  }
  return dependencies;
}

function findLockEntry(lockfile: Lockfile, name: string, spec: string) {
  for (const importer of Object.values(lockfile.importers)) {
    for (const section of ["dependencies", "optionalDependencies"] as const) {
      const entries = importer[section];
      const entry = entries?.[name];
      if (entry?.specifier === spec) {
        return entry;
      }
    }
  }
  return undefined;
}

function materializeLocalAiPackage(staging: string) {
  const virtualStore = join(staging, "node_modules", ".pnpm");
  if (!existsSync(virtualStore)) {
    return false;
  }
  const candidate = readdirSync(virtualStore).find((name) => name.startsWith("@openclaw+ai@file+"));
  if (!candidate) {
    return false;
  }
  const source = join(virtualStore, candidate, "node_modules", "@openclaw", "ai");
  if (!existsSync(source)) {
    return false;
  }
  const target = join(staging, "node_modules", "@openclaw", "ai");
  rmSync(target, { recursive: true, force: true });
  cpSync(source, target, { recursive: true, dereference: true });
  return true;
}

let options: ReturnType<typeof parseArgs>;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}

const manifestPath = join(options.staging, "package.json");
const manifest = readJson(manifestPath) as PackageManifest;
// The deploy target is a standalone production tree. Keep the source package
// manager pin in the repository provenance, but do not make the staged
// install synthesize a packageManagerDependencies entry of its own.
delete manifest.packageManager;
const sourceLock = readLockfile(join(dirname(options.staging), "pnpm-lock.yaml"));
const dependencies = collectExtensionRuntimeDependencies(join(options.staging, "dist"));
const added: string[] = [];

for (const [name, record] of dependencies) {
  const manifestSection: DependencySection | undefined = Object.hasOwn(
    manifest.dependencies ?? {},
    name,
  )
    ? "dependencies"
    : Object.hasOwn(manifest.optionalDependencies ?? {}, name)
      ? "optionalDependencies"
      : undefined;
  const existingSpec =
    manifestSection === "dependencies"
      ? manifest.dependencies?.[name]
      : manifest.optionalDependencies?.[name];
  if (existingSpec !== undefined && existingSpec !== record.spec) {
    throw new Error(
      `Root and bundled extension declare conflicting specs for ${name}: ${existingSpec} and ${record.spec}`,
    );
  }
  const section = manifestSection ?? (record.optional ? "optionalDependencies" : "dependencies");
  const sectionDependencies = (manifest[section] ??= {});
  if (existingSpec === undefined) {
    sectionDependencies[name] = record.spec;
    const lockEntry = findLockEntry(sourceLock, name, record.spec);
    if (!lockEntry) {
      throw new Error(
        `Lockfile has no entry for bundled runtime dependency ${name}@${record.spec}`,
      );
    }
    added.push(`${name}@${record.spec}`);
  }
}

writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

const sourceAlias = join(dirname(options.staging), "dist", "extensions", "node_modules");
const stagedAlias = join(options.staging, "dist", "extensions", "node_modules");
if (existsSync(sourceAlias)) {
  cpSync(sourceAlias, stagedAlias, { recursive: true, dereference: true, force: true });
}

const materializedAi = materializeLocalAiPackage(options.staging);

console.log(
  `prepared ${added.length} bundled runtime dependencies, ${existsSync(sourceAlias) ? "copied" : "skipped"} the plugin SDK alias, and ${materializedAi ? "materialized" : "skipped"} the local AI package`,
);
