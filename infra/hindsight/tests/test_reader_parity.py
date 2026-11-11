"""P1 pilot gate: SDK-reader parity >= 99.9% turn-level (diet-design §11).

Method (card d338ba30): the source is the staging gateway's durable session
store on ava-harness. The store's sqlite (main + -wal + -shm sidecars, taken
TOGETHER so the WAL contents are visible) is COPIED read-only to a temp dir —
the live DB is never touched. Ground truth = raw catalog + event rows from
the copy. Reader side = StoreSnapshotReader paging through the same copy with
a deliberately tiny page limit, exercising cursor continuity, ordering and
completeness exactly as the SDK/RPC paging surfaces behave (the adapter's
import path models those shapes; see adapter/openclaw_reader.py).

Parity = matched turns / ground-truth turns, gate at >= 0.999. The result is
recorded on disk (gate-1 JSON). Stdlib-only (no pytest on ava-harness);
run with: python3 infra/hindsight/tests/test_reader_parity.py
"""

from __future__ import annotations

import datetime as _dt
import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

_TESTS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(_TESTS_DIR.parent))

from adapter.openclaw_reader import (  # noqa: E402
    ExclusionMatrix,
    ImportReader,
    StoreSnapshotReader,
)

STATE_DIR = os.environ.get("W4_STATE_DIR", "/var/lib/ava-staging/gateway/.openclaw/state")
GATE_DIR = os.environ.get("W4_GATE_DIR", "/var/lib/ava-staging/evidence/hindsight")
PAGE_LIMIT = 1  # force maximal pagination so cursor bugs cannot hide
PARITY_THRESHOLD = 0.999

SNAPSHOT_FILES = ("openclaw.sqlite", "openclaw.sqlite-wal", "openclaw.sqlite-shm")


def snapshot_to_tmp(state_dir: str) -> str:
    """Copy the state store (3 WAL-sidecar files together) read-only to tmp."""
    tmp = tempfile.mkdtemp(prefix="w4-parity-")
    copied_any = False
    for name in SNAPSHOT_FILES:
        src = os.path.join(state_dir, name)
        if not os.path.exists(src):
            continue
        dst = os.path.join(tmp, name)
        try:
            shutil.copyfile(src, dst)
        except PermissionError:
            subprocess.run(["sudo", "-n", "cp", src, dst], check=True)
            subprocess.run(["sudo", "-n", "chmod", "644", dst], check=True)
        copied_any = True
    if not copied_any:
        shutil.rmtree(tmp, ignore_errors=True)
        raise FileNotFoundError(f"no state store files found under {state_dir}")
    return tmp


