"""W6 import pipeline — the 12 steps of spec §5 over the curated corpus.

Normative references:
- AVA-vNEXT-GENESIS-CANONICAL-SPEC-v0.3.md §5 (pipeline + quantitative gates),
  §6 (import contract + checkpoints), §7 (D-tier quarantine, dreaming LAST).
- HONCHO-DIET-AND-MIGRATION-DESIGN.md §4 (dedup/supersession), §8 (provider
  qualification pre-gate), §9 (reconciliation replaces count-equality).
- W4 adapter: adapter/import_contract.py (records, store, batch submitter),
  adapter/tier_contract.py (tier -> contract-field projection).

Steps (each a method; state flows through PipelineState):
  1 inventory          7 sensitive/authority filters
  2 normalize          8 shadow curation
  3 exact dedup        9 adjudication
  4 near-dup groups   10 proof vs three baselines
  5 rule-based noise  11 progressive ingest (checkpointed, rollback-able)
  6 derived handling  12 post-ingest reconciliation

Invariants enforced (spec §5 quantitative gates):
- 100% source IDs accounted: lineage both directions, zero orphan derived facts.
- 0 cross-bank leaks (D-tier never active; dreaming never active).
- hash mismatch = quarantine + HALT (remaining batches not started).
- update_mode: replace prohibited (delegated to W4 build_record).
- consolidation OFF for the entire backfill (asserted in every receipt).
- provider-qualification receipt (gold-set gate) REQUIRED before ingest.

Pure stdlib; PEP 604/585 style.
"""

from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from dataclasses import dataclass, field
from typing import Any, Iterable, Mapping, Protocol

try:  # package mode (sys.path has infra/hindsight)
    from adapter.corpus import (
        TRANSFORM_VERSION,
        CorpusIntegrityError,
        CorpusReader,
        CuratedManifest,
        ExtractionError,
        ManifestEntry,
        normalize_entry,
    )
    from adapter.tier_contract import (
        IMPORT_ORDER,
        QUARANTINE_TIERS,
        NOISE_RULESET_VERSION,
        canonical_id_for,
        resolve_bank,
        spec_for,
    )
except ImportError:  # flat mode (adapter dir itself on sys.path)
    from corpus import (
        TRANSFORM_VERSION,
        CorpusIntegrityError,
        CorpusReader,
        CuratedManifest,
        ExtractionError,
        ManifestEntry,
        normalize_entry,
    )
    from tier_contract import (
        IMPORT_ORDER,
        QUARANTINE_TIERS,
        NOISE_RULESET_VERSION,
        canonical_id_for,
        resolve_bank,
        spec_for,
    )

try:  # W4 adapter modules (namespace package when run from infra/hindsight)
    from adapter.import_contract import (  # type: ignore
        BatchHaltedError,
        BatchSubmitter,
        ContractStore,
        ReconciliationError,
    )
except ImportError:  # direct-run layout (tests add infra/hindsight to sys.path)
    from import_contract import (  # type: ignore
        BatchHaltedError,
        BatchSubmitter,
        ContractStore,
        ReconciliationError,
    )

class PipelineFatal(Exception):
    """Fatal pipeline defect (strict mode: never silently continue)."""


class QualificationRequiredError(PipelineFatal):
    """Ingest attempted without a PASSED provider-qualification receipt."""


CONSOLIDATION = "off"  # entire backfill + benchmark window (card hard gate)

# Dispositions (shadow curation + lineage ledger)
DISP_ACTIVE = "candidate-active"
DISP_ARCHIVE = "raw-archive"
DISP_DREAMING = "dreaming-history"
DISP_QUARANTINE = "quarantine-bank"       # ingested into the quarantine bank
DISP_HOLDOUT = "holdout-quarantine"       # never ingested (--holdout-quarantine)
DISP_EXCLUDED_NOISE = "policy-excluded-operational-noise"
DISP_COLLAPSED = "collapsed-exact-dup"
DISP_INTEGRITY = "integrity-quarantine"   # manifest-vs-bytes mismatch
DISP_EMPTY = "empty-source-record"        # 0-byte/blank source: nothing to ingest

# Dispositions that are NEVER submitted to the target.
NON_INGESTABLE = frozenset(
    {DISP_HOLDOUT, DISP_EXCLUDED_NOISE, DISP_COLLAPSED, DISP_INTEGRITY, DISP_EMPTY}
)

_NON_ACTIVE = {
    DISP_ARCHIVE, DISP_DREAMING, DISP_QUARANTINE, DISP_HOLDOUT,
    DISP_EXCLUDED_NOISE, DISP_COLLAPSED, DISP_INTEGRITY, DISP_EMPTY,
}

# --- step 5: rule-based noise (versioned ruleset corpus-noise-v1) -----------
_NOISE_TOKENS = ("heartbeat", "cron", "subagent", "monitoring", "health-check")
_NOISE_ECHO_SHAPE = re.compile(r"^\s*(ok|done|ack|heartbeat-ok)[\s.!]*$", re.I)

