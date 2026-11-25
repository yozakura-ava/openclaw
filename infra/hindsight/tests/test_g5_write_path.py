"""G5 write-path integration test: write -> read-back against a configurable
endpoint (card d338ba30; diet-design §5/§9, spec §6).

Default LOOPBACK CONTRACT MODE: the target is the in-process ContractStore
(reference shape of the G5 write surface). LIVE mode activates when
G5_ENDPOINT is set (avaworker:8766) and drives the same scenario over HTTP.

Dependency record (as of 2026-11-06): the live G5 endpoint is ABSENT (node
tailscale-pings OK, port 8766 closed — G5 ACL grant is owner-gated and
avaworker SSH is granted to no lane by design). The LOOPBACK PASS is the
deliverable; the live run fires when the endpoint exists.

Stdlib-only (no pytest on ava-harness):
    python3 infra/hindsight/tests/test_g5_write_path.py
"""

from __future__ import annotations

import datetime as _dt
import hashlib
import json
import os
import sys
import tempfile
import unittest
import urllib.request
from pathlib import Path

_TESTS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(_TESTS_DIR.parent))

from adapter.import_contract import (  # noqa: E402
    BatchHaltedError,
    BatchSubmitter,
    CHECKPOINT_OPERATION_COMPLETE,
    CHECKPOINT_RECONCILED,
    CHECKPOINT_SUBMITTED,
    ContractStore,
    ContractValidationError,
    GHOST_WINDOW,
    ImportRecord,
    QuarantineError,
    ReconciliationError,
    ReplaceProhibitedError,
    SupersessionRequiredError,
    correction_payload,
    document_id,
    operation_id,
)

G5_ENDPOINT = os.environ.get("G5_ENDPOINT", "").strip()
EVIDENCE_DIR = os.environ.get("W4_GATE_DIR", "/var/lib/ava-staging/evidence/hindsight")


def full_record(canonical_id: str, content: str, **overrides: object) -> dict:
    """A §5-complete record: every field of the field spec is exercised."""
    payload: dict = {
        "canonical_id": canonical_id,
        "source_system": "openclaw",
        "source_uri": "archive://staging-state/2026-11-06/session/bed22971",
        "source_sha256": hashlib.sha256(content.encode("utf-8")).hexdigest(),
        "content": content,
        "session_key": "agent:main:dashboard:858e4aa6-2f97-44d6-938c-84b1b26d1c73",
        "turn_index": 1,
        "parent_turn": None,
        "thread_id": "thread-w4-g5-selftest",
        "actor_type": "human",
        "record_type": "message",
        "trust_class": "A",
        "sensitivity": "internal",
        "claim_status": "observed",
        "supersedes": [],
        "evidence_ids": ["ev-0001"],
        "erasure_key_id": "dek-stg-0001",
        "retention_class": "permanent",
        "redaction_state": "none",
        "target_bank": "ava-staging-main",
    }
    payload.update(overrides)
    return payload


