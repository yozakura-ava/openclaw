#!/usr/bin/env bash
# cpu_guard.sh — thin delegate for openclaw-canonical builds (card 608ab6d1).
#
# The fleet's HR5 card wording references scripts/cpu_guard.sh, but the real
# guard lives in the workspace repo (/root/.openclaw/workspace/scripts/). The
# guard itself is repo-independent — flock-per-agent + cgroup/taskset fence
# around ANY command — so the canonical copy simply delegates to it.
#
# Usage (identical to the workspace guard):
#   scripts/cpu_guard.sh <agent-id> -- <command...>
#
# Fallback: if the workspace guard is not present on this host (a canonical
# checkout outside the fleet), exec the command directly and print a loud
# warning so a guard-less run is never mistaken for a guarded one.

set -u

WORKSPACE_GUARD="/root/.openclaw/workspace/scripts/cpu_guard.sh"

if [[ -x "$WORKSPACE_GUARD" ]]; then
  exec "$WORKSPACE_GUARD" "$@"
fi

echo "[cpu_guard] WARNING: workspace guard not found at $WORKSPACE_GUARD;" \
  "running UNPROTECTED (no flock, no cgroup fence)." >&2
exec "$@"
