#!/usr/bin/env bash
# run_test_scope.sh — targeted vitest runner for openclaw-canonical (card 608ab6d1).
#
# Fleet HR5 wording says "targeted tests only via scripts/run_test_scope.sh";
# the workspace version of that script is pytest/Ayumi/Cabal-specific. This is
# the canonical-repo equivalent: it runs ONLY the vitest test files passed as
# arguments, under the cpu_guard fence, resolved against the invoking
# worktree.
#
# Usage:
#   bash scripts/run_test_scope.sh <test_file...> [-- <extra vitest args>]
#
# Rules:
# - At least one explicit *.test.ts|tsx|mts|js file argument is required.
#   Directory-scoped or whole-suite runs are REFUSED (HR5: full suite is
#   Craig-gated; there is no --full here by design).
# - Workspace resolution precedence (anti-false-green, mirrors the workspace
#   script's card-1a85e267 fix):
#     1. OPENCLAW_CANONICAL env override
#     2. caller cwd, when it is the toplevel of a git worktree of this repo
#        that carries its own copy of this script
#     3. this script's location
#   The resolved root and rule are printed on every run.
# - The command runs under scripts/cpu_guard.sh <agent> -- (flock + cgroup
#   fence). Agent id comes from $CPU_GUARD_AGENT, default "tsubaki".

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

resolve_root() {
  if [[ -n "${OPENCLAW_CANONICAL:-}" ]]; then
    printf '%s\tenv\n' "$OPENCLAW_CANONICAL"
    return 0
  fi
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    local top
    top="$(git rev-parse --show-toplevel 2>/dev/null || true)"
    if [[ -n "$top" && -f "$top/scripts/run_test_scope.sh" ]]; then
      printf '%s\tcwd\n' "$top"
      return 0
    fi
  fi
  printf '%s\tscript-location\n' "$DEFAULT_ROOT"
}

_resolved="$(resolve_root)"
ROOT="${_resolved%%$'\t'*}"
ROOT_SOURCE="${_resolved#*$'\t'}"
echo "[run_test_scope] repo root: $ROOT (source: $ROOT_SOURCE)"

# Split trailing "-- extra args" from the test-file list.
EXTRA_ARGS=()
ARGS=("$@")
for i in "${!ARGS[@]}"; do
  if [[ "${ARGS[$i]}" == "--" ]]; then
    EXTRA_ARGS=("${ARGS[@]:$((i + 1))}")
    ARGS=("${ARGS[@]:0:$i}")
    break
  fi
done

if [[ ${#ARGS[@]} -eq 0 ]]; then
  echo "[run_test_scope] REFUSED: no test files given." \
    "Pass explicit *.test.ts files (targeted runs only; full suite is Craig-gated)." >&2
  exit 64
fi

files=()
for f in "${ARGS[@]}"; do
  case "$f" in
    *.test.ts|*.test.tsx|*.test.mts|*.test.js) files+=("$f") ;;
    *)
      echo "[run_test_scope] REFUSED: '$f' is not an explicit test file." \
        "Only *.test.{ts,tsx,mts,js} paths are accepted (HR5 targeted-only)." >&2
      exit 64
      ;;
  esac
  if [[ ! -f "$ROOT/$f" ]]; then
    echo "[run_test_scope] REFUSED: $ROOT/$f does not exist." >&2
    exit 66
  fi
done

AGENT="${CPU_GUARD_AGENT:-tsubaki}"
cd "$ROOT"
exec bash "$SCRIPT_DIR/cpu_guard.sh" "$AGENT" -- \
  node scripts/run-vitest.mjs run "${files[@]}" "${EXTRA_ARGS[@]}"