# --- step 7: sensitive/authority filters (corpus-sensitive-v1) --------------
_SENSITIVE_PATTERNS = (
    re.compile(r"sk-[A-Za-z0-9]{20,}"),                      # openai-style keys
    re.compile(r"ghp_[A-Za-z0-9]{36}"),                      # github tokens
    re.compile(r"AKIA[0-9A-Z]{16}"),                         # aws access keys
    re.compile(r"-----BEGIN[ A-Z]{0,20}PRIVATE KEY-----"),
    re.compile(r"\b(password|passwd|api[_-]?key|secret)\b\s*[:=]\s*\S{8,}", re.I),
)
_AUTHORITY_PATTERNS = (
    re.compile(r"\b(craig|owner)\b[^.\n]{0,40}\b(authoriz|approv|grant|permit)", re.I),
    re.compile(r"\bpermission (is )?granted\b", re.I),
)
_NEGATION_TOKENS = ("not ", "never ", "no longer", "stopped", "removed", "won't", "do not")
_PREFERENCE_TOKENS = ("prefer", "instead", "rather", "switch to", "favorite")
_ANTONYM_PAIRS = (("enable", "disable"), ("add", "remove"), ("keep", "drop"),
                  ("use", "avoid"), ("start", "stop"))
_DERIVED_MARKERS = ("conclusion:", "inferred:", "derived from", "we conclude", "implication:")
_NEAR_DUP_JACCARD = 0.80


def _norm_for_compare(text: str) -> str:
    return " ".join(unicodedata.normalize("NFC", text).casefold().split())


# --- records ---------------------------------------------------------------
@dataclass
class PipelineRecord:
    """One source record flowing through the pipeline."""

    entry: ManifestEntry
    tier: str
    payload: dict[str, Any]
    raw: bytes
    canonical_id: str
    disposition: str = ""                  # assigned at normalize, refined below
    disposition_reason: str = ""
    near_dup_group: str | None = None
    near_dup_class: str | None = None
    noise_hit: str | None = None
    sensitive_hits: tuple[str, ...] = ()
    authority_hits: tuple[str, ...] = ()
    derived: bool = False
    adjudication: str = "pending"          # pending/approved/escalated/reclassified
    escalated_reason: str | None = None
    batch_id: str | None = None
    operation_id: str | None = None
    document_id: str | None = None
    kept_by: str | None = None             # exact-dup collapse target canonical_id


# --- adjudicator protocol (step 9) ------------------------------------------
@dataclass(frozen=True)
class AdjudicationDecision:
    verdict: str                 # "approve" | "escalate" | "reclassify"
    reason: str = ""
    reclass_sensitivity: str | None = None


class Adjudicator(Protocol):
    def adjudicate(self, record: PipelineRecord) -> AdjudicationDecision: ...


class DeterministicAdjudicator:
    """Default adjudicator: approves tier-contract-conformant records,
    escalates every sensitive-sealed / authority-flagged / contradiction /
    C-flag item. LLM-backed adjudicators are pluggable here but qualify
    separately (diet-design §8: the decision provider is gated on its own)."""

    def adjudicate(self, record: PipelineRecord) -> AdjudicationDecision:
        if record.authority_hits:
            return AdjudicationDecision("escalate", "authority-pattern: " + record.authority_hits[0])
        if record.sensitive_hits:
            return AdjudicationDecision("escalate", "sensitive-pattern: " + record.sensitive_hits[0])
        if record.near_dup_class == "contradiction":
            return AdjudicationDecision("escalate", "near-dup contradiction group")
        if record.tier == "C-flag":
            return AdjudicationDecision("escalate", "C-flag stratified audit sample")
        return AdjudicationDecision("approve", "tier-contract conformant")


# --- receipts ---------------------------------------------------------------
@dataclass
class Receipt:
    kind: str
    payload: dict[str, Any]
    prev_sha256: str | None = None

    def sealed(self) -> dict[str, Any]:
        body = dict(self.payload)
        body["kind"] = self.kind
        body["prev_receipt_sha256"] = self.prev_sha256
        blob = json.dumps(body, sort_keys=True).encode("utf-8")
        body["receipt_sha256"] = hashlib.sha256(blob).hexdigest()
        return body


class ReceiptChain:
    """Hash-chained receipts: tamper-evident per-checkpoint evidence."""

    def __init__(self) -> None:
        self._receipts: list[dict[str, Any]] = []
        self._prev: str | None = None

    def emit(self, kind: str, **payload: Any) -> dict[str, Any]:
        rec = Receipt(kind, payload, prev_sha256=self._prev)
        sealed = rec.sealed()
        self._prev = sealed["receipt_sha256"]
        self._receipts.append(sealed)
        return sealed

    def as_list(self) -> list[dict[str, Any]]:
        return list(self._receipts)

    def write_dir(self, out_dir: str) -> list[str]:
        import pathlib

        d = pathlib.Path(out_dir)
        d.mkdir(parents=True, exist_ok=True)
        paths = []
        for i, r in enumerate(self._receipts):
            p = d / f"receipt-{i:03d}-{r['kind']}.json"
            p.write_text(json.dumps(r, indent=1, sort_keys=True) + "\n", encoding="utf-8")
            paths.append(str(p))
        return paths


