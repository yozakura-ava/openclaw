"""Curated-corpus manifest loader + manifest-addressed reader + §6 normalize — W6.

Normative references:
- Card d244e8fa: corpus at ~/staging/estate-migration/memory-curated/,
  manifest curation-manifest-v1.2.json (tiers, counts, per-file inventory).
- Spec §6: source_sha256 / ingested_sha256 / source_time (UTC + original tz)
  / erasure_key_id / session_key fields.
- Spec §5 + diet-design §5: hash mismatch = quarantine + halt batch.

Enumeration discipline (the file-scan prohibition, made structural): the ONLY
enumeration source is the manifest inventory list. This module contains no
directory walk, no glob, no os.scandir — records exist because the reviewed
inventory says they exist (the inventory step of the 12-step pipeline).

Pure stdlib; PEP 604/585 style.
"""

from __future__ import annotations

import base64
import datetime as _dt
import hashlib
import json
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator, Mapping

try:  # package mode (sys.path has infra/hindsight)
    from adapter.tier_contract import canonical_id_for, spec_for
except ImportError:  # flat mode (adapter dir itself on sys.path)
    from tier_contract import canonical_id_for, spec_for

MANIFEST_FILENAME = "curation-manifest-v1.2.json"
TRANSFORM_VERSION = "1"


class ManifestError(ValueError):
    """Manifest missing, malformed, or census-inconsistent (FATAL)."""


class CorpusIntegrityError(Exception):
    """Manifest-vs-bytes integrity mismatch — QUARANTINE + HALT the batch."""

    def __init__(self, path: str, detail: str) -> None:
        super().__init__(f"{path}: {detail}")
        self.path = path
        self.detail = detail


class ExtractionError(Exception):
    """Record extraction/normalization failure — FATAL (strict mode §8)."""


@dataclass(frozen=True)
class ManifestEntry:
    path: str
    tier: str
    bytes: int
    mtime: int
    sha256: str | None = None  # optional per-file pin (future manifests)


@dataclass(frozen=True)
class CuratedManifest:
    path: Path
    file_sha256: str
    freeze_hash: str
    purpose: str
    created_utc: str
    counts: dict[str, int]
    inventory: tuple[ManifestEntry, ...]

    def tier_index(self) -> dict[str, list[ManifestEntry]]:
        idx: dict[str, list[ManifestEntry]] = {}
        for entry in self.inventory:
            idx.setdefault(entry.tier, []).append(entry)
        for tier, entries in idx.items():
            entries.sort(key=lambda e: e.path)
        return idx

    def entry_by_path(self, path: str) -> ManifestEntry | None:
        for entry in self.inventory:
            if entry.path == path:
                return entry
        return None


