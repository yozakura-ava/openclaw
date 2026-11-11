"""Hindsight import contract — hardened spec §6 / diet-design §5 mechanics.

Normative references:
- AVA-vNEXT-GENESIS-HARDENED-SPEC.md §6 (Honcho → Hindsight import).
- HONCHO-DIET-AND-MIGRATION-DESIGN.md §5 (full field spec), §4.4
  (update_mode: replace PROHIBITED), §5 checkpoint ladder, §9 (reconciliation
  replaces count-equality).

Spec-mandated invariants enforced by this module:
- operation_id = f(canonical_id, ingested_sha256, transform_version).
- document_id  = stable per canonical_id (gen-0 upsert identity).
- Checkpoints advance submitted -> operation_complete -> reconciled only
  (monotonic, single-step; reconciliation against source is the only
  trustworthy "done").
- Hash mismatch (declared source_sha256 vs actual original bytes) =
  quarantine + HALT the remaining batch.
- update_mode: replace is PROHIBITED — corrections are new records with a
  supersedes edge (immutable one-doc-per-submission + supersedes graph).
- Idempotency: operation_id changes with payload or transform_version, so a
  replay of the same operation is detectable and a stale-cache replay of an
  older payload produces a different operation_id.
- W6 (card d244e8fa) ADDITIVE extension: optional source_time_utc + source_tz
  fields carry the §6 binding field source_time (UTC + original tz). Defaults
  preserve every W4 construction path; no behavior change otherwise.

Pure stdlib; PEP 604/585 style.
"""

from __future__ import annotations

import hashlib
import re
import uuid
from dataclasses import dataclass, field
from typing import Any, Iterable, Mapping, Sequence

TRANSFORM_VERSION_DEFAULT = "1"

SOURCE_SYSTEMS = frozenset({"honcho", "openclaw", "identity", "workboard", "diary"})
CLAIM_STATUSES = frozenset({"observed", "reported", "inferred", "disputed", "superseded"})
TRUST_CLASSES = frozenset({"A", "B", "C", "D"})
ACTOR_TYPES = frozenset({"human", "agent", "system", "tool", "unknown"})
RECORD_TYPES = frozenset(
    {
        "message",
        "summary",
        "fact",
        "event",
        "decision",
        "preference",
        "derived_conclusion",
    }
)
SENSITIVITY_LEVELS = frozenset({"public", "internal", "sensitive", "sealed"})
RETENTION_CLASSES = frozenset({"permanent", "long", "standard", "ephemeral"})
REDACTION_STATES = frozenset({"none", "redacted", "pseudonymized"})

CHECKPOINT_SUBMITTED = "submitted"
CHECKPOINT_OPERATION_COMPLETE = "operation_complete"
CHECKPOINT_RECONCILED = "reconciled"
CHECKPOINT_ORDER: tuple[str, ...] = (
    CHECKPOINT_SUBMITTED,
    CHECKPOINT_OPERATION_COMPLETE,
    CHECKPOINT_RECONCILED,
)

# Pinned ghost window (diet-design §2: hash-verified importer CONSTANT, never
# runtime config). Dates re-verified against diary evidence before bulk import.
GHOST_WINDOW = ("2026-10-28T04:00:00Z", "2026-11-05T04:00:00Z")

_SHA_HEX_LEN = 64

# source_time_utc: ISO-8601 UTC instant ('2026-11-07T02:21:58Z'); original tz
# recorded separately in source_tz ('UTC' when the epoch source carries none).
_ISO_UTC_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$")


class ContractValidationError(ValueError):
    """Record violates the §5 field contract (shape/enum/format)."""


class QuarantineError(Exception):
    """A record failed integrity checks — quarantined, never imported."""


class BatchHaltedError(Exception):
    """Batch processing halted after a quarantine event (spec §5)."""

    def __init__(self, batch_id: str, cause: QuarantineError) -> None:
        super().__init__(f"batch {batch_id} halted: {cause}")
        self.batch_id = batch_id
        self.cause = cause


class ReplaceProhibitedError(Exception):
    """update_mode: replace attempted — prohibited per diet-design §4.4."""


class SupersessionRequiredError(Exception):
    """Same canonical_id re-submitted with different payload without a
    supersedes edge — corrections must flow through the supersedes graph."""


class CheckpointError(Exception):
    """Invalid checkpoint transition (backwards, skip, or unknown state)."""


