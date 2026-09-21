import { getChangedPathFacts } from "./changed-path-facts.mjs";

// These are admission budgets, not performance targets.  A scoped plan is
// expected to be small; a fallback plan may use the compact PR suite, but it
// must never silently expand into an unbounded matrix.
export const CI_MATRIX_BUDGETS = Object.freeze({
  scoped: Object.freeze({ node: 32, ui: 7, qa: 6, native: 8 }),
  fallback: Object.freeze({ node: 120, ui: 14, qa: 6, native: 8 }),
  full: Object.freeze({ node: 256, ui: 14, qa: 6, native: 16 }),
});

const GLOBAL_SURFACE_PATH_RE =
  /^(?:\.github\/|package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|tsconfig(?:\.|$)|vitest(?:\.|$)|tsdown(?:\.|$)|\.ox(?:lint|fmt)|\.pre-commit-config\.yaml$|Dockerfile(?:\.|$)|Makefile$)/u;

/**
 * Returns true for changes whose effects cannot safely be inferred from one
 * affected TypeScript project or test target.
 */
export function isGlobalCiPath(changedPath) {
  if (typeof changedPath !== "string" || changedPath.length === 0) {
    return true;
  }
  const facts = getChangedPathFacts(changedPath);
  return (
    facts.surface === "unknown" ||
    facts.surface === "rootGlobal" ||
    GLOBAL_SURFACE_PATH_RE.test(changedPath)
  );
}

/**
 * Classifies the admission policy before the detailed matrix planner runs.
 * The planner may promote a known, non-global change to fallback if it cannot
 * prove an affected-only plan.
 *
 * @param {{
 *   eventName?: string,
 *   repository?: string,
 *   ref?: string,
 *   changedPaths?: string[] | null,
 *   manualScope?: string,
 *   fullLabel?: boolean,
 * }} options
 */
export function classifyCiScope({
  eventName,
  repository,
  ref,
  changedPaths,
  manualScope = "full",
  fullLabel = false,
} = {}) {
  const canonicalMainPush =
    repository === "openclaw/openclaw" &&
    eventName === "push" &&
    (ref === "refs/heads/main" || ref === "main");
  if (eventName === "workflow_dispatch" && manualScope === "full") {
    return { scope: "full", reason: "manual workflow dispatch" };
  }
  if (canonicalMainPush) {
    return { scope: "full", reason: "push to main" };
  }
  if (eventName === "pull_request" && fullLabel) {
    return { scope: "full", reason: "pull request labeled ci/full" };
  }
  if (changedPaths === null || changedPaths === undefined) {
    return { scope: "fallback", reason: "changed paths unavailable" };
  }
  if (!Array.isArray(changedPaths)) {
    return { scope: "fallback", reason: "changed paths are invalid" };
  }
  if (changedPaths.some(isGlobalCiPath)) {
    return { scope: "fallback", reason: "global or unknown change" };
  }
  if (changedPaths.length === 0) {
    return { scope: "scoped", reason: "no product changes" };
  }
  return { scope: "scoped", reason: "affected-path plan eligible" };
}
