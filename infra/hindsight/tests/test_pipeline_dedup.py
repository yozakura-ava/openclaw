"""W6: dedup (exact 0-facts-lost) + near-dup groups (never merged) + canaries."""

from __future__ import annotations

import shutil
import unittest

import w6fixtures  # noqa: F401  (sys.path bootstrap)

from adapter.corpus import CorpusReader, load_manifest  # noqa: E402
from adapter.gold_set import gold_facts  # noqa: E402
from adapter.pipeline import (  # noqa: E402
    DISP_ACTIVE,
    DISP_COLLAPSED,
    DISP_EXCLUDED_NOISE,
    Pipeline,
)


def _run_shadow(files, tier_of):
    root, mp = w6fixtures.build_fixture(files, tier_of)
    try:
        m = load_manifest(mp)
        pipe = Pipeline(m, CorpusReader(m, root))
        pipe.run()
        return pipe, root
    finally:
        pass  # root cleaned by caller via returned handle


class TestExactDedup(unittest.TestCase):
    def tearDown(self):
        if getattr(self, "root", None):
            shutil.rmtree(self.root, ignore_errors=True)

    def test_exact_dup_group_collapsed_with_reversible_lineage(self):
        files = {
            "memory/keep.md": "Identical body for exact-dup fixture coverage.\nLine two.\n",
            "memory/dupz.md": "Identical body for exact-dup fixture coverage.\nLine two.\n",
            "memory/unique.md": "Wholly unique protected content lives here.\n",
        }
        tiers = {p: "A-protected" for p in files}
        self.pipe, self.root = _run_shadow(files, tiers)
        recs = {r.canonical_id: r for r in self.pipe.state.records}
        # deterministic keeper = lexicographically first manifest path
        keeper = recs["honcho:memory:memory/dupz.md"]
        dup = recs["honcho:memory:memory/keep.md"]
        self.assertEqual(keeper.disposition, DISP_ACTIVE)
        self.assertEqual(dup.disposition, DISP_COLLAPSED)
        self.assertEqual(dup.kept_by, keeper.canonical_id)
        groups = [r for r in self.pipe.state.receipts.as_list()
                  if r["kind"] == "step03-exact-dedup"]
        self.assertTrue(any(g["groups"] for g in groups))

    def test_zero_facts_lost_fixture(self):
        # REQ-008: collapse allowed only with reviewed fixture proving 0 facts lost.
        files = {
            "memory/keep.md": "Alpha fact one with real substance stated fully.\nBeta fact two with substance too.\n",
            "memory/dupz.md": "Alpha fact one with real substance stated fully.\nBeta fact two with substance too.\n",
        }
        tiers = {p: "A-protected" for p in files}
        self.pipe, self.root = _run_shadow(files, tiers)
        recs = {r.canonical_id: r for r in self.pipe.state.records}
        keeper = recs["honcho:memory:memory/dupz.md"]   # lexicographic keeper
        dup = recs["honcho:memory:memory/keep.md"]
        # gold-fact sets are identical -> collapse loses zero distinct facts
        self.assertEqual(
            sorted(gold_facts(keeper.payload["content"])),
            sorted(gold_facts(dup.payload["content"])),
        )
        self.assertEqual(dup.disposition, DISP_COLLAPSED)

    def test_dedup_wins_over_noise_on_collapsed_records(self):
        files = {
            "memory/dup-a.md": "heartbeat runbook duplicated verbatim here.\n",
            "memory/dup-b.md": "heartbeat runbook duplicated verbatim here.\n",
        }
        tiers = {p: "B-daily" for p in files}
        self.pipe, self.root = _run_shadow(files, tiers)
        recs = {r.canonical_id: r for r in self.pipe.state.records}
        keeper = recs["honcho:memory:memory/dup-a.md"]
        dup = recs["honcho:memory:memory/dup-b.md"]
        self.assertEqual(keeper.disposition, DISP_EXCLUDED_NOISE)  # noise applies to keeper
        self.assertEqual(dup.disposition, DISP_COLLAPSED)          # dedup already claimed dup


