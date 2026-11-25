#!/usr/bin/env python3
"""W5 scoped tests — restore canaries + drill receipt/RTO (card 6b277b28).

Native stdlib unittest only (pytest intentionally absent on-box; HR5
targeted-tests-only honored — run this file directly, never bare pytest).
Fully self-contained: temp dirs + per-class generated key material; never
touches the on-box drill key or any live staging state.

Run: python3 infra/backup/tests/test_restore_canary.py
"""
import json
import os
import secrets
import shutil
import sqlite3
import subprocess
import tempfile
import unittest
from pathlib import Path

BIN = Path(__file__).resolve().parents[1] / "bin"
RESTORE = BIN / "restore.sh"
ENCRYPT = BIN / "encrypt.sh"
VERIFY = BIN / "verify.sh"


def census_regen(snap_root: Path) -> str:
    """Independent re-implementation of census-v1 (byte-matches census.tsv)."""
    import hashlib

    def sha(p: Path) -> str:
        h = hashlib.sha256()
        with open(p, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        return h.hexdigest()

    lines = ["#census-v1"]
    for sub in ("state", "workspace"):
        base = snap_root / sub
        if not base.is_dir():
            continue
        rels = sorted(
            (Path(dp, f).relative_to(snap_root) for dp, _dirs, fs in os.walk(base) for f in fs),
            key=lambda p: str(p).encode())
        for rel in rels:
            p = snap_root / rel
            lines.append(f"{sha(p)}\t{p.stat().st_size}\t{rel}")
    return "\n".join(lines) + "\n"


class RestoreCanaryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.TemporaryDirectory(prefix="w5-restore-test-")
        root = Path(cls._tmp.name)
        cls.root = root
        state = root / "state"
        ws = root / "workspace"
        backup_root = root / "backup-root"
        (state / "canary").mkdir(parents=True)
        (state / "memory-index" / "lance" / "demo.lance").mkdir(parents=True)
        (ws / "notes").mkdir(parents=True)
        (state / "openclaw.json").write_text(
            json.dumps({"gateway": {"workspace": str(ws)}}) + "\n")
        (state / "canary" / "singleton.state").write_text("singleton-canary-state\n")
        (state / "memory-index" / "lance" / "demo.lance" / "data.bin").write_text("lance-vector-blob\n")
        (ws / "README.md").write_text("# workspace marker\n")
        db = sqlite3.connect(str(state / "db.sqlite"))
        db.execute("create table t1(id integer primary key, v text)")
        db.executemany("insert into t1(v) values (?)", [("a",), ("b",), ("c",)])
        db.commit()
        db.close()
        backup_root.mkdir()

        cls.secrets_dir = root / "secrets"
        cls.secrets_dir.mkdir()
        key_file = cls.secrets_dir / "backup-drill-key"
        key_file.write_text(secrets.token_hex(32) + "\n")
        os.chmod(key_file, 0o600)

        def enc_env():
            env = os.environ.copy()
            env["AVA_BACKUP_SECRETS_DIR"] = str(cls.secrets_dir)
            return env

        cls._enc_env = staticmethod(enc_env)
        snap_out = subprocess.run(
            ["bash", str(BIN / "snapshot.sh"), "--state-dir", str(state),
             "--root", str(backup_root), "--label", "unittest-restore"],
            capture_output=True, text=True, timeout=120, check=True)
        cls.snapshot_dir = Path(snap_out.stdout.strip())
        cls.archive = root / "archive.tar.zst.enc"
        enc = subprocess.run(
            ["bash", str(ENCRYPT), "--snapshot", str(cls.snapshot_dir),
             "--out", str(cls.archive), "--secretref", "backup-drill-key"],
            capture_output=True, text=True, timeout=120, check=True, env=enc_env())
        cls.archive_meta = Path(str(cls.archive) + ".meta.json")
        cls.fixture_readme = (ws / "README.md").read_text()

    @classmethod
    def tearDownClass(cls):
        cls._tmp.cleanup()

    def restore(self, target, extra=(), env_extra=None):
        env = self._enc_env()
        env.update(env_extra or {})
        return subprocess.run(
            ["bash", str(RESTORE), "--archive", str(self.archive),
             "--meta", str(self.archive_meta), "--target", str(target), *extra],
            capture_output=True, text=True, env=env, timeout=120)

    def test_happy_drill_receipt_rto_canaries(self):
        target = self.root / "r-happy"
        r = self.restore(target)
        self.assertEqual(r.returncode, 0, r.stderr)
        with open(target / "restore-receipt.json") as f:
            receipt = json.load(f)
        self.assertEqual(receipt["status"], "ok")
        self.assertEqual(receipt["census_diff"], "0")
        self.assertIsInstance(receipt["rto_seconds"], int)
        self.assertGreaterEqual(receipt["rto_seconds"], 0)
        self.assertEqual(receipt["canaries"]["failures"], [])
        self.assertTrue(receipt["canaries"]["checks"]["config_json_parses"])
        self.assertTrue(receipt["canaries"]["checks"]["singleton_state_present"])
        self.assertTrue(receipt["canaries"]["checks"]["sqlcount:state/db.sqlite"])
        restored = Path(receipt["target"]) / "restored"
        self.assertEqual((restored / "workspace" / "README.md").read_text(),
                         self.fixture_readme)
        self.assertEqual((restored / "state" / "db.sqlite").exists(), True)

    def test_census_gate_rejects_tampered_payload(self):
        tampered = self.root / "snap-tampered"
        shutil.copytree(self.snapshot_dir, tampered)
        (tampered / "state" / "canary" / "singleton.state").write_text("tampered\n")
        archive2 = self.root / "tampered.tar.zst.enc"
        subprocess.run(
            ["bash", str(ENCRYPT), "--snapshot", str(tampered), "--out", str(archive2),
             "--secretref", "backup-drill-key"],
            capture_output=True, text=True, timeout=120, check=True, env=self._enc_env())
        target = self.root / "r-tampered"
        r = subprocess.run(
            ["bash", str(RESTORE), "--archive", str(archive2),
             "--target", str(target)],
            capture_output=True, text=True, env=self._enc_env(), timeout=120)
        self.assertNotEqual(r.returncode, 0, "census gate must fail on tampered payload")
        with open(target / "restore-receipt.json") as f:
            receipt = json.load(f)
        self.assertEqual(receipt["status"], "failed")
        self.assertFalse((target / "work").exists(), "paired revert must remove work dir")
        self.assertFalse((target / "restored").exists())

    def test_verify_drill_detects_missing_canary(self):
        target = self.root / "r-canary"
        self.assertEqual(self.restore(target).returncode, 0)
        restored = target / "restored"
        os.remove(restored / "state" / "canary" / "singleton.state")
        # keep the census layer consistent: the canary layer (not the hash
        # census) is what must catch a semantically lost canary file
        (restored / "census.tsv").write_text(census_regen(restored))
        r = subprocess.run(
            ["bash", str(VERIFY), "--drill", str(target)],
            capture_output=True, text=True, timeout=60)
        self.assertNotEqual(r.returncode, 0, "verify --drill must catch missing canary")
        self.assertIn("canaries FAILED", r.stderr)

    def test_wrong_key_rejected_cleanly(self):
        other = self.root / "other-secrets"
        other.mkdir()
        kf = other / "backup-drill-key"
        kf.write_text(secrets.token_hex(32) + "\n")
        os.chmod(kf, 0o600)
        target = self.root / "r-wrongkey"
        r = self.restore(target, env_extra={"AVA_BACKUP_SECRETS_DIR": str(other)})
        self.assertNotEqual(r.returncode, 0, "wrong backup key must fail the drill")
        with open(target / "restore-receipt.json") as f:
            receipt = json.load(f)
        self.assertEqual(receipt["status"], "failed")
        self.assertFalse((target / "restored").exists())

    def test_xeon_drill_target_guard(self):
        target = self.root / "r-guard"
        r = self.restore(target, extra=("--mode", "xeon-drill"))
        self.assertEqual(r.returncode, 3)
        self.assertIn("ava-primary-drills", r.stderr)
        self.assertFalse(target.exists(), "guarded target must not be created")

    def test_verify_snapshot_and_archive_positive(self):
        r1 = subprocess.run(["bash", str(VERIFY), "--snapshot", str(self.snapshot_dir)],
                            capture_output=True, text=True, timeout=60)
        self.assertEqual(r1.returncode, 0, r1.stderr)
        self.assertIn("SNAPSHOT OK", r1.stdout)
        r2 = subprocess.run(
            ["bash", str(VERIFY), "--archive", str(self.archive),
             "--meta", str(self.archive_meta)],
            capture_output=True, text=True, timeout=60)
        self.assertEqual(r2.returncode, 0, r2.stderr)
        self.assertIn("ARCHIVE OK", r2.stdout)
        with open(self.archive_meta) as f:
            meta = json.load(f)
        self.assertTrue(meta["secretref"].startswith("secretref:"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
