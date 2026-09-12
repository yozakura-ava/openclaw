import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
// Local copy of isRecord (packages/normalization-core/src/record-coerce.ts):
// scripts/ is not a workspace package member, so `node scripts/...` cannot
// resolve @openclaw/normalization-core at runtime (tarball check test spawns
// this file with plain node). Keep this in sync with the source helper.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
import { WORKSPACE_TEMPLATE_PACK_PATHS } from "./workspace-bootstrap-smoke.mts";

const FULL_GIT_COMMIT_RE = /^[0-9a-f]{40}$/iu;

const WORKBOARD_SOURCE_MANIFEST_PATH = "extensions/workboard/openclaw.plugin.json";
const WORKBOARD_SOURCE_RUNTIME_PATH = "extensions/workboard/src/workspace-access.ts";
const WORKBOARD_SOURCE_ENTRY_PATH = "extensions/workboard/index.ts";
const WORKBOARD_ARTIFACT_MANIFEST_PATH = "dist/extensions/workboard/openclaw.plugin.json";
const WORKBOARD_ARTIFACT_RUNTIME_PATH = "dist/extensions/workboard/index.js";

export const WORKBOARD_REQUIRED_ARCHIVE_PATHS = [
  WORKBOARD_ARTIFACT_MANIFEST_PATH,
  WORKBOARD_ARTIFACT_RUNTIME_PATH,
  "dist/build-info.json",
  ...WORKSPACE_TEMPLATE_PACK_PATHS,
] as const;

type JsonRecord = Record<string, unknown>;

function readJson(filePath: string): JsonRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function normalizeNames(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "")
    : [];
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].toSorted();
}

function compareNameSets(label: string, actual: readonly string[], expected: readonly string[]) {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const missing = expected.filter((name) => !actualSet.has(name));
  const unexpected = actual.filter((name) => !expectedSet.has(name));
  const duplicateCount = actual.length - actualSet.size;
  const errors: string[] = [];
  if (missing.length > 0) {
    errors.push(`${label} is missing: ${sortedUnique(missing).join(", ")}`);
  }
  if (unexpected.length > 0) {
    errors.push(`${label} has unexpected names: ${sortedUnique(unexpected).join(", ")}`);
  }
  if (duplicateCount > 0) {
    errors.push(`${label} contains duplicate names`);
  }
  return errors;
}

/** Extracts the authoritative Workboard registration list without importing runtime code. */
export function extractWorkboardToolNames(source: string): string[] {
  const match = /export const WORKBOARD_TOOL_NAMES\s*=\s*\[([\s\S]*?)\]\s*as const/u.exec(source);
  if (!match) {
    throw new Error("WORKBOARD_TOOL_NAMES declaration not found");
  }
  return [...(match[1] ?? "").matchAll(/['"](workboard_[^'"]+)['"]/gu)].map((entry) => entry[1]!);
}

function manifestNames(manifest: JsonRecord): string[] {
  const contracts = isRecord(manifest.contracts) ? manifest.contracts : undefined;
  return normalizeNames(contracts?.tools);
}

function manifestMetadata(manifest: JsonRecord): JsonRecord | undefined {
  return isRecord(manifest.toolMetadata) ? manifest.toolMetadata : undefined;
}

function validateWorkboardManifest(
  manifestPath: string,
  expectedNames: readonly string[] | undefined,
): string[] {
  const errors: string[] = [];
  const manifest = readJson(manifestPath);
  if (!manifest) {
    return [`Workboard manifest is missing or invalid JSON: ${manifestPath}`];
  }
  const declaredNames = manifestNames(manifest);
  const metadata = manifestMetadata(manifest);
  if (!metadata) {
    errors.push(`Workboard manifest is missing toolMetadata: ${manifestPath}`);
  }
  if (expectedNames) {
    errors.push(
      ...compareNameSets("Workboard manifest contracts.tools", declaredNames, expectedNames),
    );
  }
  if (declaredNames.length === 0) {
    errors.push(`Workboard manifest has no contracts.tools: ${manifestPath}`);
  }
  if (metadata) {
    errors.push(
      ...compareNameSets("Workboard manifest toolMetadata", Object.keys(metadata), declaredNames),
    );
    for (const name of declaredNames) {
      const entry = metadata[name];
      if (!isRecord(entry) || entry.optional !== true) {
        errors.push(`Workboard manifest toolMetadata.${name}.optional must be true`);
      }
    }
  }
  return errors;
}

export function collectWorkboardSourceContractErrors(rootDir: string): string[] {
  const errors: string[] = [];
  const runtimePath = path.join(rootDir, WORKBOARD_SOURCE_RUNTIME_PATH);
  const manifestPath = path.join(rootDir, WORKBOARD_SOURCE_MANIFEST_PATH);
  let names: string[] | undefined;
  try {
    names = extractWorkboardToolNames(fs.readFileSync(runtimePath, "utf8"));
  } catch (error) {
    errors.push(`Workboard runtime registration cannot be read: ${String(error)}`);
  }
  if (names) {
    errors.push(...compareNameSets("WORKBOARD_TOOL_NAMES", names, names));
    errors.push(...validateWorkboardManifest(manifestPath, names));
  } else {
    errors.push(...validateWorkboardManifest(manifestPath, undefined));
  }
  const entryPath = path.join(rootDir, WORKBOARD_SOURCE_ENTRY_PATH);
  if (fs.existsSync(entryPath)) {
    const runtime = fs.readFileSync(entryPath, "utf8");
    if (!/names\s*:\s*\[\.\.\.WORKBOARD_TOOL_NAMES\s*\]/u.test(runtime)) {
      errors.push("Workboard runtime registration must use WORKBOARD_TOOL_NAMES");
    }
    if (!/optional\s*:\s*true/u.test(runtime)) {
      errors.push("Workboard runtime registration must declare optional: true");
    }
  }
  return errors;
}

