# infra/backup — W5 backup drill machinery (ava-staging)

Backup **drill machinery** for the ava-staging harness on ava-primary
(card `6b277b28`, canonical spec **WP-02**): consistent snapshot extraction
with census from the same snapshot, encrypted archives (the spec's top open
gap — zero encrypted-backup history), restore rehearsal to LOCAL + XEON
drill targets, canaries + RTO stamping, and a single-flight pipeline with
paired revert + receipts. Off-site (third-site) backup is future gate
**P-04** — deliberately out of scope here.

## Layout

```
infra/backup/
├── README.md                     this file
├── bin/
│   ├── apply.sh                  single-flight pipeline: snapshot → encrypt →
│   │                             verify (+ optional local drill) — receipt + paired revert
│   ├── snapshot.sh               consistent snapshot + census FROM THE SAME snapshot
│   ├── encrypt.sh                streamed encrypted archive (backup keys ≠ data keys)
│   ├── restore.sh                restore rehearsal: local + xeon-drill targets, canaries + RTO
│   └── verify.sh                 verification kit: snapshot / drill / archive
└── tests/
    ├── test_snapshot_census.py   unittest — census + snapshot gates (native unittest, no pytest)
    └── test_restore_canary.py    unittest — restore canaries + drill receipt/RTO
```

## Snapshot contents

- **state dir** `/var/lib/ava-staging/gateway/.openclaw` (config incl.
  `openclaw.json`, canary state, **memory index incl. LanceDB/embedding
  cache when present under the state dir** — detected and recorded)
- **workspace** (auto-detected from `openclaw.json` → `gateway.workspace`,
  fallback `<state>/workspace`; recorded as *absent* when missing)
- SQLite files inside those trees are replaced in the snapshot with
  `sqlite3` **`.backup` copies** (python3 stdlib backup API — the CLI is not
  assumed), folding WAL/SHM: consistent copies, counted in `SNAPSHOT.json`.
- `census.tsv` (`#census-v1`: `sha256<TAB>size<TAB>path`, `LC_ALL=C` order)
  is generated **FROM THE SAME snapshot**, then a second independent pass
  must reproduce it byte-for-byte (**re-census diff = 0 gate**) before the
  snapshot is finalized atomically (rename).
- `SNAPSHOT.json` records sources, memory-index paths, sqlite consistency
  counts, **live-SQL per-table row counts** (WP-02 verification data), and
  the census sha. **No secrets ever appear in snapshot metadata** — the
  snapshot layer handles no credentials at all.

## Encryption — backup keys ≠ data keys

`encrypt.sh` streams `tar | zstd | gzip | openssl enc -aes-256-cbc -pbkdf2
-iter 600000`; **no plaintext archive ever touches disk**. The archive key
is a **dedicated backup key** (never a data-at-rest key), resolved via
**SecretRef only**:

1. `AVA_BACKUP_SECRET_RESOLVER` — command run with the ref name as argv[1],
   key expected on stdout (e.g. a remote fetch over the tailnet);
2. `$AVA_BACKUP_SECRETS_DIR/<ref>`, else `/etc/ava-staging/secrets/<ref>`,
   else `~/.ava-staging/secrets/<ref>` — key file **MUST be 0600/0400**.

Key bytes exist only in memory and the secrets store; refs are recorded as
**names** (`secretref:<name>`) in `SNAPSHOT.json`, archive meta, and
receipts. A hygiene gate refuses to ship any artifact containing key-material
patterns.

**Drill key (current):** `secretref:backup-drill-key`, provisioned on-box at
`~/.ava-staging/secrets/backup-drill-key` (0600, dir 0700), generated
2026-11-06 during this build. It is **drill-scoped** — adequate for rehearsals
only. ⚠️ **Production key provisioning is owner-gated**: before any
production backup schedule, the owner must provision a production backup key
into a root-owned store (e.g. `/etc/ava-staging/secrets/<production-ref>`,
0600) and rotate the drill key out. Flagged in the handoff manifest.

## Restore rehearsal (drill)

`restore.sh` decrypts (memory-only key), extracts into `<target>/work`,
re-censuses (diff = 0 gate), runs **canaries** — config parses, singleton
canary state, workspace non-empty (when snapshotted), memory-index paths,
**live-SQL COUNT verification** against `SNAPSHOT.json` row counts — then
writes `restore-receipt.json` with **RTO stamping** (`rto_seconds`, clock
starts before decrypt) and atomically finalizes `work/` → `restored/`.
Any gate failure: receipt marked `failed`, in-flight work removed (paired
revert), non-zero exit.

| Mode | Where it runs | Target |
|---|---|---|
| `--mode local` | ava-primary | `$AVA_BACKUP_REHEARSAL_ROOT/<snapshot_id>` (default under the backup root) |
| `--mode xeon-drill` | xeon gateway host | `/root/backups/ava-primary-drills/<snapshot_id>/` — **only** that drill root is written (enforced; `--allow-target` exists for tests). The archive is pulled from ava-primary via rsync/ssh over the tailnet; the backup key is fetched over ssh into memory (never xeon disk). `/root/.openclaw` production state is never touched. |

**Drill execution is orchestrator-owned** — this build ships machinery only;
`apply.sh` prints the exact xeon-side command instead of executing it.

## Single-flight pipeline

`apply.sh` mirrors `infra/staging/bin/apply.sh` (pattern reference, not
modified): `flock` single-flight, receipt written **before** any mutation,
paired revert removes only artifacts the batch created, per-stage logs under
`<root>/receipts/`. Stages: snapshot → encrypt → verify snapshot →
(`--drill-local`) rehearsal + verify drill.

## Quickstart

```bash
# full pipeline, local drill (privileged: reads the svc-stg-gateway state dir)
sudo infra/backup/bin/apply.sh --drill-local --label nightly

# xeon drill (ON the xeon gateway host, orchestrator-owned)
infra/backup/bin/restore.sh --mode xeon-drill --remote ava-harness \
  --remote-archive /var/backups/ava-staging/archives/<snap-id>.tar.zst.enc
```

Tests (scoped, native unittest — pytest is intentionally not used, HR5
"targeted only" honored; never run bare pytest here):

```bash
python3 infra/backup/tests/test_snapshot_census.py
python3 infra/backup/tests/test_restore_canary.py
```

Tests are fully self-contained (temp dirs + per-test key material); they
never read the on-box drill key or any live staging state.

## Operating notes

- **Read access:** the state dir is `svc-stg-gateway`-owned (0700) — run
  snapshot/apply under root or the staging-backup service context. Scripts
  fail closed (rc=3, with guidance) on unreadable state; a partial snapshot
  is never finalized.
- **Consistency:** rsync + sqlite `.backup` pass; single-flight lock prevents
  concurrent runs; re-census diff = 0 proves the snapshot was stable in
  flight. True point-in-time quiesce of the gateway is a drill-execution /
  unit-enablement concern (orchestrator-owned).
- **Retention (spec §5.5):** retention windows are owner-configured; this
  tree never deletes finalized snapshots (only this-run in-flight artifacts
  on failure).
- **staging-backup.service:** the W2 skeleton unit exists; enabling/upgrading
  it to call this pipeline is orchestrator-owned post-review (no systemd
  changes were made by this card).
- **Out of scope (future gates):** third-site/off-site backups (P-04),
  production key provisioning (owner-gated, see above), restore to a *new*
  bare box (drill covers rehearsed targets; the machinery is
  target-parameterized so the new-box drill needs no code change).
