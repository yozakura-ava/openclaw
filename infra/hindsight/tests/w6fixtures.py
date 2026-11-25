"""Shared W6 test fixtures: synthetic curated corpus + manifest v1.2 writer.

Hermetic — everything lands in tempfile dirs; no network, no privileged ops.
"""

from __future__ import annotations

import hashlib
import json
import sys
import tempfile
from pathlib import Path

_TESTS_DIR = Path(__file__).resolve().parent
for p in (str(_TESTS_DIR), str(_TESTS_DIR.parent)):
    if p not in sys.path:
        sys.path.insert(0, p)

MTIME_BASE = 1793931141  # fixed epoch so receipts/ids are deterministic


def make_entries(tier_of: dict[str, str], *, mtime_base: int = MTIME_BASE,
                 with_sha: bool = False, root: Path | None = None) -> list[dict]:
    entries = []
    for i, (path, tier) in enumerate(sorted(tier_of.items())):
        e: dict = {
            "path": path,
            "tier": tier,
            "bytes": (root / path).stat().st_size if root else 1,
            "mtime": mtime_base + i * 3600,
        }
        if with_sha and root is not None:
            e["sha256"] = hashlib.sha256((root / path).read_bytes()).hexdigest()
        entries.append(e)
    return entries


def write_manifest(root: Path, tier_of: dict[str, str], *, with_sha: bool = False,
                   mtime_base: int = MTIME_BASE, counts_override: dict | None = None,
                   total_files_override: int | None = None) -> Path:
    entries = make_entries(tier_of, mtime_base=mtime_base, with_sha=with_sha, root=root)
    counts: dict[str, int] = {}
    for e in entries:
        counts[e["tier"]] = counts.get(e["tier"], 0) + 1
    if counts_override is not None:
        counts = counts_override
    manifest = {
        "ruleset": "curatorial-ruleset-v1.2",
        "created_utc": "2026-11-07T02:00:00Z",
        "purpose": "W6 fixture corpus (test)",
        "classification_rules": "fixture",
        "counts": counts,
        "total_files": len(entries) if total_files_override is None else total_files_override,
        "total_bytes": sum(e["bytes"] for e in entries),
        "inventory": entries,
        "ruleset_history": ["fixture"],
    }
    p = root / "curation-manifest-v1.2.json"
    p.write_text(json.dumps(manifest, indent=1), encoding="utf-8")
    return p


def write_files(root: Path, files: dict[str, str]) -> None:
    for path, content in files.items():
        f = root / path
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(content, encoding="utf-8")


def build_fixture(files: dict[str, str], tier_of: dict[str, str], *,
                  with_sha: bool = False, counts_override: dict | None = None,
                  total_files_override: int | None = None) -> tuple[Path, Path]:
    """Create corpus root + manifest in a fresh tempdir. Returns (root, manifest)."""
    root = Path(tempfile.mkdtemp(prefix="w6-fixture-"))
    write_files(root, files)
    manifest = write_manifest(
        root, tier_of, with_sha=with_sha,
        counts_override=counts_override,
        total_files_override=total_files_override,
    )
    return root, manifest


def default_corpus_spec() -> tuple[dict[str, str], dict[str, str]]:
    """(files, tier_of) for a small corpus touching every tier."""
    files = {
        "MEMORY.md": "# MEMORY\nCraig is the owner and operator of this estate.\n",
        "memory/2026-04-03.md": (
            "AYUAA-93 FTMO demo account setup blocked (HIGH).\n"
            "Sent Telegram alert to Craig with the issue breakdown.\n"
        ),
        "memory/2026-04-04.md": (
            "Focus recommended on AYUAA-172 (Media Manager recovery).\n"
        ),
        "memory/dup-a.md": "Identical body for exact-dup fixture coverage.\nLine two.\n",
        "memory/dup-b.md": "Identical body for exact-dup fixture coverage.\nLine two.\n",
        "memory/near-a.md": (
            "The deployment uses the blue-green strategy on the staging cluster "
            "with automated rollback triggers attached.\n"
        ),
        "memory/near-b.md": (
            "The deployment uses the blue-green strategy on the staging cluster "
            "with automated rollback triggers disabled.\n"
        ),
        "memory/same-a.md": (
            "Weekly review happens every Monday at ten in the morning covering "
            "sprint burn-down and the incident queue.\n"
        ),
        "memory/same-b.md": (
            "Weekly review happens every Monday at ten in the morning covering "
            "sprint burn-down and the incident queue.\n"
        ),
        "memory/derived-a.md": (
            "Conclusion: the retry budget should stay at three attempts because "
            "the bridge call backoff is 2/4/8 seconds.\n"
        ),
        "memory/secret-a.md": "Rotate the relay key sk-abcdef1234567890abcdef1234567890abc this week.\n",
        "memory/authority-a.md": "Owner authorizes the deployment of the new watcher on Friday.\n",
        "memory/.dreams/2026-05-29.md": "Dream log: the harbor was full of small boats at dawn.\n",
        "memory/mowc/MOWC-006.md": "Silence that was not a silence; episode confabulated under stress.\n",
        "memory/ghost/gw-001.md": "Ghost-window diary entry with unverifiable timestamps inside.\n",
        "wiki/drafts/reward-design.md": "Reward function design notes for the research draft.\n",
        "data/state/export.json": "{\"heartbeat\": \"cron-style operational echo\"}\n",
    }
    tier_of = {
        "MEMORY.md": "A-core",
        "memory/2026-04-03.md": "A-protected",
        "memory/2026-04-04.md": "A-protected",
        "memory/dup-a.md": "A-protected",
        "memory/dup-b.md": "A-protected",
        "memory/near-a.md": "A-protected",
        "memory/near-b.md": "A-protected",
        "memory/same-a.md": "A-protected",
        "memory/same-b.md": "A-protected",
        "memory/derived-a.md": "A-protected",
        "memory/secret-a.md": "A-protected",
        "memory/authority-a.md": "A-protected",
        "memory/.dreams/2026-05-29.md": "T-dreaming",
        "memory/mowc/MOWC-006.md": "D-suspect",
        "memory/ghost/gw-001.md": "D-ghost-window",
        "wiki/drafts/reward-design.md": "A-wiki",
        "memory/2026-04-05-daily.md": "B-daily",
        "memory/growth/mood.md": "B-growth",
        "memory/archive/projects.md": "B-other",
        "data/state/export.json": "C-flag",
    }
    files["memory/2026-04-05-daily.md"] = "Daily notes: heartbeat check ran, cron fine.\n"
    files["memory/growth/mood.md"] = "Mood journal: steady week, growth cohort notes.\n"
    files["memory/archive/projects.md"] = "Project archive: Ayumi forex bot status snapshot.\n"
    return files, tier_of


def default_corpus() -> tuple[Path, Path]:
    files, tier_of = default_corpus_spec()
    return build_fixture(files, tier_of)


def pass_receipt() -> dict:
    """Minimal PASSED qualification receipt shape for pipeline gate tests."""
    return {
        "kind": "w6-gold-set-qualification",
        "verdict": "PASS",
        "receipt_sha256": "fixture-pass-hash",
        "n_docs": 100,
    }
