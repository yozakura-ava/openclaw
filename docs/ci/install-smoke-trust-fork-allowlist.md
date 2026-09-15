# install-smoke: fork-aware trusted-workflow allowlist

The `install-smoke-reusable.yml` workflow uses a `Restore exact trusted
workflow revision` step to verify that the trusted release harness checked
out under `.release-harness/` was sourced from the same owner/repo that
the GitHub Actions runner is currently executing on. This is a
defense-in-depth measure against an attacker copying the workflow to
their own repo and minting trusted artifacts.

## Problem on forks

Two coupled hard-codings prevented fork installs from running:

1. The "Checkout trusted release harness" step checked out the harness
   from the literal `openclaw/openclaw`, so on a fork the harness's
   `origin` URL was `https://github.com/openclaw/openclaw`.
2. The JS identity check required
   `remote === https://github.com/${EXPECTED_WORKFLOW_REPOSITORY}`,
   where `EXPECTED_WORKFLOW_REPOSITORY = github.repository`. On a fork
   those two values differ and the check threw unconditionally,
   regardless of any allowlist opt-in.

The downstream effect was that `installer_smoke_update` — the upstream
mechanism for catching missing artifacts during update — was silently
skipped.

## Fix

The two coupled hard-codings are resolved together so they stay
consistent:

1. **Harness checkout now sources from `github.repository`** instead of
   the literal `openclaw/openclaw`. The harness's `origin` URL therefore
   equals `https://github.com/${github.repository}` — exactly what the
   identity check requires — for both upstream and fork runs.
2. **Identity check still gates trust** via `OPENCLAW_TRUSTED_WORKFLOW_REPOS`,
   a comma-separated allowlist of `owner/repo` slugs sourced from the
   repository variable `vars.OPENCLAW_TRUSTED_WORKFLOW_REPOS`. When unset,
   the default list is `["openclaw/openclaw"]` so upstream behavior is
   preserved exactly.

```yaml
# Checkout step:
- uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
  with:
    repository: ${{ github.repository }}
    ref: ${{ github.event.repository.default_branch }}
    path: .release-harness
    fetch-depth: 1
    persist-credentials: false

# Identity-check env block:
env:
  EXPECTED_WORKFLOW_REPOSITORY: ${{ github.repository }}
  OPENCLAW_TRUSTED_WORKFLOW_REPOS: ${{ vars.OPENCLAW_TRUSTED_WORKFLOW_REPOS || 'openclaw/openclaw' }}
```

```javascript
const ALLOWED_TRUSTED_REPOS = (process.env.OPENCLAW_TRUSTED_WORKFLOW_REPOS ?? "openclaw/openclaw")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
if (!ALLOWED_TRUSTED_REPOS.includes(repository) || job.workflow_repository !== repository) {
  throw new Error(
    `job.workflow_repository must match a trusted repo (allowed: ${ALLOWED_TRUSTED_REPOS.join(", ")}); got ${repository}`,
  );
}
```

## Security rationale

1. **Default-deny.** Unset variable ⇒ only `openclaw/openclaw` is trusted.
   Upstream behavior is byte-identical to the pre-allowlist state.
2. **Explicit per-repo opt-in.** A fork must set its own
   `OPENCLAW_TRUSTED_WORKFLOW_REPOS` repository variable to add itself.
   Repository variable changes require admin access and are recorded in
   the GitHub audit log.
3. **Allowlist is the trust boundary, not the harness source.** Sourcing
   the harness from `github.repository` is safe *because* the allowlist
   gates which `github.repository` values are accepted. A repo that is
   not on the allowlist fails the identity check before any harness
   state is consumed.
4. **Origin URL re-check preserved.** The second guard still verifies
   `git -C .release-harness remote get-url origin` equals
   `https://github.com/${repository}`. The harness checkout step now
   guarantees that equality holds by construction.
5. **Exact-SHA fetch/checkout preserved.** The third guard
   (`workflow_sha` regex) and the final `git fetch origin <sha> &&
   git checkout --detach <sha>` are unchanged. The harness is always
   resolved to the exact commit that triggered the run.
6. **No upstream widening.** `openclaw/openclaw` does not set the
   variable; it relies on the default. A fork can only enable itself,
   not weaken upstream.

## Fork setup

After this change merges to `main`, run once on the fork:

```bash
gh variable set OPENCLAW_TRUSTED_WORKFLOW_REPOS \
  --repo yozakura-ava/openclaw \
  --body 'openclaw/openclaw,yozakura-ava/openclaw'
```

Then trigger `install-smoke.yml` via `workflow_dispatch` and verify all
14 jobs (including `installer_smoke_update`) succeed.

## Out of scope

The same hard-coded literal exists in 10 other workflow files, 1
fork-inherited action, and 10 scripts. Tracked as a separate follow-up.
