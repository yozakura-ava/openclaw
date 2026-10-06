import { describe, expect, it } from "vitest";
import {
  isVerifiedReleaseResyncGraph,
  VERIFIED_RELEASE_RESYNC_COMMIT,
  VERIFIED_RELEASE_RESYNC_TREE,
} from "../../scripts/lib/release-checkpoint-provenance.mts";

const validGraph = {
  mergeParents: ["fork-main", "release-resync"],
  candidateParents: [VERIFIED_RELEASE_RESYNC_COMMIT],
  checkpointTree: VERIFIED_RELEASE_RESYNC_TREE,
  candidateParentTree: VERIFIED_RELEASE_RESYNC_TREE,
  candidateTree: "guard-tree",
  mergeTree: "guard-tree",
  changedPaths: [
    "scripts/check-assertion-safety-ratchet.mts",
    "scripts/lib/release-checkpoint-provenance.mts",
  ],
} as const;

describe("release checkpoint provenance", () => {
  it("accepts only the pinned checkpoint plus guard files", () => {
    expect(isVerifiedReleaseResyncGraph(validGraph)).toBe(true);
  });

  it.each([
    ["wrong checkpoint commit", { candidateParents: ["another-commit"] }],
    ["wrong checkpoint tree", { candidateParentTree: "another-tree" }],
    ["unrelated source change", { changedPaths: ["src/runtime.ts"] }],
    ["generated tree drift", { candidateTree: "candidate-tree" }],
    ["merge tree drift", { mergeTree: "merge-tree" }],
  ])("rejects %s", (_label, changes) => {
    expect(isVerifiedReleaseResyncGraph({ ...validGraph, ...changes })).toBe(false);
  });
});