class TestNearDup(unittest.TestCase):
    def tearDown(self):
        if getattr(self, "root", None):
            shutil.rmtree(self.root, ignore_errors=True)

    BODY = (
        "The deployment pipeline for the staging cluster uses a blue-green "
        "strategy with automated rollback triggers watching error budgets "
        "across every service deployed through the release train each week "
        "and the canary analysis window runs for thirty minutes before any "
        "promotion to the production cells with manual approval still "
        "required for the database migration steps and the secrets rotation "
        "jobs that follow the runbook order documented in the wiki page "
        "about release engineering practices for the whole platform team "
    )

    def _both_records(self, a: str, b: str):
        files = {"memory/near-a.md": a, "memory/near-b.md": b}
        tiers = {p: "A-protected" for p in files}
        pipe, root = _run_shadow(files, tiers)
        self.root = root
        recs = {r.canonical_id: r for r in pipe.state.records}
        return pipe, recs["honcho:memory:memory/near-a.md"], recs["honcho:memory:memory/near-b.md"]

    def test_same_meaning_grouped_never_merged(self):
        a = self.BODY + "with the pager rotation attached to the on-call schedule."
        b = self.BODY + "with the pager rotation attached to the oncall schedule."
        pipe, ra, rb = self._both_records(a, b)
        self.assertIsNotNone(ra.near_dup_group, "expected near-dup grouping")
        self.assertEqual(ra.near_dup_group, rb.near_dup_group)
        self.assertEqual(ra.near_dup_class, "same-meaning")
        # NEVER merged: both records remain distinct and accounted
        self.assertEqual(ra.disposition, DISP_ACTIVE)
        self.assertEqual(rb.disposition, DISP_ACTIVE)
        groups = [r for r in pipe.state.receipts.as_list() if r["kind"] == "step04-near-dup"]
        flat = [g for grp in groups for g in grp["groups"]]
        self.assertTrue(flat)
        self.assertTrue(all(g["merged"] is False for g in flat))

    def test_negation_diff_forces_different_event_no_collapse(self):
        a = self.BODY + "with the pager rotation attached to the on-call schedule."
        b = self.BODY + "with the pager rotation not attached to the on-call schedule."
        pipe, ra, rb = self._both_records(a, b)
        self.assertIsNotNone(ra.near_dup_group, "expected near-dup grouping")
        self.assertEqual(ra.near_dup_class, "different-event")
        self.assertEqual(rb.near_dup_class, "different-event")
        self.assertNotEqual(ra.disposition, DISP_COLLAPSED)
        self.assertNotEqual(rb.disposition, DISP_COLLAPSED)

    def test_preference_diff_forces_different_event(self):
        a = self.BODY + "with the handoff summary posted by the primary responder."
        b = self.BODY + "with the handoff summary posted instead by the primary responder."
        pipe, ra, rb = self._both_records(a, b)
        self.assertIsNotNone(ra.near_dup_group, "expected near-dup grouping")
        self.assertEqual(rb.near_dup_class, "different-event")
        self.assertNotEqual(rb.disposition, DISP_COLLAPSED)

    def test_antonym_flip_classified_contradiction_and_escalated(self):
        a = self.BODY + "with the rotation hook enabled for the on-call schedule."
        b = self.BODY + "with the rotation hook disabled for the on-call schedule."
        pipe, ra, rb = self._both_records(a, b)
        self.assertIsNotNone(ra.near_dup_group, "expected near-dup grouping")
        self.assertEqual(ra.near_dup_class, "contradiction")
        self.assertEqual(rb.near_dup_class, "contradiction")
        escalated = {e["canonical_id"] for e in pipe.state.third_reviewer_queue}
        self.assertIn(ra.canonical_id, escalated)
        self.assertIn(rb.canonical_id, escalated)

    def test_correction_pair_canary_recorded_not_auto_superseded(self):
        # A then B where B corrects A — must stay two records, no supersedes edge
        a = self.BODY + "with the relay limit set to forty requests per minute."
        b = self.BODY + "with the relay limit not set to forty requests per minute."
        pipe, ra, rb = self._both_records(a, b)
        self.assertEqual(ra.near_dup_class, "different-event")
        self.assertNotIn("supersedes", ra.payload)
        self.assertNotIn("supersedes", rb.payload)
        groups = [r for r in pipe.state.receipts.as_list() if r["kind"] == "step04-near-dup"]
        flat = [g for grp in groups for g in grp["groups"]]
        self.assertTrue(any(g["class"] == "different-event" for g in flat))


if __name__ == "__main__":
    unittest.main(verbosity=2)