class LoopbackG5WritePath(unittest.TestCase):
    """Loopback contract mode: write -> read-back through ContractStore."""

    def setUp(self) -> None:
        self.store = ContractStore()
        self.submitter = BatchSubmitter(self.store, transform_version="1")

    def test_01_write_readback_full_field_roundtrip(self) -> None:
        recs = [
            full_record("openclaw:message:0001", "alpha turn content",
                        ingest_checkpoint="batch-loopback-1"),
            full_record("openclaw:message:0002", "beta turn content", turn_index=2,
                        ingest_checkpoint="batch-loopback-1"),
            full_record("openclaw:message:0003", "gamma turn content", turn_index=3,
                        ingest_checkpoint="batch-loopback-1"),
        ]
        result = self.submitter.submit_batch(recs, batch_id="batch-loopback-1")
        self.assertEqual(len(result.submitted), 3)
        self.assertFalse(result.halted)
        # Read-back by document_id AND operation_id; content hash must match.
        for payload, op in zip(recs, result.submitted):
            doc = self.store.get_operation(op)
            self.assertIsNotNone(doc, f"read-back failed for operation {op}")
            record: ImportRecord = doc["record"]
            self.assertEqual(record.content, payload["content"])
            self.assertEqual(
                hashlib.sha256(record.content.encode("utf-8")).hexdigest(),
                record.ingested_sha256,
                "ingested_sha256 must equal sha256(submitted bytes)",
            )
            self.assertEqual(record.operation_id, operation_id(
                record.canonical_id, record.ingested_sha256, record.transform_version
            ))
            self.assertEqual(record.session_key, payload["session_key"])
            self.assertEqual(record.turn_index, payload["turn_index"])
            self.assertEqual(record.erasure_key_id, payload["erasure_key_id"])
            self.assertEqual(record.ingest_checkpoint, "batch-loopback-1")
            self.assertEqual(record.checkpoint, CHECKPOINT_SUBMITTED)
            self.assertEqual(
                doc["operation_id"], self.store.documents[record.document_id]["operation_id"]
            )
        # Checkpoint ladder submitted -> operation_complete -> reconciled.
        reconciled = self.store.reconcile_batch("batch-loopback-1")
        self.assertEqual(reconciled, 3)
        for op in result.submitted:
            rec = self.store.get_operation(op)["record"]
            self.assertEqual(rec.checkpoint, CHECKPOINT_RECONCILED)
        self.assertEqual(self.store.batches["batch-loopback-1"]["state"], CHECKPOINT_RECONCILED)

    def test_01b_ingest_checkpoint_mismatch_rejected(self) -> None:
        bad = full_record("openclaw:message:0010", "checkpoint mismatch",
                          ingest_checkpoint="some-other-batch")
        with self.assertRaises(ContractValidationError):
            self.submitter.submit_batch([bad], batch_id="batch-loopback-2")
        self.assertEqual(len(self.store.documents), 0)

    def test_02_idempotent_replay_lands_on_same_documents(self) -> None:
        recs = [full_record("openclaw:message:0100", "idempotent payload")]
        r1 = self.submitter.submit_batch(recs, batch_id="batch-idem-1")
        r2 = self.submitter.submit_batch(recs, batch_id="batch-idem-2")
        self.assertEqual(r1.submitted, r2.submitted, "same payload must replay identically")
        self.assertEqual(len(self.store.documents), 1, "no duplicate documents on replay")

    def test_03_operation_id_changes_with_payload_and_transform(self) -> None:
        rec = full_record("openclaw:message:0200", "stable content")
        op_a = operation_id(rec["canonical_id"],
                            hashlib.sha256(rec["content"].encode()).hexdigest(), "1")
        payload_byte_flip = rec["content"] + " "
        op_b = operation_id(rec["canonical_id"],
                            hashlib.sha256(payload_byte_flip.encode()).hexdigest(), "1")
        op_c = operation_id(rec["canonical_id"],
                            hashlib.sha256(rec["content"].encode()).hexdigest(), "2")
        self.assertNotEqual(op_a, op_b, "payload change must change operation_id")
        self.assertNotEqual(op_a, op_c, "transform_version change must change operation_id")
        # And the store refuses a different payload under the same document
        # identity without a supersedes edge (no silent replace).
        self.submitter.submit_batch([rec], batch_id="batch-opid-1")
        mutated = dict(rec, content=rec["content"] + " mutated")
        with self.assertRaises(SupersessionRequiredError):
            self.submitter.submit_batch([mutated], batch_id="batch-opid-2")

    def test_04_replace_mode_is_prohibited(self) -> None:
        bad = dict(full_record("openclaw:message:0300", "x"), update_mode="replace")
        with self.assertRaises(ReplaceProhibitedError):
            self.submitter.submit_batch([bad], batch_id="batch-replace-1")
        self.assertEqual(len(self.store.documents), 0, "replace-mode payload must not land")

    def test_05_correction_flows_through_supersedes_graph(self) -> None:
        original_payload = full_record("openclaw:preference:0400", "prefers tea")
        r1 = self.submitter.submit_batch([original_payload], batch_id="batch-corr-1")
        original = self.store.get_operation(r1.submitted[0])["record"]
        correction = correction_payload(original, "prefers tea, oat milk, no sugar")
        r2 = self.submitter.submit_batch([correction], batch_id="batch-corr-2")
        corrected = self.store.get_operation(r2.submitted[0])["record"]
        # Original document is IMMUTABLE and still queryable.
        original_doc = self.store.get_document(original.document_id)
        self.assertIsNotNone(original_doc)
        self.assertEqual(original_doc["record"].content, "prefers tea")
        self.assertIn(original.document_id, self.store.superseded)
        self.assertEqual(
            self.store.supersedes, [(original.document_id, corrected.document_id)]
        )
        # Representative selection resolves FORWARD to the correction.
        rep = self.store.representative("openclaw:preference:0400")
        self.assertIsNotNone(rep)
        self.assertEqual(rep["record"].document_id, corrected.document_id)
        self.assertEqual(corrected.document_id, document_id("openclaw:preference:0400", 1))
        # A bare generation bump without supersedes is invalid.
        with self.assertRaises(ContractValidationError):
            self.submitter.submit_batch(
                [dict(correction, supersedes=[])], batch_id="batch-corr-3"
            )

    def test_06_hash_mismatch_quarantines_and_halts_batch(self) -> None:
        good1 = full_record("openclaw:message:0500", "good one")
        bad = full_record("openclaw:message:0501", "declared hash is stale")
        tampered_bytes = b"actual evidence bytes differ"
        after = full_record("openclaw:message:0502", "never processed")
        with self.assertRaises(BatchHaltedError) as ctx:
            self.submitter.submit_batch(
                [good1, bad, after],
                originals={"openclaw:message:0501": tampered_bytes},
                batch_id="batch-hash-1",
            )
        self.assertEqual(ctx.exception.batch_id, "batch-hash-1")
        # The bad record is quarantined, never imported.
        quarantined = list(self.store.quarantined.values())
        self.assertTrue(any("hash mismatch" in q for q in quarantined))
        bad_op = operation_id(
            "openclaw:message:0501",
            hashlib.sha256(bad["content"].encode()).hexdigest(),
            "1",
        )
        self.assertIn(bad_op, self.store.quarantined)
        self.assertIsNone(self.store.get_operation(bad_op))
        # Halt semantics: later records are NOT processed.
        after_op = operation_id(
            "openclaw:message:0502",
            hashlib.sha256(after["content"].encode()).hexdigest(),
            "1",
        )
        self.assertIsNone(self.store.get_operation(after_op))
        # Records BEFORE the bad one keep their submitted state.
        self.assertEqual(
            self.store.get_document(document_id("openclaw:message:0500"))["record"].checkpoint,
            CHECKPOINT_SUBMITTED,
        )

    def test_07_checkpoint_ladder_rejects_skips_and_regressions(self) -> None:
        rec_payload = full_record("openclaw:message:0600", "ladder check")
        r = self.submitter.submit_batch([rec_payload], batch_id="batch-ladder-1")
        op = r.submitted[0]
        with self.assertRaises(Exception):
            self.store.advance_checkpoint(op, CHECKPOINT_RECONCILED)  # skip is invalid
        self.store.advance_checkpoint(op, CHECKPOINT_OPERATION_COMPLETE)
        with self.assertRaises(Exception):
            self.store.advance_checkpoint(op, CHECKPOINT_SUBMITTED)  # regression
        rec = self.store.get_operation(op)["record"]
        self.assertEqual(rec.checkpoint, CHECKPOINT_OPERATION_COMPLETE)

    def test_08_reconciliation_requires_evidence_on_derived_facts(self) -> None:
        orphan = full_record(
            "openclaw:fact:0700",
            "derived: owner runs tsubaki lane",
            record_type="derived_conclusion",
            evidence_ids=[],
            trust_class="C",
        )
        r = self.submitter.submit_batch([orphan], batch_id="batch-orphan-1")
        with self.assertRaises(ReconciliationError):
            self.store.reconcile_batch("batch-orphan-1")
        # Still stuck at operation_complete-level invariants: not reconciled.
        rec = self.store.get_operation(r.submitted[0])["record"]
        self.assertEqual(rec.checkpoint, CHECKPOINT_SUBMITTED)

    def test_09_ghost_window_constant_is_pinned(self) -> None:
        self.assertEqual(GHOST_WINDOW, ("2026-10-28T04:00:00Z", "2026-11-05T04:00:00Z"))


