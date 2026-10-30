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

## Tier 3 disposition — 2026-10-30 (owner directive 11:11 EDT, 72h tip-age rule)

Owner approved removal of all 55 Tier 3 branches with a 72-hour timing rule: tips older than 2026-10-27 11:11 EDT pruned immediately; newer tips scheduled for prune 2026-11-02 ~11:30 EDT unless used before then.

### Pruned now (54)

| branch                                                       | tip SHA      | tip date (UTC)            | origin outcome                                                                   |
| ------------------------------------------------------------ | ------------ | ------------------------- | -------------------------------------------------------------------------------- |
| `release/2026.9.4`                                           | `e622048378` | 2026-09-16T16:15:48+00:00 | deleted-tip-matched                                                              |
| `fork/2026.9.4-deltas`                                       | `2811dbf5b1` | 2026-09-16T17:58:44+00:00 | deleted-tip-matched                                                              |
| `trackf/101-pipeline-routing`                                | `dd156e6387` | 2026-09-18T15:24:52+00:00 | DIVERGED origin_tip=1340f85858 KEPT unique=60 uncovered=21                       |
| `riko/1c9e249a-fork-ci-cleanup`                              | `dd385afe97` | 2026-09-19T02:01:43+00:00 | DIVERGED origin_tip=e124610805 KEPT unique=45 uncovered=6                        |
| `ken/install-smoke-fork-trust-allowlist`                     | `3089312899` | 2026-09-19T02:05:47+00:00 | DIVERGED origin_tip=625b50f1e0 KEPT unique=46 uncovered=7                        |
| `trackf/100-claim-guard`                                     | `309c896c5f` | 2026-09-20T02:45:38+00:00 | DIVERGED origin_tip=a845473c01 KEPT unique=53 uncovered=14                       |
| `trackf/98-sessions-cleanup`                                 | `61aa47165c` | 2026-09-20T02:56:40+00:00 | DIVERGED origin_tip=1edbc99415 KEPT unique=47 uncovered=8                        |
| `tsubaki/b7731e2f-consolidated-flag`                         | `12655c2cd0` | 2026-09-21T22:09:15+00:00 | deleted-tip-matched                                                              |
| `plan/rebase-9.6-analysis`                                   | `2f060a72fc` | 2026-09-23T15:41:21-04:00 | absent                                                                           |
| `cf038632-pr163-ci-repair`                                   | `49d07cfe45` | 2026-09-24T03:54:56+00:00 | absent                                                                           |
| `codex/catalog-worker-heap-boundary`                         | `bf975757ca` | 2026-09-25T10:06:49+00:00 | deleted-tip-matched                                                              |
| `yozakura/rel-os-councilhandoff-sanitizer`                   | `495ce4c0cd` | 2026-09-26T09:58:51-04:00 | deleted-diverged-covered                                                         |
| `pr-209`                                                     | `d52d2a7508` | 2026-09-26T13:30:34+00:00 | deleted-tip-matched                                                              |
| `tomo/68310970-lobster-args-canonical`                       | `ebb24bb38f` | 2026-09-29T00:50:34+00:00 | deleted-tip-matched                                                              |
| `tsubaki/8ffaed8b-bounded-retention`                         | `94df19c15e` | 2026-09-29T02:13:43+00:00 | absent                                                                           |
| `tomoe/f3ba1664-tool-surface-friction`                       | `c935922f7c` | 2026-09-29T18:38:35+00:00 | absent                                                                           |
| `yozakura/security-rollout-fork-407`                         | `e38d9acfc3` | 2026-09-30T09:38:01+00:00 | DIVERGED origin_tip=45be974ca9 KEPT unique=72 uncovered=1                        |
| `riko/875df04e-wb-claim-comment-brick`                       | `2c0aa93050` | 2026-10-01T01:20:36+00:00 | absent                                                                           |
| `fix/rss-threshold-raise-5gib`                               | `9a7ad90a22` | 2026-10-01T17:43:53+00:00 | deleted-diverged-covered                                                         |
| `heads/archive/workboard-reclaim-carveout-plus-store-deltas` | `49c550e545` | 2026-10-02T00:22:59+00:00 | absent                                                                           |
| `ava/pr241-lint-fix`                                         | `b2cb8e3db9` | 2026-10-02T14:16:17+00:00 | absent                                                                           |
| `ava/release-validation-hermeticity`                         | `f61722f682` | 2026-10-02T14:59:34+00:00 | deleted-tip-matched                                                              |
| `ci/upstream-release-test-fixes`                             | `cdf0493f9b` | 2026-10-03T01:01:31+00:00 | deleted-tip-matched                                                              |
| `riko/e03f22e5-sentinel-claim`                               | `51ccf8c789` | 2026-10-04T14:35:05+00:00 | absent                                                                           |
| `tmp-ken-feat/162319-window-prune`                           | `05a111f404` | 2026-10-04T14:48:30+00:00 | absent                                                                           |
| `riko/7decbc47-review-status-reaper`                         | `acbfd6dcb4` | 2026-10-04T15:23:57+00:00 | absent                                                                           |
| `tmp-ken-fix/rss-threshold-raise-5gib`                       | `e3e53eb117` | 2026-10-04T15:44:07+00:00 | absent                                                                           |
| `tsubaki/7011ba05-addComment-cap`                            | `b6fff1ec97` | 2026-10-04T16:55:02+00:00 | absent                                                                           |
| `tsubaki/9a97b80d-chunked-storage`                           | `2ea9180137` | 2026-10-04T18:03:13+00:00 | absent                                                                           |
| `tsubaki/9ab03edf-cap-chunked-integration`                   | `a42de0516f` | 2026-10-04T18:32:00+00:00 | absent                                                                           |
| `voice-401-fix`                                              | `85e32326ad` | 2026-10-04T23:15:42+00:00 | absent                                                                           |
| `riko/88d7b273-routing-gate-port`                            | `c05989638c` | 2026-10-05T01:51:59+00:00 | absent                                                                           |
| `tsubaki/ddad0073-tool-registration`                         | `ea02ffb1f9` | 2026-10-05T13:34:21+00:00 | absent                                                                           |
| `riko/14d352cf-argsjson-guard`                               | `f8de2cb7ea` | 2026-10-05T23:22:52+00:00 | absent                                                                           |
| `pr261`                                                      | `bd690f2447` | 2026-10-06T15:07:53+00:00 | absent                                                                           |
| `tsubaki-1b65ce64-claim-fence`                               | `2648f783fe` | 2026-10-08T18:46:04+00:00 | absent                                                                           |
| `riko/c7b2c362-broker-init-fresh-worktree`                   | `6cecd57777` | 2026-10-08T18:49:08+00:00 | absent                                                                           |
| `tsubaki/e525f3f2-wb-prefix-resolver`                        | `6cecd57777` | 2026-10-08T18:49:08+00:00 | absent                                                                           |
| `tsubaki/c2013f12-sanitizer-fail-open`                       | `0bdaff469e` | 2026-10-08T22:18:40+00:00 | absent                                                                           |
| `upstream-hb-gate`                                           | `6ec94fcc12` | 2026-10-09T16:06:45+00:00 | local pruned; origin tip 4794818c99 diverged (4148 unique/4121 uncovered) — KEPT |
| `tsubaki/e525f3f2-wb-prefix-resolver-v2`                     | `ffc2a67a37` | 2026-10-09T17:07:17+00:00 | absent                                                                           |
| `integration/official-stable-2026.9.9`                       | `07e2e3df6e` | 2026-10-12T15:56:40+00:00 | absent                                                                           |
| `tsubaki/c2013f12-sanitizer-fail-closed`                     | `cfabbdbbe8` | 2026-10-13T16:11:54+00:00 | absent                                                                           |
| `yozakura/2026.9.33`                                         | `5873f8174e` | 2026-10-14T19:30:22-07:00 | absent                                                                           |
| `tsubaki/66cb438d-heartbeat-admission`                       | `c7674e6447` | 2026-10-16T03:24:48+00:00 | DIVERGED origin_tip=b92f7c4c45 KEPT unique=381 uncovered=3                       |
| `backport/173793-workboard-session-reconcile`                | `13354bb2d4` | 2026-10-16T13:25:25+00:00 | deleted-tip-matched                                                              |
| `qualify/2026.10.5-ava`                                      | `a1c9b2d2d6` | 2026-10-20T19:49:58+00:00 | DIVERGED origin_tip=5ae49e55b2 KEPT unique=106 uncovered=96                      |
| `riko/336f7721-phase0-telemetry`                             | `9a443007fe` | 2026-10-24T07:49:26+00:00 | absent                                                                           |
| `tsubaki/pr274-single`                                       | `fea9e8ee9c` | 2026-10-25T13:21:44+00:00 | absent                                                                           |
| `pd-graph-skills-eligible-split`                             | `e4ffc60e7b` | 2026-10-25T13:21:45+00:00 | DIVERGED origin_tip=ebe592357c KEPT unique=380 uncovered=2                       |
| `tsubaki/pr276-deps-fix`                                     | `6412cccaa6` | 2026-10-25T13:21:51+00:00 | absent                                                                           |
| `tsubaki/pr275-rework`                                       | `ff7b40e1a6` | 2026-10-25T13:21:52+00:00 | absent                                                                           |
| `tsubaki/pr273-fixes`                                        | `0e81077d76` | 2026-10-25T13:21:53+00:00 | DIVERGED origin_tip=b30ce5c0e2 KEPT unique=412 uncovered=6                       |
| `tsubaki/338bcdc0-nodes-desc-parity`                         | `03487fe793` | 2026-10-26T10:25:57+00:00 | absent                                                                           |

