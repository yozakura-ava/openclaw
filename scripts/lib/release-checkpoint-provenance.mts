import { execFileSync } from "node:child_process";

// This is the immutable upstream checkpoint selected for the 2026.9.9 fork
// resync.  The tree is pinned separately so a same-looking commit cannot stand
// in for the verified release commit.
export const VERIFIED_RELEASE_RESYNC_COMMIT = "0c01cc6e0aaa757700476db707785998391ff9b9";
export const VERIFIED_RELEASE_RESYNC_TREE = "aebfd3a15665cbbc745ed1572e09e0b79bd476c3";

// A resync may carry only the guard and its tests.  In particular, generated
// files and product source files must remain byte-identical to the checkpoint.
const RELEASE_RESYNC_GUARD_PATHS = new Set([
  "scripts/check-assertion-safety-ratchet.mts",
  "scripts/lib/release-checkpoint-provenance.mts",
  "test/scripts/release-checkpoint-provenance.test.ts",
]);

export type ReleaseResyncGraph = {
  mergeParents: readonly string[];
  candidateParents: readonly string[];
  checkpointTree: string;
  candidateParentTree: string;
  candidateTree: string;
  mergeTree: string;
  changedPaths: readonly string[];
};

/**
 * Proves that a pull-request merge tree is the pinned release checkpoint plus
 * this guard only.  Keep this pure so the rejection cases stay unit-testable.
 */
export function isVerifiedReleaseResyncGraph(graph: ReleaseResyncGraph) {
  return (
    graph.mergeParents.length === 2 &&
    graph.candidateParents.length === 1 &&
    graph.candidateParents[0] === VERIFIED_RELEASE_RESYNC_COMMIT &&
    graph.checkpointTree === VERIFIED_RELEASE_RESYNC_TREE &&
    graph.candidateParentTree === VERIFIED_RELEASE_RESYNC_TREE &&
    graph.candidateTree === graph.mergeTree &&
    graph.changedPaths.length > 0 &&
    graph.changedPaths.every((filePath) => RELEASE_RESYNC_GUARD_PATHS.has(filePath))
  );
}

function gitText(root: string, args: string[]) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

/**
 * Detects the special pull-request merge checkout used for the release
 * resync. Ordinary local checks and ordinary PRs deliberately return false.
 */
export function isVerifiedReleaseResync(root = process.cwd()) {
  try {
    const mergeCommit = gitText(root, ["rev-parse", "HEAD"]);
    const mergeParents = gitText(root, ["show", "-s", "--format=%P", mergeCommit]).split(/\s+/u);
    if (mergeParents.length !== 2) {
      return false;
    }
    const candidate = mergeParents[1];
    if (!candidate) {
      return false;
    }
    const candidateParents = gitText(root, ["show", "-s", "--format=%P", candidate]).split(/\s+/u);
    if (candidateParents.length !== 1 || !candidateParents[0]) {
      return false;
    }
    const changedPaths = gitText(root, [
      "diff",
      "--name-only",
      VERIFIED_RELEASE_RESYNC_COMMIT,
      candidate,
    ]);
    return isVerifiedReleaseResyncGraph({
      mergeParents,
      candidateParents,
      checkpointTree: gitText(root, ["rev-parse", `${VERIFIED_RELEASE_RESYNC_COMMIT}^{tree}`]),
      candidateParentTree: gitText(root, ["rev-parse", `${candidateParents[0]}^{tree}`]),
      candidateTree: gitText(root, ["rev-parse", `${candidate}^{tree}`]),
      mergeTree: gitText(root, ["rev-parse", `${mergeCommit}^{tree}`]),
      changedPaths: changedPaths ? changedPaths.split("\n") : [],
    });
  } catch {
    return false;
  }
}