class ReconciliationError(Exception):
    """Batch failed the §9 lineage relation / orphan-derived-facts check."""


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def operation_id(canonical_id: str, ingested_sha256: str, transform_version: str) -> str:
    """operation_id = f(canonical_id, ingested_sha256, transform_version).

    Deterministic; changes with payload bytes or transform version, which is
    what defeats stale-cache replays (diet-design §5 idempotency trap).
    """
    material = f"{canonical_id}|{ingested_sha256}|{transform_version}".encode("utf-8")
    return "hsop-" + hashlib.sha256(material).hexdigest()[:32]


def document_id(canonical_id: str, generation: int = 0) -> str:
    """Stable document identity for a canonical record.

    generation 0 is THE stable upsert identity for the canonical_id (replays
    of the same payload land on the same document). A correction under the
    supersedes graph is a NEW generation with its own document_id — the
    original document is never mutated or replaced.
    """
    material = f"document|{canonical_id}|{generation}".encode("utf-8")
    return "hsdoc-" + hashlib.sha256(material).hexdigest()[:32]


def _validate_sha256(value: str, field_name: str) -> str:
    v = value.lower()
    if len(v) != _SHA_HEX_LEN or any(c not in "0123456789abcdef" for c in v):
        raise ContractValidationError(f"{field_name} must be a 64-char sha256 hex string")
    return v


def _validate_canonical_id(canonical_id: str) -> str:
    parts = canonical_id.split(":")
    if len(parts) != 3 or not all(parts):
        raise ContractValidationError(
            f"canonical_id must be 'source:object-type:native-id', got {canonical_id!r}"
        )
    if parts[0] not in SOURCE_SYSTEMS:
        raise ContractValidationError(
            f"canonical_id source segment {parts[0]!r} not in {sorted(SOURCE_SYSTEMS)}"
        )
    return canonical_id


@dataclass(frozen=True)
class ImportRecord:
    """One portable record per diet-design §5 field spec (all fields present).

    Immutability: instances are frozen; corrections create NEW records wired
    into the supersedes graph — there is no in-place mutation or replace.
    """

    canonical_id: str
    source_system: str
    source_uri: str
    source_sha256: str
    ingested_sha256: str
    content: str
    record_type: str
    trust_class: str
    sensitivity: str
    target_bank: str
    session_key: str | None = None
    turn_index: int | None = None
    parent_turn: int | None = None
    thread_id: str | None = None
    actor_type: str = "unknown"
    claim_status: str = "observed"
    supersedes: tuple[str, ...] = ()
    evidence_ids: tuple[str, ...] = ()
    erasure_key_id: str | None = None
    retention_class: str = "standard"
    redaction_state: str = "none"
    source_time_utc: str | None = None
    source_tz: str | None = None
    transform_version: str = TRANSFORM_VERSION_DEFAULT
    ingest_checkpoint: str | None = None
    checkpoint: str = CHECKPOINT_SUBMITTED
    generation: int = 0
    operation_id: str = field(init=False)
    document_id: str = field(init=False)

    def __post_init__(self) -> None:
        _validate_canonical_id(self.canonical_id)
        _validate_sha256(self.source_sha256, "source_sha256")
        _validate_sha256(self.ingested_sha256, "ingested_sha256")
        for name, value, allowed in (
            ("source_system", self.source_system, SOURCE_SYSTEMS),
            ("actor_type", self.actor_type, ACTOR_TYPES),
            ("record_type", self.record_type, RECORD_TYPES),
            ("trust_class", self.trust_class, TRUST_CLASSES),
            ("sensitivity", self.sensitivity, SENSITIVITY_LEVELS),
            ("claim_status", self.claim_status, CLAIM_STATUSES),
            ("retention_class", self.retention_class, RETENTION_CLASSES),
            ("redaction_state", self.redaction_state, REDACTION_STATES),
        ):
            if value not in allowed:
                raise ContractValidationError(f"{name}={value!r} not in {sorted(allowed)}")
        if self.checkpoint not in CHECKPOINT_ORDER:
            raise ContractValidationError(
                f"checkpoint {self.checkpoint!r} not in {CHECKPOINT_ORDER}"
            )
        if self.source_time_utc is not None and not _ISO_UTC_RE.match(self.source_time_utc):
            raise ContractValidationError(
                "source_time_utc must be an ISO-8601 UTC instant like 2026-11-07T02:21:58Z"
            )
        object.__setattr__(self, "operation_id", operation_id(
            self.canonical_id, self.ingested_sha256, self.transform_version
        ))
        object.__setattr__(self, "document_id", document_id(self.canonical_id, self.generation))

    def with_checkpoint(self, state: str) -> "ImportRecord":
        if CHECKPOINT_ORDER.index(state) != CHECKPOINT_ORDER.index(self.checkpoint) + 1:
            raise CheckpointError(
                f"checkpoint must advance one step along {CHECKPOINT_ORDER}, "
                f"got {self.checkpoint} -> {state}"
            )
        data = {
            k: v for k, v in self.__dict__.items()
            if k not in ("operation_id", "document_id")
        }
        return ImportRecord(**{**data, "checkpoint": state})

    def to_payload(self) -> dict[str, Any]:
        d = dict(self.__dict__)
        d["supersedes"] = list(self.supersedes)
        d["evidence_ids"] = list(self.evidence_ids)
        return d


