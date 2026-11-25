"""W6: tier contract — frozen tier -> import-contract projection + bank router."""

from __future__ import annotations

import unittest

import w6fixtures  # noqa: F401  (sys.path bootstrap)

from adapter.tier_contract import (  # noqa: E402
    ALL_TIERS,
    BANKS,
    IMPORT_ORDER,
    QUARANTINE_TIERS,
    TierContractError,
    canonical_id_for,
    resolve_bank,
    spec_for,
)


class TestTierContract(unittest.TestCase):
    def test_import_order_t_dreaming_last(self):
        self.assertEqual(IMPORT_ORDER[0], "A-core")
        self.assertEqual(IMPORT_ORDER[-1], "T-dreaming")
        self.assertNotIn("T-dreaming", IMPORT_ORDER[:-1])

    def test_d_tiers_quarantined_never_in_import_order(self):
        self.assertEqual(set(QUARANTINE_TIERS), {"D-suspect", "D-ghost-window"})
        for t in QUARANTINE_TIERS:
            self.assertNotIn(t, IMPORT_ORDER)
        self.assertEqual(set(ALL_TIERS), set(IMPORT_ORDER) | set(QUARANTINE_TIERS))

    def test_spec_unknown_tier_fails_closed(self):
        with self.assertRaises(TierContractError):
            spec_for("Z-bogus")

    def test_canonical_id_shape_and_sources(self):
        cid = canonical_id_for("A-core", "MEMORY.md")
        self.assertEqual(cid, "honcho:memory:MEMORY.md")
        cid_d = canonical_id_for("T-dreaming", "memory/.dreams/x.md")
        self.assertTrue(cid_d.startswith("diary:dreaming:"))
        for tier in ALL_TIERS:
            parts = canonical_id_for(tier, "p/q.md").split(":")
            self.assertEqual(len(parts), 3)
            self.assertTrue(all(parts))

    def test_resolve_bank_d_tier_locked_to_quarantine(self):
        for tier in QUARANTINE_TIERS:
            self.assertEqual(resolve_bank(tier), "quarantine")
            with self.assertRaises(TierContractError):
                resolve_bank(tier, "active")

    def test_resolve_bank_active_requires_trust_a_or_b(self):
        self.assertEqual(resolve_bank("A-core"), "active")
        self.assertEqual(resolve_bank("B-daily"), "archive")
        with self.assertRaises(TierContractError):
            resolve_bank("T-dreaming", "active")   # trust C
        with self.assertRaises(TierContractError):
            resolve_bank("C-flag", "active")       # trust C

    def test_resolve_bank_unknown_bank_refused(self):
        with self.assertRaises(TierContractError):
            resolve_bank("A-core", "vault")

    def test_bank_enum_frozen_members(self):
        self.assertEqual(
            set(BANKS), {"active", "archive", "derived", "dreaming", "quarantine"}
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
