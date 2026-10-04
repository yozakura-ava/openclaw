#!/usr/bin/env python3
"""
Regression test for card e03f22e5-48d0-4202-ad3c-74c22aa1c955.

Bug: Workboard plugin refuses assignee claims on dispatcher release-sentinel
(claim_json ownerId='dispatcher-dispatched', expiresAt=0).

Acceptance criteria (from the card):
  - write a sentinel claim (ownerId='dispatcher-dispatched', expiresAt=0,
    dispatchedAt=now) on a running card;
  - assert workboard_claim by a different owner SUCCEEDS without manual DB
    intervention;
  - also assert a normal live claim (non-zero future expiresAt, different
    owner) is still refused.

This test drives the ACTUAL TypeScript plugin code via tsx subprocess — no
mocks, real sqlite-backed workboard, real isWorkboardClaimReclaimable and
real store.claim().

HR5 scoped: invokes a single TS helper script and asserts on JSON output.
No full vitest run, no full pytest collection, no full-repo tsc.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest


WORKTREE = Path(__file__).resolve().parent.parent
HELPER_REL = "tests/workboard_claim_sentinel_helper.mts"


def _run_helper() -> str:
    """Spawn the TS helper via tsx and return its stdout.

    Pass the loader (scripts/tsx.mjs) as an absolute file URL so Node's ESM
    resolver does not try to treat the relative path as a package import.
    """
    tsx_loader = WORKTREE / "scripts" / "tsx.mjs"
    cmd = [
        "node",
        "--import",
        tsx_loader.resolve().as_uri(),
        str(WORKTREE / HELPER_REL),
    ]
    env = os.environ.copy()
    proc = subprocess.run(
        cmd,
        cwd=str(WORKTREE),
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
    )
    if proc.returncode != 0:
        sys.stderr.write("--- helper stderr ---\n")
        sys.stderr.write(proc.stderr)
        sys.stderr.write("\n--- end helper stderr ---\n")
        raise RuntimeError(
            f"workboard_claim_sentinel_helper exited {proc.returncode}"
        )
    return proc.stdout


def test_sentinel_claim_succeeds_and_live_claim_refused():
    """End-to-end check against the actual TS plugin code."""
    stdout = _run_helper()
    # The helper writes a single JSON object to stdout, line-delimited.
    payload = json.loads(stdout)
    assert payload.get("sentinel") == "ok", (
        f"sentinel scenario failed: {payload!r}"
    )
    assert payload.get("live") == "ok", (
        f"live scenario failed: {payload!r}"
    )


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))