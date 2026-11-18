# Gateway dist overlay — 2026.11.3 session-history admission retry

Owner-authorized temporary overlay for the **installed gateway release**, not a
pnpm dependency patch. It is not registered with patch-package: apply it after
installing/updating the gateway dist, as described below.

## Bug

Cold boot crash-looped while projecting session history:

```text
WorkerTaskError: worker task capacity reached
code: overloaded
```

After the 21 agent databases were prepared, `sessions.projection` released
session-history reads onto the process-global transcript worker lanes at once.
The pool's bounded admission (shipped limits: 128 pending tasks / 256 MiB
pending input) rejected the excess with `overloaded`, and the caller treated
that transient rejection as a fatal startup error, aborting the gateway.
Upstream: [openclaw#195316](https://github.com/openclaw/openclaw/issues/195316).
Incident + remediation record:
`/home/ava-agent/.openclaw/repair-evidence-20261118/openclaw-startup-capacity-healing.md`.

## Fix (dist overlay)

Only the two session-history admission call sites retry transient `overloaded`
admission failures: 25 ms initial delay, exponential growth capped at 1 s,
±50% jitter, the request timeout as the total retry deadline, abort-signal
support. No worker-task or byte limit was raised.

## Targets

| Target | Stock SHA-256 | Patched SHA-256 |
| --- | --- | --- |
| `dist/session-transcript-worker-runtime-DyHfVUVm.mjs` | `f88a7e49ad69d10ddcd520a6306ca4f23351510eda192dc680c5cd51db1837ad` | `111b90f8c34a93eba4230fdf226a4ec78b5d707af8a96082d9cb7d8720339c66` |
| `dist/session-transcript-worker-resources-D1956Oac.mjs` | `c4bc5a6d939c0ae91378619297ee9cc3288b324a5e75f21ec8c44bfeaad3369f` | `c7d57c9aa6f6b590038387f680f3ce3b7a615befdb36adec93b6a47988c0d939` |

Patched hashes match `repair-evidence-20261118/successful-runtime-config-hashes.txt`
(the bytes serving live traffic on 2026-11-18). Hashed chunk names are
build-specific: a new gateway release regenerates them. On a rebuild, re-port
the two hunks from the `.patch` files here into the new chunk names instead of
copying these files wholesale.

## Reapply on update

From this directory, against an installed stock release at
`/opt/ava-staging/releases/openclaw-<version>`:

```bash
REL=/opt/ava-staging/releases/openclaw-<version>          # stock release to patch
REL_RETRY=$REL-session-retry                               # staged patched copy
cp -a "$REL" "$REL_RETRY"
cp -a patched/. "$REL_RETRY/dist/"                         # byte-exact (same build)
# OR, when only the hunks apply to a NEW build of the same code:
#   patch -d "$REL_RETRY" -p1 --dry-run < <this-dir>/<target>.mjs.patch  (then without --dry-run)
node --check "$REL_RETRY/dist/session-transcript-worker-runtime-DyHfVUVm.mjs"
node --check "$REL_RETRY/dist/session-transcript-worker-resources-D1956Oac.mjs"
sha256sum "$REL_RETRY/dist/"session-transcript-worker-*.mjs   # must match table above
```

Then point the service at the staged runtime via the existing drop-in
(`~/.config/systemd/user/openclaw-gateway.service.d/session-retry-staging.conf`,
preserved at `repair-evidence-20261118/session-retry-staging.conf.active`) and
restart — gateway restart is owner-gated (HR2). Originals for diffing are in
`originals/`; full pre-remediation service rollback is documented in the
healing record.

## Removal gate

Drop this overlay when an upstream release fixes the cold-start admission
burst (watch the resolution of openclaw#195316 and the release notes for the
session-history retry). Until then, every `openclaw update` review must check
whether the new release still needs it. The durable fix is a source-level port
of the retry hunks into this fork (builder lane + Rin review + owner merge);
this artifact is the bridge.