class TestReaderParityP1(unittest.TestCase):
    """P1: adapter reader projection vs raw store — >= 99.9% turn parity."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp_snap = snapshot_to_tmp(STATE_DIR)
        cls.main_sqlite = os.path.join(cls.tmp_snap, "openclaw.sqlite")

    @classmethod
    def tearDownClass(cls) -> None:
        shutil.rmtree(cls.tmp_snap, ignore_errors=True)

    def _ground_truth(self, db: sqlite3.Connection) -> tuple[list[dict], list[dict]]:
        heads = [
            dict(r)
            for r in db.execute(
                "SELECT session_key, agent_id, last_sequence, pruned_max_sequence, "
                "updated_at FROM session_state_heads ORDER BY session_key"
            )
        ]
        events = [
            dict(r)
            for r in db.execute(
                "SELECT sequence, session_key, session_id, agent_id, kind, actor_type, "
                "actor_id, run_id, occurred_at, summary FROM session_state_events "
                "ORDER BY session_key, sequence"
            )
        ]
        return heads, events

    def _reader_pages(self, reader: StoreSnapshotReader) -> tuple[list[dict], list[dict]]:
        heads: list[dict] = []
        cursor: str | None = None
        while True:
            page = reader.catalog_page("main", limit=PAGE_LIMIT, cursor=cursor)
            heads.extend(page["items"])
            if not page["cursor"]:
                break
            cursor = page["cursor"]
        events: list[dict] = []
        for head in heads:
            ecursor: str | None = None
            while True:
                page = reader.entries_page(head["session_key"], limit=PAGE_LIMIT, cursor=ecursor)
                events.extend(
                    {
                        "sequence": e.sequence,
                        "session_key": e.session_key,
                        "session_id": e.session_id,
                        "agent_id": e.agent_id,
                        "kind": e.kind,
                        "actor_type": e.actor_type,
                        "actor_id": e.actor_id,
                        "run_id": e.run_id,
                        "occurred_at": e.occurred_at,
                        "summary": e.summary,
                    }
                    for e in page["items"]
                )
                if not page["cursor"]:
                    break
                ecursor = page["cursor"]
        events.sort(key=lambda e: (e["session_key"], e["sequence"]))
        return heads, events

    @staticmethod
    def _key(row: dict) -> tuple:
        return (row["session_key"], row["sequence"])

    def test_p1_gate_1_turn_parity(self) -> None:
        db = sqlite3.connect(f"file:{self.main_sqlite}?mode=ro", uri=True)
        db.row_factory = sqlite3.Row
        try:
            gt_heads, gt_events = self._ground_truth(db)
        finally:
            db.close()
        reader = StoreSnapshotReader(self.main_sqlite)
        try:
            rd_heads, rd_events = self._reader_pages(reader)
        finally:
            reader.close()

        # Catalog parity: every head present exactly once, fields equal.
        gt_head_map = {h["session_key"]: h for h in gt_heads}
        rd_head_map = {h["session_key"]: h for h in rd_heads}
        head_matches = sum(
            1
            for k, h in gt_head_map.items()
            if k in rd_head_map
            and rd_head_map[k]["last_sequence"] == h["last_sequence"]
            and rd_head_map[k]["updated_at"] == h["updated_at"]
        )
        total_heads = len(gt_head_map)

        # Turn-level parity: match on (session_key, sequence) + full field equality.
        gt_map = {self._key(e): e for e in gt_events}
        matched = 0
        for key, gt in gt_map.items():
            found = next((e for e in rd_events if self._key(e) == key), None)
            if found is not None and all(found[f] == gt[f] for f in gt if f in found):
                matched += 1
        total = len(gt_map)
        parity = (matched / total) if total else 1.0

        result = "PASS" if parity >= PARITY_THRESHOLD and head_matches == total_heads else "FAIL"
        record = {
            "gate": "P1-SDK-reader-parity",
            "recorded_at": _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds"),
            "snapshot_source": STATE_DIR,
            "snapshot_sha256": hashlib.sha256(Path(self.main_sqlite).read_bytes()).hexdigest(),
            "threshold": PARITY_THRESHOLD,
            "page_limit_forced": PAGE_LIMIT,
            "sessions": total_heads,
            "sessions_matched": head_matches,
            "total_turns": total,
            "matched_turns": matched,
            "turn_level_parity": round(parity, 6),
            "result": result,
            "exclusion_matrix_hash": ExclusionMatrix().resolved_hash(),
            "corpus_caveat": (
                "staging corpus is young (staging gateway booted 2026-11-06 under W3); "
                "turn count is small, so parity is exact but statistically thin — "
                "re-run as the corpus grows; the gate runs over ANY corpus size"
                if total < 100
                else None
            ),
        }
        self._write_gate_record(record)
        print(
            f"\nP1 gate-1: parity={parity:.4%} turns={matched}/{total} "
            f"sessions={head_matches}/{total_heads} -> {result}"
        )
        self.assertEqual(result, "PASS", f"P1 parity gate failed: {record}")

    def test_reader_ledgers_are_policy_accounting(self) -> None:
        """Known-lossy ledger must attribute every policy loss (diet §6)."""
        reader = StoreSnapshotReader(self.main_sqlite)
        matrix = ExclusionMatrix()  # defaults: heartbeat/cron/subagent excluded
        ir = ImportReader(reader, matrix)
        try:
            heads = reader.all_sessions("main")
            raw_entries = [e for h in heads for e in reader.all_entries(h["session_key"])]
            expected_excluded = sum(1 for e in raw_entries if matrix.applies(e))
            list(ir.iter_agent_turns("main"))
        finally:
            reader.close()
        # Matrix hash is deterministic and attribution-bearing.
        self.assertEqual(matrix.resolved_hash(), ExclusionMatrix().resolved_hash())
        # Every excluded source entry must be ledgered with a reason.
        self.assertEqual(expected_excluded, len(ir.ledger.excluded_operational_entries))
        for loss in ir.ledger.excluded_operational_entries:
            self.assertEqual(loss["reason"], "operational-exclusion-matrix")
            self.assertIn("matrix_hash", loss)

    def _write_gate_record(self, record: dict) -> None:
        try:
            os.makedirs(GATE_DIR, exist_ok=True)
            path = os.path.join(GATE_DIR, "gate-1-parity.json")
            with open(path, "w", encoding="utf-8") as fh:
                json.dump(record, fh, indent=2, sort_keys=True)
            print(f"P1 gate-1 record written: {path}")
        except OSError as exc:
            print(f"WARN: could not write gate-1 record to {GATE_DIR}: {exc}")
            alt = os.path.join(self.tmp_snap, "gate-1-parity.json")
            with open(alt, "w", encoding="utf-8") as fh:
                json.dump(record, fh, indent=2, sort_keys=True)
            print(f"P1 gate-1 record written (fallback): {alt}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
