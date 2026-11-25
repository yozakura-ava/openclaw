"""W6 provider-qualification gate — the hard pre-import gate (diet-design §8).

Normative references:
- HONCHO-DIET-AND-MIGRATION-DESIGN.md §8: fixed 100-doc gold set from the
  protected strata; >= 98% gold-fact recovery; 0 dropped chunks; strict schema
  on; extraction errors FATAL.
- Card d244e8fa: gold set from the A-protected stratum; embeddings = local
  Ollama bge-m3 (qualified per EMBEDDING-PROVIDER-QUALIFICATION-RECEIPT-2026-11-06,
  pinned in adapter/config.json).

Mechanics: the gate deterministically selects n=100 docs from the A-protected
manifest stratum, derives deterministic gold-fact units per doc, pushes every
doc through the SAME normalize/validate path the import pipeline uses (strict
schema via W4 build_record), lands them in a dedicated qualification
ContractStore (never the import store), then measures recovery. The ingest
runner refuses to run without a PASSED receipt from this gate.

The optional live embed probe (local Ollama bge-m3) is recorded best-effort:
unavailability degrades the receipt, never fabricates a pass (the embedding
provider qualification itself is already recorded 2026-11-06 in config pins).

Pure stdlib; PEP 604/585 style.
"""

from __future__ import annotations

import hashlib
import json
import re
import urllib.request
from dataclasses import dataclass, field
from typing import Any

try:  # package mode (sys.path has infra/hindsight)
    from adapter.corpus import (
        CorpusIntegrityError,
        CorpusReader,
        CuratedManifest,
        ManifestEntry,
        canonicalize_text,
    )
    from adapter.tier_contract import spec_for
    from adapter.import_contract import (
        ContractStore,
        ContractValidationError,
        QuarantineError,
        ReplaceProhibitedError,
        build_record,
    )
except ImportError:  # flat mode (adapter dir itself on sys.path)
    from corpus import (
    CorpusIntegrityError,
    CorpusReader,
    CuratedManifest,
    ManifestEntry,
    canonicalize_text,
)
    from tier_contract import spec_for
    from import_contract import (
        ContractStore,
        ContractValidationError,
        QuarantineError,
        ReplaceProhibitedError,
        build_record,
    )

GOLD_STRATUM = "A-protected"
GOLD_N_DOCS = 100
GOLD_RECOVERY_THRESHOLD = 0.98
GOLD_SEED = "w6-gold-set-2026-11-07"
MAX_GOLD_FACTS_PER_DOC = 20
_MIN_FACT_CHARS = 40
_EMBED_ENDPOINT = "http://127.0.0.1:11434"
_EMBED_MODEL = "bge-m3"


class QualificationFatal(Exception):
    """Extraction error inside the gold set — FATAL (strict mode §8)."""


class QualificationRequiredError(Exception):
    """Ingest attempted without a PASSED qualification receipt."""


def _seeded_permutation(items: list[ManifestEntry], seed: str) -> list[ManifestEntry]:
    """Deterministic sha256-seeded Fisher-Yates (stable across runs/hosts)."""
    out = list(items)
    counter = 0
    for i in range(len(out) - 1, 0, -1):
        material = f"{seed}|{i}".encode("utf-8")
        j = int.from_bytes(hashlib.sha256(material).digest()[:8], "big") % (i + 1)
        out[i], out[j] = out[j], out[i]
        counter += 1  # keep counter referenced; loop bound is the entropy source
    return out


def gold_facts(content: str) -> list[str]:
    """Deterministic gold-fact units: sentence-like lines with substance.

    A gold fact is any line >= 40 chars with >= 60% alphanumeric content,
    truncated to its first sentence if long. Deterministic and order-stable.
    """
    facts: list[str] = []
    for line in content.split("\n"):
        line = line.strip().lstrip("-*#> ").strip()
        if len(line) < _MIN_FACT_CHARS:
            continue
        alnum = sum(c.isalnum() for c in line)
        if alnum / max(1, len(line)) < 0.6:
            continue
        sentence = re.split(r"(?<=[.!?])\s+", line)[0].strip()
        facts.append(sentence if len(sentence) >= _MIN_FACT_CHARS else line)
        if len(facts) >= MAX_GOLD_FACTS_PER_DOC:
            break
    return facts


