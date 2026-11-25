"""W6: progressive ingest — qualification gate, checkpoints, halt semantics,
deterministic re-run, one-batch rollback, replace prohibition."""

from __future__ import annotations

import shutil
import unittest

import w6fixtures  # noqa: F401  (sys.path bootstrap)

from adapter.corpus import CorpusReader, load_manifest  # noqa: E402
from adapter.import_contract import (  # noqa: E402
    ContractStore,
    ReplaceProhibitedError,
    build_record,
)
from adapter.pipeline import (  # noqa: E402
    DISP_INTEGRITY,
    Pipeline,
    QualificationRequiredError,
)

FAIL_RECEIPT = {"kind": "w6-gold-set-qualification", "verdict": "FAIL",
                "receipt_sha256": "fixture-fail-hash"}


def _ingest_run(files, tier_of, receipt, *, with_sha=False, **kw):
    root, mp = w6fixtures.build_fixture(files, tier_of, with_sha=with_sha)
    m = load_manifest(mp)
    store = ContractStore()
    pipe = Pipeline(m, CorpusReader(m, root), **kw)
    pipe.run(store=store, do_ingest=True, qualification_receipt=receipt)
    return pipe, store, root


class TestQualificationGate(unittest.TestCase):
    def setUp(self):
        self.files, self.tiers = w6fixtures.default_corpus_spec()

    def tearDown(self):
        pass

    def test_ingest_without_receipt_refused(self):
        with self.assertRaises(QualificationRequiredError):
            _ingest_run(self.files, self.tiers, receipt=None)

    def test_ingest_with_failed_receipt_refused(self):
        with self.assertRaises(QualificationRequiredError):
            _ingest_run(self.files, self.tiers, receipt=FAIL_RECEIPT)


