"""W6: post-ingest reconciliation — lineage both directions, zero orphan
derived facts, cross-bank leak checks, D-tier quarantine guarantees."""

from __future__ import annotations

import shutil
import unittest

import w6fixtures  # noqa: F401  (sys.path bootstrap)

from adapter.corpus import CorpusReader, load_manifest  # noqa: E402
from adapter.import_contract import ContractStore  # noqa: E402
from adapter.pipeline import Pipeline, PipelineFatal  # noqa: E402
from adapter.tier_contract import TierContractError  # noqa: E402


def _full_run(files=None, tiers=None):
    if files is None:
        files, tiers = w6fixtures.default_corpus_spec()
    root, mp = w6fixtures.build_fixture(files, tiers)
    m = load_manifest(mp)
    store = ContractStore()
    pipe = Pipeline(m, CorpusReader(m, root))
    pipe.run(store=store, do_ingest=True, qualification_receipt=w6fixtures.pass_receipt())
    return pipe, store, root


class TestReconciliation(unittest.TestCase):
    def setUp(self):
        self.pipe, self.store, self.root = _full_run()

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def test_reconciled_run_passes_lineage_both_directions(self):
        self.assertFalse(self.pipe.state.halted)
        ingested = [r for r in self.pipe.state.records if r.operation_id]
        self.assertGreater(len(ingested), 0)
        for r in ingested:
            doc = self.store.get_document(r.document_id)
            self.assertIsNotNone(doc, r.canonical_id)
            self.assertEqual(doc["record"].canonical_id, r.canonical_id)
        run_ops = {r.operation_id for r in ingested}
        for op_id in self.store.operations:
            if op_id in run_ops:
                doc = self.store.get_document(self.store.operations[op_id])
                self.assertTrue(
                    any(r.canonical_id == doc["record"].canonical_id
                        for r in ingested)
                )

    def test_zero_orphan_derived_facts(self):
        for r in self.pipe.state.records:
            if r.payload.get("record_type") == "derived_conclusion":
                self.assertTrue(r.payload.get("evidence_ids"), r.canonical_id)

    def test_no_d_tier_promoted_to_active_bank(self):
        for r in self.pipe.state.records:
            if r.tier in ("D-suspect", "D-ghost-window"):
                self.assertNotEqual(r.disposition, "candidate-active")
                if r.operation_id:
                    doc = self.store.get_document(r.document_id)
                    self.assertEqual(doc["record"].target_bank, "quarantine")

    def test_no_cross_bank_leaks_target_side(self):
        for r in self.pipe.state.records:
            if not r.operation_id:
                continue
            doc = self.store.get_document(r.document_id)
            target = doc["record"]
            if target.target_bank == "active":
                self.assertIn(target.trust_class, ("A", "B"), r.canonical_id)
            if target.trust_class == "D":
                self.assertEqual(target.target_bank, "quarantine")

    def test_step12_receipt_records_gates(self):
        rec = [r for r in self.pipe.state.receipts.as_list()
               if r["kind"] == "step12-reconciliation"]
        self.assertEqual(len(rec), 1)
        self.assertEqual(rec[0]["d_tier_active"], 0)
        self.assertEqual(rec[0]["cross_bank_leaks"], 0)

    def test_missing_source_breaks_accounting(self):
        st = self.pipe.state
        st.records.pop()  # drop one record -> 100% accounting violated
        with self.assertRaises(PipelineFatal):
            self.pipe.step12_reconcile(self.store)

    def test_orphan_derived_fact_detected(self):
        st = self.pipe.state
        derived = next(
            (r for r in st.records
             if r.payload.get("record_type") == "derived_conclusion"), None)
        if derived is None:
            self.skipTest("no derived record in fixture")
        derived.payload["evidence_ids"] = []
        with self.assertRaises(PipelineFatal):
            self.pipe.step12_reconcile(self.store)

    def test_d_tier_forced_active_refused_by_bank_router(self):
        st = self.pipe.state
        d_rec = next(r for r in st.records if r.tier == "D-suspect")
        d_rec.payload["target_bank"] = "active"
        d_rec.disposition = "candidate-active"
        with self.assertRaises(TierContractError):
            self.pipe.step11_progressive_ingest(
                ContractStore(), qualification_receipt=w6fixtures.pass_receipt()
            )


if __name__ == "__main__":
    unittest.main(verbosity=2)