class LiveG5WritePath(unittest.TestCase):
    """LIVE mode — only runs when G5_ENDPOINT is set (avaworker:8766)."""

    @unittest.skipUnless(G5_ENDPOINT, "G5_ENDPOINT not set — loopback mode is the deliverable")
    def test_live_write_readback(self) -> None:
        rec = full_record("openclaw:message:9000", "live endpoint probe")
        # Wire shape: POST /v1/batches/{id}/records, GET /v1/documents/{id}.
        base = G5_ENDPOINT.rstrip("/")
        body = json.dumps(
            {"records": [rec], "transform_version": "1"}
        ).encode("utf-8")
        req = urllib.request.Request(
            f"{base}/v1/batches/batch-live-1/records",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            ack = json.loads(resp.read().decode("utf-8"))
        self.assertEqual(ack.get("status"), "submitted")
        doc_id = document_id("openclaw:message:9000")
        with urllib.request.urlopen(f"{base}/v1/documents/{doc_id}", timeout=15) as resp:
            back = json.loads(resp.read().decode("utf-8"))
        self.assertEqual(back.get("content_sha256"), rec["source_sha256"])


def write_evidence(loopback_passed: bool, live_status: str) -> None:
    record = {
        "test": "g5-write-path",
        "recorded_at": _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds"),
        "mode": "loopback-contract" if not G5_ENDPOINT else "live+loopback",
        "loopback_result": "PASS" if loopback_passed else "FAIL",
        "live_endpoint": G5_ENDPOINT or None,
        "live_status": live_status,
        "dependency_note": (
            "live G5 endpoint ABSENT as of 2026-11-06 (avaworker:8766 port closed; "
            "G5 ACL grant owner-gated; avaworker SSH granted to no lane). Loopback "
            "contract pass is the W4 deliverable; live run fires when endpoint exists."
            if not G5_ENDPOINT
            else None
        ),
    }
    try:
        os.makedirs(EVIDENCE_DIR, exist_ok=True)
        path = os.path.join(EVIDENCE_DIR, "g5-write-path.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(record, fh, indent=2, sort_keys=True)
        print(f"G5 write-path record written: {path}")
    except OSError as exc:
        print(f"WARN: could not write g5 evidence: {exc}")


if __name__ == "__main__":
    result = unittest.main(exit=False, verbosity=2)
    loopback_ok = result.result.wasSuccessful() if result.result else False
    live = "not-run (G5_ENDPOINT unset; endpoint absent by design)" if not G5_ENDPOINT else "attempted"
    write_evidence(loopback_ok, live)
    sys.exit(0 if loopback_ok else 1)
