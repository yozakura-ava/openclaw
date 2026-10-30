# canonical-cleanup-20261030 — deletion receipt

Executed per owner-approved scope in [issue #300](https://github.com/yozakura-ava/openclaw/issues/300) (approved 2026-10-30 09:46 EDT) by Ken (git-management lane).
Anchor: `main` = `6b43a18842` — main content untouched; all deletions verified by patch-id containment before removal.

Preservation set (kept, untouched): all `origin/archive/*`, `origin/backup/*`, `runtime/*` + `checkpoint/*` tags.
Dirty-worktree backups (patches + untracked copies): `/root/.openclaw/backups/canonical-worktree-patches-20261030/` (never stashed; re-exported immediately before each worktree removal).

## Tier 1

- 10 stale worktree registrations pruned (`git worktree prune`, dirs already absent).
- 4 /tmp worktrees removed: `/tmp/wb-lineage-4854992d` (8 dirty → exported), `/tmp/wb-ac7` (3), `/tmp/rin-ac7-review2` (3), `/tmp/rin-ac7-review` (clean).
- 5 merged-into-main branches deleted (verified 0 commits ahead of main):

| branch                                    | tip SHA      | preserved-in        |
| ----------------------------------------- | ------------ | ------------------- |
| `release/2026.10.8`                       | `c1663b4957` | main                |
| `release-2026-10-8-cancelled-status-test` | `6b43a18842` | main (tip = main)   |
| `riko/9dd79ad6-actor-id`                  | `673922359f` | main                |
| `tsubaki/boardclear2-wb-fixes`            | `ad8cc0c7dd` | main                |
| `qualify/2026.10.5-upstream-base`         | `1b58cb9a1b` | main (local+origin) |

- Primary worktree: `archive/20261030/main-pre-2026.10.8-promotion-local` pushed to origin (13 commits, push-on-create, kept); primary worktree moved to `main` @ `6b43a18842`.

## Tier 2 — deleted branches (patch-id-verified contained)

Method: every unique non-merge commit (`main..branch`) patch-id-checked against origin `archive/*` + `backup/*` refs, `runtime/*` + `checkpoint/*` tags, and main itself (subject prefilter + patch-id equality, bounded at the fork point). Containment re-verified independently before deletion; origin refs checked (`ls-remote`) before any origin deletion; origin tips that diverged from local were classified separately.

| branch                                                | tip SHA      | preserved-in (patch-id coverage)                                                                                                                                                                                                                                                                                                                                    | worktree patch (if any)                                            |
| ----------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `ava/f3ba1664-rebase-97`                              | `e6b9f80f81` | archive/20261015T141925Z/integration-official-stable-2026.9.9, archive/20261015T141925Z/main, archive/20261015T141925Z/yozakura-2026.9.33, archive/main-before-2026.10.5-20261020T212553Z, archive/main-before-release-2026.9.9-refresh-6512a079, backup/main-before-2026.9.9-refresh-2005a0b09bee                                                                  | backup:/tomoe-f3ba1664-tool-surface-friction/tracked-vs-HEAD.patch |
| `chore/fork-main-flip-9.7-newtip`                     | `9e61c3506c` | archive/20261015T141925Z/integration-official-stable-2026.9.9, archive/20261015T141925Z/main, archive/20261015T141925Z/yozakura-2026.9.33, archive/main-before-2026.10.5-20261020T212553Z, archive/main-before-release-2026.9.9-refresh-6512a079, backup/main-before-2026.9.9-refresh-2005a0b09bee                                                                  | —                                                                  |
| `chore/pr239-rebase-onto-9.7`                         | `fd0b290618` | archive/20261015T141925Z/integration-official-stable-2026.9.9, archive/20261015T141925Z/main, archive/20261015T141925Z/yozakura-2026.9.33, archive/main-before-2026.10.5-20261020T212553Z, archive/main-before-release-2026.9.9-refresh-6512a079, backup/main-before-2026.9.9-refresh-2005a0b09bee                                                                  | backup:/pr239-rebase/tracked-vs-HEAD.patch                         |
| `ci-fix/release-validation-tests`                     | `728bd95c68` | archive/20261015T141925Z/integration-official-stable-2026.9.9, archive/20261015T141925Z/main, archive/20261015T141925Z/yozakura-2026.9.33, archive/main-before-2026.10.5-20261020T212553Z, archive/main-before-release-2026.9.9-refresh-6512a079, backup/main-before-2026.9.9-refresh-2005a0b09bee                                                                  | —                                                                  |
| `codex/openclaw-2026.10.6-custom-port`                | `e8137df691` | runtime/2026.10.3-deployed                                                                                                                                                                                                                                                                                                                                          | —                                                                  |
| `compat/2026.10.3-workboard-workshop`                 | `81d049448a` | archive/20261015T141925Z/integration-official-stable-2026.9.9, archive/20261015T141925Z/main, archive/20261015T141925Z/yozakura-2026.9.33, archive/main-before-2026.10.5-20261020T212553Z, archive/main-before-release-2026.9.9-refresh-6512a079, archive/main-pre-2026.10.6-20261023, backup/main-before-2026.9.9-refresh-2005a0b09bee, runtime/2026.10.3-deployed | —                                                                  |
| `deploy-20260928`                                     | `b7b8c2bd48` | checkpoint/2026.9.6-b7b8c2bd-20260928, checkpoint/20260927-starvation-fix, checkpoint/20260928-pre-upstream-sync, archive/20261015T141925Z/integration-official-stable-2026.9.9, archive/20261015T141925Z/main, archive/fork-main-pre-9.7, archive/pre-sync-custom-20260927, backup/main-before-2026.9.9-refresh-2005a0b09bee                                       | backup:/upstream-sync/tracked-vs-HEAD.patch                        |
| `feat/162319-window-prune`                            | `d553f274b8` | archive/20261015T141925Z/integration-official-stable-2026.9.9, archive/20261015T141925Z/main, archive/20261015T141925Z/yozakura-2026.9.33, archive/main-before-2026.10.5-20261020T212553Z, archive/main-before-release-2026.9.9-refresh-6512a079, backup/main-before-2026.9.9-refresh-2005a0b09bee                                                                  | —                                                                  |
| `migration/openclaw-2026.9.5`                         | `3d07327fe7` | archive/custom-pre-9.6                                                                                                                                                                                                                                                                                                                                              | —                                                                  |
| `riko/eb741566-claim-fence`                           | `81d049448a` | archive/20261015T141925Z/integration-official-stable-2026.9.9, archive/20261015T141925Z/main, archive/20261015T141925Z/yozakura-2026.9.33, archive/main-before-2026.10.5-20261020T212553Z, archive/main-before-release-2026.9.9-refresh-6512a079, archive/main-pre-2026.10.6-20261023, backup/main-before-2026.9.9-refresh-2005a0b09bee, runtime/2026.10.3-deployed | backup:/riko-eb741566-claim-fence/tracked-vs-HEAD.patch            |
| `sync/upstream-2026-10-02`                            | `4e340a4b8a` | archive/20261015T141925Z/integration-official-stable-2026.9.9, archive/20261015T141925Z/main, archive/20261015T141925Z/yozakura-2026.9.33, archive/main-before-2026.10.5-20261020T212553Z, archive/main-before-release-2026.9.9-refresh-6512a079, backup/main-before-2026.9.9-refresh-2005a0b09bee                                                                  | —                                                                  |
| `tsubaki/a2681a8d-sdk-surface-pin`                    | `7b2f507f7f` | main-equivalent                                                                                                                                                                                                                                                                                                                                                     | backup:/tsubaki-a2681a8d-sdk-surface-pin/tracked-vs-HEAD.patch     |
| `tsubaki/ba1c45e3-expired-claim-fence`                | `620be5080e` | main-equivalent                                                                                                                                                                                                                                                                                                                                                     | —                                                                  |
| `yozakura/2026.10.3`                                  | `414ab11b8b` | archive/20261015T141925Z/integration-official-stable-2026.9.9, archive/20261015T141925Z/main, archive/20261015T141925Z/yozakura-2026.9.33, archive/main-before-2026.10.5-20261020T212553Z, archive/main-before-release-2026.9.9-refresh-6512a079, archive/main-pre-2026.10.6-20261023, backup/main-before-2026.9.9-refresh-2005a0b09bee, runtime/2026.10.3-deployed | backup:/openclaw-2026.10.3/tracked-vs-HEAD.patch                   |
| `yozakura/gw-request-coalescing-oom`                  | `55982fcf01` | checkpoint/2026.9.6-b7b8c2bd-20260928, checkpoint/20260927-starvation-fix, checkpoint/20260928-pre-upstream-sync, archive/20261015T141925Z/integration-official-stable-2026.9.9, archive/20261015T141925Z/main, archive/fork-main-pre-9.7, archive/pre-sync-custom-20260927, backup/main-before-2026.9.9-refresh-2005a0b09bee                                       | —                                                                  |
| `yozakura/rel-os-councilhandoff-sanitizer-v97-rebase` | `f2a30f6912` | archive/20261015T141925Z/integration-official-stable-2026.9.9, archive/20261015T141925Z/main, archive/20261015T141925Z/yozakura-2026.9.33, archive/main-before-2026.10.5-20261020T212553Z, archive/main-before-release-2026.9.9-refresh-6512a079, backup/main-before-2026.9.9-refresh-2005a0b09bee                                                                  | backup:/pr209-rebase-v97/tracked-vs-HEAD.patch                     |

Origin counterparts: `sync/upstream-2026-10-02`, `tsubaki/ba1c45e3-expired-claim-fence`, `yozakura/2026.10.3`, `yozakura/gw-request-coalescing-oom` deleted (tips matched local exactly). Origin-only tips classified separately: `feat/162319-window-prune` and `migration/openclaw-2026.9.5` (fully covered → origin refs deleted); `compat/2026.10.3-workboard-workshop` origin tip **kept** (Tier 3 — 6 uncovered of 412).

## Tier 3 — kept, owner decision required (unique content not proven preserved)

| branch                                                       | unique commits (main..branch) | uncovered |
| ------------------------------------------------------------ | ----------------------------- | --------- |
| `tsubaki/pr273-fixes`                                        | 413                           | 7         |
| `tsubaki/pr274-single`                                       | 413                           | 7         |
| `backport/173793-workboard-session-reconcile`                | 402                           | 1         |
| `tsubaki/pr276-deps-fix`                                     | 382                           | 4         |
| `pd-graph-skills-eligible-split`                             | 381                           | 3         |
| `tsubaki/pr275-rework`                                       | 381                           | 3         |
| `tsubaki/66cb438d-heartbeat-admission`                       | 380                           | 2         |
| `tsubaki/c2013f12-sanitizer-fail-closed`                     | 300                           | 2         |
| `integration/official-stable-2026.9.9`                       | 299                           | 1         |
| `tsubaki/c2013f12-sanitizer-fail-open`                       | 295                           | 2         |
| `tsubaki/e525f3f2-wb-prefix-resolver-v2`                     | 295                           | 1         |
| `riko/c7b2c362-broker-init-fresh-worktree`                   | 294                           | 1         |
| `tsubaki/e525f3f2-wb-prefix-resolver`                        | 294                           | 1         |
| `yozakura/2026.9.33`                                         | 270                           | 1         |
| `tsubaki-1b65ce64-claim-fence`                               | 260                           | 1         |
| `pr261`                                                      | 231                           | 1         |
| `ken/install-smoke-fork-trust-allowlist`                     | 106                           | 98        |
| `riko/1c9e249a-fork-ci-cleanup`                              | 102                           | 94        |
| `trackf/101-pipeline-routing`                                | 100                           | 91        |
| `tmp-ken-feat/162319-window-prune`                           | 96                            | 14        |
| `tmp-ken-fix/rss-threshold-raise-5gib`                       | 95                            | 12        |
| `yozakura/rel-os-councilhandoff-sanitizer`                   | 78                            | 1         |
| `pr-209`                                                     | 77                            | 1         |
| `release/2026.9.4`                                           | 76                            | 68        |
| `qualify/2026.10.5-ava`                                      | 71                            | 56        |
| `plan/rebase-9.6-analysis`                                   | 58                            | 3         |
| `tomo/68310970-lobster-args-canonical`                       | 49                            | 1         |
| `tomoe/f3ba1664-tool-surface-friction`                       | 49                            | 1         |
| `cf038632-pr163-ci-repair`                                   | 44                            | 5         |
| `tsubaki/8ffaed8b-bounded-retention`                         | 44                            | 5         |
| `tsubaki/b7731e2f-consolidated-flag`                         | 35                            | 2         |
| `codex/catalog-worker-heap-boundary`                         | 34                            | 1         |
| `trackf/100-claim-guard`                                     | 31                            | 3         |
| `trackf/98-sessions-cleanup`                                 | 29                            | 1         |
| `ci/upstream-release-test-fixes`                             | 21                            | 12        |
| `riko/14d352cf-argsjson-guard`                               | 19                            | 10        |
| `tsubaki/ddad0073-tool-registration`                         | 17                            | 8         |
| `riko/88d7b273-routing-gate-port`                            | 16                            | 7         |
| `voice-401-fix`                                              | 16                            | 7         |
| `tsubaki/9ab03edf-cap-chunked-integration`                   | 15                            | 6         |
| `tsubaki/9a97b80d-chunked-storage`                           | 14                            | 5         |
| `tsubaki/7011ba05-addComment-cap`                            | 13                            | 4         |
| `ava/pr241-lint-fix`                                         | 11                            | 1         |
| `riko/7decbc47-review-status-reaper`                         | 11                            | 2         |
| `ava/release-validation-hermeticity`                         | 10                            | 1         |
| `fix/rss-threshold-raise-5gib`                               | 10                            | 1         |
| `heads/archive/workboard-reclaim-carveout-plus-store-deltas` | 10                            | 1         |
| `riko/875df04e-wb-claim-comment-brick`                       | 10                            | 1         |
| `riko/e03f22e5-sentinel-claim`                               | 10                            | 1         |
| `yozakura/security-rollout-fork-407`                         | 10                            | 1         |
| `fork/2026.9.4-deltas`                                       | 8                             | 8         |
| `upstream-hb-gate`                                           | 3                             | 3         |
| `openclaw-2026.10.6-session-startup-worker-20261022`         | 2                             | 2         |
| `riko/336f7721-phase0-telemetry`                             | 2                             | 2         |
| `tsubaki/338bcdc0-nodes-desc-parity`                         | 1                             | 1         |

None of these were deleted. `heads/archive/workboard-reclaim-carveout-plus-store-deltas` is archive-named and kept regardless of verdict.

## Final counts (2026-10-30)

- Worktrees: 56 → 31 (primary on main; rest attached to Tier 3 / active branches)
- Local branches: 93 → 74 (main + archives/backups + Tier 3 set)
- Origin heads: pruned in mirror (5 Tier-1 + 4 Tier-2 tip-matched + 2 origin-only covered refs deleted)

PRs closed with reason: #297, #298, #299 (dependabot ecosystems removed via #301); dependabot branches deleted.
