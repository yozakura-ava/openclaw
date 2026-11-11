"""W6: pipeline shadow stages — tier projection, noise, derived, sensitive,
adjudication, ordering (T-dreaming LAST) and the three-baseline proof."""

from __future__ import annotations

import shutil
import unittest

import w6fixtures  # noqa: F401  (sys.path bootstrap)

from adapter.corpus import CorpusReader, load_manifest  # noqa: E402
from adapter.pipeline import (  # noqa: E402
    DISP_ACTIVE,
    DISP_ARCHIVE,
    DISP_DREAMING,
    DISP_EXCLUDED_NOISE,
    DISP_QUARANTINE,
    Pipeline,
)


def _shadow(files, tier_of, **kw):
    root, mp = w6fixtures.build_fixture(files, tier_of)
    m = load_manifest(mp)
    pipe = Pipeline(m, CorpusReader(m, root), **kw)
    pipe.run()
    return pipe, root


def _default_corpus_args():
    return w6fixtures.default_corpus_spec()


class TestShadowPipeline(unittest.TestCase):
    def setUp(self):
        self.pipe, self.root = _shadow(*_default_corpus_args())

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def test_coverage_identity_per_tier(self):
        census = {t: len(idx) for t, idx in self.pipe.manifest.tier_index().items()}
        coverage = self.pipe.coverage_deltas()
        for tier, n in census.items():
            self.assertEqual(sum(coverage[tier].values()), n, tier)

    def test_tier_projections(self):
        recs = self.pipe.state.by_canonical_id()
        self.assertEqual(recs["honcho:memory:MEMORY.md"].disposition, DISP_ACTIVE)
        self.assertEqual(recs["honcho:memory:MEMORY.md"].payload["trust_class"], "A")
        dream = recs["diary:dreaming:memory/.dreams/2026-05-29.md"]
        self.assertEqual(dream.disposition, DISP_DREAMING)
        self.assertEqual(dream.payload["claim_status"], "reported")
        suspect = recs["honcho:memory:memory/mowc/MOWC-006.md"]
        self.assertEqual(suspect.disposition, DISP_QUARANTINE)
        self.assertEqual(suspect.payload["target_bank"], "quarantine")

    def test_t_dreaming_normalized_last_after_all_a_b_c(self):
        order = [
            r["tier"] for r in self.pipe.state.receipts.as_list()
            if r["kind"] == "step02-normalize"
        ]
        non_d = [t for t in order if t not in ("D-suspect", "D-ghost-window")]
        self.assertEqual(non_d[-1], "T-dreaming")  # LAST import tier (spec §7)
        dream_pos = order.index("T-dreaming")
        for t in set(t for t in non_d if t != "T-dreaming"):
            self.assertLess(order.index(t), dream_pos, t)

    def test_d_tiers_processed_after_t_dreaming(self):
        order = [
            r["tier"] for r in self.pipe.state.receipts.as_list()
            if r["kind"] == "step02-normalize"
        ]
        self.assertLess(order.index("T-dreaming"), order.index("D-suspect"))
        self.assertLess(order.index("T-dreaming"), order.index("D-ghost-window"))

    def test_noise_excludes_b_c_but_never_a(self):
        recs = self.pipe.state.by_canonical_id()
        daily = recs["honcho:memory:memory/2026-04-05-daily.md"]
        self.assertEqual(daily.disposition, DISP_EXCLUDED_NOISE)
        self.assertIsNotNone(daily.noise_hit)
        # A-tier doc mentioning operational tokens is NEVER auto-excluded
        files = {"memory/cron-note.md": "The cron scheduler was reconfigured on Tuesday.\n"}
        pipe, root = _shadow(files, {"memory/cron-note.md": "A-protected"})
        try:
            rec = pipe.state.records[0]
            self.assertEqual(rec.noise_hit, "cron")
            self.assertEqual(rec.disposition, DISP_ACTIVE)
        finally:
            shutil.rmtree(root, ignore_errors=True)

    def test_derived_conclusions_rebanked_with_evidence(self):
        recs = self.pipe.state.by_canonical_id()
        derived = recs["honcho:memory:memory/derived-a.md"]
        self.assertTrue(derived.derived)
        self.assertEqual(derived.payload["record_type"], "derived_conclusion")
        self.assertEqual(derived.payload["target_bank"], "derived")
        self.assertEqual(derived.payload["evidence_ids"], [derived.canonical_id])
        self.assertEqual(derived.disposition, DISP_ARCHIVE)  # never candidate-active

    def test_sensitive_and_authority_escalate(self):
        recs = self.pipe.state.by_canonical_id()
        secret = recs["honcho:memory:memory/secret-a.md"]
        self.assertEqual(secret.payload["sensitivity"], "sealed")
        authority = recs["honcho:memory:memory/authority-a.md"]
        queue_ids = {e["canonical_id"] for e in self.pipe.state.third_reviewer_queue}
        self.assertIn(secret.canonical_id, queue_ids)
        self.assertIn(authority.canonical_id, queue_ids)

    def test_step10_three_baselines_receipt(self):
        proofs = [
            r for r in self.pipe.state.receipts.as_list()
            if r["kind"] == "step10-proof"
        ]
        self.assertEqual(len(proofs), 1)
        p = proofs[0]
        self.assertIn("census_baseline", p)
        self.assertIn("shadow_baseline", p)
        self.assertEqual(p["consolidation"], "off")

    def test_empty_source_record_accounted_not_ingestable(self):
        files = {"memory/empty.md": "", "memory/full.md": "Real content with substance here.\n"}
        tiers = {p: "A-protected" for p in files}
        pipe, root = _shadow(files, tiers)
        try:
            recs = {r.canonical_id: r for r in pipe.state.records}
            empty = recs["honcho:memory:memory/empty.md"]
            self.assertEqual(empty.disposition, "empty-source-record")
            full = recs["honcho:memory:memory/full.md"]
            self.assertEqual(full.disposition, DISP_ACTIVE)
            cov = pipe.coverage_deltas()["A-protected"]
            self.assertEqual(sum(cov.values()), 2)  # 100% accounting holds
            reasons = {e["canonical_id"]: e["reason"]
                       for e in pipe.exclusion_manifest()}
            self.assertIn("empty source record", reasons["honcho:memory:memory/empty.md"])
        finally:
            shutil.rmtree(root, ignore_errors=True)

    def test_holdout_quarantine_flag_never_ingestable(self):
        pipe, root = _shadow(*_default_corpus_args(), holdout_quarantine=True)
        try:
            recs = pipe.state.by_canonical_id()
            ghost = recs["diary:dreaming:memory/ghost/gw-001.md"]
            self.assertEqual(ghost.disposition, "holdout-quarantine")
            # every D-tier record held out of ingest lineage
            for r in pipe.state.records:
                if r.tier in ("D-suspect", "D-ghost-window"):
                    self.assertEqual(r.disposition, "holdout-quarantine")
        finally:
            shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    unittest.main(verbosity=2)
