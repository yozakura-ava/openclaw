"""W6: gold-set provider-qualification gate (diet-design §8 hard pre-gate)."""

from __future__ import annotations

import shutil
import unittest
from unittest import mock

import w6fixtures  # noqa: F401  (sys.path bootstrap)

import adapter.gold_set as gold_set  # noqa: E402
from adapter.corpus import CorpusReader, ExtractionError, load_manifest  # noqa: E402
from adapter.gold_set import (  # noqa: E402
    GOLD_N_DOCS,
    GOLD_RECOVERY_THRESHOLD,
    GOLD_STRATUM,
    QualificationFatal,
    build_gold_set,
    gold_facts,
    run_qualification,
)


def _fixture():
    files, tiers = w6fixtures.default_corpus_spec()
    root, mp = w6fixtures.build_fixture(files, tiers)
    m = load_manifest(mp)
    return m, CorpusReader(m, root), root


class TestGoldSetSelection(unittest.TestCase):
    def setUp(self):
        self.m, self.reader, self.root = _fixture()

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def test_stratum_and_size(self):
        picked = build_gold_set(self.m, n=5)
        self.assertEqual(len(picked), 5)
        self.assertTrue(all(e.tier == GOLD_STRATUM for e in picked))

    def test_binary_docs_skipped_from_selection(self):
        # a PNG in the stratum must not enter the gold set (facts are text units)
        blob = bytes(range(256))
        files, tiers = w6fixtures.default_corpus_spec()
        files["memory/identity/avatar.png"] = ""
        tiers["memory/identity/avatar.png"] = "A-protected"
        root2, mp2 = w6fixtures.build_fixture(files, tiers)
        (root2 / "memory/identity/avatar.png").write_bytes(blob)
        try:
            import json as _json, hashlib as _hl
            doc = _json.loads(mp2.read_text())
            for e in doc["inventory"]:
                if e["path"] == "memory/identity/avatar.png":
                    e["bytes"] = len(blob)
                    e["sha256"] = _hl.sha256(blob).hexdigest()
            mp2.write_text(_json.dumps(doc))
            m2 = load_manifest(mp2)
            r2 = CorpusReader(m2, root2)
            picked = build_gold_set(m2, reader=r2)
            self.assertTrue(all(e.path != "memory/identity/avatar.png" for e in picked))
        finally:
            shutil.rmtree(root2, ignore_errors=True)

    def test_deterministic_selection(self):
        a = [e.path for e in build_gold_set(self.m, n=GOLD_N_DOCS)]
        b = [e.path for e in build_gold_set(self.m, n=GOLD_N_DOCS)]
        self.assertEqual(a, b)
        self.assertNotEqual(a, sorted(a))  # permutation actually shuffles

    def test_gold_facts_deterministic_units(self):
        text = (
            "Short.\n"
            "This is a substantial protected fact line with plenty of characters.\n"
            "Another substantial protected fact line, also with plenty of characters!\n"
        )
        facts = gold_facts(text)
        self.assertEqual(len(facts), 2)
        self.assertEqual(facts, gold_facts(text))


class TestQualificationRun(unittest.TestCase):
    def setUp(self):
        self.m, self.reader, self.root = _fixture()

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def test_loopback_pass_with_full_recovery(self):
        receipt = run_qualification(self.m, self.reader, embed_probe=False)
        self.assertEqual(receipt.verdict, "PASS")
        self.assertGreaterEqual(receipt.recovery_rate, GOLD_RECOVERY_THRESHOLD)
        self.assertEqual(receipt.dropped_chunks, [])
        self.assertEqual(receipt.schema_violations, [])
        sealed = receipt.to_dict()
        self.assertTrue(sealed["receipt_sha256"])

    def test_strict_schema_violation_fails_gate(self):
        original = gold_set.build_record

        def poisoned(payload, **kw):
            if payload["canonical_id"].endswith("memory/2026-04-03.md"):
                bad = dict(payload)
                bad["trust_class"] = "X"  # enum violation -> strict schema failure
                return original(bad, **kw)
            return original(payload, **kw)

        with mock.patch.object(gold_set, "build_record", poisoned):
            receipt = run_qualification(self.m, self.reader, embed_probe=False)
        self.assertEqual(receipt.verdict, "FAIL")
        self.assertTrue(receipt.schema_violations)

    def test_extraction_error_is_fatal(self):
        original = gold_set.canonicalize_text

        def fatal(raw):
            text = original(raw)
            if "AYUAA-93" in text:
                raise ExtractionError("simulated extraction failure")
            return text

        with mock.patch.object(gold_set, "canonicalize_text", fatal):
            with self.assertRaises(QualificationFatal):
                run_qualification(self.m, self.reader, embed_probe=False)

    def test_dropped_chunks_fail_gate(self):
        # target loses every doc -> zero chunks landed -> gate must FAIL
        with mock.patch.object(
            gold_set.ContractStore, "get_document", return_value=None
        ):
            receipt = run_qualification(self.m, self.reader, embed_probe=False)
        self.assertEqual(receipt.verdict, "FAIL")
        self.assertLess(receipt.recovery_rate, GOLD_RECOVERY_THRESHOLD)


if __name__ == "__main__":
    unittest.main(verbosity=2)
