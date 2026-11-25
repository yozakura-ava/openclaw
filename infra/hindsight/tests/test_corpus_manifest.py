"""W6: curated-manifest loading + manifest-addressed corpus reader + normalize."""

from __future__ import annotations

import datetime as _dt
import hashlib
import json
import re
import shutil
import tempfile
import unittest
from pathlib import Path

import w6fixtures  # noqa: F401  (sys.path bootstrap)

from adapter.corpus import (  # noqa: E402
    TRANSFORM_VERSION,
    CorpusIntegrityError,
    CorpusReader,
    ExtractionError,
    ManifestError,
    canonicalize_text,
    erasure_key_id,
    iso_utc,
    load_manifest,
    normalize_entry,
)
from adapter.tier_contract import canonical_id_for  # noqa: E402

FILES = {
    "MEMORY.md": "# MEMORY\nCraig is the owner.\n",
    "memory/a.md": "Alpha memory content with substance.\n",
    "memory/dreams/x.md": "Dream entry.\n",
}
TIERS = {
    "MEMORY.md": "A-core",
    "memory/a.md": "A-protected",
    "memory/dreams/x.md": "T-dreaming",
}


class TestManifestLoad(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="w6-manifest-"))
        self.root, self.manifest_path = w6fixtures.build_fixture(FILES, TIERS)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)
        shutil.rmtree(self.root, ignore_errors=True)

    def test_load_counts_and_freeze(self):
        m = load_manifest(self.manifest_path)
        self.assertEqual(m.counts, {"A-core": 1, "A-protected": 1, "T-dreaming": 1})
        self.assertEqual(len(m.inventory), 3)
        raw = self.manifest_path.read_bytes()
        self.assertEqual(m.file_sha256, hashlib.sha256(raw).hexdigest())
        # freeze hash is deterministic across loads
        self.assertEqual(m.freeze_hash, load_manifest(self.manifest_path).freeze_hash)

    def test_census_mismatch_fatal(self):
        bad = w6fixtures.write_manifest(
            self.root, TIERS, counts_override={"A-core": 99, "A-protected": 1, "T-dreaming": 1}
        )
        with self.assertRaises(ManifestError):
            load_manifest(bad)

    def test_total_files_mismatch_fatal(self):
        bad = w6fixtures.write_manifest(self.root, TIERS, total_files_override=99)
        with self.assertRaises(ManifestError):
            load_manifest(bad)

    def test_duplicate_inventory_path_fatal(self):
        m = json.loads(self.manifest_path.read_text())
        m["inventory"].append(dict(m["inventory"][0]))
        self.manifest_path.write_text(json.dumps(m))
        with self.assertRaises(ManifestError):
            load_manifest(self.manifest_path)

    def test_missing_manifest_fatal(self):
        with self.assertRaises(ManifestError):
            load_manifest(self.root / "nope.json")


class TestCorpusReader(unittest.TestCase):
    def setUp(self):
        self.root, self.manifest_path = w6fixtures.build_fixture(FILES, TIERS, with_sha=True)
        self.manifest = load_manifest(self.manifest_path)
        self.reader = CorpusReader(self.manifest, self.root)

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def test_iter_tier_manifest_addressed_sorted(self):
        entries = list(self.reader.iter_tier("A-protected"))
        self.assertEqual([e.path for e, _ in entries], ["memory/a.md"])

    def test_tamper_length_quarantine_error(self):
        (self.root / "memory/a.md").write_text("Alpha memory content with substance!!\n")
        with self.assertRaises(CorpusIntegrityError):
            list(self.reader.iter_tier("A-protected"))

    def test_tamper_sha_pin_quarantine_error(self):
        # same-length tamper defeats length check; sha pin catches it
        (self.root / "memory/a.md").write_text("Alpha memory CONTENT with substance.\n")
        with self.assertRaises(CorpusIntegrityError):
            list(self.reader.iter_tier("A-protected"))

    def test_missing_file_quarantine_error(self):
        (self.root / "memory/a.md").unlink()
        with self.assertRaises(CorpusIntegrityError):
            list(self.reader.iter_tier("A-protected"))


