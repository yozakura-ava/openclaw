#!/usr/bin/env node
// Verifies that the runtime and bundled Control UI identify the same build.
import fs from "node:fs";
import path from "node:path";
import { normalizeControlUiBuildInfo } from "../ui/src/build-info-normalizers.ts";
import { isDirectRunUrl } from "./lib/direct-run.mjs";

type BuildArtifactIdentity = {
  runtime: ReturnType<typeof normalizeControlUiBuildInfo>;
  serviceWorkerBuildId: string;
  embeddedBuildIds: string[];
};

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
}

function requireBuildIdentity(
  value: ReturnType<typeof normalizeControlUiBuildInfo>,
  source: string,
): ReturnType<typeof normalizeControlUiBuildInfo> {
  if (!value.version || !value.commit || !value.builtAt || value.buildId === "dev") {
    throw new Error(`${source} does not contain a complete production build identity`);
  }
  return value;
}

function collectControlUiBuildIds(controlUiDir: string): string[] {
  const assetsDir = path.join(controlUiDir, "assets");
  const ids = new Set<string>();
  if (!fs.existsSync(assetsDir)) {
    throw new Error(`Control UI assets directory is missing: ${assetsDir}`);
  }
  for (const name of fs.readdirSync(assetsDir)) {
    if (!name.endsWith(".js") || name.endsWith(".map")) {
      continue;
    }
    const source = fs.readFileSync(path.join(assetsDir, name), "utf8");
    // The Vite global define is emitted as buildId:`...` (or a quoted
    // equivalent). Other runtime buildId fields are expressions, not literals.
    for (const match of source.matchAll(/\bbuildId\s*:\s*[`"']([^`"']+)[`"']/gu)) {
      const value = match[1];
      if (value && /^\d{4}\.\d+\./u.test(value)) {
        ids.add(value);
      }
    }
  }
  return [...ids].toSorted();
}

export function readBuildArtifactIdentity(rootDir = process.cwd()): BuildArtifactIdentity {
  const distDir = path.join(rootDir, "dist");
  const runtime = requireBuildIdentity(
    normalizeControlUiBuildInfo(readJson(path.join(distDir, "build-info.json"))),
    path.join(distDir, "build-info.json"),
  );
  const serviceWorker = fs.readFileSync(path.join(distDir, "control-ui/sw.js"), "utf8");
  const serviceWorkerBuildId =
    /\bEMBEDDED_CACHE_VERSION\s*=\s*["']([^"']+)["']/u.exec(serviceWorker)?.[1] ?? "";
  if (!serviceWorkerBuildId) {
    throw new Error("Control UI service worker has no embedded build identity");
  }
  const embeddedBuildIds = collectControlUiBuildIds(path.join(distDir, "control-ui"));
  return { runtime, serviceWorkerBuildId, embeddedBuildIds };
}

export function assertBuildArtifactIdentity(rootDir = process.cwd()): BuildArtifactIdentity {
  const identity = readBuildArtifactIdentity(rootDir);
  const expected = identity.runtime.buildId;
  const mismatches = [
    identity.serviceWorkerBuildId !== expected
      ? `service worker=${identity.serviceWorkerBuildId}`
      : null,
    identity.embeddedBuildIds.length !== 1 || identity.embeddedBuildIds[0] !== expected
      ? `bundled UI=${identity.embeddedBuildIds.join(",") || "missing"}`
      : null,
  ].filter((value): value is string => value !== null);
  if (mismatches.length > 0) {
    throw new Error(
      `runtime/UI build identity mismatch; expected ${expected}; ${mismatches.join("; ")}`,
    );
  }
  return identity;
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  try {
    const identity = assertBuildArtifactIdentity();
    console.error(`[build-identity] verified ${identity.runtime.buildId}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
