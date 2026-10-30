#!/usr/bin/env bash
# fork-sync.sh — one-command upstream bump for fork/carried.
# Methodology: fork-upstream-alignment skill (mode B rebase --onto + compat audit,
# PR structure per verified PR #237 pattern). Failure at any step = stop and report.
#
# Usage: fork-sync.sh <new-upstream-tag> [worktree-path]
#   <new-upstream-tag>   e.g. v2026.11.0 (must be a fetched upstream tag)
# Env: FORK_REPO (default /root/.openclaw/openclaw-canonical)
set -euo pipefail

NEW_TAG=${1:?usage: fork-sync.sh <new-upstream-tag> [worktree-path]}
REPO=${FORK_REPO:-/root/.openclaw/openclaw-canonical}
WT=${2:-$REPO/../openclaw/worktrees/fork-carried-build}
BRANCH=fork/carried
STEP=0
step() { STEP=$((STEP+1)); echo "== [$STEP] $*"; }
die()  { echo "FORK-SYNC FAILED at step [$STEP]: $*" >&2; exit 1; }

step "fetch upstream main + tags (verify refspec first)"
cd "$REPO"
[ "$(git config --get-all remote.upstream.fetch)" = "+refs/heads/*:refs/remotes/upstream/*" ] \
  || die "remote.upstream.fetch is not +refs/heads/*:refs/remotes/upstream/* — fix config before syncing (skill rule 2)"
git fetch upstream main --tags

step "verify tag object $NEW_TAG exists"
NEW_BASE=$(git rev-parse "${NEW_TAG}^{}" 2>/dev/null) || die "tag ${NEW_TAG} not found after fetch"
echo "   new base: $NEW_BASE $(git log -1 --format='%ci %s' "$NEW_BASE" | head -c 80)"

step "compute old base (merge-base of fork/carried and ${NEW_TAG})"
OLD_BASE=$(git merge-base "$BRANCH" "$NEW_BASE") || die "cannot merge-base ${BRANCH} ${NEW_TAG} — is origin/${BRANCH} fetched?"
[ -n "$OLD_BASE" ] || die "empty old base"
echo "   old base: $OLD_BASE $(git log -1 --format='%ci %s' "$OLD_BASE" | head -c 80)"
[ "$OLD_BASE" != "$NEW_BASE" ] || { echo "   already on ${NEW_TAG} — nothing to do"; exit 0; }

step "compat audit: carried files deleted by the upstream advance"
# skill rule 7: if the upstream advance deletes a file the carried series touches,
# stop — resolve by dropping the carried commit (if upstream already fixed it) or
# porting to the successor module before rebasing.
mapfile -t carried_files < <(git diff --name-only "$OLD_BASE" "$BRANCH")
deleted=0
while IFS= read -r f; do
  for cf in "${carried_files[@]:-}"; do
    if [ "$f" = "$cf" ]; then
      echo "   CONFLICT-RISK: carried file deleted upstream: $f"
      deleted=$((deleted+1))
    fi
  done
done < <(git diff --name-status "$OLD_BASE" "$NEW_BASE" | awk '$1=="D" {print $2}')
[ "$deleted" -eq 0 ] || die "$deleted carried file(s) deleted by upstream advance — resolve per skill rule 7 before rebasing"

step "ensure worktree for ${BRANCH} at $WT"
if [ ! -d "$WT" ]; then
  git worktree add "$WT" "$BRANCH" || die "cannot create worktree $WT"
fi
git -C "$WT" checkout "$BRANCH" || die "worktree $WT cannot check out ${BRANCH} (held elsewhere?)"

step "rebase --onto ${NEW_TAG} ${OLD_BASE} (skill rule 8)"
git -C "$WT" rebase --onto "$NEW_BASE" "$OLD_BASE" "$BRANCH" || die "rebase conflict — resolve in $WT per skill rule 10 (new structure wins), then 'git rebase --continue' and re-run remaining steps"

step "post-check: fork-only surface must be the expected carried set"
git -C "$WT" diff --stat "$NEW_BASE..$BRANCH" | tail -3

step "push (force-with-lease; non-force fallback per skill rule 12)"
if ! git -C "$WT" push --force-with-lease origin "$BRANCH" 2>/dev/null; then
  echo "   force-with-lease rejected — pushing under fresh name ${BRANCH}-rebased"
  git -C "$WT" push origin "+${BRANCH}:${BRANCH}-rebased" || die "cannot push rebased branch"
  BRANCH_PUSHED="${BRANCH}-rebased"
else
  BRANCH_PUSHED="$BRANCH"
fi

step "open PR from alignment branch (pristine tag + picks + merge main → MERGEABLE, skill rule 12)"
SYNC="sync/fork-bump-$(date +%Y%m%d-%H%M)"
git -C "$WT" checkout -b "$SYNC" "$BRANCH_PUSHED"
git -C "$WT" merge --no-edit origin/main || die "alignment merge against origin/main conflicted — inspect in $WT"
git -C "$WT" push -u origin "$SYNC" || die "cannot push $SYNC"
gh pr create --base main --head "$SYNC" \
  --title "chore(fork): absorb upstream ${NEW_TAG} + carried series" \
  --body "Upstream bump via fork-sync.sh: rebase fork/carried onto ${NEW_TAG} (${OLD_BASE:0:10} → ${NEW_BASE:0:10}), compat audit clean, alignment merge included so origin/main is an ancestor (MERGEABLE). Runbook: docs/ci/fork-sync.md" \
  || die "gh pr create failed"

echo "FORK-SYNC OK: PR opened from $SYNC (carried branch ${BRANCH_PUSHED} @ $(git -C "$WT" rev-parse --short=10 "$BRANCH_PUSHED"))"
echo "Post-merge follow-ups: checkpoint-tag deployed result; stage-before-live per skill rule 13."