def build_record(
    payload: Mapping[str, Any],
    *,
    original_bytes: bytes | None = None,
    transform_version: str = TRANSFORM_VERSION_DEFAULT,
) -> ImportRecord:
    """Build + validate an ImportRecord from a raw payload mapping.

    - ingested_sha256 is COMPUTED from the exact submitted content bytes
      (hash of bytes actually submitted to target, spec §5).
    - original_bytes, when provided, must hash to payload["source_sha256"].
      A mismatch raises QuarantineError — the caller (BatchSubmitter) turns
      that into quarantine + batch halt.
    - Any payload carrying update_mode='replace' is rejected outright:
      corrections flow exclusively through the supersedes graph (§4.4).
    """
    if "update_mode" in payload:
        if str(payload["update_mode"]).strip().lower() == "replace":
            raise ReplaceProhibitedError(
                "update_mode: replace is PROHIBITED (diet-design §4.4); "
                "submit a correction record with a supersedes edge instead"
            )
    try:
        content = payload["content"]
    except KeyError as exc:
        raise ContractValidationError(f"missing required field: {exc}") from exc
    if not isinstance(content, str) or not content:
        raise ContractValidationError("content must be a non-empty string")
    ingested = sha256_hex(content.encode("utf-8"))
    for required in ("canonical_id", "source_system", "source_uri", "source_sha256",
                     "record_type", "trust_class", "sensitivity", "target_bank"):
        if required not in payload:
            raise ContractValidationError(f"missing required field: {required}")
    source_sha = _validate_sha256(str(payload["source_sha256"]), "source_sha256")
    if original_bytes is not None and sha256_hex(original_bytes) != source_sha:
        raise QuarantineError(
            f"hash mismatch for {payload['canonical_id']}: source_sha256 does not "
            "match the original evidence bytes — record must be QUARANTINED and "
            "the batch HALTED (spec §5)"
        )
    if "checkpoint" in payload and payload["checkpoint"] != CHECKPOINT_SUBMITTED:
        raise ContractValidationError("new records always start at 'submitted'")
    generation = int(payload.get("generation", 0))
    supersedes = tuple(payload.get("supersedes", ()))
    if generation > 0 and not supersedes:
        raise ContractValidationError(
            "generation > 0 (a correction) requires a non-empty supersedes[] edge list"
        )
    if supersedes and payload.get("claim_status", "observed") == "superseded":
        raise ContractValidationError(
            "a superseding (correction) record carries its own live claim_status; "
            "claim_status='superseded' belongs to the record being replaced"
        )
    return ImportRecord(
        canonical_id=str(payload["canonical_id"]),
        source_system=str(payload["source_system"]),
        source_uri=str(payload["source_uri"]),
        source_sha256=source_sha,
        ingested_sha256=ingested,
        content=content,
        record_type=str(payload["record_type"]),
        trust_class=str(payload["trust_class"]),
        sensitivity=str(payload["sensitivity"]),
        target_bank=str(payload["target_bank"]),
        session_key=payload.get("session_key"),
        turn_index=payload.get("turn_index"),
        parent_turn=payload.get("parent_turn"),
        thread_id=payload.get("thread_id"),
        actor_type=str(payload.get("actor_type", "unknown")),
        claim_status=str(payload.get("claim_status", "observed")),
        supersedes=supersedes,
        evidence_ids=tuple(payload.get("evidence_ids", ())),
        erasure_key_id=payload.get("erasure_key_id"),
        retention_class=str(payload.get("retention_class", "standard")),
        redaction_state=str(payload.get("redaction_state", "none")),
        source_time_utc=payload.get("source_time_utc"),
        source_tz=payload.get("source_tz"),
        transform_version=str(payload.get("transform_version", transform_version)),
        ingest_checkpoint=payload.get("ingest_checkpoint"),
        generation=generation,
    )


