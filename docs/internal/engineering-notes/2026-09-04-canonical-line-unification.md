# Engineering Notes — Canonical Line Unification

**Date:** 2026-09-04
**Card:** 7eda72cd-a159-4449-9aab-0fc80c21d463
**Author:** Riko (Platform/Framework Engineer)
**Provenance:** Ava audit 2026-09-04; Craig directive "make sure all patches needing
gateway changes are properly staged in openclaw-canonical and built in openclaw current"

## Rebuild Source Designation

**Designated rebuild source branch:** `canonical/integration-20260904`
**Same commit as:** `riko/canonical-unification-20260904` (alias branch, Riko-attributed
build lane)
**Merge commit:** `153b6fc53ad389fc26274e2a39a6e62a0b60ab54`

The integration branch carries BOTH:

- **Line A** restart-trio backports (commits `1069c87d5a0` +
  `27b49bdb434` + `2bd358f884`) — the dist patches keeping
  `openclaw-current` alive across restarts:
  - `done_without_proof` reclamation proof stub
  - `workboard_bad_rows` malformed-row audit
  - `PATCH-d16f9796` review-independence invariant
  - `bd165865` claim dep-gate
  - `1b0f98cb` reclaim TTL honor
  - comment-cap 4096
- **Line B** deployment-tree port onto `canonical/2026.8.2` (`bc958b9beac`,
  base `dcc60111`) — the 361/361-green srcbuild deployment source

A rebuild that picks up `canonical/integration-20260904` carries every
gateway patch currently in production AND the v2026.8.2 deployment base.
Neither the restart-trio patches nor the 8.2 port is dropped.

## Preserved Branches (no force-moves)

| Branch                            | Commit    | Role                                            |
| --------------------------------- | --------- | ----------------------------------------------- |
| `workboard-owner-fallback-fix`    | `82acd082808` | Line A HEAD — restart-trio + dep-gate         |
| `canonical/2026.8.2`              | `bc958b9beac` | Line B HEAD — v2026.8.2 deployment port       |
| `riko/canonical-unification-20260904` | `153b6fc53ad` | Build lane (Riko-attributed) — same tip as integration alias |
| `canonical/integration-20260904`  | `153b6fc53ad` | **Rebuild source (designated)**                |

## Conflict Resolution Summary

251 conflicts resolved; full reasoning lives in the merge commit message
(`153b6fc53ad`) and the card worker log. Top-level policy:

- **Take Line B (theirs):** all generated i18n (62), `extensions/*/package.json`
  (148), `pnpm-lock.yaml`, `pnpm-workspace.yaml`, root `package.json`,
  `packages/*/package.json`, `.xcstrings`, `.plist`, `config/env-var-count-budget.txt`,
  `docs/install/*`, `docs/plugins/codex-*`, codex-runtime version pins
  (`0.150.1` → `0.151.0`), and `extensions/workboard/package.json` (purely dep
  pin bump; source-level Line A workboard code is preserved).

- **Preserve Line A (ours):** `extensions/workboard/index.ts`,
  `extensions/workboard/openclaw.plugin.json`,
  `extensions/workboard/src/store.test.ts` — the plugin entry, plugin
  metadata, and the test file specifically referenced by the workboard
  restart-trio contract. The actual marker-bearing source files
  (`store-workflow.ts`, `sqlite-store.ts`, `store-enrichment.ts`,
  `store-card-helpers.ts`) were never in conflict — the merge only
  conflicted on package-metadata-side files in the workboard extension.

- **Take Line B (theirs) on gateway/recovery code:** gateway code in
  `src/gateway/server-*.ts` and `src/gateway/config-reload*.ts` was newer
  on Line B (Aug 28–31 vs Line A Aug 26–27). Line B's gateway refactor
  removed the `sessionKeys`/`sessionIds` parameters from
  `markMainSessionsAbortedForRestart`; companion code in
  `src/agents/main-session-recovery/main-session-restart-recovery-marking.ts`
  and matching tests followed the same direction.

- **Delete in Line B:** `src/commands/doctor/shared/automatic-upgrade-config-repair.test.ts`
  — its companion source `automatic-upgrade-config-repair.ts` was also
  removed in Line B (commit `52e43a4a4fe`); keeping the test against a
  removed source would fail typecheck.

## Verification Evidence

```
$ grep -c 'done_without_proof\|workboard_bad_rows' \
    extensions/workboard/src/store-workflow.ts \
    extensions/workboard/src/sqlite-store.ts
extensions/workboard/src/store-workflow.ts:2
extensions/workboard/src/sqlite-store.ts:4
```

```
$ pnpm test:extension workboard
 Test Files  19 passed (19)
      Tests  372 passed (372)
   Duration  49.55s
```

## Risk and Follow-up

- The `canonical/integration-20260904` branch has not been force-pushed to
  the `yozakura-ava/openclaw` fork. Per R7 ("local commits only, no remote
  push") and the card `allowed_files` clause, the rebuild source remains
  a local commit; pushing is outside Riko's lane and routes to Craig.
- The integration branch supersedes `workboard-owner-fallback-fix` as the
  rebuild source for any consumer building from `openclaw-canonical`; the
  old branch is preserved (no force-move) but should not be the rebuild
  source going forward.
- `extensions/memory-core`, `extensions/codex`, and gateway runtime
  components all reflect Line B's August 28–31 state; if any open
  workboard-card depends on a Line A–only fix outside the restart-trio
  set, the card's worker log should be checked before merge.