class TestProgressiveIngest(unittest.TestCase):
    FILES = {
        "MEMORY.md": "# MEMORY\nOwner estate anchor file.\n",
        "memory/a.md": "Protected alpha content with enough substance to matter.\n",
        "memory/b.md": "Protected beta content with enough substance to matter.\n",
        "memory/.dreams/d.md": "Dream entry for the dreaming bank.\n",
        "memory/mowc/m.md": "Suspect entry quarantined from active recall.\n",
    }
    TIERS = {
        "MEMORY.md": "A-core",
        "memory/a.md": "A-protected",
        "memory/b.md": "A-protected",
        "memory/.dreams/d.md": "T-dreaming",
        "memory/mowc/m.md": "D-suspect",
    }

    def tearDown(self):
        if getattr(self, "root", None):
            shutil.rmtree(self.root, ignore_errors=True)

    def test_batches_reach_reconciled_checkpoint(self):
        pipe, store, self.root = _ingest_run(
            self.FILES, self.TIERS, w6fixtures.pass_receipt()
        )
        self.assertFalse(pipe.state.halted)
        # every submitted operation is at 'reconciled'
        for rec in pipe.state.records:
            if rec.operation_id is None:
                continue
            doc = store.get_operation(rec.operation_id)
            self.assertIsNotNone(doc, rec.canonical_id)
            self.assertEqual(doc["record"].checkpoint, "reconciled")
        # batch states reconciled, one per tier, T-dreaming/D last
        states = {b: v["state"] for b, v in pipe.state.batches.items()}
        self.assertTrue(states)
        self.assertTrue(all(s == "reconciled" for s in states.values()))
        cps = [r for r in pipe.state.receipts.as_list()
               if r["kind"] == "step11-batch-checkpoint"]
        self.assertTrue(all(
            c["checkpoint"] == "submitted->operation_complete->reconciled" for c in cps
        ))
        # quarantine-bank docs exist for D-tier (history preserved, never active)
        d_recs = [r for r in pipe.state.records if r.tier == "D-suspect"]
        self.assertEqual(len(d_recs), 1)
        self.assertEqual(d_recs[0].disposition, "quarantine-bank")

    def test_hash_mismatch_quarantines_and_halts(self):
        # manifest pins sha; tamper one file -> integrity gate halts before ingest
        pipe, store, self.root = _ingest_run(
            self.FILES, self.TIERS, w6fixtures.pass_receipt(), with_sha=True,
        )
        self.assertFalse(pipe.state.halted)  # baseline first: untampered passes
        self.assertTrue(len(store.documents) >= 4)
        # now tamper and re-run
        shutil.rmtree(self.root, ignore_errors=True)
        root, mp = w6fixtures.build_fixture(self.FILES, self.TIERS, with_sha=True)
        (root / "memory/b.md").write_text("Tampered beta content that breaks the pin.\n")
        try:
            m = load_manifest(mp)
            store2 = ContractStore()
            pipe2 = Pipeline(m, CorpusReader(m, root))
            pipe2.run(store=store2, do_ingest=True,
                      qualification_receipt=w6fixtures.pass_receipt())
            self.assertTrue(pipe2.state.halted)
            self.assertIn("integrity mismatch", pipe2.state.halt_reason)
            kinds = [r["kind"] for r in pipe2.state.receipts.as_list()]
            self.assertIn("step02-integrity-quarantine", kinds)
            self.assertIn("step11-ingest-refused", kinds)
            self.assertEqual(len(store2.documents), 0)  # no batches started
            # tampered + never-reached records accounted as integrity quarantine
            integrity = [r for r in pipe2.state.records
                         if r.disposition == DISP_INTEGRITY]
            self.assertTrue(integrity)
        finally:
            shutil.rmtree(root, ignore_errors=True)

    def test_deterministic_rerun_identical_operations(self):
        runs = []
        for _ in range(2):
            pipe, store, root = _ingest_run(
                self.FILES, self.TIERS, w6fixtures.pass_receipt()
            )
            runs.append((
                sorted(
                    (r.canonical_id, r.operation_id)
                    for r in pipe.state.records if r.operation_id
                ),
                sorted(pipe.state.batches),
                [r["kind"] for r in pipe.state.receipts.as_list()],
            ))
            shutil.rmtree(root, ignore_errors=True)
        (ops1, batches1, kinds1), (ops2, batches2, kinds2) = runs
        self.assertEqual(ops1, ops2)
        self.assertEqual(batches1, batches2)
        self.assertEqual(kinds1, kinds2)

    def test_one_batch_rollback_no_target_deletes(self):
        pipe, store, self.root = _ingest_run(
            self.FILES, self.TIERS, w6fixtures.pass_receipt()
        )
        docs_before = len(store.documents)
        first_batch = sorted(pipe.state.batches)[0]
        expected = sum(1 for r in pipe.state.records if r.batch_id == first_batch)
        n = pipe.rollback_batch(first_batch)
        self.assertEqual(n, expected)
        self.assertGreaterEqual(n, 1)
        self.assertEqual(len(store.documents), docs_before)  # append-only
        rb = [r for r in pipe.state.receipts.as_list()
              if r["kind"] == "step11-batch-rollback"]
        self.assertEqual(rb[-1]["target_deletes"], 0)

    def test_colon_bearing_filename_ingests_clean(self):
        # real corpus carries backup-style filenames like '13:10bak'; the
        # native-id segment is percent-escaped so build_record stays valid
        files = {
            "memory/daily_focus.md.13:10bak": "Backup snapshot content with substance.\n",
            "memory/regular.md": "Regular protected content with substance here.\n",
        }
        tiers = {p: "A-protected" for p in files}
        pipe, store, root = _ingest_run(files, tiers, w6fixtures.pass_receipt())
        try:
            self.assertFalse(pipe.state.halted)
            escaped = [r for r in pipe.state.records
                       if "13%3A10bak" in r.canonical_id]
            self.assertEqual(len(escaped), 1)
            self.assertIsNotNone(escaped[0].operation_id)
            self.assertTrue(all(v["state"] == "reconciled"
                                for v in pipe.state.batches.values()))
            doc = store.get_document(escaped[0].document_id)
            self.assertIsNotNone(doc)
            self.assertEqual(doc["record"].canonical_id, escaped[0].canonical_id)
        finally:
            shutil.rmtree(root, ignore_errors=True)

    def test_replace_mode_prohibited(self):
        payload = {
            "canonical_id": "honcho:memory:x.md",
            "source_system": "honcho",
            "source_uri": "curated-corpus://x.md",
            "source_sha256": "a" * 64,
            "content": "content",
            "record_type": "fact",
            "trust_class": "A",
            "sensitivity": "internal",
            "target_bank": "active",
            "update_mode": "replace",
        }
        with self.assertRaises(ReplaceProhibitedError):
            build_record(payload)
        # pipeline payloads never carry update_mode at all
        pipe, store, self.root = _ingest_run(
            self.FILES, self.TIERS, w6fixtures.pass_receipt()
        )
        for r in pipe.state.records:
            self.assertNotIn("update_mode", r.payload)


if __name__ == "__main__":
    unittest.main(verbosity=2)