# --- pipeline state ----------------------------------------------------------
@dataclass
class PipelineState:
    records: list[PipelineRecord] = field(default_factory=list)
    receipts: ReceiptChain = field(default_factory=ReceiptChain)
    manifest: CuratedManifest | None = None
    halted: bool = False
    halt_reason: str | None = None
    batches: dict[str, dict[str, Any]] = field(default_factory=dict)
    third_reviewer_queue: list[dict[str, Any]] = field(default_factory=list)

    def by_canonical_id(self) -> dict[str, PipelineRecord]:
        return {r.canonical_id: r for r in self.records}


_COVERAGE_SLOTS = (
    DISP_ACTIVE, DISP_ARCHIVE, DISP_DREAMING, DISP_QUARANTINE,
    DISP_HOLDOUT, DISP_EXCLUDED_NOISE, DISP_COLLAPSED, DISP_INTEGRITY,
    DISP_EMPTY,
)


class Pipeline:
    """The 12-step import pipeline (fixture/loopback target by default)."""

    def __init__(
        self,
        manifest: CuratedManifest,
        reader: CorpusReader,
        *,
        adjudicator: Adjudicator | None = None,
        batch_size: int = 200,
        holdout_quarantine: bool = False,
    ) -> None:
        self.manifest = manifest
        self.reader = reader
        self.adjudicator = adjudicator or DeterministicAdjudicator()
        self.batch_size = max(1, int(batch_size))
        self.holdout_quarantine = holdout_quarantine
        self.state = PipelineState(manifest=manifest)

    # -- step 1 ---------------------------------------------------------------
    def step01_inventory(self) -> PipelineState:
        st = self.state
        tier_counts: dict[str, int] = {}
        for entry in self.manifest.inventory:
            tier_counts[entry.tier] = tier_counts.get(entry.tier, 0) + 1
        unknown = set(tier_counts) - set(IMPORT_ORDER) - set(QUARANTINE_TIERS)
        if unknown:
            raise PipelineFatal(
                f"manifest carries tiers outside the v1.2 contract: {sorted(unknown)}"
            )
        st.receipts.emit(
            "step01-inventory",
            manifest_file_sha256=self.manifest.file_sha256,
            manifest_freeze_hash=self.manifest.freeze_hash,
            total_files=len(self.manifest.inventory),
            tier_counts=tier_counts,
            declared_counts=self.manifest.counts,
            import_order=list(IMPORT_ORDER),
            quarantine_tiers=list(QUARANTINE_TIERS),
        )
        return st

    # -- steps 2-8 (normalize through shadow curation, per tier in order) ----
    def _tier_run_order(self, tiers: Iterable[str] | None) -> list[str]:
        wanted = tuple(tiers) if tiers is not None else IMPORT_ORDER + QUARANTINE_TIERS
        unknown = [t for t in wanted if t not in IMPORT_ORDER + QUARANTINE_TIERS]
        if unknown:
            raise PipelineFatal(f"unknown tiers requested: {unknown}")
        order = [t for t in IMPORT_ORDER if t in wanted]
        order += [t for t in QUARANTINE_TIERS if t in wanted]
        return order

    def steps02to08(self, tiers: Iterable[str] | None = None) -> PipelineState:
        st = self.state
        exact_dup_groups: list[dict[str, Any]] = []
        near_dup_groups: list[dict[str, Any]] = []
        for tier in self._tier_run_order(tiers):
            tier_records = self._normalize_tier(tier)                                # 2
            collapsed_tier: list[PipelineRecord] = []
            tier_records = self._exact_dedup(
                tier, tier_records, exact_dup_groups, collapsed_tier
            )                                                                        # 3
            self._near_dup_groups(tier, tier_records, near_dup_groups)               # 4
            self._noise_rules(tier_records)                                          # 5
            self._derived_handling(tier_records)                                     # 6
            self._sensitive_filters(tier_records)                                    # 7
            st.records.extend(tier_records)
            st.records.extend(collapsed_tier)
            st.receipts.emit(
                "step08-shadow-curation-tier",
                tier=tier,
                coverage=self._tier_coverage(tier_records + collapsed_tier),
            )
        st.receipts.emit(
            "step04-near-dup",
            groups=near_dup_groups,
            policy=("groups recorded, NEVER merged; negation/preference-token diff "
                    "forces different-event (diet-design §4.2)"),
        )
        st.receipts.emit(  # step 8 run-level artifact
            "step08-shadow-curation",
            coverage=self.coverage_deltas(),
            exclusion_manifest=self.exclusion_manifest(),
        )
        return st

    def _default_disposition(self, rec: PipelineRecord) -> None:
        if self.holdout_quarantine and rec.tier in QUARANTINE_TIERS:
            rec.disposition = DISP_HOLDOUT
            rec.disposition_reason = "holdout-quarantine flag (never ingested)"
            return
        bank = resolve_bank(rec.tier)  # fails closed (D -> quarantine, etc.)
        if bank == "active":
            rec.disposition, rec.disposition_reason = DISP_ACTIVE, "tier contract: active bank"
        elif bank == "dreaming":
            rec.disposition, rec.disposition_reason = DISP_DREAMING, "tier contract: dreaming history"
        elif bank == "quarantine":
            rec.disposition = DISP_QUARANTINE
            rec.disposition_reason = "D-tier: quarantine bank, never active recall (spec §7)"
        else:
            rec.disposition, rec.disposition_reason = DISP_ARCHIVE, "tier contract: raw-archive"

    # step 2: normalize (manifest-addressed reads; integrity gate)
    def _normalize_tier(self, tier: str) -> list[PipelineRecord]:
        st = self.state
        records: list[PipelineRecord] = []
        it = self.reader.iter_tier(tier)
        while True:
            try:
                entry, raw = next(it)
            except StopIteration:
                break
            except CorpusIntegrityError as exc:
                # spec §5: mismatch = QUARANTINE + HALT the batch stream.
                # Placeholder record keeps the 100%-accounting identity intact.
                hit = self.manifest.entry_by_path(exc.path)
                hit_tier = hit.tier if hit else tier
                cid = canonical_id_for(hit_tier, exc.path)
                records.append(PipelineRecord(
                    entry=hit, tier=hit_tier,
                    payload={"canonical_id": cid, "target_bank": "quarantine"},
                    raw=b"", canonical_id=cid,
                    disposition=DISP_INTEGRITY,
                    disposition_reason=f"integrity gate: {exc.detail}",
                ))
                st.halted = True
                st.halt_reason = f"integrity mismatch {exc.path}: {exc.detail}"
                st.receipts.emit(
                    "step02-integrity-quarantine",
                    path=exc.path, detail=exc.detail,
                    action="quarantine+halt-batch-stream",
                )
                # Account the never-reached remainder of this tier so the
                # 100%-accounting identity survives the halt.
                for e2 in sorted(
                    self.manifest.tier_index().get(hit_tier, []), key=lambda e: e.path
                ):
                    if e2.path <= exc.path:
                        continue
                    cid2 = canonical_id_for(hit_tier, e2.path)
                    records.append(PipelineRecord(
                        entry=e2, tier=hit_tier,
                        payload={"canonical_id": cid2, "target_bank": "quarantine"},
                        raw=b"", canonical_id=cid2,
                        disposition=DISP_INTEGRITY,
                        disposition_reason="not reached: batch stream halted upstream",
                    ))
                break
            try:
                payload = normalize_entry(entry, raw, tier)
            except ExtractionError as exc:
                raise PipelineFatal(
                    f"extraction error (FATAL): {entry.path}: {exc}"
                ) from exc
            resolve_bank(tier, payload["target_bank"])  # fails closed
            rec = PipelineRecord(
                entry=entry, tier=tier, payload=payload, raw=raw,
                canonical_id=canonical_id_for(tier, entry.path),
            )
            if not payload["content"].strip():
                # 0-byte/blank source records are real source records: they
                # stay 100%-accounted but carry nothing to ingest.
                rec.disposition = DISP_EMPTY
                rec.disposition_reason = "empty source record (no content to ingest)"
                records.append(rec)
                continue
            self._default_disposition(rec)
            records.append(rec)
        st.receipts.emit(
            "step02-normalize",
            tier=tier,
            records=len(records),
            transform_version=TRANSFORM_VERSION,
        )
        return records

    # step 3: deterministic exact dedup (0-facts-lost fixture backs collapse)
    def _exact_dedup(
        self,
        tier: str,
        records: list[PipelineRecord],
        groups_out: list[dict[str, Any]],
        collapsed_out: list[PipelineRecord],
    ) -> list[PipelineRecord]:
        by_content: dict[str, list[PipelineRecord]] = {}
        for rec in records:
            if rec.disposition in NON_INGESTABLE:  # integrity placeholders etc.
                by_content.setdefault(f"final:{rec.canonical_id}", [rec])
                continue
            key = hashlib.sha256(
                _norm_for_compare(rec.payload["content"]).encode("utf-8")
            ).hexdigest()
            by_content.setdefault(key, []).append(rec)
        kept: list[PipelineRecord] = []
        tier_groups: list[dict[str, Any]] = []
        for key, group in by_content.items():
            if len(group) == 1:
                kept.append(group[0])
                continue
            group.sort(key=lambda r: r.entry.path)  # deterministic keeper
            keeper = group[0]
            for dup in group[1:]:
                dup.disposition = DISP_COLLAPSED
                dup.disposition_reason = f"exact-dup of {keeper.canonical_id}"
                dup.kept_by = keeper.canonical_id
                collapsed_out.append(dup)  # stays in accounting (reversible lineage)
            kept.append(keeper)
            tier_groups.append({
                "tier": tier,
                "content_sha": key,
                "keeper": keeper.canonical_id,
                "collapsed": [d.canonical_id for d in group[1:]],
                "n": len(group),
            })
        groups_out.extend(tier_groups)
        self.state.receipts.emit("step03-exact-dedup", tier=tier, groups=tier_groups)
        return kept

    # step 4: near-dup groups — classified, NEVER merged
    def _near_dup_groups(
        self, tier: str, records: list[PipelineRecord], groups_out: list[dict[str, Any]]
    ) -> None:
        def shingles(text: str, k: int = 5) -> set[str]:
            toks = _norm_for_compare(text).split()
            return {" ".join(toks[i:i + k]) for i in range(max(0, len(toks) - k + 1))}

        def classify(a: PipelineRecord, b: PipelineRecord) -> str:
            ta, tb = a.payload["content"].casefold(), b.payload["content"].casefold()
            neg_a = any(t in ta for t in _NEGATION_TOKENS)
            neg_b = any(t in tb for t in _NEGATION_TOKENS)
            pref_a = any(t in ta for t in _PREFERENCE_TOKENS)
            pref_b = any(t in tb for t in _PREFERENCE_TOKENS)
            if neg_a != neg_b or pref_a != pref_b:
                return "different-event"  # §4: never collapse across these lines
            for pos_w, neg_w in _ANTONYM_PAIRS:
                a_pos, a_neg = pos_w in ta, neg_w in ta
                b_pos, b_neg = pos_w in tb, neg_w in tb
                if (a_pos and not a_neg and b_neg and not b_pos) or (
                    b_pos and not b_neg and a_neg and not a_pos
                ):
                    return "contradiction"
            return "same-meaning"

        shingle_cache = [
            (r, shingles(r.payload["content"]))
            for r in records if r.disposition not in NON_INGESTABLE
        ]
        group_seq = 0
        for i in range(len(shingle_cache)):
            rec_i, sh_i = shingle_cache[i]
            if rec_i.near_dup_group is not None or not sh_i:
                continue
            for j in range(i + 1, len(shingle_cache)):
                rec_j, sh_j = shingle_cache[j]
                if rec_j.near_dup_group is not None or not sh_j:
                    continue
                jac = len(sh_i & sh_j) / len(sh_i | sh_j)
                if jac >= _NEAR_DUP_JACCARD:
                    cls = classify(rec_i, rec_j)
                    group_seq += 1
                    gid = f"nd-{tier}-{group_seq:04d}"
                    rec_i.near_dup_group = rec_i.near_dup_group or gid
                    rec_j.near_dup_group = gid
                    rec_i.near_dup_class = rec_i.near_dup_class or cls
                    rec_j.near_dup_class = cls
                    groups_out.append({
                        "group": gid, "tier": tier, "class": cls,
                        "jaccard": round(jac, 4),
                        "members": [rec_i.canonical_id, rec_j.canonical_id],
                        "merged": False,
                    })

    # step 5: rule-based noise (A-tier NEVER auto-excluded)
    def _noise_rules(self, records: list[PipelineRecord]) -> None:
        for rec in records:
            if rec.disposition in (DISP_COLLAPSED, DISP_HOLDOUT, DISP_INTEGRITY):
                continue
            haystack = (rec.entry.path + "\n" + rec.payload["content"][:512]).casefold()
            hit = next((t for t in _NOISE_TOKENS if t in haystack), None)
            if hit is None and _NOISE_ECHO_SHAPE.match(rec.payload["content"]):
                hit = "tool-echo"
            rec.noise_hit = hit
            if hit and rec.tier in ("B-daily", "B-growth", "B-other", "C-flag"):
                rec.disposition = DISP_EXCLUDED_NOISE
                rec.disposition_reason = f"noise ruleset {NOISE_RULESET_VERSION}: {hit}"

    # step 6: derived-knowledge handling
    def _derived_handling(self, records: list[PipelineRecord]) -> None:
        for rec in records:
            if rec.disposition in NON_INGESTABLE:
                continue
            text = rec.payload["content"].casefold()
            marker = next((m for m in _DERIVED_MARKERS if m in text), None)
            if marker is None:
                continue
            rec.derived = True
            rec.payload["record_type"] = "derived_conclusion"
            rec.payload["evidence_ids"] = [rec.canonical_id]  # depth-1 provenance
            if rec.tier in QUARANTINE_TIERS:
                continue  # D-tier stays in the quarantine bank, no re-banking
            if spec_for(rec.tier).target_bank == "active":
                rec.payload["target_bank"] = "derived"
                resolve_bank(rec.tier, "derived")
                rec.disposition = DISP_ARCHIVE
                rec.disposition_reason = (
                    "derived conclusion -> derived bank (quarantine-default "
                    "until re-derivation proven, spec §5)"
                )

    # step 7: sensitive/authority filters (classify, never silently drop)
    def _sensitive_filters(self, records: list[PipelineRecord]) -> None:
        for rec in records:
            if rec.disposition in NON_INGESTABLE:
                continue
            content = rec.payload["content"]
            s_hits = tuple(p.pattern for p in _SENSITIVE_PATTERNS if p.search(content))
            a_hits = tuple(p.pattern for p in _AUTHORITY_PATTERNS if p.search(content))
            if s_hits:
                rec.sensitive_hits = s_hits
                rec.payload["sensitivity"] = "sealed"
                rec.payload["redaction_state"] = "pseudonymized"
            if a_hits:
                rec.authority_hits = a_hits

    # step 8: shadow curation artifacts (dispositions are final by now)
    def coverage_deltas(self) -> dict[str, dict[str, int]]:
        return {
            rec.tier: self._tier_coverage(
                [r for r in self.state.records if r.tier == rec.tier]
            )
            for rec in self.state.records
        } if self.state.records else {}

    def _tier_coverage(self, records: list[PipelineRecord]) -> dict[str, int]:
        slot = {name: 0 for name in _COVERAGE_SLOTS}
        for rec in records:
            slot[rec.disposition] = slot.get(rec.disposition, 0) + 1
        return slot

    def exclusion_manifest(self) -> list[dict[str, str]]:
        return [
            {
                "canonical_id": r.canonical_id,
                "tier": r.tier,
                "disposition": r.disposition,
                "reason": r.disposition_reason or r.disposition,
            }
            for r in self.state.records
            if r.disposition in _NON_ACTIVE
        ]

    # -- step 9: adjudication -------------------------------------------------
    def step09_adjudication(self, samples_per_tier: int = 5) -> PipelineState:
        st = self.state
        by_tier: dict[str, list[PipelineRecord]] = {}
        for rec in st.records:
            by_tier.setdefault(rec.tier, []).append(rec)
        adjudicated = 0
        for tier in sorted(by_tier):
            recs = by_tier[tier]
            escalations = [
                r for r in recs
                if r.sensitive_hits or r.authority_hits
                or r.near_dup_class == "contradiction" or r.tier == "C-flag"
            ]
            ordered = sorted(recs, key=lambda r: r.entry.path)
            step = max(1, len(ordered) // max(1, samples_per_tier))
            sample = ordered[::step][:samples_per_tier]
            seen_ids: set[str] = set()
            for rec in escalations + sample:
                if rec.canonical_id in seen_ids:
                    continue
                seen_ids.add(rec.canonical_id)
                decision = self.adjudicator.adjudicate(rec)
                rec.adjudication = decision.verdict
                adjudicated += 1
                if decision.verdict == "escalate":
                    rec.escalated_reason = decision.reason
                    st.third_reviewer_queue.append({
                        "canonical_id": rec.canonical_id,
                        "tier": rec.tier,
                        "reason": decision.reason,
                    })
                elif decision.verdict == "reclassify" and decision.reclass_sensitivity:
                    rec.payload["sensitivity"] = decision.reclass_sensitivity
        st.receipts.emit(
            "step09-adjudication",
            adjudicated=adjudicated,
            third_reviewer_queue=len(st.third_reviewer_queue),
            decision_provider="deterministic-default (LLM adjudicator qualifies separately, §8)",
        )
        return st

    # -- step 10: proof vs three baselines ------------------------------------
    def step10_proof(self) -> PipelineState:
        st = self.state
        census = {t: len(entries) for t, entries in self.manifest.tier_index().items()}
        shadow = {
            tier: self._tier_coverage(
                [r for r in st.records if r.tier == tier]
            )
            for tier in census
        }
        for tier, slot in shadow.items():
            if sum(slot.values()) != census[tier]:
                raise PipelineFatal(
                    f"coverage delta mismatch for {tier}: "
                    f"{sum(slot.values())} != census {census[tier]}"
                )
        for rec in st.records:
            if rec.disposition == DISP_ACTIVE:
                if rec.payload["trust_class"] not in ("A", "B"):
                    raise PipelineFatal(
                        f"cross-bank leak: {rec.canonical_id} active with trust "
                        f"{rec.payload['trust_class']}"
                    )
            if (
                rec.tier in QUARANTINE_TIERS
                and rec.disposition not in (DISP_QUARANTINE, DISP_HOLDOUT,
                                            DISP_COLLAPSED, DISP_INTEGRITY)
            ):
                raise PipelineFatal(f"D-tier promoted out of quarantine: {rec.canonical_id}")
        st.receipts.emit(
            "step10-proof",
            census_baseline=census,
            shadow_baseline=shadow,
            invariants="active=>trust A/B; D-tier=>quarantine; coverage identity holds",
            consolidation=CONSOLIDATION,
        )
        return st

    # -- step 11: progressive ingest ------------------------------------------
    def step11_progressive_ingest(
        self, store: ContractStore, *, qualification_receipt: Mapping[str, Any] | None = None
    ) -> PipelineState:
        st = self.state
        if qualification_receipt is None or qualification_receipt.get("verdict") != "PASS":
            raise QualificationRequiredError(
                "progressive ingest requires a PASSED gold-set qualification receipt "
                "(diet-design §8 hard pre-import gate)"
            )
        submitter = BatchSubmitter(store)
        if st.halted:
            st.receipts.emit(
                "step11-ingest-refused",
                reason=st.halt_reason,
                action="halt: no batches started",
            )
            return st
        ingestable = [r for r in st.records if r.disposition not in NON_INGESTABLE]
        for rec in ingestable:
            resolve_bank(rec.tier, rec.payload["target_bank"])
        batch_plan = self._plan_batches(ingestable)
        st.receipts.emit(
            "step11-batch-plan",
            batches=[b["batch_id"] for b in batch_plan],
            batch_size=self.batch_size,
            consolidation=CONSOLIDATION,
            qualification_receipt_sha=qualification_receipt.get("receipt_sha256"),
        )
        for plan in batch_plan:
            if st.halted:
                st.receipts.emit(
                    "step11-batches-aborted",
                    skipped_batch=plan["batch_id"],
                    reason=st.halt_reason,
                )
                break
            self._submit_batch(st, submitter, store, plan)
        return st

    def _plan_batches(self, ingestable: list[PipelineRecord]) -> list[dict[str, Any]]:
        by_tier: dict[str, list[PipelineRecord]] = {}
        for rec in ingestable:
            by_tier.setdefault(rec.tier, []).append(rec)
        plan: list[dict[str, Any]] = []
        for tier in [t for t in IMPORT_ORDER + QUARANTINE_TIERS if t in by_tier]:
            recs = sorted(by_tier[tier], key=lambda r: r.entry.path)
            for chunk_i in range(0, len(recs), self.batch_size):
                chunk = recs[chunk_i:chunk_i + self.batch_size]
                plan.append({
                    "batch_id": f"w6-{tier}-{chunk_i // self.batch_size:03d}",
                    "tier": tier,
                    "records": chunk,
                })
        return plan

    def _submit_batch(
        self,
        st: PipelineState,
        submitter: BatchSubmitter,
        store: ContractStore,
        plan: dict[str, Any],
    ) -> None:
        batch_id = plan["batch_id"]
        records: list[PipelineRecord] = plan["records"]
        payloads = []
        originals: dict[str, bytes] = {}
        for rec in records:
            rec.payload["ingest_checkpoint"] = batch_id
            payloads.append(rec.payload)
            originals[rec.canonical_id] = rec.raw
        try:
            result = submitter.submit_batch(payloads, originals=originals, batch_id=batch_id)
        except BatchHaltedError as exc:
            # Partial result is recoverable from the store's batch ledger.
            submitted_before = len(store.batches.get(batch_id, {}).get("operations", []))
            st.halted = True
            st.halt_reason = str(exc)
            self._rollback_records(records, reason="batch-halt rollback (integrity mismatch)")
            st.receipts.emit(
                "step11-batch-halted",
                batch_id=batch_id,
                tier=plan["tier"],
                reason=str(exc),
                submitted_before_halt=submitted_before,
                quarantined=[q for q in store.quarantined],
                remaining_batches_aborted=True,
            )
            return
        by_cid = {r.canonical_id: r for r in records}
        for op_id in result.submitted:
            doc = store.get_operation(op_id)
            if doc is None:
                raise PipelineFatal(f"operation {op_id} missing from store after submit")
            record = doc["record"]
            rec = by_cid.get(record.canonical_id)
            if rec is None:
                continue
            rec.batch_id = batch_id
            rec.operation_id = op_id
            rec.document_id = record.document_id
        try:
            n_live = store.reconcile_batch(batch_id)
        except ReconciliationError as exc:
            st.halted = True
            st.halt_reason = f"reconciliation failed for {batch_id}: {exc}"
            st.batches[batch_id] = {
                "tier": plan["tier"], "submitted": len(result.submitted),
                "quarantined": list(result.quarantined), "reconciled": 0,
                "state": "reconcile-failed",
            }
            st.receipts.emit(
                "step11-batch-reconcile-failed",
                batch_id=batch_id, tier=plan["tier"], reason=str(exc),
                checkpoint="halted before reconciled (never silently continue)",
            )
            return
        st.batches[batch_id] = {
            "tier": plan["tier"],
            "submitted": len(result.submitted),
            "quarantined": list(result.quarantined),
            "reconciled": n_live,
            "state": "reconciled",
        }
        st.receipts.emit(
            "step11-batch-checkpoint",
            batch_id=batch_id,
            tier=plan["tier"],
            submitted=len(result.submitted),
            quarantined=list(result.quarantined),
            checkpoint="submitted->operation_complete->reconciled",
            consolidation=CONSOLIDATION,
        )

    def _rollback_records(self, records: list[PipelineRecord], *, reason: str) -> None:
        for rec in records:
            rec.disposition = DISP_INTEGRITY
            rec.disposition_reason = reason
            rec.batch_id = None
            rec.operation_id = None
            rec.document_id = None

    def rollback_batch(self, batch_id: str) -> int:
        """One-batch rollback: its records leave the ingest lineage (append-only —
        no target deletion; exclusion reversible via source->target mapping)."""
        st = self.state
        n = 0
        for rec in st.records:
            if rec.batch_id == batch_id:
                self._rollback_records([rec], reason=f"one-batch rollback: {batch_id}")
                n += 1
        if batch_id in st.batches:
            st.batches[batch_id]["state"] = "rolled-back"
        st.receipts.emit(
            "step11-batch-rollback", batch_id=batch_id, records=n, target_deletes=0
        )
        return n

    # -- step 12: post-ingest reconciliation ----------------------------------
    def step12_reconcile(self, store: ContractStore) -> PipelineState:
        st = self.state
        manifest_paths = {e.path for e in self.manifest.inventory}
        ingested = [r for r in st.records if r.operation_id is not None]
        # lineage source -> target (every ingested source resolves to its doc)
        for rec in ingested:
            doc = store.get_document(rec.document_id)
            if doc is None:
                raise PipelineFatal(f"lineage break: {rec.canonical_id} has no target document")
            target_record = doc["record"]
            if target_record.canonical_id != rec.canonical_id:
                raise PipelineFatal(f"lineage mismatch on {rec.canonical_id}")
            if rec.entry.path not in manifest_paths:
                raise PipelineFatal(f"target references unknown source path {rec.entry.path}")
            if rec.tier in QUARANTINE_TIERS and target_record.target_bank != "quarantine":
                raise PipelineFatal(
                    f"cross-bank leak: D-tier {rec.canonical_id} landed in bank "
                    f"{target_record.target_bank}"
                )
            if (
                target_record.target_bank == "active"
                and target_record.trust_class not in ("A", "B")
            ):
                raise PipelineFatal(
                    f"cross-bank leak: {rec.canonical_id} active with trust "
                    f"{target_record.trust_class}"
                )
        # lineage target -> source (every store doc from this run maps back)
        run_op_ids = {r.operation_id for r in ingested}
        for op_id, doc_id in store.operations.items():
            if op_id in run_op_ids:
                doc = store.get_document(doc_id)
                record = doc["record"]
                if not any(r.canonical_id == record.canonical_id for r in ingested):
                    raise PipelineFatal(
                        f"orphan target document {doc_id} ({record.canonical_id})"
                    )
        # zero orphan derived facts
        for rec in ingested:
            if (
                rec.payload.get("record_type") == "derived_conclusion"
                and not rec.payload.get("evidence_ids")
            ):
                raise PipelineFatal(f"orphan derived fact: {rec.canonical_id} cites no evidence")
        # coverage identity: every manifest source accounted exactly once
        accounted = {r.canonical_id: r.disposition for r in st.records}
        if len(accounted) != len(st.records):
            raise PipelineFatal("duplicate canonical ids in pipeline state")
        census_ids = {
            canonical_id_for(e.tier, e.path) for e in self.manifest.inventory
        }
        missing = census_ids - set(accounted)
        extra = set(accounted) - census_ids
        if missing or extra:
            raise PipelineFatal(
                f"100%-accounting violated: missing={sorted(missing)[:3]} "
                f"extra={sorted(extra)[:3]}"
            )
        d_active = [
            r.canonical_id for r in st.records
            if r.tier in QUARANTINE_TIERS and r.disposition == DISP_ACTIVE
        ]
        if d_active:
            raise PipelineFatal(f"D-tier promoted to active: {d_active[:3]}")
        st.receipts.emit(
            "step12-reconciliation",
            batches_reconciled=len(
                [b for b in st.batches.values() if b.get("state") == "reconciled"]
            ),
            ingested=len(ingested),
            accounted=len(accounted),
            lineage="source->target and target->source verified; zero orphan derived facts",
            d_tier_active=0,
            cross_bank_leaks=0,
            consolidation=CONSOLIDATION,
        )
        return st

    # -- runner -----------------------------------------------------------------
    def run(
        self,
        *,
        tiers: Iterable[str] | None = None,
        store: ContractStore | None = None,
        qualification_receipt: Mapping[str, Any] | None = None,
        do_ingest: bool = False,
        samples_per_tier: int = 5,
    ) -> PipelineState:
        self.step01_inventory()
        self.steps02to08(tiers)
        self.step09_adjudication(samples_per_tier=samples_per_tier)
        self.step10_proof()
        if do_ingest:
            if store is None:
                raise PipelineFatal("do_ingest=True requires a ContractStore target")
            self.step11_progressive_ingest(
                store, qualification_receipt=qualification_receipt
            )
            if not self.state.halted:
                self.step12_reconcile(store)
        self.state.receipts.emit(
            "run-summary",
            records=len(self.state.records),
            ingested=sum(1 for r in self.state.records if r.operation_id),
            halted=self.state.halted,
            halt_reason=self.state.halt_reason,
            consolidation=CONSOLIDATION,
        )
        return self.state
