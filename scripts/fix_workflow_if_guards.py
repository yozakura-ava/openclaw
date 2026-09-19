#!/usr/bin/env python3
"""
Card 1c9e249a-f8ef-43c6-b062-7eb8981095ea — workflow if-guard fixer.

Two passes per non-KEEP workflow file under .github/workflows/:

  Pass A — REPLACE existing `if:` conditions with hard `if: false`.
           Handles inline (`if: <expr>`) and block-scalar (`if: >-` /
           `if: |-`) forms. Keeps the original expression as a YAML
           comment for audit.

  Pass B — ADD `if: false` to jobs that lack any `if:` condition
           entirely. Inserted as the first key after the job-name line,
           with a YAML comment explaining the guard.

KEEP set (untouched): ci.yml, codeql.yml, docs.yml, dependency-audit.yml.

Run from worktree root:

    python3 scripts/fix_workflow_if_guards.py

After running, verify with:

    python3 scripts/audit_workflow_if_guards.py

A clean post-fix run prints:

    audit: no_if 0, root_no_if 0, bad_if 0 (across N non-KEEP workflows)
"""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path

import yaml

WORKFLOW_DIR = Path(".github/workflows")
KEEP = {"ci.yml", "codeql.yml", "docs.yml", "dependency-audit.yml"}
COMMENT_REPLACE = (
    "# Card 1c9e249a r3: original if-condition replaced by if: false "
    "(sprint 2026-09-16-debt-p2);"
)
COMMENT_ADD = (
    "# Card 1c9e249a r4: added if: false to guard previously-unconditional job "
    "(sprint 2026-09-16-debt-p2);"
)


def is_hard_false(v) -> bool:
    """True if the value is a literal hard-disable guard."""
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


def indent_of_line(text: str) -> int:
    return len(text) - len(text.lstrip(" "))


def detect_block_scalar_kind(value_line: str) -> str | None:
    """Detect |, >, |-, >-, |+, >+ block-scalar header in value part."""
    stripped = value_line.strip()
    m = re.match(r"^([|>])([+\-]?\d*[+\-]?)$", stripped)
    if m:
        return m.group(0)
    return None


def find_block_scalar_range(
    lines: list[str], header_idx: int, header_indent: int
) -> tuple[int, int]:
    """Return (header_idx, end_idx_exclusive) for a |- or >- block scalar."""
    end = len(lines)
    for i in range(header_idx + 1, len(lines)):
        ln = lines[i]
        if ln.strip() == "" or ln.lstrip().startswith("#"):
            break
        ind = indent_of_line(ln)
        if ind <= header_indent:
            end = i
            break
    return header_idx, end


def replace_inline_if(
    new_lines: list[str], if_idx: int, original_value: str
) -> None:
    """Mutate new_lines: replace inline `if: <value>` line with `if: false`
    plus a trailing inline comment preserving original."""
    if_line = new_lines[if_idx]
    m = re.match(r"^(\s*)if:(.*)$", if_line)
    if not m:
        return
    prefix_ws = m.group(1)
    new_line = f"{prefix_ws}if: false  # original if: {original_value}"
    new_lines[if_idx] = new_line


def replace_block_if(
    new_lines: list[str], if_idx: int, prefix_ws: str
) -> int:
    """Mutate new_lines: replace a block-scalar `if:` value with
    `if: false`. Returns the new index (next line after splice) so the
    caller can continue iterating if needed."""
    header_indent = len(prefix_ws)
    bs_start, bs_end = find_block_scalar_range(new_lines, if_idx, header_indent)
    original_block = "\n".join(new_lines[bs_start:bs_end])
    commented = "\n".join(
        f"{prefix_ws}# {ol.lstrip()}" for ol in new_lines[bs_start:bs_end] if ol.strip()
    )
    replacement = (
        f"{prefix_ws}{COMMENT_REPLACE}\n"
        f"{prefix_ws}# original:\n"
        f"{commented}\n"
        f"{prefix_ws}if: false"
    )
    new_lines[bs_start:bs_end] = [replacement]
    return bs_start + 1


def add_if_false_to_job(new_lines: list[str], job_start: int, job_indent: int) -> None:
    """Insert `    if: false  # Card 1c9e249a r4: ...` as the FIRST key
    immediately after the <jobname>: line. Mutates new_lines in place."""
    target_indent = job_indent + 2
    prefix_ws = " " * target_indent
    insertion = f"{prefix_ws}if: false  {COMMENT_ADD}"
    new_lines.insert(job_start + 1, insertion)


