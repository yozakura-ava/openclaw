# infra/hindsight — Hindsight import adapter (W4)

AVA vNext sprint `2026-11-05-ava-vnext-harness-build`, work package W4
(workboard card `d338ba30-557a-4dc4-977e-5a8f231f0ec5`). Implements the
Honcho→Hindsight import contract mechanics of
`AVA-vNEXT-GENESIS-HARDENED-SPEC.md` §6 and
`HONCHO-DIET-AND-MIGRATION-DESIGN.md` §4–§9 + §11 pilot ladder.

## Layout

| Path | Purpose |
|---|---|
| `adapter/import_contract.py` | §5 field spec, operation_id/document_id derivation, checkpoint ladder (`submitted → operation_complete → reconciled`), hash-mismatch quarantine + batch halt, `update_mode: replace` prohibition, supersedes-only corrections, §9 reconciliation (lineage + zero-orphan-derived-facts), loopback `ContractStore` + `BatchSubmitter`. Pure stdlib. |
| `adapter/openclaw_reader.py` | Source readers: Gateway-RPC (`sessions.list` + `chat.history`) and the SDK shapes they mirror (`readSessionTranscriptCatalogPage({agentId, sessionKey, limit, cursor})`, `listSessionEntriesAsync({agentId})`). **No file-scan reader exists** — the upstream backfill CLI's file scan is the #5569 defect and is prohibited. `StoreSnapshotReader` is a parity-gate FIXTURE bound to a read-only COPY of a state-store sqlite, never an import path. Operational-exclusion matrix (provider × role × session-type × age) with baseline heartbeat + explicit cron/subagent exclusions, evaluator-exempt allowlist, pinned ghost window, exclusion-list hash. Known-lossy defaults ledger (retainRoles, 2000-char tool truncation). |
| `adapter/config.json` | Version pins: `hindsight_engine` 1.1.0, `hindsight_openclaw_plugin` 1.2.0, `embedVersion` **pinned** (`latest` prohibited — lint-enforced). SecretRef-only credentials. `replace_prohibited`, consolidation off + 300s settle, pinned ghost window `["2026-10-28T04:00:00Z","2026-11-05T04:00:00Z"]` (diet-design §2 constant). Embedding-model one-way-door pin slots resolve at provider qualification (P3/P5) — lint fails production-import mode while pending. `allowKnowledgeDelete: false` asserted for backfill/benchmark (delete propagation proven separately at P8). |
| `tests/test_reader_parity.py` | **P1 pilot gate** — ≥99.9% turn-level parity. Copies the staging state store (sqlite + `-wal` + `-shm` taken together) read-only to a temp dir; live DB untouched. Reader paging is forced to `limit=1` so cursor/ordering bugs cannot hide. Gate-1 JSON record written to `/var/lib/ava-staging/evidence/hindsight/gate-1-parity.json`. |
| `tests/test_g5_write_path.py` | G5 write→read-back. Default **loopback contract mode** (in-process `ContractStore`). Live mode via `G5_ENDPOINT` (avaworker:8766) — endpoint ABSENT as of 2026-11-06 (node pings, port closed; G5 ACL grant owner-gated; avaworker SSH granted to no lane by design). Loopback pass is the deliverable; the dependency is recorded. |
| `bin/apply.sh` | Payload deploy to `/opt/ava-staging/hindsight` + unit upgrade. Single-flight (flock), receipts per privileged batch in `/var/lib/staging-iac/receipts/`, paired auto-revert. Never touches staging-gateway (asserts it stays active). |
| `bin/verify.sh` | Config lint (pins / no-`latest` / SecretRef-only / replace prohibited / ghost window) + loopback contract self-test + unit state. Read-only; safe under `ProtectSystem=strict`. |

Staging unit: `infra/staging/units/staging-hindsight.service` — W4 payload
(oneshot adapter verify), preserving the W2 pins: `User/Group
svc-stg-hindsight`, `MemoryMax=4G`, `MemorySwapMax=0` (+ the W2 hardening set:
`NoNewPrivileges`, `ProtectSystem=strict`, `PrivateTmp`, CPUAccounting).

## Contract summary (diet-design §5)

- `operation_id = f(canonical_id, ingested_sha256, transform_version)` —
  changes with payload or transform version (defeats stale-cache replays).
- `document_id` — stable per canonical_id (gen-0 upsert identity); corrections
  are NEW generations with a `supersedes[]` edge; original documents are
  immutable and remain queryable; representative selection resolves forward.
- Checkpoints advance `submitted → operation_complete → reconciled` only
  (single-step, monotonic). Reconciliation (§9) = lineage relation +
  zero-orphan-derived-facts; reconciliation against source is the only
  trustworthy "done".
- Hash mismatch (declared `source_sha256` vs actual original bytes) =
  quarantine + HALT the remaining batch.
- `update_mode: replace` PROHIBITED (§4.4) — enforced structurally: the store
  has no replace/update/delete API.

## Runbooks

```bash
# Tests (stdlib unittest; no pytest on ava-harness)
python3 infra/hindsight/tests/test_reader_parity.py       # P1 gate, needs staging state readable (sudo -n fallback)
python3 infra/hindsight/tests/test_g5_write_path.py       # loopback; set G5_ENDPOINT for live mode

# Deploy + verify (host: ava-harness)
sudo -n true && infra/hindsight/bin/apply.sh
/opt/ava-staging/hindsight/bin/verify.sh                  # post-apply health (also the unit ExecStart)
```

## Evidence + receipts

- P1 gate-1 record: `/var/lib/ava-staging/evidence/hindsight/gate-1-parity.json`
- G5 write-path record: `/var/lib/ava-staging/evidence/hindsight/g5-write-path.json`
- IaC receipts: `/var/lib/staging-iac/receipts/<ts>-w4-hindsight-*.receipt`
- Card receipt: `/root/ava-vnext-genesis/W4-HINDSIGHT-ADAPTER-RECEIPT.md` (build host)

## Dependency flag (owner-gated, non-blocking)

LIVE G5 write-path run requires (a) the G5 Tailscale ACL grant rendered
(`PHASE2-TAILSCALE-ACL.snippet`) and (b) a listener on `avaworker:8766`. Until
then the loopback contract pass is the qualified write path; the live run
fires when the endpoint exists.