def load_manifest(manifest_path: str | Path) -> CuratedManifest:
    """Load + validate the curated-corpus manifest (FATAL on inconsistency)."""
    p = Path(manifest_path)
    if not p.is_file():
        raise ManifestError(f"manifest not found: {p}")
    raw_bytes = p.read_bytes()
    try:
        raw = json.loads(raw_bytes.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ManifestError(f"manifest is not valid JSON: {exc}") from exc
    inventory_raw = raw.get("inventory")
    if not isinstance(inventory_raw, list) or not inventory_raw:
        raise ManifestError("manifest has no inventory list")
    entries: list[ManifestEntry] = []
    seen: set[str] = set()
    for i, item in enumerate(inventory_raw):
        if not isinstance(item, Mapping) or not {"path", "tier", "bytes"} <= set(item):
            raise ManifestError(f"inventory[{i}] missing path/tier/bytes")
        path = str(item["path"])
        if path in seen:
            raise ManifestError(f"duplicate inventory path: {path}")
        seen.add(path)
        entries.append(
            ManifestEntry(
                path=path,
                tier=str(item["tier"]),
                bytes=int(item["bytes"]),
                mtime=int(item.get("mtime", 0)),
                sha256=item.get("sha256"),
            )
        )
    counts = {k: int(v) for k, v in dict(raw.get("counts", {})).items()}
    observed: dict[str, int] = {}
    for entry in entries:
        observed[entry.tier] = observed.get(entry.tier, 0) + 1
    for tier, declared in counts.items():
        if observed.get(tier, 0) != declared:
            raise ManifestError(
                f"census mismatch for tier {tier}: manifest counts={declared}, "
                f"inventory has {observed.get(tier, 0)}"
            )
    total_files = int(raw.get("total_files", len(entries)))
    if total_files != len(entries):
        raise ManifestError(
            f"total_files={total_files} but inventory has {len(entries)} entries"
        )
    freeze_material = json.dumps(
        [
            {"path": e.path, "tier": e.tier, "bytes": e.bytes,
             "mtime": e.mtime, "sha256": e.sha256}
            for e in entries
        ],
        sort_keys=True,
    ).encode("utf-8")
    return CuratedManifest(
        path=p,
        file_sha256=hashlib.sha256(raw_bytes).hexdigest(),
        freeze_hash=hashlib.sha256(freeze_material).hexdigest(),
        purpose=str(raw.get("purpose", "")),
        created_utc=str(raw.get("created_utc", "")),
        counts=counts,
        inventory=tuple(entries),
    )


class CorpusReader:
    """Manifest-addressed corpus reader.

    Iterates ONLY manifest inventory entries (never the filesystem) and
    verifies byte integrity against the manifest on every read. A length or
    pinned-sha256 mismatch raises CorpusIntegrityError — the pipeline turns
    that into quarantine + batch halt (spec §5).
    """

    def __init__(self, manifest: CuratedManifest, corpus_root: str | Path) -> None:
        self.manifest = manifest
        self.root = Path(corpus_root)
        if not self.root.is_dir():
            raise ManifestError(f"corpus root not found: {self.root}")

    def iter_tier(self, tier: str) -> Iterator[tuple[ManifestEntry, bytes]]:
        for entry in self.manifest.tier_index().get(tier, []):
            yield entry, self.read(entry)

    def read(self, entry: ManifestEntry) -> bytes:
        f = self.root / entry.path
        if not f.is_file():
            raise CorpusIntegrityError(entry.path, "file missing from corpus root")
        data = f.read_bytes()
        if len(data) != entry.bytes:
            raise CorpusIntegrityError(
                entry.path,
                f"byte-length mismatch: manifest={entry.bytes} actual={len(data)}",
            )
        if entry.sha256 is not None:
            actual = hashlib.sha256(data).hexdigest()
            if actual != entry.sha256:
                raise CorpusIntegrityError(
                    entry.path,
                    f"sha256 mismatch: manifest={entry.sha256} actual={actual}",
                )
        return data


def canonicalize_text(raw: bytes) -> str:
    """transform_version=1 canonicalization: UTF-8 decode + NFC + LF newlines.

    The ORIGINAL bytes stay the evidence (source_sha256 hashes them); the
    canonicalized payload is what gets ingested (ingested_sha256 hashes it).
    Decode failure is an extraction error -> FATAL (strict mode).
    """
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ExtractionError(f"non-UTF-8 corpus payload: {exc}") from exc
    return unicodedata.normalize("NFC", text).replace("\r\n", "\n").replace("\r", "\n")


def erasure_key_id(source_sha256: str) -> str:
    """Content-keyed erasure key: replicas of the same source bytes share it,
    so the §5.5 lineage cascade reaches every replica via one key."""
    return "ers-" + hashlib.sha256(
        ("erasure|" + source_sha256).encode("utf-8")
    ).hexdigest()[:24]


def iso_utc(epoch_seconds: int) -> str:
    return (
        _dt.datetime.fromtimestamp(int(epoch_seconds), tz=_dt.timezone.utc)
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z")
    )


def normalize_entry(entry: ManifestEntry, raw: bytes, tier: str) -> dict:
    """Build the §6 import-contract payload for one manifest entry.

    source_time: manifest-declared mtime rendered as UTC; original tz is
    recorded as UTC (epoch mtimes carry no original-tz information — recorded
    honestly, never invented).

    Binary artifacts (the corpus carries e.g. identity PNGs) are carried
    LOSSLESSLY as "base64:<payload>" — a declared transform-v1 encoding, so
    every source file lands as a record and ingested_sha256 pins the exact
    canonicalized bytes.
    """
    spec = spec_for(tier)
    source_sha = hashlib.sha256(raw).hexdigest()
    try:
        content = canonicalize_text(raw)
    except ExtractionError:
        content = "base64:" + base64.b64encode(raw).decode("ascii")
    return {
        # canonical_id_for percent-escapes ':' in the native-id segment, so
        # colon-bearing corpus filenames stay contract-valid (3 segments).
        "canonical_id": canonical_id_for(tier, entry.path),
        "source_system": spec.source_system,
        "source_uri": f"curated-corpus://{entry.path}",
        "source_sha256": source_sha,
        "content": content,
        "record_type": spec.record_type,
        "trust_class": spec.trust_class,
        "sensitivity": spec.sensitivity,
        "target_bank": spec.target_bank,
        "session_key": entry.path,
        "turn_index": None,
        "parent_turn": None,
        "thread_id": None,
        "actor_type": spec.actor_type,
        "claim_status": spec.claim_status,
        "source_time_utc": iso_utc(entry.mtime),
        "source_tz": "UTC",
        "erasure_key_id": erasure_key_id(source_sha),
        "retention_class": "permanent" if spec.trust_class in ("A", "B") else "standard",
        "transform_version": TRANSFORM_VERSION,
    }
