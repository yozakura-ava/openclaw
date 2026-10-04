#!/usr/bin/env python3
"""
Regression test for card 7decbc47-2073-49df-945d-73f7f35ef9fa.

Bug: Workboard expired claims on review-status cards still fence mutations.
The bounded dispatch pass (store.ts:479) reaps running cards but skips
review/done-adjacent statuses; once a worker session ends, the orchestrator
stalls ~30 min waiting out the claim TTL.

Acceptance criteria (from the card):
  - the reaper (extensions/workboard/src/reaper.ts) clears expired claims on
    review-status cards using the STABLE isWorkboardClaimReclaimable API;
  - sentinel claims (expiresAt=0) on review-status cards are reaped;
  - live claims (expiresAt future) are NOT reaped;
  - running-status cards with expired claims are NOT touched by the reaper
    (the dispatch pass owns that path);
  - claimless review-status cards are a no-op;
  - the selector is pure / deterministic.

This test drives the ACTUAL TypeScript plugin code via tsx subprocess — no
mocks, real sqlite-backed workboard, real isWorkboardClaimReclaimable and
real store.claim() / store.updateCard().

HR5 scoped: invokes a single TS helper script and asserts on JSON output.
No full vitest run, no full pytest collection, no full-repo tsc.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest


WORKTREE = Path(__file__).resolve().parent.parent
HELPER_REL = "tests/workboard_reaper_helper.mts"


def _run_helper() -> dict:
    """Spawn the TS helper via tsx and return the parsed JSON payload.

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
            f"workboard_reaper_helper exited {proc.returncode}"
        )
    return json.loads(proc.stdout)


def test_reaper_clears_review_expired_claim():
    """Review-status card with an expired claim is reaped and fresh-claimable."""
    payload = _run_helper()
    assert payload.get("review_expired") == "ok", (
        f"review_expired scenario failed: {payload!r}"
    )


def test_reaper_clears_review_sentinel_claim():
    """Review-status card with dispatcher release-sentinel (expiresAt=0) is reaped."""
    payload = _run_helper()
    assert payload.get("review_sentinel") == "ok", (
        f"review_sentinel scenario failed: {payload!r}"
    )


def test_reaper_leaves_review_live_claim_intact():
    """Review-status card with a live claim is NOT reaped; cross-owner still fenced."""
    payload = _run_helper()
    assert payload.get("review_live") == "ok", (
        f"review_live scenario failed: {payload!r}"
    )


def test_reaper_skips_running_status():
    """Running-status card with expired claim is NOT touched by the reaper.

    The bounded dispatch pass at store.ts:479 owns the running path; the
    reaper's eligibleStatuses defaults to ["review"] to avoid stepping on it.
    """
    payload = _run_helper()
    assert payload.get("running_expired") == "ok", (
        f"running_expired scenario failed: {payload!r}"
    )


def test_reaper_no_op_on_claimless_card():
    """Claimless review-status card is left alone."""
    payload = _run_helper()
    assert payload.get("no_claim") == "ok", (
        f"no_claim scenario failed: {payload!r}"
    )


def test_reaper_selector_is_pure_and_deterministic():
    """selectExpiredClaimsForReaping is a pure function on its inputs."""
    payload = _run_helper()
    assert payload.get("pure_selector") == "ok", (
        f"pure_selector scenario failed: {payload!r}"
    )


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))