def fix_workflow_file(path: Path) -> tuple[bool, str]:
    """Process one workflow file. Returns (changed?, summary)."""
    if path.name in KEEP:
        return False, "KEEP — untouched"

    text = path.read_text()
    try:
        with path.open() as fh:
            doc = yaml.safe_load(fh)
    except yaml.YAMLError as e:
        return False, f"YAML parse error: {e}"

    if not isinstance(doc, dict):
        return False, "not a mapping"
    jobs = doc.get("jobs")
    if not isinstance(jobs, dict):
        return False, "no jobs mapping"

    # Classify every job.
    replace_jobs: list[str] = []   # has if: but not hard-false
    add_jobs: list[str] = []        # has no if: at all
    for jname, jdef in jobs.items():
        if not isinstance(jdef, dict):
            continue
        if "if" not in jdef:
            add_jobs.append(jname)
        else:
            if not is_hard_false(jdef.get("if")):
                replace_jobs.append(jname)

    if not replace_jobs and not add_jobs:
        return False, "no non-hard-false or missing job ifs"

    lines = text.splitlines(keepends=False)
    new_lines = list(lines)

    # Find top-level `jobs:` line.
    jobs_line_idx = None
    for i, ln in enumerate(lines):
        if re.match(r"^jobs:\s*(#.*)?$", ln):
            jobs_line_idx = i
            break
    if jobs_line_idx is None:
        return False, "no top-level jobs: found"

    # Find each job-name line under `jobs:` (indent == 2).
    job_starts: list[tuple[str, int]] = []
    for i in range(jobs_line_idx + 1, len(lines)):
        ln = lines[i]
        if ln.strip() == "" or ln.lstrip().startswith("#"):
            continue
        ind = indent_of_line(ln)
        if ind <= 0:
            break
        if ind == 2:
            m = re.match(r"^  ([A-Za-z0-9_-]+):\s*(#.*)?$", ln)
            if m:
                job_starts.append((m.group(1), i))

    if not job_starts:
        return False, "no job definitions found"

    # Apply replacements and insertions from BOTTOM to TOP to keep indices
    # stable for subsequent edits at earlier positions.
    job_index_by_name = {name: idx for idx, (name, _) in enumerate(job_starts)}
    ordered = list(reversed(job_starts))

    for jname, jstart in ordered:
        if jname in add_jobs:
            job_indent = indent_of_line(new_lines[jstart])
            add_if_false_to_job(new_lines, jstart, job_indent)
            continue

        if jname in replace_jobs:
            job_indent = indent_of_line(new_lines[jstart])
            target_indent = job_indent + 2
            target_prefix = " " * target_indent + "if:"

            if_idx = None
            for i in range(jstart + 1, len(new_lines)):
                ln = new_lines[i]
                if ln.strip() == "" or ln.lstrip().startswith("#"):
                    continue
                ind = indent_of_line(ln)
                if ind <= job_indent:
                    break
                if ind == target_indent and ln.lstrip().startswith("if:"):
                    if_idx = i
                    break

            if if_idx is None:
                continue

            if_line = new_lines[if_idx]
            m = re.match(r"^(\s*)if:(.*)$", if_line)
            if not m:
                continue
            prefix_ws = m.group(1)
            rest = m.group(2)

            if detect_block_scalar_kind(rest) is not None:
                replace_block_if(new_lines, if_idx, prefix_ws)
            else:
                original_value = rest.strip()
                replace_inline_if(new_lines, if_idx, original_value)

    new_text = "\n".join(new_lines)
    if not new_text.endswith("\n"):
        new_text += "\n"

    # Re-parse to confirm structural validity after rewriting.
    try:
        yaml.safe_load(new_text)
    except yaml.YAMLError as e:
        return False, f"YAML validation failed after rewrite: {e}"

    path.write_text(new_text)
    parts = []
    if replace_jobs:
        parts.append(f"replaced: {', '.join(replace_jobs)}")
    if add_jobs:
        parts.append(f"added: {', '.join(add_jobs)}")
    return True, "; ".join(parts)


def main() -> None:
    # Pin cwd to the worktree so this script is portable when invoked from
    # either /root/.openclaw/workspace or anywhere else with PATH set.
    os.chdir(
        "/root/.openclaw/openclaw-canonical/.worktrees/riko-1c9e249a-fork-ci-cleanup"
    )

    if not WORKFLOW_DIR.is_dir():
        print(f"ERROR: {WORKFLOW_DIR} not found from cwd", file=sys.stderr)
        sys.exit(2)

    summary: list[str] = []
    for p in sorted(WORKFLOW_DIR.glob("*.yml")):
        changed, info = fix_workflow_file(p)
        if changed:
            summary.append(f"FIX  {p.name}: {info}")
        elif "YAML" in info or "KEEP" in info:
            summary.append(f"NOTE {p.name}: {info}")

    for line in summary:
        print(line)
    n_files = sum(1 for s in summary if s.startswith("FIX "))
    print(f"\nTotal changed files: {n_files}")


if __name__ == "__main__":
    main()
