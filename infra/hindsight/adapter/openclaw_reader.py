"""OpenClaw transcript readers for the Hindsight import adapter.

Normative references:
- diet-design §6 (ingestion path): source readers MUST be the OpenClaw Plugin
  SDK transcript readers or the Gateway RPC equivalents — NEVER the upstream
  backfill CLI's file scan (broken on both backends; hindsight issue #5569 /
  research-brief-P0 R1).
- diet-design §6 + §3 Class C: the operational-exclusion matrix
  (provider × role × session-type × age) applies at OUR importer AND at live
  capture — upstream defaults only exclude the heartbeat provider, so naive
  backfill re-imports cron/subagent sessions.
- diet-design §6 known-lossy defaults ledger: retainRoles (user+assistant
  only) and 2000-char tool-result truncation are recorded as POLICY losses,
  never silent holes.

Supported source surfaces (research-brief-P0 R1, verbatim shapes):
- SDK:  readSessionTranscriptCatalogPage({agentId, sessionKey, limit, cursor})
        listSessionEntriesAsync({agentId})
- RPC:  sessions.list + chat.history

This module contains NO file-scan reader. The only non-RPC source is
StoreSnapshotReader, a parity-gate FIXTURE bound to a read-only COPY of a
state-store sqlite snapshot (never the live DB, never an import path).

Pure stdlib; PEP 604/585 style.
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Iterator, Mapping, Sequence

# Real SDK/RPC surface names (src/plugin-sdk/session-transcript-runtime.ts,
# src/plugin-sdk/session-store-runtime.ts, src/gateway/session-transcript-catalog.ts).
SDK_READ_SESSION_TRANSCRIPT_CATALOG_PAGE = "readSessionTranscriptCatalogPage"
SDK_LIST_SESSION_ENTRIES_ASYNC = "listSessionEntriesAsync"
RPC_SESSIONS_LIST = "sessions.list"
RPC_CHAT_HISTORY = "chat.history"

# Prohibited import path (upstream backfill CLI defect #5569). Kept as a named
# constant so tests can assert the prohibition stays load-bearing.
PROHIBITED_SOURCE = "file-scan backfill (hindsight-openclaw-backfill CLI)"

DEFAULT_EXCLUDE_PROVIDERS = ("heartbeat", "cron", "subagent")
DEFAULT_RETAIN_ROLES = ("user", "assistant")
DEFAULT_EXCLUDE_SESSION_TYPES = ("operational", "heartbeat", "cron", "subagent", "monitoring")
TOOL_RESULT_TRUNCATION_CHARS = 2000

_OPERATIONAL_TOKENS = ("cron", "heartbeat", "subagent", "monitor", "health")


@dataclass(frozen=True)
class TranscriptEntry:
    """One catalog entry projected from an SDK page / RPC history / store row."""

    session_key: str
    agent_id: str
    sequence: int
    kind: str
    actor_type: str
    actor_id: str | None
    occurred_at: int | None
    summary: str | None
    payload: Mapping[str, Any] | None
    session_id: str | None = None
    run_id: str | None = None

    def provider(self) -> str:
        """Best-effort provider/origin projection from the session key.

        OpenClaw session keys look like agent:<agent>:<origin>:<id>; cron and
        heartbeat sessions carry those tokens in the key or agent id.
        """
        haystack = f"{self.session_key} {self.agent_id}".lower()
        for token in _OPERATIONAL_TOKENS:
            if token in haystack:
                return token
        parts = self.session_key.split(":")
        return parts[2] if len(parts) >= 4 else (parts[0] if parts else "unknown")

    def session_type(self) -> str:
        return "operational" if self.provider() in DEFAULT_EXCLUDE_PROVIDERS or any(
            t in self.provider() for t in _OPERATIONAL_TOKENS
        ) else "conversation"

    def role(self) -> str:
        return {"human": "user", "agent": "assistant"}.get(self.actor_type, self.actor_type)


@dataclass
class PolicyLossLedger:
    """Known-lossy defaults ledger (diet-design §6) — policy losses, not holes."""

    truncated_tool_results: list[dict[str, Any]] = field(default_factory=list)
    dropped_non_retained_roles: list[dict[str, Any]] = field(default_factory=list)
    excluded_operational_entries: list[dict[str, Any]] = field(default_factory=list)

    def as_list(self) -> list[dict[str, Any]]:
        return (
            self.truncated_tool_results
            + self.dropped_non_retained_roles
            + self.excluded_operational_entries
        )


class ExclusionMatrix:
    """Operational-exclusion matrix: provider × role × session-type × age.

    Baseline + explicit exclusions (upstream only excludes 'heartbeat'):
    cron and subagent providers are excluded by default per diet-design §3
    Class C. Evaluator/backfill-exempt sessions (red-team E1/F1) are pinned
    via exempt_session_keys — an explicit allowlist, never inferred.
    """

    def __init__(
        self,
        *,
        exclude_providers: Sequence[str] = DEFAULT_EXCLUDE_PROVIDERS,
        retain_roles: Sequence[str] = DEFAULT_RETAIN_ROLES,
        exclude_session_types: Sequence[str] = DEFAULT_EXCLUDE_SESSION_TYPES,
        exempt_session_keys: Sequence[str] = (),
        ghost_window: tuple[str, str] | None = None,
        max_age_days: int | None = None,
        now_ms: int | None = None,
    ) -> None:
        self.exclude_providers = tuple(exclude_providers)
        self.retain_roles = tuple(retain_roles)
        self.exclude_session_types = tuple(exclude_session_types)
        self.exempt_session_keys = tuple(exempt_session_keys)
        self.ghost_window = ghost_window
        self.max_age_days = max_age_days
        self.now_ms = now_ms

    def resolved_hash(self) -> str:
        """Exclusion-list hash (red-team control: mandatory attribution)."""
        material = json.dumps(
            {
                "exclude_providers": sorted(self.exclude_providers),
                "retain_roles": sorted(self.retain_roles),
                "exclude_session_types": sorted(self.exclude_session_types),
                "exempt_session_keys": sorted(self.exempt_session_keys),
                "ghost_window": list(self.ghost_window) if self.ghost_window else None,
                "max_age_days": self.max_age_days,
            },
            sort_keys=True,
        ).encode("utf-8")
        return hashlib.sha256(material).hexdigest()

    def applies(self, entry: TranscriptEntry) -> bool:
        """True when the entry is EXCLUDED from ingest (operational noise)."""
        if entry.session_key in self.exempt_session_keys:
            return False
        if entry.provider() in self.exclude_providers:
            return True
        if entry.session_type() in self.exclude_session_types:
            return True
        if entry.role() not in self.retain_roles:
            return True
        if self.max_age_days is not None and self.now_ms is not None and entry.occurred_at:
            age_ms = self.now_ms - entry.occurred_at
            if age_ms > self.max_age_days * 86_400_000:
                return True
        return False


class RpcReader:
    """Gateway-RPC transcript reader (the production import path).

    Reads via RPC sessions.list + chat.history against a running OpenClaw
    gateway. Credentials come ONLY from a SecretRef-style env var (never
    inline). There is deliberately no path-based fallback: an absent endpoint
    is an error, not an invitation to file-scan.
    """

    def __init__(self, endpoint: str, *, token_env: str = "AVA_OPENCLAW_RPC_TOKEN",
                 timeout_s: int = 30) -> None:
        self.endpoint = endpoint.rstrip("/")
        self.token_env = token_env
        self.timeout_s = timeout_s

    def _call(self, method: str, params: Mapping[str, Any]) -> Any:
        import os

        token = os.environ.get(self.token_env, "")
        body = json.dumps({"method": method, "params": dict(params)}).encode("utf-8")
        req = urllib.request.Request(
            f"{self.endpoint}/rpc",
            data=body,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {token}",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=self.timeout_s) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def list_sessions(self, agent_id: str, *, limit: int = 200, cursor: str | None = None) -> Mapping[str, Any]:
        """RPC sessions.list — paginated catalog page ({agentId, limit, cursor})."""
        return self._call(RPC_SESSIONS_LIST, {"agentId": agent_id, "limit": limit, "cursor": cursor})

    def chat_history(self, session_key: str, *, limit: int = 200, cursor: str | None = None) -> Mapping[str, Any]:
        """RPC chat.history — paginated entry page ({sessionKey, limit, cursor})."""
        return self._call(RPC_CHAT_HISTORY, {"sessionKey": session_key, "limit": limit, "cursor": cursor})

    @staticmethod
    def entry_from_rpc(session_key: str, agent_id: str, row: Mapping[str, Any]) -> TranscriptEntry:
        return TranscriptEntry(
            session_key=session_key,
            agent_id=agent_id,
            sequence=int(row.get("sequence", row.get("turnIndex", 0))),
            kind=str(row.get("kind", row.get("role", "message"))),
            actor_type=str(row.get("actorType", row.get("role", "unknown"))),
            actor_id=row.get("actorId"),
            occurred_at=row.get("occurredAt"),
            summary=row.get("summary"),
            payload=row.get("payload") if isinstance(row.get("payload"), Mapping) else None,
            session_id=row.get("sessionId"),
            run_id=row.get("runId"),
        )


class StoreSnapshotReader:
    """PARITY-GATE FIXTURE — read-only reader over a COPIED state-store snapshot.

    Binds to a sqlite COPY (three WAL-sidecar files taken together) of the
    gateway state store, opened with mode=ro. Used exclusively by the P1
    reader-parity gate. It is NOT the import path: bulk import goes through
    RpcReader/SDK surfaces only (diet-design §6).
    """

    def __init__(self, snapshot_path: str) -> None:
        uri = f"file:{snapshot_path}?mode=ro"
        self._db = sqlite3.connect(uri, uri=True)
        self._db.row_factory = sqlite3.Row

    def close(self) -> None:
        self._db.close()

    def catalog_page(self, agent_id: str, *, limit: int = 200, cursor: str | None = None) -> Mapping[str, Any]:
        """Mirror of readSessionTranscriptCatalogPage / sessions.list paging.

        Opaque cursor = 'o:<offset>'; heads are the durable session catalog
        (session_state_heads).
        """
        offset = int(cursor.split(":", 1)[1]) if cursor else 0
        rows = self._db.execute(
            "SELECT session_key, agent_id, last_sequence, pruned_max_sequence, updated_at "
            "FROM session_state_heads WHERE agent_id = ? ORDER BY session_key LIMIT ? OFFSET ?",
            (agent_id, limit, offset),
        ).fetchall()
        items = [dict(r) for r in rows]
        next_cursor = f"o:{offset + len(items)}" if len(items) == limit else None
        return {"items": items, "cursor": next_cursor}

    def entries_page(self, session_key: str, *, limit: int = 200, cursor: str | None = None) -> Mapping[str, Any]:
        """Mirror of listSessionEntriesAsync / chat.history entry paging.

        Cursor = last seen sequence; entries ordered by sequence.
        """
        after = int(cursor) if cursor else 0
        rows = self._db.execute(
            "SELECT sequence, dedupe_key, session_key, session_id, agent_id, kind, "
            "actor_type, actor_id, run_id, occurred_at, summary, payload_json "
            "FROM session_state_events WHERE session_key = ? AND sequence > ? "
            "ORDER BY sequence LIMIT ?",
            (session_key, after, limit),
        ).fetchall()
        items = [self._entry_from_row(dict(r)) for r in rows]
        next_cursor = str(items[-1].sequence) if len(items) == limit else None
        return {"items": items, "cursor": next_cursor}

    def all_sessions(self, agent_id: str | None = None) -> list[dict[str, Any]]:
        sql = "SELECT session_key, agent_id, last_sequence, updated_at FROM session_state_heads"
        params: tuple[Any, ...] = ()
        if agent_id is not None:
            sql += " WHERE agent_id = ?"
            params = (agent_id,)
        return [dict(r) for r in self._db.execute(sql, params)]

    def all_entries(self, session_key: str) -> list[TranscriptEntry]:
        rows = self._db.execute(
            "SELECT sequence, dedupe_key, session_key, session_id, agent_id, kind, "
            "actor_type, actor_id, run_id, occurred_at, summary, payload_json "
            "FROM session_state_events WHERE session_key = ? ORDER BY sequence",
            (session_key,),
        ).fetchall()
        return [self._entry_from_row(dict(r)) for r in rows]

    @staticmethod
    def _entry_from_row(row: Mapping[str, Any]) -> TranscriptEntry:
        payload = None
        if row.get("payload_json"):
            try:
                payload = json.loads(str(row["payload_json"]))
            except json.JSONDecodeError:
                payload = {"_unparsed": str(row["payload_json"])}
        return TranscriptEntry(
            session_key=str(row["session_key"]),
            agent_id=str(row["agent_id"]),
            sequence=int(row["sequence"]),
            kind=str(row["kind"]),
            actor_type=str(row.get("actor_type") or "unknown"),
            actor_id=row.get("actor_id"),
            occurred_at=row.get("occurred_at"),
            summary=row.get("summary"),
            payload=payload,
            session_id=row.get("session_id"),
            run_id=row.get("run_id"),
        )


class ImportReader:
    """Import-side reader: pages a source through the exclusion matrix.

    Emits only in-scope turns and records every policy loss in the ledger
    (retainRoles drops, 2000-char tool-result truncation, operational
    exclusions) so reconciliation can distinguish policy-explained losses
    from holes (diet-design §6).
    """

    def __init__(self, source: RpcReader | StoreSnapshotReader, matrix: ExclusionMatrix) -> None:
        self.source = source
        self.matrix = matrix
        self.ledger = PolicyLossLedger()

    def iter_session_turns(self, session_key: str, agent_id: str) -> Iterator[TranscriptEntry]:
        """Page through one session, drop excluded entries, ledger the losses."""
        cursor: str | None = None
        if isinstance(self.source, StoreSnapshotReader):
            while True:
                page = self.source.entries_page(session_key, cursor=cursor)
                yield from self._filter(agent_id, page["items"])
                if not page["cursor"]:
                    break
                cursor = page["cursor"]
        elif isinstance(self.source, RpcReader):
            while True:
                page = self.source.chat_history(session_key, cursor=cursor)
                items = [
                    RpcReader.entry_from_rpc(session_key, agent_id, row)
                    for row in page.get("items", [])
                ]
                yield from self._filter(agent_id, items)
                if not page.get("cursor"):
                    break
                cursor = page.get("cursor")
        else:  # pragma: no cover - type guard
            raise TypeError(f"unsupported source: {type(self.source)!r}")

    def _filter(self, agent_id: str, entries: Sequence[TranscriptEntry]) -> list[TranscriptEntry]:
        kept: list[TranscriptEntry] = []
        for entry in entries:
            if self.matrix.applies(entry):
                self.ledger.excluded_operational_entries.append(
                    {
                        "session_key": entry.session_key,
                        "sequence": entry.sequence,
                        "reason": "operational-exclusion-matrix",
                        "provider": entry.provider(),
                        "matrix_hash": self.matrix.resolved_hash(),
                    }
                )
                continue
            if entry.role() not in self.matrix.retain_roles:
                self.ledger.dropped_non_retained_roles.append(
                    {"session_key": entry.session_key, "sequence": entry.sequence,
                     "role": entry.role()}
                )
                continue
            payload = entry.payload or {}
            text = payload.get("text") or payload.get("content") or ""
            if entry.role() == "tool" and isinstance(text, str) and len(text) > TOOL_RESULT_TRUNCATION_CHARS:
                self.ledger.truncated_tool_results.append(
                    {"session_key": entry.session_key, "sequence": entry.sequence,
                     "original_chars": len(text), "policy_chars": TOOL_RESULT_TRUNCATION_CHARS}
                )
                text = text[:TOOL_RESULT_TRUNCATION_CHARS]
            kept.append(entry)
        return kept

    def iter_agent_turns(self, agent_id: str) -> Iterator[TranscriptEntry]:
        """Page the agent catalog, then stream each session's in-scope turns."""
        if isinstance(self.source, StoreSnapshotReader):
            heads = self.source.all_sessions(agent_id)
        elif isinstance(self.source, RpcReader):
            heads = list(self.source.list_sessions(agent_id).get("items", []))
        else:  # pragma: no cover - type guard
            raise TypeError(f"unsupported source: {type(self.source)!r}")
        for head in heads:
            session_key = str(head.get("session_key") or head.get("sessionKey"))
            yield from self.iter_session_turns(session_key, agent_id)

    def exclusion_count_report(self, entries: Sequence[TranscriptEntry]) -> dict[str, int]:
        """P4 count-test helper: source operational turns must reach target 0."""
        excluded = [e for e in entries if self.matrix.applies(e)]
        return {
            "total": len(entries),
            "excluded_operational": len(excluded),
            "in_scope": len(entries) - len(excluded),
            "matrix_hash": self.matrix.resolved_hash(),
        }
