"""Tier contract for the curated-corpus import (manifest v1.2) — W6.

Normative references:
- AVA-vNEXT-GENESIS-CANONICAL-SPEC-v0.3.md §5 (tier classification + pipeline),
  §7 (D-suspect/D-ghost-window quarantine; dreaming LAST).
- Card d244e8fa tier contract: import order A-core/A-protected/A-wiki FIRST ->
  B-daily/B-growth/B-other -> C-flag per deterministic rules -> T-dreaming LAST;
  D-suspect + D-ghost-window QUARANTINED — never into active recall.

This module is the single frozen mapping tier -> import-contract fields
(trust_class, target_bank, record_type, claim_status, sensitivity,
source_system, object_type, actor_type) plus the bank router (fails closed).
Pure stdlib; PEP 604/585 style.
"""

from __future__ import annotations

from dataclasses import dataclass

# Import order — T-dreaming strictly LAST (spec §7); D tiers are quarantine
# batches that run after everything else (they never enter active recall).
IMPORT_ORDER: tuple[str, ...] = (
    "A-core",
    "A-protected",
    "A-wiki",
    "B-daily",
    "B-growth",
    "B-other",
    "C-flag",
    "T-dreaming",
)
QUARANTINE_TIERS: tuple[str, ...] = ("D-suspect", "D-ghost-window")
ALL_TIERS: tuple[str, ...] = IMPORT_ORDER + QUARANTINE_TIERS

# Target banks (distinct bank/tag dimension per §5: derived conclusions are
# inferences, not ground truth; dreaming is history, not factual recall).
BANKS: frozenset[str] = frozenset(
    {"active", "archive", "derived", "dreaming", "quarantine"}
)

NOISE_RULESET_VERSION = "corpus-noise-v1"
SENSITIVE_RULESET_VERSION = "corpus-sensitive-v1"


@dataclass(frozen=True)
class TierSpec:
    """Frozen per-tier import-contract projection."""

    trust_class: str
    target_bank: str
    record_type: str
    claim_status: str
    sensitivity: str
    source_system: str
    object_type: str
    actor_type: str


TIER_SPECS: dict[str, TierSpec] = {
    "A-core": TierSpec(
        trust_class="A", target_bank="active", record_type="fact",
        claim_status="observed", sensitivity="sensitive",
        source_system="honcho", object_type="memory", actor_type="agent",
    ),
    "A-protected": TierSpec(
        trust_class="A", target_bank="active", record_type="fact",
        claim_status="observed", sensitivity="sensitive",
        source_system="honcho", object_type="memory", actor_type="agent",
    ),
    "A-wiki": TierSpec(
        trust_class="A", target_bank="active", record_type="fact",
        claim_status="observed", sensitivity="internal",
        source_system="honcho", object_type="wiki", actor_type="agent",
    ),
    "B-daily": TierSpec(
        trust_class="B", target_bank="archive", record_type="summary",
        claim_status="observed", sensitivity="internal",
        source_system="honcho", object_type="memory", actor_type="agent",
    ),
    "B-growth": TierSpec(
        trust_class="B", target_bank="archive", record_type="summary",
        claim_status="reported", sensitivity="internal",
        source_system="honcho", object_type="memory", actor_type="agent",
    ),
    "B-other": TierSpec(
        trust_class="B", target_bank="archive", record_type="fact",
        claim_status="observed", sensitivity="internal",
        source_system="honcho", object_type="memory", actor_type="agent",
    ),
    "C-flag": TierSpec(
        trust_class="C", target_bank="archive", record_type="fact",
        claim_status="observed", sensitivity="internal",
        source_system="honcho", object_type="memory", actor_type="system",
    ),
    "T-dreaming": TierSpec(
        trust_class="C", target_bank="dreaming", record_type="event",
        claim_status="reported", sensitivity="internal",
        source_system="diary", object_type="dreaming", actor_type="agent",
    ),
    "D-suspect": TierSpec(
        trust_class="D", target_bank="quarantine", record_type="fact",
        claim_status="disputed", sensitivity="sensitive",
        source_system="honcho", object_type="memory", actor_type="agent",
    ),
    "D-ghost-window": TierSpec(
        trust_class="D", target_bank="quarantine", record_type="event",
        claim_status="disputed", sensitivity="sensitive",
        source_system="diary", object_type="dreaming", actor_type="agent",
    ),
}


class TierContractError(ValueError):
    """Tier/bank projection violates the frozen tier contract."""


def spec_for(tier: str) -> TierSpec:
    """Tier spec lookup — fails closed on an unknown tier."""
    spec = TIER_SPECS.get(tier)
    if spec is None:
        raise TierContractError(
            f"unknown tier {tier!r} not in manifest-v1.2 contract {ALL_TIERS}"
        )
    return spec


def _escape_native_id(path: str) -> str:
    """Percent-encode ':' and '%' so the native-id segment is colon-free.

    The corpus contains colon-bearing filenames (e.g. backup-style
    '13:10bak'); the import contract requires exactly three ':'-separated
    segments. Escaping is deterministic and reversible against source_uri +
    the manifest inventory (which stays the lineage authority).
    """
    return path.replace("%", "%25").replace(":", "%3A")


def canonical_id_for(tier: str, path: str) -> str:
    """canonical_id = 'source:object-type:native-id' (import-contract shape).

    The native id is the manifest-relative corpus path (colon-escaped), so
    canonical ids are stable across runs and map 1:1 back to manifest
    inventory entries.
    """
    spec = spec_for(tier)
    cid = f"{spec.source_system}:{spec.object_type}:{_escape_native_id(path)}"
    parts = cid.split(":")
    if len(parts) != 3 or not all(parts):
        raise TierContractError(f"canonical_id {cid!r} is not source:type:native-id")
    return cid


def resolve_bank(tier: str, requested: str | None = None) -> str:
    """Bank router — fails closed.

    Contract guarantees enforced here (fail-closed per W4 config assertions):
    - D-suspect / D-ghost-window land ONLY in the quarantine bank.
    - bank 'active' is reachable only by trust classes A and B.
    - unknown banks are refused outright.
    """
    spec = spec_for(tier)
    bank = requested if requested is not None else spec.target_bank
    if bank not in BANKS:
        raise TierContractError(f"bank {bank!r} not in {sorted(BANKS)}")
    if tier in QUARANTINE_TIERS and bank != "quarantine":
        raise TierContractError(
            f"tier {tier} is QUARANTINED (spec §7): bank must be 'quarantine', got {bank!r}"
        )
    if bank == "active" and spec.trust_class not in ("A", "B"):
        raise TierContractError(
            f"bank 'active' requires trust A/B; tier {tier} is trust {spec.trust_class}"
        )
    return bank
