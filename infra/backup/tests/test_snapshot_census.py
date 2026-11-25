#!/usr/bin/env python3
"""W5 scoped tests — snapshot census machinery (card 6b277b28).

Native stdlib unittest only (pytest is intentionally absent on-box; HR5
targeted-tests-only honored — run this file directly, never bare pytest).
Fully self-contained: temp dirs only; never touches the on-box drill key
or any live staging state.

Run: python3 infra/backup/tests/test_snapshot_census.py
"""
import fcntl
import json
import os
import shutil
import sqlite3
import subprocess
import tempfile
import unittest
from pathlib import Path

BIN = Path(__file__).resolve().parents[1] / "bin"
SNAPSHOT = BIN / "snapshot.sh"


def _sha256(path: Path) -> str:
    import hashlib
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def census_regen(snap_root: Path) -> str:
    """Independent re-implementation of census-v1 (must byte-match census.tsv)."""
    lines = ["#census-v1"]
    for sub in ("state", "workspace"):
        base = snap_root / sub
        if not base.is_dir():
            continue
        rels = sorted(
            (Path(dp, f).relative_to(snap_root) for dp, _dirs, fs in os.walk(base) for f in fs),
            key=lambda p: str(p).encode(),
        )
        for rel in rels:
            p = snap_root / rel
            lines.append(f"{_sha256(p)}\t{p.stat().st_size}\t{rel}")
    return "\n".join(lines) + "\n"


class SnapshotCensusTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix="w5-snap-test-")
        self.root = Path(self._tmp.name)
        self.state = self.root / "state"
        self.ws = self.root / "workspace"
        self.backup_root = self.root / "backup-root"
        (self.state / "canary").mkdir(parents=True)
        (self.state / "memory-index" / "lance" / "demo.lance").mkdir(parents=True)
        (self.ws / "notes").mkdir(parents=True)
        (self.state / "openclaw.json").write_text(
            json.dumps({"gateway": {"workspace": str(self.ws)}}) + "\n")
        (self.state / "canary" / "singleton.state").write_text("singleton-canary-state\n")
        (self.state / "memory-index" / "lance" / "demo.lance" / "data.bin").write_text("lance-vector-blob\n")
        (self.ws / "README.md").write_text("# workspace marker\n")
        (self.ws / "notes" / "a.txt").write_text("note-1\n")
        # WAL-mode sqlite db with an uncheckpointed committed row (kept open so
        # the -wal sidecar exists at snapshot time and must be folded in)
        self.db = sqlite3.connect(str(self.state / "db.sqlite"))
        self.addCleanup(self.db.close)
        self.db.execute("create table t1(id integer primary key, v text)")
        self.db.executemany("insert into t1(v) values (?)", [("a",), ("b",), ("c",)])
        self.db.execute("pragma journal_mode=wal")
        self.db.execute("insert into t1(v) values (?)", ("wal-row",))
        self.db.commit()
        self.backup_root.mkdir()

    def tearDown(self):
        self._tmp.cleanup()

    def run_snapshot(self, *extra, env_extra=None):
        env = os.environ.copy()
        env.update(env_extra or {})
        return subprocess.run(
            ["bash", str(SNAPSHOT), "--state-dir", str(self.state),
             "--root", str(self.backup_root), *extra],
            capture_output=True, text=True, env=env, timeout=120)

    def test_happy_path_census_from_same_snapshot(self):
        r = self.run_snapshot("--label", "unittest")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(len(r.stdout.strip().splitlines()), 1, "stdout must be the path only")
        snap = Path(r.stdout.strip())
        self.assertTrue(snap.is_dir())
        with open(snap / "SNAPSHOT.json") as f:
            meta = json.load(f)
        self.assertEqual(meta["schema"], "ava-backup-snapshot-v1")
        self.assertEqual(meta["label"], "unittest")
        self.assertTrue(meta["sources"]["workspace_present"])
        self.assertTrue(meta["memory_index_present"])
        self.assertIn("state/memory-index/lance/demo.lance", meta["memory_index_paths"])
        self.assertEqual(meta["sqlite"]["consistent"], 1)
        self.assertEqual(meta["sql_row_counts"]["state/db.sqlite"]["t1"], 4)
        self.assertEqual(meta["census"]["rows"], 6)
        # the core spec gate: census regenerated from the SAME snapshot is byte-identical
        self.assertEqual((snap / "census.tsv").read_text(), census_regen(snap),
                         "re-census diff must be 0")
        self.assertNotIn("SNAPSHOT.json", (snap / "census.tsv").read_text(),
                         "census covers payload only, not metadata")
        # no in-flight leftovers after success
        self.assertEqual([p.name for p in self.backup_root.glob(".inflight-*")], [])

    def test_sqlite_wal_folded_and_integrity_ok(self):
        r = self.run_snapshot()
        self.assertEqual(r.returncode, 0, r.stderr)
        snap = Path(r.stdout.strip())
        db = snap / "state" / "db.sqlite"
        self.assertFalse(db.with_name("db.sqlite-wal").exists(),
                         "WAL sidecar must be folded into the .backup copy")
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        try:
            self.assertEqual(con.execute("pragma integrity_check").fetchone()[0], "ok")
            self.assertEqual(con.execute("select count(*) from t1").fetchone()[0], 4,
                             "WAL-committed row must be present in the consistent copy")
        finally:
            con.close()

    def test_single_flight_refusal(self):
        lock = self.backup_root / ".snapshot.lock"
        f = open(lock, "w")
        fcntl.flock(f, fcntl.LOCK_EX)
        try:
            r = self.run_snapshot()
            self.assertEqual(r.returncode, 2)
            self.assertIn("single-flight refuses", r.stderr)
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)
            f.close()

    def test_preflight_unreadable_state_fails_closed(self):
        locked = self.root / "locked-state"
        locked.mkdir()
        (locked / "x").write_text("x")
        os.chmod(locked, 0o000)
        try:
            r = subprocess.run(
                ["bash", str(SNAPSHOT), "--state-dir", str(locked),
                 "--root", str(self.backup_root)],
                capture_output=True, text=True, timeout=60)
            self.assertEqual(r.returncode, 3)
            self.assertIn("not readable", r.stderr)
            self.assertEqual([p.name for p in self.backup_root.glob(".inflight-*")], [],
                             "failed preflight must leave no in-flight dirs")
        finally:
            os.chmod(locked, 0o700)

    def test_workspace_absent_is_recorded_not_fatal(self):
        shutil.rmtree(self.ws)
        r = self.run_snapshot()
        self.assertEqual(r.returncode, 0, r.stderr)
        snap = Path(r.stdout.strip())
        with open(snap / "SNAPSHOT.json") as f:
            meta = json.load(f)
        self.assertFalse(meta["sources"]["workspace_present"])
        self.assertFalse((snap / "workspace").exists())
        self.assertNotIn("workspace/", (snap / "census.tsv").read_text())
        self.assertEqual(meta["census"]["rows"], 4)


if __name__ == "__main__":
    unittest.main(verbosity=2)
