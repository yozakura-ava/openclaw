import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";
import type { WorkboardArtifact } from "@openclaw/workboard-contract";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { ConsumerSurfaceEvidence } from "./persistence-types.js";

const execFileAsync = promisify(execFile);

/** Card labels that gate completion on consumer_surface_evidence. */
export const CONSUMER_SURFACE_EVIDENCE_LABELS = new Set(["[BUILD]", "[INFRA]"]);

function asConsumerSurfaceEvidence(input: unknown): ConsumerSurfaceEvidence {
  if (!isRecord(input)) {
    throw new Error(
      '[BUILD]/[INFRA] cards require consumer_surface_evidence on completion: an object like { kind: "code" | "skill" | "research", repoPath?, commitSha?, filePath?, consumerId? }. The evidence is verified independently; caller-supplied proof text is never trusted.',
    );
  }
  const kind = input.kind;
  if (kind !== "code" && kind !== "skill" && kind !== "research") {
    throw new Error(
      'consumer_surface_evidence.kind must be one of "code", "skill", or "research".',
    );
  }
  const readPath = (field: string): string | undefined => {
    const value = input[field];
    if (value === undefined) {
      return undefined;
    }
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(`consumer_surface_evidence.${field} must be a non-empty string.`);
    }
    return value;
  };
  const evidence: ConsumerSurfaceEvidence = {
    kind,
    ...(readPath("repoPath") ? { repoPath: readPath("repoPath") } : {}),
    ...(readPath("commitSha") ? { commitSha: readPath("commitSha") } : {}),
    ...(readPath("filePath") ? { filePath: readPath("filePath") } : {}),
    ...(readPath("consumerId") ? { consumerId: readPath("consumerId") } : {}),
  };
  return evidence;
}

/**
 * Independently verify consumer surface evidence against the world — never
 * trusting caller-supplied text. kind=code resolves the commit in the given
 * git repository; kind=skill requires an existing SKILL.md; kind=research
 * requires an existing non-empty artifact file.
 */
export async function verifyConsumerSurfaceEvidence(
  input: unknown,
  now: number,
): Promise<WorkboardArtifact> {
  const evidence = asConsumerSurfaceEvidence(input);
  if (evidence.kind === "code") {
    if (!evidence.repoPath || !evidence.commitSha) {
      throw new Error('consumer_surface_evidence kind "code" requires repoPath and commitSha.');
    }
    try {
      await execFileAsync("git", [
        "-C",
        evidence.repoPath,
        "cat-file",
        "-e",
        `${evidence.commitSha}^{commit}`,
      ]);
    } catch {
      throw new Error(
        `consumer_surface_evidence rejected: commit ${evidence.commitSha} does not resolve in repository ${evidence.repoPath}.`,
      );
    }
  }
  if (evidence.filePath) {
    try {
      const info = await stat(evidence.filePath);
      if (evidence.kind === "research" && !info.isFile()) {
        throw new Error("not a file");
      }
      if (evidence.kind === "research" && info.size === 0) {
        throw new Error("empty file");
      }
      if (
        evidence.kind === "skill" &&
        (!info.isFile() || !evidence.filePath.split("/").at(-1)?.endsWith(".md"))
      ) {
        throw new Error("not a markdown skill file");
      }
    } catch (error) {
      throw new Error(
        `consumer_surface_evidence rejected: filePath ${evidence.filePath} failed verification (${error instanceof Error ? error.message : String(error)}).`,
        { cause: error },
      );
    }
  } else if (evidence.kind === "skill" || evidence.kind === "research") {
    throw new Error(`consumer_surface_evidence kind "${evidence.kind}" requires filePath.`);
  }
  return {
    id: randomUUID(),
    createdAt: now,
    label: `consumer_surface_evidence:${evidence.kind}`,
    ...(evidence.filePath
      ? { path: evidence.filePath }
      : evidence.repoPath
        ? { path: evidence.repoPath }
        : {}),
    ...(evidence.consumerId ? { url: `consumer:${evidence.consumerId}` } : {}),
  };
}
