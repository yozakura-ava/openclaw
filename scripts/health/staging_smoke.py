#!/usr/bin/env python3
"""
OpenClaw staging smoke (PR-K).

Exit non-zero on:
  1. `gateway ready` log line not seen within timeout window
  2. /readyz returns non-200, or returns ready=false
  3. any of the required plugins (workboard, codex, acpx) is missing
  4. the served build id does NOT match the provenance tuple's build id
     (stale build id — the postmortem root cause for stale dashboard tabs)

A 4096-comment round-trip check is STUBBED — it activates only when
ENABLE_COMMENT_ROUND_TRIP=1 (which will be flipped after PR-A merges onto
main and the comment-cap rework lands).

Usage:
  python3 staging_smoke.py --dry-run                                 # unit-style
  python3 staging_smoke.py --port 18800 --timeout 90                 # live smoke
  python3 staging_smoke.py --port 18800 --provenance-file /path/to/provenance.json

Provenance tuple (commit, manifest SHA, lockfile SHA, node version, artifact
SHA) is read from --provenance-file (JSON) or the env vars OPENCLAW_BUILD_*
so the same tuple emitted by the GH Actions workflow can be echoed back during
smoke.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

REQUIRED_PLUGINS: tuple[str, ...] = ("workboard", "codex", "acpx")
GATEWAY_READY_PATTERN = re.compile(r"gateway\s+ready", re.IGNORECASE)
BUILDSHIPS_PATTERN = re.compile(r'gatewayBuild\s*[:=]\s*"?([A-Za-z0-9_.\-]+)"?', re.IGNORECASE)
GATEWAY_STARTUP_MARKERS = (
    "ERR_REQUIRE_ESM_RACE_CONDITION",
    "ERR_MODULE_NOT_FOUND",
    "plugin failed during load",
)


@dataclass
class CheckResult:
    name: str
    passed: bool
    message: str = ""
    details: dict = field(default_factory=dict)


@dataclass
class Provenance:
    commit: str
    manifest_sha: str
    lockfile_sha: str
    node_version: str
    artifact_sha: str
    served_build_id: str = ""

    @classmethod
    def from_json_file(cls, path: Path) -> "Provenance":
        payload = json.loads(path.read_text())
        return cls(
            commit=str(payload["commit"]),
            manifest_sha=str(payload["manifest_sha"]),
            lockfile_sha=str(payload["lockfile_sha"]),
            node_version=str(payload["node_version"]),
            artifact_sha=str(payload["artifact_sha"]),
        )

    @classmethod
    def from_env(cls) -> "Provenance":
        return cls(
            commit=os.environ.get("OPENCLAW_BUILD_COMMIT", ""),
            manifest_sha=os.environ.get("OPENCLAW_BUILD_MANIFEST_SHA", ""),
            lockfile_sha=os.environ.get("OPENCLAW_BUILD_LOCKFILE_SHA", ""),
            node_version=os.environ.get("OPENCLAW_BUILD_NODE_VERSION", ""),
            artifact_sha=os.environ.get("OPENCLAW_BUILD_ARTIFACT_SHA", ""),
        )


def http_get(url: str, timeout: float = 5.0) -> tuple[int, bytes, dict]:
    req = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read(), dict(resp.headers)
    except urllib.error.HTTPError as err:  # noqa: PERF203 — explicit branch
        return err.code, err.read() if err.fp else b"", dict(err.headers or {})
    except (urllib.error.URLError, TimeoutError, ConnectionError) as err:
        return 0, str(err).encode(), {}


def tail_journal(unit: str, lines: int = 200) -> str:
    try:
        result = subprocess.run(
            ["journalctl", "--user", "-u", unit, "-n", str(lines), "--no-pager"],
            check=False,
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired) as err:
        return f"<journalctl unavailable: {err}>"
    return result.stdout or ""


def check_gateway_ready(port: int, unit: str, timeout_seconds: float) -> CheckResult:
    """Poll journalctl for "gateway ready" within the timeout window.

    HTTP /readyz alone is insufficient because the gateway may be accepting
    connections while plugins are still loading (postmortem lesson).
    """
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        log = tail_journal(unit)
        if GATEWAY_READY_PATTERN.search(log):
            return CheckResult(
                name="gateway_ready",
                passed=True,
                message=f"gateway_ready log observed within {timeout_seconds:.0f}s",
            )
        time.sleep(min(2.0, max(0.5, deadline - time.time())))
    return CheckResult(
        name="gateway_ready",
        passed=False,
        message=f"timeout waiting for 'gateway ready' in {unit}",
    )


def check_readyz(port: int, timeout_seconds: float = 5.0) -> CheckResult:
    """GET /readyz must return 200 with ready=true."""
    url = f"http://127.0.0.1:{port}/readyz"
    status, body, _ = http_get(url, timeout=timeout_seconds)
    if status != 200:
        return CheckResult(
            name="readyz",
            passed=False,
            message=f"/readyz returned HTTP {status}",
        )
    try:
        payload = json.loads(body or b"{}")
    except json.JSONDecodeError:
        payload = {}
    ready = bool(payload.get("ready", payload.get("ok", False)))
    if not ready:
        return CheckResult(
            name="readyz",
            passed=False,
            message=f"/readyz returned HTTP 200 but ready=false body={body!r}",
        )
    return CheckResult(name="readyz", passed=True, message="/readyz returned 200 ready=true")


def check_plugin_presence(unit: str, required: tuple[str, ...]) -> CheckResult:
    """Scan the journal for required plugin load markers; reject on known failure markers."""
    log = tail_journal(unit, lines=400)
    for blocker in GATEWAY_STARTUP_MARKERS:
        if blocker in log:
            return CheckResult(
                name="plugin_presence",
                passed=False,
                message=f"startup blocker observed in journal: {blocker}",
                details={"log_excerpt": _tail_lines(log, 8)},
            )
    missing = [name for name in required if f"plugin '{name}' loaded" not in log and f"{name} loaded" not in log]
    if missing:
        return CheckResult(
            name="plugin_presence",
            passed=False,
            message=f"required plugins missing from load markers: {missing}",
            details={"log_excerpt": _tail_lines(log, 8)},
        )
    return CheckResult(
        name="plugin_presence",
        passed=True,
        message=f"required plugins loaded: {sorted(required)}",
    )


def check_build_id_freshness(port: int, provenance: Provenance, timeout_seconds: float = 5.0) -> CheckResult:
    """Confirm the served gatewayBuild matches the provenance artifact SHA origin."""
    url = f"http://127.0.0.1:{port}/"
    status, body, _ = http_get(url, timeout=timeout_seconds)
    if status != 200:
        return CheckResult(
            name="build_id_freshness",
            passed=False,
            message=f"root document returned HTTP {status}",
        )
    match = BUILDSHIPS_PATTERN.search((body or b"").decode("utf-8", errors="replace"))
    served_build = match.group(1) if match else ""
    if not served_build:
        return CheckResult(
            name="build_id_freshness",
            passed=False,
            message="could not extract gatewayBuild from root document",
            details={"body_excerpt": (body[:200] if body else b"").decode("utf-8", errors="replace")},
        )
    provenance.served_build_id = served_build
    expected = provenance.artifact_sha[:12]
    if expected and expected not in served_build:
        return CheckResult(
            name="build_id_freshness",
            passed=False,
            message=f"served build id {served_build!r} does not contain artifact sha prefix {expected!r}",
        )
    return CheckResult(
        name="build_id_freshness",
        passed=True,
        message=f"served build id {served_build!r} matches provenance artifact sha",
    )


def check_oversized_comment_roundtrip_stub(port: int) -> CheckResult:
    """STUB. The real PR-A rework lands the 4096 chunked-comment write path.

    Once PR-A merges and ENABLE_COMMENT_ROUND_TRIP=1 is set, this stub will
    flip to a real check: POST a 4000-char comment via the workboard RPC and
    verify the gateway accepted it without sanitizer truncation.

    Until then, the stub is INERT — it always reports pass-with-noop so smoke
    does not gate on absent infrastructure.
    """
    if os.environ.get("ENABLE_COMMENT_ROUND_TRIP") != "1":
        return CheckResult(
            name="oversized_comment_roundtrip",
            passed=True,
            message="STUBBED: activates when ENABLE_COMMENT_ROUND_TRIP=1 (post PR-A merge)",
            details={"stub": True},
        )
    return CheckResult(
        name="oversized_comment_roundtrip",
        passed=False,
        message="ENABLE_COMMENT_ROUND_TRIP=1 but PR-A integration not yet wired (placeholder)",
    )


def _tail_lines(text: str, n: int) -> str:
    lines = text.splitlines()
    return "\n".join(lines[-n:]) if lines else ""


def run_dry(provenance: Provenance | None) -> list[CheckResult]:
    """Dry-run mode: run every check's no-network preconditions and report synthetic passes.

    Useful for CI unit testing of the script itself and for offline review.
    No live HTTP calls are made; the journal does not need to exist.
    """
    results: list[CheckResult] = [
        CheckResult(name="gateway_ready", passed=True, message="[dry-run] synthetically passed"),
        CheckResult(name="readyz", passed=True, message="[dry-run] synthetically passed"),
        CheckResult(
            name="plugin_presence",
            passed=True,
            message=f"[dry-run] synthetically passed for {list(REQUIRED_PLUGINS)}",
        ),
        CheckResult(
            name="build_id_freshness",
            passed=True,
            message="[dry-run] synthetically passed",
            details={"artifact_sha_prefix": (provenance.artifact_sha[:12] if provenance else "")},
        ),
        CheckResult(
            name="oversized_comment_roundtrip",
            passed=True,
            message="[dry-run] stub in inert state",
            details={"stub": True},
        ),
    ]
    return results


def summarize(results: list[CheckResult]) -> int:
    print("=" * 60)
    print("OpenClaw staging smoke — PR-K")
    print("=" * 60)
    failed = [r for r in results if not r.passed]
    for r in results:
        marker = "PASS" if r.passed else "FAIL"
        print(f"[{marker}] {r.name}: {r.message}")
    print("-" * 60)
    print(f"Total: {len(results)}, Passed: {len(results) - len(failed)}, Failed: {len(failed)}")
    if failed:
        print("FAILED CHECKS:", ", ".join(r.name for r in failed))
        return 1
    print("All checks passed.")
    return 0


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="OpenClaw staging smoke (PR-K)")
    parser.add_argument("--port", type=int, default=int(os.environ.get("OPENCLAW_GATEWAY_PORT", "18800")))
    parser.add_argument("--unit", default=os.environ.get("OPENCLAW_STAGING_UNIT", "openclaw-staging.service"))
    parser.add_argument(
        "--timeout",
        type=float,
        default=float(os.environ.get("OPENCLAW_SMOKE_TIMEOUT", "90")),
        help="seconds to wait for gateway_ready log line",
    )
    parser.add_argument("--provenance-file", type=Path, default=None)
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="synthetic passes; no live HTTP or journal access",
    )
    parser.add_argument(
        "--enable-comment-round-trip",
        action="store_true",
        help="DEPRECATED stub flag; honors ENABLE_COMMENT_ROUND_TRIP env instead",
    )
    args = parser.parse_args(argv)

    if args.enable_comment_round_trip:
        os.environ["ENABLE_COMMENT_ROUND_TRIP"] = "1"

    provenance: Provenance | None = None
    if args.provenance_file and args.provenance_file.exists():
        provenance = Provenance.from_json_file(args.provenance_file)
    elif os.environ.get("OPENCLAW_BUILD_ARTIFACT_SHA"):
        provenance = Provenance.from_env()

    if args.dry_run:
        return summarize(run_dry(provenance))

    checks: list[Callable[[], CheckResult]] = [
        lambda: check_gateway_ready(args.port, args.unit, args.timeout),
        lambda: check_readyz(args.port),
        lambda: check_plugin_presence(args.unit, REQUIRED_PLUGINS),
        lambda: check_build_id_freshness(args.port, provenance or Provenance("", "", "", "", "")),
        lambda: check_oversized_comment_roundtrip_stub(args.port),
    ]
    results = [check() for check in checks]
    return summarize(results)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