@dataclass
class QualificationReceipt:
    verdict: str  # PASS | FAIL
    n_docs: int
    gold_facts_total: int
    gold_facts_recovered: int
    recovery_rate: float
    dropped_chunks: list[dict[str, Any]] = field(default_factory=list)
    schema_violations: list[dict[str, Any]] = field(default_factory=list)
    replace_attempts: int = 0
    embed_probe: dict[str, Any] = field(default_factory=dict)
    seed: str = GOLD_SEED
    receipt_sha256: str | None = None
    detail: str = ""

    def to_dict(self) -> dict[str, Any]:
        d = {
            "kind": "w6-gold-set-qualification",
            "stratum": GOLD_STRATUM,
            "n_docs": self.n_docs,
            "gold_facts_total": self.gold_facts_total,
            "gold_facts_recovered": self.gold_facts_recovered,
            "recovery_rate": round(self.recovery_rate, 6),
            "threshold": GOLD_RECOVERY_THRESHOLD,
            "dropped_chunks": self.dropped_chunks,
            "schema_violations": self.schema_violations,
            "replace_attempts": self.replace_attempts,
            "embed_probe": self.embed_probe,
            "seed": self.seed,
            "verdict": self.verdict,
            "detail": self.detail,
        }
        blob = json.dumps(
            {k: v for k, v in d.items() if k != "receipt_sha256"}, sort_keys=True
        ).encode("utf-8")
        d["receipt_sha256"] = hashlib.sha256(blob).hexdigest()
        return d


def build_gold_set(
    manifest: CuratedManifest,
    *,
    reader: CorpusReader | None = None,
    n: int = GOLD_N_DOCS,
    seed: str = GOLD_SEED,
) -> list[ManifestEntry]:
    """Deterministic n-doc gold set from the A-protected stratum.

    Gold FACTS are text units, so binary artifacts (identity PNGs etc.) are
    skipped from SELECTION — deterministically, by decode probe, when a
    reader is supplied. They remain fully in scope for the import pipeline
    itself (carried as lossless base64 records).
    """
    entries = sorted(manifest.tier_index().get(GOLD_STRATUM, []), key=lambda e: e.path)
    if reader is not None:
        text_entries = []
        for e in entries:
            try:
                e_bytes = reader.read(e)
                e_bytes.decode("utf-8")
            except (CorpusIntegrityError, UnicodeDecodeError):
                continue
            text_entries.append(e)
        entries = text_entries
    if not entries:
        raise QualificationFatal(f"stratum {GOLD_STRATUM} empty — cannot qualify")
    picked = _seeded_permutation(entries, seed)[:n]
    return picked


