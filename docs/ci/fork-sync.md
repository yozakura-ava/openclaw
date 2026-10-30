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
3. **Old base** = `git merge-base fork/carried <new-tag>` (the previous release tag).
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
7. **Push:** `--force-with-lease` (approval-gated); fallback = push to
   `fork/carried-rebased` under a fresh name (skill rule 12).
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
- 2026-10-30 baseline: 38 FORK-CUSTOM commits (36 fork-authored workboard/session/
  scripts/ci/docs fixes + 2 upstream-authored workboard fixes picked from PRs that
  never reached mainline), extracted onto `v2026.10.8` — `git diff main fork/carried`
  = 0 bytes.
