# Fork sync runbook — bumping `fork/carried` onto a new upstream release

Scope: this fork (`yozakura-ava/openclaw`) tracks upstream `openclaw/openclaw` via a
**carried-series** structure: a long-lived `fork/carried` branch =
pristine upstream release tag + our fork-custom commit series (workboard
adjustments, fork-aware CI patches, dependency/config trims, fork docs). Every
upstream bump is one `rebase --onto` + one PR — no manual reapply of lost patches
(the 2026.10.8 promotion lost `deploy-bundle.yml` and the fork-aware security-review
fallback this way; see issue #300 and PRs #302/#264).

Methodology source: the `fork-upstream-alignment` skill (mode B rules; PR structure
per verified PR #237). Tooling: `scripts/fork-sync.sh`.

## The structure

- `fork/carried` = `v<RELEASE>` (upstream tag object) + cherry-picked FORK-CUSTOM
  series, oldest-first, no merge commits.
- `main` = same content, landed via PRs (so `git diff main fork/carried` is empty
  between bumps).
- After each upstream promotion, `fork/carried` is rebased onto the NEW release tag
  and a bump PR absorbs it into `main`.

## One-command bump

```bash
scripts/fork-sync.sh v2026.11.0
```

Steps the script performs (numbered checkpoints; **any failure stops the run**):

1. **Fetch** upstream `main` + tags. Refspec must be
   `+refs/heads/*:refs/remotes/upstream/*` (a scoped refspec silently leaves
   `upstream/main` stale — skill rule 2).
2. **Anchor to the TAG OBJECT** (`git rev-parse v<X>^{}`), never `upstream/main`
   (releases live on release branches).
3. **Old base** = the peeled nearest first-parent release tag of `fork/carried`
   (`git describe --first-parent --tags --match 'v[0-9]*' --abbrev=0 fork/carried`).
   Verify no merge commits follow that base. Release branches can diverge: the
   merge-base with the new release may precede the actual carried base and would
   replay upstream release commits as customizations.
4. **Compat audit (hard gate):** if the upstream advance deletes any file the carried
   series touches, the script stops. Resolve per skill rule 7: drop the carried commit
   if upstream already contains the equivalent fix, else port it to the successor
   module — then re-run.
5. **Rebase** in the `fork-carried-build` worktree:
   `git rebase --onto <new-tag> <old-base> fork/carried`. On conflicts, resolve
   against the NEW structure (skill rule 10: check where a symbol lives now via
   `git show main:<path>`); fork-only files absent upstream conflict as delete/add —
   restore from the parent commit, then `git apply --3way` or hand-patch. **Never
   resurrect a path upstream deleted.**
6. **Post-check:** `git diff --stat <new-tag>..fork/carried` must show exactly the
   fork-only file set (expected ≈69 files, +3141/−407 as of 2026-10-30).
7. **Push:** publish the rebased series under a fresh timestamped branch with a
   normal push. Never force-push an existing carried branch. A rejected push stops
   the run for inspection.
8. **PR** from a throwaway alignment branch (`sync/fork-bump-<date>` =
   `fork/carried` + `git merge main`) so origin/main is an ancestor and the PR is
   MERGEABLE despite rewritten SHAs (skill rule 12 / PR #237 pattern).

## Post-merge

- Checkpoint-tag the deployed result (`checkpoint/<date>-post-<tag>` convention) and
  the pre-sync state if main moved.
- Stage-before-live (build on a separate port, isolated HOME, one verified session
  turn) per skill rule 13 before the owner's deploy go.
- `fork/carried` is long-lived: never delete it; never merge main INTO it (the
  alignment merge lives on the throwaway `sync/*` branch only).

## Triaging the carried series (when adding/updating picks)

- Candidates: commits in `main` above the current release tag.
- Gate = patch-id: a commit whose patch-id exists in the new upstream base is
  UPSTREAM-EQUIVALENT (drop — content already in base); unmatched fork-authored work
  is FORK-CUSTOM (keep); unmatched work superseded by later upstream changes is
  OBSOLETE (drop, list as a deliberate delta). Authorship helps triage; patch-id decides.
- 2026-10-30 sprint close: series synced with the CI trim (#307), fork-sync tooling (#306), and cleanup receipt updates (#303/#304) + codeql=KEEP ruling; tip `02f2c70b8144`, `git diff main fork/carried` = the codeql receipt note pending PR #308 (0 bytes at its merge). Next bump: one `scripts/fork-sync.sh <tag>` run.
- 2026-10-30 baseline: 38 FORK-CUSTOM commits (36 fork-authored workboard/session/
  scripts/ci/docs fixes + 2 upstream-authored workboard fixes picked from PRs that
  never reached mainline), extracted onto `v2026.10.8` — `git diff main fork/carried`
  = 0 bytes.

## 2026.11.1 reconciliation

The 2026.10.8 carried base is `dc2523e5a5c7a309517fd7fa834add938231d526`.
The 2026.11.1 peeled tag is `4ffdd2047d192dd65554de3c8c46c0e0197c6e2a`.
Their merge-base is older than the carried base; use the explicit series boundary.
Before rebasing, reconcile local main, remote main, and carried content in a new
task-owned branch/worktree and save recovery refs. Preserve occupied worktrees.
Port the deleted Workboard browser test into current coverage rather than restoring
its retired path. Keep alignment merges on a separate branch; require tracked-tree
parity between the final linear carried series, canonical checkout, and fork main.