export function readWorkboardBuildIdentity(artifactRoot: string): {
  buildInfoCommit?: string;
  buildStampCommit?: string;
} {
  const distRoot = path.join(artifactRoot, "dist");
  const buildInfo = readJson(path.join(distRoot, "build-info.json"));
  const buildStamp = readJson(path.join(distRoot, ".buildstamp"));
  return {
    ...(typeof buildInfo?.commit === "string" ? { buildInfoCommit: buildInfo.commit } : {}),
    ...(typeof buildStamp?.head === "string" ? { buildStampCommit: buildStamp.head } : {}),
  };
}

export function collectWorkboardArtifactContractErrors(
  artifactRoot: string,
  options: { requireBuildStamp?: boolean } = {},
): string[] {
  const errors: string[] = [];
  const manifestPath = path.join(artifactRoot, WORKBOARD_ARTIFACT_MANIFEST_PATH);
  const runtimePath = path.join(artifactRoot, WORKBOARD_ARTIFACT_RUNTIME_PATH);
  const manifest = readJson(manifestPath);
  errors.push(...validateWorkboardManifest(manifestPath, undefined));
  if (!fs.existsSync(runtimePath)) {
    errors.push(`Workboard artifact runtime is missing: ${runtimePath}`);
  } else if (manifest) {
    const runtime = fs.readFileSync(runtimePath, "utf8");
    for (const name of manifestNames(manifest)) {
      if (!runtime.includes(name)) {
        errors.push(`Workboard artifact runtime is missing registered tool name: ${name}`);
      }
    }
  }
  const identity = readWorkboardBuildIdentity(artifactRoot);
  if (!identity.buildInfoCommit || !FULL_GIT_COMMIT_RE.test(identity.buildInfoCommit)) {
    errors.push("Workboard artifact dist/build-info.json must contain a full commit SHA");
  }
  if (options.requireBuildStamp) {
    if (!identity.buildStampCommit || !FULL_GIT_COMMIT_RE.test(identity.buildStampCommit)) {
      errors.push("Workboard artifact dist/.buildstamp must contain a full commit SHA");
    }
  }
  if (
    identity.buildInfoCommit &&
    identity.buildStampCommit &&
    identity.buildInfoCommit !== identity.buildStampCommit
  ) {
    errors.push("Workboard artifact build-info.json and .buildstamp commits differ");
  }
  for (const templatePath of WORKSPACE_TEMPLATE_PACK_PATHS) {
    if (!fs.existsSync(path.join(artifactRoot, templatePath))) {
      errors.push(`Workboard deployment is missing required workspace template: ${templatePath}`);
    }
  }
  return errors;
}

export function collectWorkboardArchiveErrors(entries: Iterable<string>): string[] {
  const normalized = new Set(
    [...entries].map((entry) =>
      entry
        .replaceAll("\\", "/")
        .replace(/^package\//u, "")
        .replace(/\/$/u, ""),
    ),
  );
  return WORKBOARD_REQUIRED_ARCHIVE_PATHS.filter(
    (requiredPath) => !normalized.has(requiredPath),
  ).map((requiredPath) => `Workboard deployment archive is missing required path: ${requiredPath}`);
}

export function readGitCommit(rootDir: string): string | undefined {
  try {
    const commit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .toLowerCase();
    return FULL_GIT_COMMIT_RE.test(commit) ? commit : undefined;
  } catch {
    return undefined;
  }
}

export function collectWorkboardDeploymentContractErrors(params: {
  sourceRoot: string;
  artifactRoot: string;
}): string[] {
  const errors = [
    ...collectWorkboardSourceContractErrors(params.sourceRoot),
    ...collectWorkboardArtifactContractErrors(params.artifactRoot, { requireBuildStamp: true }),
  ];
  const sourceCommit = readGitCommit(params.sourceRoot);
  const identity = readWorkboardBuildIdentity(params.artifactRoot);
  if (!sourceCommit) {
    errors.push(`Cannot resolve a full source commit for ${params.sourceRoot}`);
  }
  if (
    sourceCommit &&
    identity.buildInfoCommit &&
    sourceCommit !== identity.buildInfoCommit.toLowerCase()
  ) {
    errors.push(
      `Workboard artifact build-info commit ${identity.buildInfoCommit} does not match source ${sourceCommit}`,
    );
  }
  if (
    sourceCommit &&
    identity.buildStampCommit &&
    sourceCommit !== identity.buildStampCommit.toLowerCase()
  ) {
    errors.push(
      `Workboard artifact .buildstamp commit ${identity.buildStampCommit} does not match source ${sourceCommit}`,
    );
  }
  return errors;
}
