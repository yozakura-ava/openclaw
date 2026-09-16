#!/usr/bin/env python3
"""
Card 1c9e249a-f8ef-43c6-b062-7eb8981095ea — r3 fix.

Iterates every non-KEEP workflow under .github/workflows/, finds every
top-level job whose `if:` condition is NOT a hard-disable (i.e. NOT
literal `false` / `${{ false }}`), and replaces the condition with
`if: false` while commenting out the original value(s) for audit.

Supports both inline `if: <expr>` and block-scalar `if: >-` / `if: |-`
forms.

KEEP set (untouched): ci.yml, codeql.yml, docs.yml, dependency-audit.yml.

Run from worktree root.
"""

from __future__ import annotations

import os
import sys
import re
import shutil
from pathlib import Path
import yaml

WORKFLOW_DIR = Path(".github/workflows")
KEEP = {"ci.yml", "codeql.yml", "docs.yml", "dependency-audit.yml"}
COMMENT_PREFIX = "# Card 1c9e249a r3: original if-condition replaced by if: false (sprint 2026-09-16-debt-p2);"


def is_hard_false(v) -> bool:
    if v is False:
        return True
    if isinstance(v, str):
        s = v.strip()
        if s in ("false",):
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
    """
    Given an `if:` line value (the part after 'if:'), return the block
    scalar style if present, else None.

    Returns one of: '|', '>', '|-', '>-', '|+', '>+', '|2-', etc.
    """
    stripped = value_line.strip()
    # block scalar header
    m = re.match(r"^([|>])([+\-]?\d*[+\-]?)$", stripped)
    if m:
        return m.group(0)
    return None


def find_job_block(
    lines: list[str], job_indent: int, start: int
) -> tuple[int, int]:
    """
    Return (start_line_idx, end_line_idx_exclusive) for the body of the
    job starting at `start` (the line with `<jobname>:`). Body is all
    contiguous lines whose indent is strictly > job_indent.
    """
    end = len(lines)
    for i in range(start + 1, len(lines)):
        ln = lines[i]
        if ln.strip() == "" or ln.lstrip().startswith("#"):
            continue
        ind = indent_of_line(ln)
        if ind <= job_indent:
            end = i
            break
    return start, end


def find_block_scalar_range(
    lines: list[str], header_idx: int, header_indent: int
) -> tuple[int, int]:
    """
    For a line like `    if: >-`, find the range of continuation lines
    that are part of the block scalar (indented strictly more than
    header_indent). Return (header_idx, end_idx_exclusive).
    """
    end = len(lines)
    for i in range(header_idx + 1, len(lines)):
        ln = lines[i]
        if ln.strip() == "" or ln.lstrip().startswith("#"):
            # blank/comment line within block — stop at end of block
            # (conservative: don't merge across blanks)
            break
        ind = indent_of_line(ln)
        if ind <= header_indent:
            end = i
            break
    return header_idx, end


def collect_original_if(lines: list[str], start: int, end: int) -> str:
    """
    Collect the textual content of the original `if:` block (header +
    continuation) as a single string for the comment.
    """
    return "\n".join(lines[start:end])


def replace_job_if_with_false(
    lines: list[str], job_start: int, job_end: int, comment_text: str
) -> list[str]:
    """
    Within the job body (lines[job_start+1 : job_end]), find the `if:`
    key (at job_indent + 2) and replace its value with `false`. Returns
    a new lines list.

    Strategy:
      - Compute job_indent from the `<jobname>:` line.
      - Scan job body for a line at indent == job_indent + 2 that starts
        with `if:` (after stripping).
      - If the value is a block scalar header, find the continuation
        range; replace the whole range with one comment line + one
        `if: false` line.
      - Otherwise inline: replace just the value portion of that line
        and add a trailing inline comment with the original.

    `comment_text` is the original `if:` value (one or many lines) used
    for the audit comment.
    """
    job_indent = indent_of_line(lines[job_start])
    target_indent = job_indent + 2
    target_prefix = " " * target_indent + "if:"

    # locate the `if:` line within the job body
    body_indices = []
    for i in range(job_start + 1, job_end):
        ln = lines[i]
        if ln.strip() == "" or ln.lstrip().startswith("#"):
            continue
        if indent_of_line(ln) != target_indent:
            continue
        # stripped text must START with `if:`
        if ln.lstrip().startswith("if:"):
            body_indices.append(i)

    if not body_indices:
        # no if: line found at this level — nothing to do
        return lines

    # Replace from last to first to keep indices stable
    new_lines = list(lines)
    for if_idx in reversed(body_indices):
        if_line = new_lines[if_idx]
        # split into prefix and value (after `if:`)
        m = re.match(r"^(\s*)if:(.*)$", if_line)
        if not m:
            continue
        prefix_ws = m.group(1)
        rest = m.group(2)  # everything after `if:`

        # Detect block scalar header in rest
        bs = detect_block_scalar_kind(rest)
        if bs is not None:
            # find continuation range in current new_lines
            header_idx = if_idx
            bs_start, bs_end = find_block_scalar_range(
                new_lines, header_idx, len(prefix_ws)
            )
            # Collect original block for comment
            original_block = "\n".join(new_lines[bs_start:bs_end])
            comment_line = (
                f"{prefix_ws}{COMMENT_PREFIX}\n"
                f"{prefix_ws}# original:\n"
                + "\n".join(
                    f"{prefix_ws}# {ol.lstrip()}"
                    for ol in new_lines[bs_start:bs_end]
                    if ol.strip()
                )
            )
            replacement = (
                comment_line + f"\n{prefix_ws}if: false"
            )
            # Splice: replace new_lines[bs_start:bs_end] with replacement
            new_lines[bs_start:bs_end] = [replacement]
        else:
            # inline form: replace value, comment original
            original_value = rest.strip()
            new_line = f"{prefix_ws}if: false  # original if: {original_value}"
            new_lines[if_idx] = new_line

    return new_lines


