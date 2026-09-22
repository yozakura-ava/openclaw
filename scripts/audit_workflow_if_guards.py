#!/usr/bin/env python3
"""
Card 1c9e249a-f8ef-43c6-b062-7eb8981095ea — workflow if-guard audit.

Reports three counts across all non-KEEP workflow files under
.github/workflows/:

  - no_if       : total jobs (top-level under `jobs:`) lacking any `if:` key
                  (these execute unconditionally unless guarded via a parent)
  - root_no_if  : subset of `no_if` whose job has no `needs:` chain
                  (these execute by default and MUST be guarded with `if: false`)
  - bad_if      : jobs whose existing `if:` value is NOT a hard-disable
                  (literal `false` or `${{ false }}`)

KEEP set (excluded from audit, expected to legitimately lack top-level guards):
  ci.yml, codeql.yml, docs.yml, dependency-audit.yml.

This audit script is what Ava re-runs after the fix script. Output format is
the keyword `audit:` followed by `no_if <N>, root_no_if <N>, bad_if <N>`. A
clean post-fix run prints `audit: no_if 0, root_no_if 0, bad_if 0`.

Run from worktree root:

    python3 scripts/audit_workflow_if_guards.py

Optional flag: `--workflow-dir <path>` to override the default
`.github/workflows`.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import yaml

KEEP = {"ci.yml", "codeql.yml", "docs.yml", "dependency-audit.yml"}


def is_hard_false(v) -> bool:
    """True if the value is a literal hard-disable guard.

    Mirrors the helper in fix_workflow_if_guards.py: literal `false`,
    `${{ false }}`, `false || true`, and `${{ false }} || true`.
    """
    if v is False:
        return True
    if isinstance(v, str):
        s = v.strip()
        if s == "false":
            return True
        if s == "${{ false }}":
            return True
        if s in ("${{ false }} || true", "false || true"):
            return True
        return False
    return False


def _ensure_mapping(v, what: str) -> dict | None:
    if v is None:
        return {}
    if not isinstance(v, dict):
        print(f"WARN: {what} is not a mapping (got {type(v).__name__}); skipping", file=sys.stderr)
        return None
    return v


def audit_workflows(workflow_dir: Path) -> dict:
    """Walk every *.yml in `workflow_dir` and count guard violations.

    Returns a dict with:
      - total_files: number of non-KEEP workflow files seen
      - yaml_errors: list of (filename, error) for files that failed parse
      - no_if:       list of "file:job" entries with no `if:` key
      - root_no_if:  subset of no_if where the job has no `needs:` (root jobs)
      - bad_if:      list of "file:job" with non-hard-false `if:` value
    """
    report = {
        "total_files": 0,
        "yaml_errors": [],
        "no_if": [],
        "root_no_if": [],
        "bad_if": [],
    }

    if not workflow_dir.is_dir():
        print(f"ERROR: {workflow_dir} is not a directory", file=sys.stderr)
        return report

    for path in sorted(workflow_dir.glob("*.yml")):
        if path.name in KEEP:
            continue

        report["total_files"] += 1

        try:
            with path.open() as fh:
                doc = yaml.safe_load(fh)
        except yaml.YAMLError as e:
            report["yaml_errors"].append((path.name, str(e)))
            continue

        if not isinstance(doc, dict):
            continue

        jobs = doc.get("jobs")
        if not isinstance(jobs, dict):
            continue

        for jname, jdef in jobs.items():
            jm = _ensure_mapping(jdef, f"{path.name}:jobs.{jname}")
            if jm is None:
                continue

            needs = jm.get("needs")
            is_root = needs is None  # absence of needs => root job

            ifc = jm.get("if", "__MISSING__")

            if ifc == "__MISSING__":
                tag = f"{path.name}:{jname}"
                report["no_if"].append(tag)
                if is_root:
                    report["root_no_if"].append(tag)
                continue

            if not is_hard_false(ifc):
                report["bad_if"].append(f"{path.name}:{jname}")

    return report


def main() -> int:
    parser = argparse.ArgumentParser(description="Audit workflow if-guard coverage")
    parser.add_argument(
        "--workflow-dir",
        default=".github/workflows",
        help="Path to workflows directory (default: .github/workflows)",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Print per-file findings, not just counts",
    )
    args = parser.parse_args()

    workflow_dir = Path(args.workflow_dir)
    report = audit_workflows(workflow_dir)

    no_if_n = len(report["no_if"])
    root_n = len(report["root_no_if"])
    bad_n = len(report["bad_if"])

    print(
        f"audit: no_if {no_if_n}, "
        f"root_no_if {root_n}, "
        f"bad_if {bad_n} "
        f"(across {report['total_files']} non-KEEP workflows)"
    )

    if report["yaml_errors"]:
        print("---YAML ERRORS---")
        for fn, err in report["yaml_errors"]:
            print(f"  {fn}: {err}")

    if args.verbose:
        if report["no_if"]:
            print("---no_if jobs---")
            for tag in report["no_if"]:
                print(f"  {tag}")
        if report["root_no_if"]:
            print("---root_no_if jobs---")
            for tag in report["root_no_if"]:
                print(f"  {tag}")
        if report["bad_if"]:
            print("---bad_if jobs---")
            for tag in report["bad_if"]:
                print(f"  {tag}")

    # Exit nonzero if any violation remains (so Ava can `set -e`-gate verify).
    return 0 if (no_if_n == 0 and root_n == 0 and bad_n == 0) else 1


if __name__ == "__main__":
    sys.exit(main())