def correction_payload(original: ImportRecord, new_content: str, **overrides: Any) -> dict[str, Any]:
    """Derive a §4-compliant correction payload from an existing record.

    The correction is a NEW record (new content → new operation_id, next
    generation → its own document_id) with a supersedes edge pointing at the
    original document. The original document is never mutated (replace is
    prohibited; representative selection resolves forward).
    """
    base: dict[str, Any] = original.to_payload()
    base.pop("checkpoint", None)
    base.pop("operation_id", None)
    base.pop("document_id", None)
    base["content"] = new_content
    base["generation"] = original.generation + 1
    base["supersedes"] = [original.document_id]
    base.update(overrides)
    return base


@dataclass
class BatchResult:
    batch_id: str
    submitted: list[str] = field(default_factory=list)
    quarantined: list[str] = field(default_factory=list)
    halted: bool = False


class ContractStore:
    """Loopback target implementing the G5 write/read contract, in-process.

    Append-only by construction: there is no update/replace/delete API for
    document content. Checkpoint advancement and supersede edges are the only
    post-submission state changes. This is also the reference shape for the
    live HTTP transport (see openclaw_reader endpoints / README).
    """

    def __init__(self) -> None:
        self.documents: dict[str, dict[str, Any]] = {}
        self.operations: dict[str, str] = {}
        self.supersedes: list[tuple[str, str]] = []
        self.superseded: set[str] = set()
        self.quarantined: dict[str, str] = {}
        self.batches: dict[str, dict[str, Any]] = {}

    def put_document(self, record: ImportRecord, batch_id: str) -> str:
        existing_op = self.operations.get(record.operation_id)
        if existing_op is not None:
            return existing_op  # idempotent replay: same operation, no change
        existing_doc = self.documents.get(record.document_id)
        if existing_doc is not None and existing_doc["operation_id"] != record.operation_id:
            raise SupersessionRequiredError(
                f"document {record.document_id} exists under a different operation "
                f"({existing_doc['operation_id']}); corrections must carry a "
                "supersedes edge (update_mode: replace is prohibited)"
            )
        if record.supersedes:
            for old_doc in record.supersedes:
                if old_doc not in self.documents:
                    raise ContractValidationError(
                        f"supersedes target {old_doc} is not a known document"
                    )
                self.supersedes.append((old_doc, record.document_id))
                self.superseded.add(old_doc)
        self.documents[record.document_id] = {
            "operation_id": record.operation_id,
            "record": record,
            "batch_id": batch_id,
        }
        self.operations[record.operation_id] = record.document_id
        self.batches.setdefault(batch_id, {"operations": [], "state": CHECKPOINT_SUBMITTED})
        self.batches[batch_id]["operations"].append(record.operation_id)
        return record.document_id

    def quarantine(self, record: ImportRecord, reason: str) -> None:
        self.quarantined[record.operation_id] = reason

    def advance_checkpoint(self, operation_id_value: str, state: str) -> None:
        doc_id = self.operations.get(operation_id_value)
        if doc_id is None:
            raise CheckpointError(f"unknown operation {operation_id_value}")
        record: ImportRecord = self.documents[doc_id]["record"]
        record = record.with_checkpoint(state)  # raises CheckpointError on bad step
        self.documents[doc_id]["record"] = record

    def set_batch_state(self, batch_id: str, state: str) -> None:
        batch = self.batches.get(batch_id)
        if batch is None:
            raise CheckpointError(f"unknown batch {batch_id}")
        current = batch["state"]
        if CHECKPOINT_ORDER.index(state) != CHECKPOINT_ORDER.index(current) + 1:
            raise CheckpointError(f"batch {batch_id}: {current} -> {state} is not a single step")
        batch["state"] = state

    def get_document(self, doc_id: str) -> dict[str, Any] | None:
        return self.documents.get(doc_id)

    def get_operation(self, op_id: str) -> dict[str, Any] | None:
        doc_id = self.operations.get(op_id)
        return self.documents.get(doc_id) if doc_id else None

    def representative(self, canonical_id: str) -> dict[str, Any] | None:
        """Forward-resolved representative for a canonical_id (§4.3)."""
        gen = 0
        chosen: dict[str, Any] | None = None
        while True:
            doc = self.documents.get(document_id(canonical_id, gen))
            if doc is None:
                break
            chosen = doc
            gen += 1
        return chosen

    def reconcile_batch(self, batch_id: str) -> int:
        """§9 reconciliation: lineage relation + zero-orphan-derived-facts.

        Every source record in the batch must have ≥1 target document; every
        target document must reference ≥1 source record; every derived
        conclusion must cite evidence (an uncited derived fact is an orphan).
        On success every submitted operation advances to 'reconciled'.
        """
        batch = self.batches.get(batch_id)
        if batch is None:
            raise ReconciliationError(f"unknown batch {batch_id}")
        quarantined_ops = {
            op for op, _ in ((op, r) for op, r in self.quarantined.items())
            if op in set(batch["operations"])
        }
        live_ops = [op for op in batch["operations"] if op not in quarantined_ops]
        if not live_ops:
            raise ReconciliationError(f"batch {batch_id} has no live operations to reconcile")
        for op in live_ops:
            doc = self.get_operation(op)
            if doc is None:
                raise ReconciliationError(f"operation {op} has no target document")
            record: ImportRecord = doc["record"]
            if record.record_type == "derived_conclusion" and not record.evidence_ids:
                raise ReconciliationError(
                    f"orphan derived fact {record.operation_id}: derived_conclusion "
                    "records must cite evidence_ids (zero-orphan check)"
                )
        for op in live_ops:
            self.advance_checkpoint(op, CHECKPOINT_OPERATION_COMPLETE)
            self.advance_checkpoint(op, CHECKPOINT_RECONCILED)
        self.set_batch_state(batch_id, CHECKPOINT_OPERATION_COMPLETE)
        self.set_batch_state(batch_id, CHECKPOINT_RECONCILED)
        return len(live_ops)