def fix_workflow_file(path: Path) -> tuple[bool, str]:
    """
    Process one workflow file. Returns (changed?, summary).
    """
    if path.name in KEEP:
        return False, "KEEP — untouched"

    text = path.read_text()
    try:
        with path.open() as fh:
            doc = yaml.safe_load(fh)
    except Exception as e:
        return False, f"YAML parse error: {e}"

    if not isinstance(doc, dict):
        return False, "not a mapping"
    jobs = doc.get("jobs") or {}
    if not isinstance(jobs, dict):
        return False, "no jobs mapping"

    bad_jobs = []
    for jname, jdef in jobs.items():
        if not isinstance(jdef, dict):
            continue
        ifc = jdef.get("if")
        if ifc is None:
            continue
        if not is_hard_false(ifc):
            bad_jobs.append(jname)

    if not bad_jobs:
        return False, "no non-hard-false job ifs"

    lines = text.splitlines(keepends=False)

    # Locate each `jobs:` block and the start of each named job.
    # We'll rebuild `lines` by iterating top-level jobs in order.
    new_lines = list(lines)

    # Find `jobs:` line (top-level)
    jobs_line_idx = None
    for i, ln in enumerate(lines):
        if re.match(r"^jobs:\s*(#.*)?$", ln):
            jobs_line_idx = i
            break
    if jobs_line_idx is None:
        return False, "no top-level jobs: found"

    jobs_indent = 0  # `jobs:` is top-level

    # Find each job-name line under `jobs:`
    job_starts: list[tuple[str, int]] = []
    for i in range(jobs_line_idx + 1, len(lines)):
        ln = lines[i]
        if ln.strip() == "" or ln.lstrip().startswith("#"):
            continue
        ind = indent_of_line(ln)
        if ind <= jobs_indent:
            break
        if ind == 2:
            m = re.match(r"^  ([A-Za-z0-9_-]+):\s*(#.*)?$", ln)
            if m:
                job_starts.append((m.group(1), i))

    # Apply replacements from BOTTOM to TOP so line indices stay valid
    # for subsequent edits at earlier positions.
    for jname, jstart in reversed(job_starts):
        if jname not in bad_jobs:
            continue
        # compute job_end = next sibling job start or EOF
        idx_in_list = next(
            (k for k, (n, _) in enumerate(job_starts) if n == jname), None
        )
        if idx_in_list is None:
            continue
        if idx_in_list + 1 < len(job_starts):
            job_end = job_starts[idx_in_list + 1][1]
        else:
            job_end = len(lines)

        new_lines = replace_job_if_with_false(
            new_lines, jstart, job_end, ""
        )

    new_text = "\n".join(new_lines)
    if not new_text.endswith("\n"):
        new_text += "\n"

    # Re-parse to validate
    try:
        yaml.safe_load(new_text)
    except Exception as e:
        return False, f"YAML validation failed after rewrite: {e}"

    path.write_text(new_text)
    return True, f"fixed {len(bad_jobs)} job(s): {', '.join(bad_jobs)}"


def main():
    os.chdir(
        "/root/.openclaw/openclaw-canonical/.worktrees/riko-1c9e249a-fork-ci-cleanup"
    )

    if not WORKFLOW_DIR.is_dir():
        print(f"ERROR: {WORKFLOW_DIR} not found from cwd", file=sys.stderr)
        sys.exit(2)

    summary = []
    for p in sorted(WORKFLOW_DIR.glob("*.yml")):
        changed, info = fix_workflow_file(p)
        if changed:
            summary.append(f"FIX  {p.name}: {info}")
        else:
            summary.append(f"SKIP {p.name}: {info}")

    # Print only files we changed (plus KEEP / errors)
    for line in summary:
        if line.startswith("FIX ") or "YAML" in line or "KEEP" in line:
            print(line)
    print(f"\nTotal changed files: {sum(1 for s in summary if s.startswith('FIX '))}")


if __name__ == "__main__":
    main()
