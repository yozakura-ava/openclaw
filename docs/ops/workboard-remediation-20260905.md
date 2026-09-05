# Workboard/DBOS remediation record — 2026-09-05

## Candidate and preservation

The remediation branch is based on the fetched `origin/main` commit
`1dafe1281a6cca527225c85bc388bde83c7a6b0a` (tree
`471fc002846de40fdde1f9898a85c01f88a3d61c`). The pre-sync work remains
reachable from:

- `backup/canonical-bqes-dbos-cutover-pre-remote-sync-20260905`
- `stash@{0}`, `pre-remote-sync canonical remediation work 2026-09-05`
- recovery bundle `/home/TacoPants/openclaw-evidence/remediation-20260905/recovery-bundle/`

The recovery bundle contains checksumed tracked and untracked patches, refs,
and a verified Git bundle. Preserved changes were reconciled by subsystem;
the stash was not wholesale-applied.

## Incident validation

The gateway journal shows normal Workboard responses at 13:21–13:22 UTC and
the exact paused-store error at 13:31–13:32 UTC:

`Workboard SQLite store is unavailable; lifecycle services are paused`

No SQLite lock, corruption, disable, or retry record appears in the narrowed
incident window. The gateway later reported severe event-loop starvation and
was restarted. The live gateway currently has the Workboard database, WAL, and
SHM descriptors open, which supports a healthy database-file diagnosis. The
historical absence of the guard-start callback cannot be observed directly
after the restart, but the source fix starts the authority guard during plugin
registration and registers it as an independent service; it no longer depends
on `gateway_start`.

Ava's additional root-cause finding is consistent with the source and incident
evidence: this gateway process skipped `onGatewayStart`, so the Workboard store
guard never started. The database file was healthy, and the paused state had no
lock, corruption, disable, or retry signal. The remediation starts the guard at
plugin registration, probes immediately, and schedules independent recovery.

## Implemented behavior

- Bounded FIFO SQLite writer queue and lifecycle state machine with structured
  transitions, retry scheduling, and watchdog records.
- Workboard connection probing and same-path reconnect/rebind after dead-handle
  errors, independent of gateway lifecycle callbacks.
- Durable BQES admission/receipt lookup for force-close active-run fencing.
- Validated deepest-first descendant cascade with claim/run/link/cycle/bound
  checks, stable operation IDs, idempotent retries, and aggregate audit.
- Append-only SQLite force-close audit records with stable keys and accepted,
  applied, and storage-failed outcomes; JSONL remains a legacy/test adapter.
- Runtime cleanup closes the store on disable/restart when no session or run
  owns the lifecycle.
- Authenticated PostgreSQL Workboard authority with JSONB records, tombstones,
  compare-and-set mutations, atomic claim limits, duplicate-operation ledger,
  and bounded SQLite compatibility projection; gateway PostgreSQL credentials
  are never used.
- Durable Workboard change intake persists pending/acked/dead-letter state and
  replays it after restart.

## Current gates

The complete Workboard suite passes 23 files and 407 tests. Extension lint,
extension production typecheck, and extension test typecheck pass. The full
artifact build and strict smoke build pass. Protected integration review,
post-merge artifact promotion, deployment, readiness window, rollback
rehearsal, and cleanup retention remain required before acceptance.

Admission and autonomous closure remain frozen through validation.