class BatchSubmitter:
    """Submits batches with spec §5 integrity semantics."""

    def __init__(self, store: ContractStore, transform_version: str = TRANSFORM_VERSION_DEFAULT) -> None:
        self.store = store
        self.transform_version = transform_version

    def submit_batch(
        self,
        payloads: Sequence[Mapping[str, Any]],
        *,
        originals: Mapping[str, bytes] | None = None,
        batch_id: str | None = None,
    ) -> BatchResult:
        """Sequentially validate + submit payloads.

        Hash mismatch on any record quarantines that record and HALTS the
        batch (remaining records are not processed, spec §5). Prior records
        keep their submitted checkpoint. Contract-shape violations and
        replace-mode attempts abort the whole batch with their own exceptions.
        """
        batch_id = batch_id or f"batch-{uuid.uuid4().hex[:12]}"
        result = BatchResult(batch_id=batch_id)
        originals = originals or {}
        for payload in payloads:
            canonical_id = str(payload.get("canonical_id", "<missing>"))
            declared_checkpoint = payload.get("ingest_checkpoint")
            if declared_checkpoint is not None and str(declared_checkpoint) != batch_id:
                raise ContractValidationError(
                    f"payload declares ingest_checkpoint={declared_checkpoint!r} but the "
                    f"batch is {batch_id!r} — the checkpoint must match the submitted batch"
                )
            try:
                record = build_record(
                    payload,
                    original_bytes=originals.get(canonical_id),
                    transform_version=self.transform_version,
                )
            except QuarantineError as exc:
                try:
                    bad = build_record(payload, original_bytes=None,
                                       transform_version=self.transform_version)
                except ContractValidationError:
                    bad_id = f"unparsed:{canonical_id}"
                    self.store.quarantined[bad_id] = str(exc)
                    result.quarantined.append(bad_id)
                else:
                    self.store.quarantine(bad, str(exc))
                    result.quarantined.append(bad.operation_id)
                result.halted = True
                raise BatchHaltedError(batch_id, exc) from exc
            self.store.put_document(record, batch_id)
            result.submitted.append(record.operation_id)
        return result


def iter_all_checkpoints(store: ContractStore, op_ids: Iterable[str]) -> list[str]:
    return [store.get_operation(op)["record"].checkpoint for op in op_ids]  # type: ignore[union-attr]
