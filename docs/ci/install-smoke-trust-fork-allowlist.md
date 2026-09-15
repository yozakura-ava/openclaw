# install-smoke: fork-aware trusted-workflow allowlist

The `install-smoke-reusable.yml` workflow uses a `Restore exact trusted
workflow revision` step to verify that the trusted release harness checked
out under `.release-harness/` was sourced from the same owner/repo that
the GitHub Actions runner is currently executing on. This is a
defense-in-depth measure against an attacker copying the workflow to
their own repo and minting trusted artifacts.

## Problem on forks

The historical implementation of that check hard-coded the literal
`openclaw/openclaw` as the only acceptable repository. On a fork,
`github.repository` is `yozakura-ava/openclaw`, so the check rejected
every image-build job before any install/update validation could run.
The downstream effect was that `installer_smoke_update` — the upstream
mechanism for catching missing artifacts during update — was silently
skipped.

## Mechanism

The check now reads `OPENCLAW_TRUSTED_WORKFLOW_REPOS`, a comma-separated
allowlist of `owner/repo` slugs sourced from the repository variable
`vars.OPENCLAW_TRUSTED_WORKFLOW_REPOS`. When unset, behavior is
unchanged: the default list is `["openclaw/openclaw"]` and the upstream
canonical repository continues to pass the check exactly as before.

```yaml
env:
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

1. **Default-deny.** Unset variable ⇒ upstream behavior preserved.
2. **Explicit opt-in.** A fork must add its own slug to the variable to
   enable install-smoke. Repository variable changes require admin
   access and are recorded in the GitHub audit log.
3. **No upstream widening.** `openclaw/openclaw` never sets the
   variable; `openclaw/openclaw` is in the default list.
4. **Origin URL re-check unchanged.** The second guard still verifies
   `git -C .release-harness remote get-url origin` equals
   `https://github.com/${repository}`.

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
