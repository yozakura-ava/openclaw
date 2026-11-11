# Publication and native landing

- Scoped publication/landing authority only. Root approval, source-trust, contributor-credit, exact-head gates remain. Ordinary ship ≠ release publication.

## Checkout and source

- `scripts/pr` owns review/prepare worktrees under canonical repo. Outside writable scope → fresh full ordinary checkout inside allowed workspace before init. Preserve full history/blobs. Never clone away active/uncertain operation or retry uncertain merge in new lock namespace.
- Trusted canonical/origin-main wrapper only. Untrusted PR supplies no local wrapper and never runs locally; isolation: `$openclaw-testing` + `$crabbox`. Never weaken guards for missing commands/deps. Requires git, gh, jq, rg, pnpm, node.
- Unset ambient `GITHUB_TOKEN`, `GH_TOKEN`, `HOMEBREW_GITHUB_API_TOKEN` if wrong writer possible. Verify effective PATH `gh` or `OPENCLAW_GH_BIN`, not cached `ghx` reads. Qualify protected route's exact merge arguments via [scripts guide](../../../../scripts/AGENTS.md#octopool-string-rewrite-protection). Unsupported writer → route-owner blocker; no raw binary, changed semantics, uncertain replay.

## Open or update the PR

- Current template + real body file; preserve human credit, maintainer-editable branches when safe. Fork edits: heed Actions/secrets warning.
- Build + focused local tests pass → open ready PR promptly; PR CI runs broad suites. Create draft first, wait for non-null `mergeable`, mark ready, verify CI attached to pushed head. Requested landing of own draft includes marking ready.
- Merge-ref startup failure cannot rerun; hourly PR CI sweeper re-fires, or authorized close/reopen after verifying missing attachment.
- No rebase just for advancing main. Refresh for conflict, failing guard, explicit request, material stale-base risk only.
- Conflict repair: record last passing run/tested head, resolved delta, affected contracts in existing preparation evidence. Reuse unchanged-input proof; run affected checks, not every completed suite. Older run ≠ current-head CI or gate waiver. Admission succeeds → merge before optional polish/cleanup.
- UI/native translation memory + locale metadata: post-merge locale workflow owners. Check hosted review bundle size; remove accidental generated output via owner, never truncate input or silently exclude authored changes.

## Evidence media

- Authorized upload: read [media upload reference](media.md) for feature detection, commands, formats, fallback.

## Red main and inherited failures

- Red `main` = emergency. Fresh worktree; exact failing check + focused tests locally (Testbox only for uncovered environment need, immediate grant). Push proven fix directly to `main`, no PR/auto-merge wait; deterministic breaks and flakes alike. Ruleset refuses direct push → PR + report refusal. Rerun alone ≠ repair. Affected merge refs need fresh push after fix.
- Main pushes run only `security-fast`; full main CI hourly.
- PR CI = default broad proof. Before PR: `pnpm test <file> --maxWorkers=1` + targeted typecheck/lint/format. Do not hold ready PR for broad pre-PR suites.
- Prefer bounded local proof on a qualified, available host. Crabbox/Testbox may cover expensive checks, busy/unqualified hosts or environment gaps; acquire only when ready and capacity is granted promptly. Queue → stop task-owned allocation, use PR CI or a safe local scope; preserve uncovered requirements and secretless isolation for untrusted source. Never chain provider fallbacks.
- Never dispatch/rerun/re-push/update branches merely for green. Fix real failures. Read failure classification before attribution.
- PR CI runs every planned job to completion. `pr-failure-report` + `openclaw/ci-gate` summary classify failed jobs against newest scheduled main run:
  - **pre-existing, matching failure signatures:** no further attribution. Native admin route may cite table run id + rows as evidence.
  - **pre-existing, job name only:** signatures not compared; inspect failing tests against main run before attribution.
  - **unknown** (scope differs/no comparable main job) or **new:** treat as PR-caused until shown otherwise.
- Proven inherited-only reds may land via native admin exception; name failures in PR. Table changes evidence form only: no automatic gate waiver. New/unknown failures require investigation; PR-caused failure does not select inherited-failure exception.
- PR CI fails → `pnpm test:ci-failed <pr>` → fix new failures/investigate unknown → `pnpm test:ci-failed <pr> --run` until selected tests pass locally → push once. Pre-existing: failure-table rule above. Never `gh run rerun` to chase green; never local full suite for CI repair.
- Exception: tiny PR-caused failure (lint, types, stale test expectation) may land same way only if lander pushes fix to `main` immediately after. Anything larger stays blocked.