class TestNormalize(unittest.TestCase):
    def setUp(self):
        self.root, self.manifest_path = w6fixtures.build_fixture(FILES, TIERS)
        self.manifest = load_manifest(self.manifest_path)
        self.reader = CorpusReader(self.manifest, self.root)

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def test_payload_field_completeness(self):
        entry = self.manifest.entry_by_path("memory/a.md")
        _, raw = next(iter(self.reader.iter_tier("A-protected")))
        payload = normalize_entry(entry, raw, "A-protected")
        for field in (
            "canonical_id", "source_system", "source_uri", "source_sha256", "content",
            "record_type", "trust_class", "sensitivity", "target_bank", "session_key",
            "turn_index", "parent_turn", "thread_id", "actor_type", "claim_status",
            "source_time_utc", "source_tz", "erasure_key_id", "transform_version",
        ):
            self.assertIn(field, payload, field)
        self.assertEqual(payload["canonical_id"], "honcho:memory:memory/a.md")
        self.assertEqual(payload["source_sha256"], hashlib.sha256(raw).hexdigest())
        self.assertEqual(payload["session_key"], "memory/a.md")
        self.assertEqual(payload["transform_version"], TRANSFORM_VERSION)
        self.assertRegex(payload["source_time_utc"], re.compile(
            r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$"))
        self.assertEqual(payload["source_tz"], "UTC")
        self.assertTrue(payload["erasure_key_id"].startswith("ers-"))

    def test_canonicalize_nfc_and_newlines(self):
        mixed = "cafe\u0301\r\nnai\u0308ve\rline".encode("utf-8")  # decomposed input
        out = canonicalize_text(mixed)
        self.assertNotIn("\r", out)
        self.assertEqual(out, "caf\u00e9\nna\u00efve\nline")  # NFC-composed

    def test_non_utf8_is_extraction_error(self):
        with self.assertRaises(ExtractionError):
            canonicalize_text(b"\xff\xfe\x00bad")

    def test_erasure_key_content_keyed(self):
        sha = hashlib.sha256(b"same bytes").hexdigest()
        self.assertEqual(erasure_key_id(sha), erasure_key_id(sha))
        self.assertNotEqual(erasure_key_id(sha), erasure_key_id(hashlib.sha256(b"other").hexdigest()))

    def test_iso_utc_rendering(self):
        # 2026-11-01 06:30:00 UTC (post-US-DST-transition instant)
        epoch = int(_dt.datetime(2026, 11, 1, 6, 30, 0, tzinfo=_dt.timezone.utc).timestamp())
        self.assertEqual(iso_utc(epoch), "2026-11-01T06:30:00Z")

    def test_tz_property_14h_skew_delta_preserved(self):
        base = int(_dt.datetime(2026, 3, 8, 7, 0, 0, tzinfo=_dt.timezone.utc).timestamp())
        skew = 14 * 3600  # +-14h property (spec §4.3 red-team B3)
        early, late = iso_utc(base), iso_utc(base + skew)
        p_early = _dt.datetime.fromisoformat(early.replace("Z", "+00:00"))
        p_late = _dt.datetime.fromisoformat(late.replace("Z", "+00:00"))
        self.assertEqual((p_late - p_early).total_seconds(), skew)

    def test_tz_property_dst_wall_clock_ambiguity_stays_utc(self):
        # US DST fall-back 2026-11-01 06:00Z == 02:00 EST == 03:00 EDT locally;
        # UTC rendering must be unambiguous regardless of wall-clock confusion.
        e1 = int(_dt.datetime(2026, 11, 1, 5, 59, 0, tzinfo=_dt.timezone.utc).timestamp())
        e2 = int(_dt.datetime(2026, 11, 1, 6, 1, 0, tzinfo=_dt.timezone.utc).timestamp())
        self.assertEqual(iso_utc(e1), "2026-11-01T05:59:00Z")
        self.assertEqual(iso_utc(e2), "2026-11-01T06:01:00Z")

    def test_binary_artifact_carried_lossless_base64(self):
        blob = bytes(range(256))
        root, mp = w6fixtures.build_fixture(
            {"memory/identity/avatar.png": ""}, {"memory/identity/avatar.png": "A-protected"}
        )
        (root / "memory/identity/avatar.png").write_bytes(blob)
        try:
            m = load_manifest(mp)
            # manifest bytes were written for the empty text file; rewrite entry
            import json as _json
            doc = _json.loads(mp.read_text())
            doc["inventory"][0]["bytes"] = len(blob)
            doc["inventory"][0]["sha256"] = hashlib.sha256(blob).hexdigest()
            mp.write_text(_json.dumps(doc))
            m = load_manifest(mp)
            entry = m.entry_by_path("memory/identity/avatar.png")
            raw = blob
            payload = normalize_entry(entry, raw, "A-protected")
            self.assertTrue(payload["content"].startswith("base64:"))
            import base64 as _b64
            self.assertEqual(
                _b64.b64decode(payload["content"][len("base64:"):]), blob
            )  # lossless
        finally:
            shutil.rmtree(root, ignore_errors=True)

    def test_tier_projection_d_tier_quarantine_bank(self):
        files = {"memory/mowc/x.md": "Suspect content.\n"}
        root, mp = w6fixtures.build_fixture(files, {"memory/mowc/x.md": "D-suspect"})
        try:
            m = load_manifest(mp)
            entry = m.entry_by_path("memory/mowc/x.md")
            raw = (root / "memory/mowc/x.md").read_bytes()
            payload = normalize_entry(entry, raw, "D-suspect")
            self.assertEqual(payload["target_bank"], "quarantine")
            self.assertEqual(payload["claim_status"], "disputed")
            self.assertEqual(canonical_id_for("D-suspect", "memory/mowc/x.md"),
                             "honcho:memory:memory/mowc/x.md")
        finally:
            shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    unittest.main(verbosity=2)