Interlocks held: tip re-verified at deletion time; dirty worktrees re-exported immediately before removal (largest: `openclaw-2026.9.33`, 139 files, 514 KB patch); origin refs deleted only on exact tip match or after inline patch-id classification proved full coverage (`fix/rss-threshold-raise-5gib`, `yozakura/rel-os-councilhandoff-sanitizer` origin tips were diverged-but-covered → deleted).

Origin tips that diverged **with uncovered content were KEPT** (owner follow-up): `upstream-hb-gate` (4148 unique/4121 uncovered), `qualify/2026.10.5-ava` (106/96), `trackf/101-pipeline-routing` (60/21), `ken/install-smoke-fork-trust-allowlist` (46/7), `trackf/100-claim-guard` (53/14), `trackf/98-sessions-cleanup` (47/8), `riko/1c9e249a-fork-ci-cleanup` (45/6), `tsubaki/66cb438d-heartbeat-admission` (381/3), `tsubaki/pr273-fixes` (412/6), `pd-graph-skills-eligible-split` (380/2), `riko/c7b2c362-broker-init-fresh-worktree`, `tsubaki/e525f3f2-wb-prefix-resolver`, `yozakura/security-rollout-fork-407`, `riko/875df04e-wb-claim-comment-brick` (origin counts in `tier2/deletion-log.jsonl`).

### Scheduled for prune 2026-11-02 ~11:30 EDT unless used before then (1)

| branch                                               | tip SHA      | tip date (UTC)            |
| ---------------------------------------------------- | ------------ | ------------------------- |
| `openclaw-2026.10.6-session-startup-worker-20261022` | `812be2c87a` | 2026-10-28T05:12:56+00:00 |

PR #283 (`qualify/2026.10.5-ava`) was already closed; disposition comment posted. Final state: worktrees 31 → 3 (primary on `main` @ `f052acc0519`, detached workshop-consumer, `openclaw-2026.10.6-source` on the scheduled branch); local branches 18 (main + archives/backups + scheduled branch).
