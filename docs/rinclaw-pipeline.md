# RinClaw Pipeline (smoke test reference)

This file documents the **RinClaw GitHub App** that automates GitHub PR reviews
on `yozakura-ava/openclaw`. It was created as part of the RinClaw pipeline
smoke test on 2026-09-16.

## What RinClaw is

RinClaw is a GitHub App owned by the `yozakura-ava` account (the Ava bot).
It authenticates via:

1. A short-lived **JWT** signed by the RinClaw private key
   (`/root/.openclaw/secrets/rinclaw.pem`, app id `4969557`)
2. Exchanged for an **installation access token** scoped to yozakura-ava
   (installation id `162294751`, repository_selection `all`)
3. Used to submit `POST /repos/{owner}/{repo}/pulls/{n}/reviews`
   with `event: APPROVE | REQUEST_CHANGES | COMMENT`

The reviewer is recorded as `rinclaw[bot]` — a separate actor from
`yozakura-ava`, so GitHub branch protection's "require non-self approval"
rule passes when RinClaw approves a PR opened by `yozakura-ava`.

## Permissions

RinClaw's installation has:

- `pull_requests: write` — can submit reviews, add labels
- `contents: read` — can read repo contents (used to inspect diffs)
- `metadata: read` — can read repo metadata

RinClaw cannot push to the repo or merge — those operations are performed
by Ava's user OAuth token.

## Branch protection interaction

`yozakura-ava/openclaw`'s `main` branch requires:

- 1 approving review (provided by RinClaw via this App)
- All review conversations resolved before merge
- Admins enforced (rules apply to admins too)

## Why this matters

The RinClaw architecture removes Craig as the bottleneck for PR approvals.
Ava opens PRs, RinClaw (via the Review Bridge) submits GitHub reviews based
on workboard card verdicts, and the Merge Bridge merges once RinClaw
approves. The pipeline runs end-to-end without human approval required.

For emergencies or aborts, Craig retains admin override and can always
force-push or revert.