## Review, prepare, merge

Main-targeted PRs: native sequence.

```bash
scripts/pr review-init <pr>
scripts/pr review-checkout-main <pr>
scripts/pr review-checkout-pr <pr>
scripts/pr review-artifacts-init <pr>
# Complete .local/review.json for this exact head.
scripts/pr review-validate-artifacts <pr>
# Local review complete → submit with enforced GitHub gates.
env -u OPENCLAW_TESTBOX OPENCLAW_PR_GATES_REMOTE=github scripts/pr prepare-run <pr>
scripts/pr merge-run <pr> --auto-merge
```

- `review.json` owns verdict; preserve PR identity/head stamp. Validation prints summary; no separate Markdown checklist/nit sweep. Unfinished templates keep valid enums; ready recommendation `READY FOR /prepare-pr`. After every push, rerun `review-init`; checkout alone leaves stale guard. Validate from PR-head mode. Never invent success or erase failed review condition.
- Unresolved investigated local failure: follow [test-failure investigation](../../openclaw-testing/SKILL.md#test-failure-policy), retain `tests.result: "fail"` + `tests.investigatedLocalFailures`. Exact `head`; nonempty `failures`: original `failure`, actual `reproductionAttempts`, `evidence`, `remainingUncertainty`. Attempts/evidence = nonempty string arrays; failure/uncertainty = nonempty strings. Keep evidence in PR; passing replay ≠ fix. READY allowed; substantive findings, behavior, CI, security, enforced reviews remain required. Failed CI uses separate admin policy.
- One gate mode per invocation. Old `OPENCLAW_TESTBOX=1` cleared above for this process only. Unsupported/conflicting mode fails before PR reads, locks, evidence replacement; fix env, don't repeat review/discard proof.
- Unset `OPENCLAW_PR_GATES_REMOTE` = `github` default; explicit selector above optional. Old full local gates: `OPENCLAW_PR_GATES_REMOTE=local`. Unset remote selector + `OPENCLAW_TESTBOX=1` retains hosted mode.
- Preparation binds pending gates to head, no success stamps/separate scheduled Testbox proof. Merge submits one pinned squash/auto-merge; known failed required checks reject absent admin exception. GitHub waits for `openclaw/ci-gate` (CI + applicable security review) + required reviews. Clean mergeable PR, or UNSTABLE with only superseded same-lane runs non-passing (watcher GREEN), lands immediately.
- Stay active through publication/review/CI/accepted auto-merge until verified merge + closeout, user pause, or concrete user-input blocker. One watcher/owner; exact PR head/checks/mergeability every two to three minutes, narrow JSON. No tight loops/repeated unchanged updates. Remote change → `merge-run` reconciliation. Watcher timeout ends observation, not task; collect result, investigate, continue/supported successor under same authority. Honor user time limits/pauses/cancellations; no automatic retry instead.
- Exact failed run: `pnpm test:ci-failed <pr>` fetches failed logs once; repair task defects/confirmed flakes, rerun only failed tests locally. Infrastructure recovery only after cause identified; never rerun CI for green. Changed head → fresh review/preparation/CI; preserve accepted receipt, recover before head replacement. Never erase outcome or blindly resubmit accepted/uncertain request.
- GitHub's head precondition applies at submission only; collaborator push may retain auto-merge. Pushed head merged → `merge-recover ... --merged-head <SHA>` ([recovery](landing-recovery.md)); changed head ≠ originally approved head.

Completed hosted evidence specifically needed:

```bash
env -u OPENCLAW_PR_GATES_REMOTE OPENCLAW_TESTBOX=1 scripts/pr prepare-run <pr>
scripts/pr merge-run <pr>
```

- Run after green CI. Patch-identical recently green pre-rebase run may qualify if incorporated main context unchanged/disjoint. Overlapping/critical input changes → current-head CI. Later main drift remains merge-owned. Explicitly owner-approved reviewed fork without hosted Testbox: `OPENCLAW_PR_GATES_REMOTE=testbox`.

### Explicit prior-CI admin landing

- Explicit operator authorization after prior successful CI + reviewed conflict repair only; ordinary land authority insufficient. Current `github_pending` preparation + completed exact-head review required.
- Read [admin evidence and recovery](landing-recovery.md#explicit-prior-ci-admin-landing) before this rare route: schema, authority, security, drift, supported recovery.

```bash
node scripts/pr-lib/merge-prior-ci.mjs delta <prior-green-head> <prepared-head>
scripts/pr merge-run <pr> --admin-evidence <evidence.json> --confirmed-operator-admin
```

#### Authorized pre-existing failures

<<<<<<< HEAD
A scoped instruction to land a PR authorizes the inherited-failure exception
when every remaining failure is independently attributed to the baseline. Do
not ask for another confirmation just because CI is inherited red. Use the same
`--admin-evidence` and `--confirmed-operator-admin` flags and `github_pending`
preparation; the confirmation records the operator-authorized exception, not
a claim that the executing bot is an administrator. A readiness question,
uncertain attribution, or a PR-caused failure does not select this route.
Keep `tests.result: "fail"` in the exact-head review and add `tests.preExistingCi`
with `head`, numeric `runId` and `runAttempt`, and a nonempty `reason`. A READY
review can retain that exception; ordinary merge admission still rejects it.
The confirmed admin route must verify the same head and failed attempt. Product
findings, enforced reviews, and security requirements are never waived.

An executing account that is not an organization/repository admin may use this
exception when it has repository write permission, active organization
membership, and live GitHub bypass authority for every effective CI gate
ruleset. The native verifier reads `current_user_can_bypass` with the actual
writer: `always` and `pull_requests_only` qualify. Each qualifying ruleset must
be an active, repository-owned branch ruleset containing only the
`openclaw/ci-gate` required check from GitHub Actions (integration `15368`).
Mixed review/security rulesets, missing or changed policy, and unavailable or
revoked grants refuse admission. The verifier rereads policy and delegated
authority after CI/security inspection and retains the writer, repository ID,
ruleset IDs and bypass modes in the existing outcome. It does not accept a
caller-supplied grant, change GitHub permissions, or grant the prior-success
conflict-resolution exception to a delegated writer.

GitHub administrators provision any missing grant through the repository
ruleset owner, preferably with a dedicated CI-bypass team and pull-request-only
mode. Inspect existing grants before changing them; never add the bot to an
organization-admin role or broaden review/security bypass to enable this path.
Task authorization remains the existing operator-invocation contract; a
GitHub bypass grant is execution capability, not an authenticated human approval.

Delegation does not remove the policy-reader requirement. The writer must still
obtain authoritative classic-protection absence through the existing supported
API. GitHub can return a generic `404 Not Found` to a non-admin even when the
repository is readable. GraphQL `branchProtectionRule: null` and an empty
`branchProtectionRules` connection can also hide real protection; they are not
absence proofs. If policy is unavailable, stop before intent and report the
missing policy-read capability. Do not upgrade the writer, substitute credentials,
or introduce a caller-attested policy snapshot to get through this guard.

Use the existing version-1 admin evidence with
`changeKind: "pre-existing-failure"`. Here `priorHead` is the recorded main
baseline, `head` is the exact prepared and tested PR head, and `runId`/`runAttempt`
identify its completed failed or cancelled CI attempt. No prior successful run
or conflict-resolution claim is required. Keep the inspected `deltaSha256`,
operator `reason`, affected `contracts`, and actual passing scoped `checks`.
Retain these additional fields:

- `testedMerge`: the actual checkout from inspected CI evidence. Its retained
  Git object must have exactly two ordered parents, `priorHead` and `head`, and
  its tree must equal Git's successful merge of those parents. This prevents a
  submitted merge tree from omitting PR changes. The baseline must be an ancestor
  of the captured protected main. Which checkout the selected CI attempt executed
  remains an inspected attestation bound to the named artifacts below.
- `artifacts`: named regular files with `name`, `path`, and `sha256`. Reuse
  existing checkout logs, failure logs, and independent qualification receipts;
  do not create another proof system. `checkout` contains `reason` and `evidence`
  (an array of these artifact names) identifying the inspected checkout binding.
- `failures`: exactly one entry per non-aggregate failed job, with numeric
  `jobId`, observed failing `cases`, repository-relative `sourcePaths`, `reason`,
  and `evidence` names. The verifier compares each named blob/tree between the
  baseline and tested merge. Qualification must explain why those inputs cover
  the failure and why the PR cannot cause it; changed or unattributed failures
  stay blocked.
- `aggregate`: the CI gate's `jobId`, `causedBy` (all admitted failed-job IDs),
  `reason`, and `evidence` names establishing the downstream failure.

Read `pr-failure-report` or `openclaw/ci-gate`: **pre-existing** with matching signatures needs no further attribution; for job-name-only **pre-existing**, check the failing tests against main before attributing the failure.

**New** and **unknown** failures retain the existing investigation and landing
rules. The table does not change gate semantics or authorize an admin landing.

The tool verifies live run/attempt/PR/head identities, complete job accounting,
the current effective GitHub Actions gate check-run, and source/artifact hashes.
During active prior-CI admission, unrelated main movement can pass when it is
forward from both captured main anchors and produces a conflict-free, nonempty
merge. Exact PR/policy facts and final live authority checks still apply; the
intent and landing-parent audit retain their original main anchor. Already-selected
REST completes its final observation and main materialization before one final
live authority verification. GraphQL retains its post-authority local-only reread,
including late REST fallback; a newly unavailable main there is a pre-dispatch
refusal. Neither path fetches after final authority verification. Crabbox admission also verifies forward main ancestry and the candidate tree. If its final proof observes newer main, it discards that authority decision before materializing or settling the new tip, then repeats full live verification within the same three-round admin limit. The tested proof base remains pinned while the live PR base is checked for forward ancestry; active organization membership is the final live authority read.

`OPENCLAW_PR_STRICT_DRIFT=1` restores strict main stability on every landing
route. Retained-outcome reconciliation keeps its existing strict main binding.
A fork run with an empty GitHub PR association must match the current PR's exact
head, branch, and source repository identity as well as that check-run; an
explicit association with another PR is rejected. The retained result names
this source/check correlation rather than claiming an API-provided association.
A new or running attempt invalidates the old failure attribution. Checkout
identification and causal independence remain explicit operator attestations,
supported by the retained evidence; source equality alone is not a causal proof.
A baseline reproduction is useful when needed, but an independently inspected
failure before changed code is reached can also qualify. Describe unknowns
honestly—for example, an initial bind collision need not invent an occupant.
Other required checks and exactly one `security-fast` job must pass. The outcome and completion
comment retain the exception without turning failed or cancelled CI into green.

The same-name Security Review commit status remains a separate gate. Admission
binds it to a successful protected-main publisher attempt and the exact PR/head
enforcement step, verifies the publisher's checked-out sources against the current
owner, and reads complete current statuses. The existing security owner interprets
its CI-only failure/success/waiting projection, requires current independent guard
clearance when rollout applies, and revalidates approval and PR/rollout identity.
Historical green guard statuses alone are insufficient. Missing, stale, foreign,
failed, or changed clearance blocks admission; only the identified combined status
may be excused with the attributed Actions CI gate. These facts are obtained live,
not supplied as an operator security waiver. Ordinary merge behavior is unchanged.

### Completed-evidence follow-through

For a requested diagnosis or the completed-evidence path, watch one exact head
with `node scripts/watch-pr-ci.mjs <pr> <head-sha>`; use narrow JSON check/run reads
and fetch failed logs once. Address substantive human/bot findings and resolve
fixed conversations. A queued bot score update is not a
separate landing gate. Check live rules and review state before claiming a human
approval is mandatory; bypass ability is not authorization to skip an enforced
review.

ClawSweeper reviews advisory; no completion comment or freshness precondition.
Accepted/uncertain merge intent → recovery below before fresh admission.

For non-main targets, do not use `prepare-run` or `merge-run`: their base is main.
Use review artifacts and exact base/head CI, revalidate the remote head, and
merge with `gh pr merge --match-head-commit <verified-sha>` under the same authority.
=======
- Scoped land instruction authorizes inherited-only exception once every remaining failure attributed to baseline; no repeat confirmation. Read [native evidence schema](landing-recovery.md#authorized-pre-existing-failures). `--admin-evidence` + `--confirmed-operator-admin` with `github_pending`; confirmation records operator authority, not bot-admin claim.
- Readiness question, uncertain attribution, PR-caused failure ≠ authority. Keep exact-head `tests.result: "fail"` + `tests.preExistingCi` (`head`, numeric `runId`/`runAttempt`, nonempty `reason`). READY allowed; ordinary admission still rejects. Admin verifier binds same head/failed attempt. Product findings, enforced reviews, security never waived.
- Writer needs native verified admin authority, or repository write + active org membership + live bypass for every effective CI gate ruleset. Delegated rule: active repository-owned branch ruleset, only GitHub Actions `openclaw/ci-gate` (integration `15368`), `current_user_can_bypass` = `always`/`pull_requests_only`. Mixed review/security policy or missing/revoked grants refuse. Bypass = capability, not human approval; no self-supplied grants, permission changes, credential substitution, bot org-admin upgrade, or broadened review/security bypass.
- Authoritative classic-protection absence required. Non-admin `404 Not Found`, GraphQL `branchProtectionRule: null`, empty `branchProtectionRules` ≠ absence proof. Missing policy read → stop before intent; no caller-attested snapshot. Prior-success exception cannot use delegated authority.
- Matching-signature table run id + rows replace extra causal attribution; still populate native evidence schema. Job-name-only → compare tests with main first. New/unknown → PR's until disproven. Never relabel failed CI green.

### Completed-evidence follow-through

- Diagnosis/completed-evidence path: `node scripts/watch-pr-ci.mjs <pr> <head-sha>`, narrow check/run JSON, failed logs once. Address substantive human/bot findings; resolve fixed conversations.
- ClawSweeper advisory: no comment, score, completion, freshness prerequisite. Check live rules/review state before claiming required human approval; bypass ≠ authorization to skip enforced review.
- Non-main target: no `prepare-run`/`merge-run` (base = main). Review artifacts + exact base/head CI, revalidate remote head, authorized `gh pr merge --match-head-commit <verified-sha>`.
>>>>>>> 97b6e87616f

## Recovery and closeout

- Accepted/uncertain intent, head replacement, lost response, locks, pending completion, cleanup: read [recovery and closeout](landing-recovery.md#recovery-and-closeout) before acting.
- Never blindly retry merge, erase receipt, clear locks, or remove live-cwd worktree. Verify remote merge + main ancestry. Preserve native cleanup refusals and unknown ownership; report retained path/blocker.

### Receipt for an auto-merged pushed head

- Read [receipt recovery](landing-recovery.md#receipt-for-an-auto-merged-pushed-head).

### Replacement after confirmed retirement

<<<<<<< HEAD
A replacement head repairing the same authorized scope needs fresh review and
preparation, not renewed landing permission. Explicitly select its exact SHA;
new scope or a different merge method still needs authorization.

Ordinary replacement recovery requires completed gates, not `github_pending`.
Use the completed-evidence preparation path above. A confirmed-cancelled auto
squash may instead recover an explicitly selected reviewed head through the
[prior-CI admin route](#explicit-prior-ci-admin-landing):

```bash
scripts/pr merge-recover <PR> <OUTCOME_OID> --confirmed-operator-recovery \
  --replacement-head <HEAD_SHA> --admin-evidence <path> --confirmed-operator-admin
```

This requires fresh review and exact-head `github_pending` preparation, followed
by current admin, review, security, and CI-evidence verification for the
selected head. The explicit `--replacement-head` may name the unchanged retained
head; no synthetic source commit is needed. It is still required for this
retired-auto transition. CI attribution must bind the selected head and current
attempt; an old head's evidence cannot qualify a different head. The
successor CAS retains the original intent, confirmed cancellation, and capture
history; neither history is relabeled as a rejected or unsubmitted request.
Unconfirmed cancellation, a renewed auto/queue request, missing explicit head
selection, and changed recovery artifacts remain blocked. Queue cancellation is unsupported.

A failed operation can retain a lock. Verify no owned child tools remain, then
recover only with the exact token and command the wrapper printed. Never remove
locks by hand or start competing retries. After throttling, inspect quota before
retrying native prepare/merge.

An unaccepted prior-CI admin REST squash may be recovered on the same prepared
head when its original capture contains the complete known GitHub response
`Base branch was modified. Review and try the merge again.` with HTTP 405 and
the matching `gh` diagnostic. Inspect that sent request and its retained outcome,
then use the existing confirmations with current admin evidence:

```bash
scripts/pr merge-recover <PR> <OUTCOME_OID> --confirmed-operator-recovery \
  --admin-evidence <path> --confirmed-operator-admin
```

This records `recovery.providerRejection`, retains every qualified capture and
the prior intent through the successor CAS, and reruns all current review,
security, admin-authority, evidence, and head checks. The exact-head
`github_pending` stamp stays pending. Capture changes during admission, unknown
extra captures, symlinks, other 405 responses, timeouts, 5xx responses, and mixed
or truncated output remain blocked. Accepted, queue, Crabbox, and replacement-head
recovery are outside this exception. Another explicit recovery must use the new
outcome OID and independently qualify its response; there is no automatic retry.
If the PR has merged meanwhile, reconcile the retained outcome without sending
another merge request.

When an unaccepted prior-CI REST admin request is uncertain, a different current
head fences its exact `sha`. After fresh review and exact-head `github_pending`
preparation, retire it into an ordinary current-head auto request:

```bash
scripts/pr merge-recover <PR> <OUTCOME_OID> --confirmed-operator-recovery \
  --replacement-head <HEAD_SHA> --auto-merge
```

Do not pass `--admin-evidence`. The replacement must differ, and the PR must stay
OPEN and `MERGEABLE/BLOCKED` or `MERGEABLE/BEHIND`. Normal required-check,
review, security, and owner gates still apply. The successor CAS
records route `auto` plus `recovery.staleHeadRetirement`, preserving ancestry
and exact regular capture bytes without interpreting them; an empty capture is
valid. Missing, symlink, extra, or admission-mutated captures, same-head or
stale evidence, lifecycle/head drift, queue state, and failed gates stay blocked.

After two identical pre-dispatch failures without new evidence, stop invoking
the same blocked route. Inspect the failure and select an already-authorized
supported route with the exact reviewed head pinned, or report the concrete
missing capability. A transport change never waives admission or authorizes
replaying an accepted or uncertain request.

A failed or timed-out merge response can still mean GitHub merged it. Reconcile
remote state and ancestry before retrying. Verify the final merge commit is on
current main; do not count a draft, pending check, or local summary as landing.
Run closeout from a persistent checkout only after the owning session has exited
or released its cwd. Changing a child command's cwd does not move its parent
agent or shell; never remove a worktree containing a live process's cwd, including
any subdirectory. Native cleanup refuses observed cwd holders. Preserve that
refusal; do not bypass it with raw `git worktree remove`, `rm`, or a custom script.
If your own session still holds the worktree, finish the report with its retained
path and defer removal to a later closeout after the session ends.
Once the requested outcome and required verification are
complete, remove task-owned test logs, receipts, proof archives, and scratch.
This includes `.crabbox` outputs and task-owned archives under `.local` or
temporary directories. Existing published PR evidence needs no local duplicate.

Remove any remaining finished task worktree through its advertised native
closeout after checking ownership and holders. Do not require an archive,
export, evidence handoff, or replacement cleanup receipt. Use a supported native
finalized-task option when ordinary removal rejects disposable proof.
Preserve native guard refusals, unrelated or unknown files, requested
deliverables, explicit retention requests, unfinished source, recovery state needed
by unfinished operations, active owners, credentials, agent state, and shared
dependencies. Never force removal, clear locks, or sign off for another owner.
Report `removed` only after verifying path
and registration absence. Otherwise report the retained path and exact blocker.

If reconciliation confirms a merge but leaves completion pending, verify and
finish ownership-scoped cleanup first. Then use the exact current receipt OID:

```bash
git rev-parse refs/openclaw/pr-merge-outcomes/<PR>
scripts/pr merge-complete <PR> <OUTCOME_OID> --confirmed-operator-completion
```

This command revalidates the historical merge and requires native worktree,
PR-owned local branches, and remote head branch absence. It never merges or deletes
resources. It may post a first completion comment from `merged`; uncertain
comment attempts only look up the existing marker and never POST again.
Missing or ambiguous markers remain pending. Re-read the OID after any state
transition. A first admin-route comment is supported only with retained prior-CI
admission evidence. Before requiring cleanup, it verifies the landed commit's
historical parent and compares it with the retained admission main. The comment
labels this audit as reconstructed after merge, claims no original at-landing
audit, and preserves the historical CI qualification without claiming current-head
CI success. Other admin receipts still require owner review of their original
audit and completion record.

Preserve the operator-facing narrative: what failed, the owning repair, important
proof and limitations, human credit, and linked final state. Record material
tradeoffs or remaining uncertainty, not a mandatory proof essay.
=======
- Read [replacement recovery](landing-recovery.md#replacement-after-confirmed-retirement).
>>>>>>> 97b6e87616f