def probe_embedding_provider(timeout_s: float = 8.0) -> dict[str, Any]:
    """Best-effort live probe of the pinned local Ollama bge-m3 endpoint.

    Measures dimension + L2 normalization on-box. Unavailability is recorded,
    never fabricated into a pass (the provider qualification receipt
    2026-11-06 + config pins remain the standing evidence).
    """
    probe: dict[str, Any] = {
        "endpoint": _EMBED_ENDPOINT,
        "model": _EMBED_MODEL,
        "status": "unavailable",
    }
    try:
        body = json.dumps({
            "model": _EMBED_MODEL,
            "input": ["w6 qualification probe"],
        }).encode("utf-8")
        req = urllib.request.Request(
            f"{_EMBED_ENDPOINT}/api/embed",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        embeddings = data.get("embeddings") or [data.get("embedding") or []]
        vec = embeddings[0] if embeddings else []
        dim = len(vec)
        l2 = sum(x * x for x in vec) ** 0.5 if vec else 0.0
        probe.update({
            "status": "live",
            "dimension": dim,
            "l2_norm": round(l2, 6),
            "expected_dimension": 1024,
            "dimension_ok": dim == 1024,
        })
    except Exception as exc:  # best-effort by design
        probe["error"] = f"{type(exc).__name__}: {exc}"
    return probe


def run_qualification(
    manifest: CuratedManifest,
    reader: CorpusReader,
    *,
    n: int = GOLD_N_DOCS,
    seed: str = GOLD_SEED,
    embed_probe: bool = True,
) -> QualificationReceipt:
    """Run the gold-set gate end-to-end in a dedicated qualification store.

    Gates: recovery >= 98%, 0 dropped chunks, strict schema (any contract
    violation counted + failing), extraction errors FATAL.
    """
    gold_entries = build_gold_set(manifest, reader=reader, n=n, seed=seed)
    store = ContractStore()  # dedicated qualification store — never the import store
    total_facts = 0
    recovered_facts = 0
    dropped: list[dict[str, Any]] = []
    dropped_chunks: list[dict[str, Any]] = []
    schema_violations: list[dict[str, Any]] = []
    replace_attempts = 0
    submitter_ok = 0
    for n_i, entry in enumerate(gold_entries):
        cid = f"honcho:gold:{entry.path}"  # source segment must be in SOURCE_SYSTEMS
        try:
            raw = reader.read(entry)
        except Exception as exc:
            raise QualificationFatal(f"gold doc unreadable {entry.path}: {exc}") from exc
        try:
            content = canonicalize_text(raw)
        except Exception as exc:
            raise QualificationFatal(f"extraction error (FATAL) {entry.path}: {exc}") from exc
        facts = gold_facts(content)
        total_facts += len(facts)
        source_sha = hashlib.sha256(raw).hexdigest()
        payload = {
            "canonical_id": cid,
            "source_system": "honcho",
            "source_uri": f"gold-set://{entry.path}",
            "source_sha256": source_sha,
            "content": content,
            "record_type": spec_for(GOLD_STRATUM).record_type,
            "trust_class": spec_for(GOLD_STRATUM).trust_class,
            "sensitivity": spec_for(GOLD_STRATUM).sensitivity,
            "target_bank": spec_for(GOLD_STRATUM).target_bank,
            "session_key": entry.path,
            "actor_type": spec_for(GOLD_STRATUM).actor_type,
            "claim_status": spec_for(GOLD_STRATUM).claim_status,
            "erasure_key_id": "ers-" + hashlib.sha256(
                ("erasure|" + source_sha).encode("utf-8")
            ).hexdigest()[:24],
        }
        try:
            record = build_record(payload, original_bytes=raw)
        except ReplaceProhibitedError as exc:  # unreachable, asserted defensively
            replace_attempts += 1
            schema_violations.append({"canonical_id": cid, "error": str(exc)})
            continue
        except QuarantineError as exc:
            # integrity mismatch inside the gold set is a hard gate failure
            schema_violations.append({"canonical_id": cid, "error": str(exc)})
            continue
        except ContractValidationError as exc:
            schema_violations.append({"canonical_id": cid, "error": str(exc)})
            continue
        if record.canonical_id != cid:  # strict-schema sanity
            schema_violations.append({"canonical_id": cid, "error": "canonical_id drift"})
            continue
        doc_id = store.put_document(record, batch_id="w6-gold-qualification")
        if doc_id is None or not facts:
            dropped.append({
                "canonical_id": cid,
                "reason": "doc landed no record" if doc_id is None else "no gold-fact units derived",
            })
            if doc_id is None:
                dropped_chunks.append({"canonical_id": cid, "reason": "zero chunks landed"})
        else:
            submitted = store.get_document(doc_id)
            ingested_content = submitted["record"].content if submitted else ""
            ingested_norm = " ".join(ingested_content.casefold().split())
            doc_recovered = 0
            for fact in facts:
                if " ".join(fact.casefold().split()) in ingested_norm:
                    doc_recovered += 1
            recovered_facts += doc_recovered
            submitter_ok += 1
            if doc_recovered < len(facts):
                # recovery accounting: missing facts measured, never silent
                pass
    dropped_chunks_final = dropped_chunks
    recovery_rate = (recovered_facts / total_facts) if total_facts else 0.0
    passed = (
        len(dropped_chunks_final) == 0
        and len(schema_violations) == 0
        and recovery_rate >= GOLD_RECOVERY_THRESHOLD
    )
    receipt = QualificationReceipt(
        verdict="PASS" if passed else "FAIL",
        n_docs=len(gold_entries),
        gold_facts_total=total_facts,
        gold_facts_recovered=recovered_facts,
        recovery_rate=recovery_rate,
        dropped_chunks=dropped,
        schema_violations=schema_violations,
        replace_attempts=replace_attempts,
        seed=seed,
        embed_probe=probe_embedding_provider() if embed_probe else {"status": "skipped"},
        detail=(
            f"dropped_chunks={len(dropped_chunks_final)} "
            f"schema_violations={len(schema_violations)} "
            f"recovered={recovered_facts}/{total_facts}"
        ),
    )
    sealed = receipt.to_dict()
    receipt.receipt_sha256 = sealed["receipt_sha256"]
    return receipt
