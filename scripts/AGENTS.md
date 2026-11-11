# Scripts Guide

Own local tooling, script wrappers, generated-artifact helper rules. Repo-global policy: root `AGENTS.md`; read only task-relevant references.

## Ownership Map

- Tests: `run-vitest.mjs`; follow [testing skill](../.agents/skills/openclaw-testing/SKILL.md) + [test-authoring skill](../.agents/skills/test-audit/SKILL.md).
- Lint/typecheck: `run-oxlint.mjs` + `run-tsgo.mjs` own repo-local runtime behavior.
- Changed-file checks: `check-changed.mjs` owns execution; `changed-lanes.mjs` owns classification. Never copy path-scope rules into hooks/CI snippets.
- PR preparation: `pr` / `pr-lib` own source acquisition, correction reviews, gate bindings. Changing them: read [PR preparation](../docs/reference/scripts/pr-preparation.md).
- PR wrapper lifecycle: `pr` / `pr-lib` own supervision, locks, materialized dependencies. Changing/repairing them: read [PR wrapper tooling](../docs/reference/scripts/pr-tooling.md).
- GitHub transport: `pr-lib` owns observations + protected dispatch. Changing API/Octopool behavior: read [PR GitHub transport](../docs/reference/scripts/github-transport.md).
- Merge admission/recovery: `pr-lib` owns policy, retained outcomes, completion. Read [merge admission](../docs/reference/scripts/merge-admission.md), [merge recovery](../docs/reference/scripts/merge-recovery.md), or [prior-CI admin admission](../docs/reference/scripts/prior-ci.md) for that operation.
- Remote proof: `crabbox-wrapper.mjs` owns source capsules; `.github/actions/prepare-testbox-shell` owns shell/cwd. Changing them: read [remote gate contracts](../docs/reference/scripts/remote-gates.md). Operating boxes: use [Crabbox skill](../.agents/skills/crabbox/SKILL.md).
- Generated artifacts: align source generator, package script, verification command. Prefer `*:gen` / `*:check` pairs over undocumented one-offs.

## Wrapper Rules

- macOS-only Bash scripts: `#!/bin/bash`, Bash 3.2-compatible syntax. Invoke directly or with `/bin/bash`, including fixtures.
- Portable Bash entrypoints using heredocs/here-strings (including sourced helpers): inline Darwin Bash 5.3+ re-exec guard before those operations prevents heredoc pipe deadlocks. stdin/sourced installers: request `/bin/bash` when replay impossible.
- Existing curated repo seam: prefer wrappers over raw tool entrypoints.
- Tests: prefer `scripts/run-vitest.mjs` or root `pnpm test ...` entrypoints over raw `vitest run` calls.
- Never bare `vitest ...` in automation: starts local watch mode unless `run` or `--run` explicit.
- Adding/editing package scripts or CI steps honoring repo-local lint/typecheck runtime behavior: prefer `scripts/run-oxlint.mjs` + `scripts/run-tsgo.mjs`.
- Before checks, inspect changed-file scope: `node scripts/check-changed.mjs --dry-run [--staged|-- <files...>]`.
- Lint (one/few files): prefer direct `node scripts/run-oxlint.mjs --tsconfig <matching config> <files...>` over sharded `pnpm lint`. `check-changed.mjs` owns targeting for core, extension, script diffs.

## TypeScript Syntax

- `scripts/**` TypeScript implementation files: erasable by Node without transformation. No parameter properties, runtime enums/namespaces, import-equals, export-assignment, or other transform-required TypeScript syntax.
- Syntax rule ≠ every script a plain-Node entrypoint. Keep `tsx` for closures intentionally depending on source runtime trees, frozen checkouts, package aliases, or tsconfig/path resolution.
- Native Node execution: opt-in per entrypoint + import closure. Only when runtime imports stay Node-resolvable; never pull broader source trees into this syntax policy.

## Proof Rules

- PR CI = default broad proof. Change builds + focused tests pass → open ready PR; never hold for pre-PR suite runs.
- Before PR: narrow proof — touched tests (`pnpm test <file> --maxWorkers=1`) + targeted typecheck/lint/format. Prefer local execution for trusted, bounded work when dependencies and current host capacity are qualified; local execution is optional.
- Boxes: deliberate remote proof for expensive checks, a busy/unqualified local host, another OS/device, live providers/channels, long E2E or heavy benchmarks. Acquire when the command is ready; use the smallest proven profile. Queued → stop only task-owned allocation, use PR CI or a safe local scope; keep platform-specific gaps pending. Never force heavy local checks or chain provider fallbacks.
- CI fails → `pnpm test:ci-failed <pr>`; read published classification (pre-existing on main vs new). Fix new failures → `pnpm test:ci-failed <pr> --run` until local pass → push once. Pre-existing: failure-table landing rule. Never rerun/re-push just for green (`gh run rerun` included); never local full suite for CI repair.
- Untrusted contributor/fork code: secretless isolation. Credentialed execution needs maintainer authorization; scope live credentials + isolate Gateway/state.

## PR Safety

<<<<<<< HEAD
`OPENCLAW_PR_TOOLING_ROOT` selects a full checkout of the same repository for
materialized wrappers' third-party dependencies; otherwise `openclaw.pr.toolingRoot` in the
canonical checkout's Git config applies, then the canonical checkout itself.
The standalone CI watcher and Crabbox entrypoint resolve missing third-party
packages from the same tooling root when their checkout has no `node_modules`,
with the same explicit-root identity checks and exact package versions. They
never link an installation or resolve workspace packages from another checkout.
The wrapper still selects and verifies code against the existing trust anchor.
Installed package versions must exactly match the anchor manifest. On mismatch,
an explicitly selected, separate, clean `main` checkout is fetched, fast-forwarded,
and installed with `pnpm install --frozen-lockfile` once before rechecking. A stale
dirty or non-main root cannot refresh; sparse and unrelated roots are always
refused. The canonical checkout is never refreshed. Keep the selected installation
intact until the command finishes. This setting applies at both dependency
materialization handoffs; in-place wrappers keep their checkout's dependency
context, and wrapper selection stays unchanged.

`OPENCLAW_PR_GIT` selects the Git executable. Startup checks that binary with a
10-second deadline before choosing wrapper code; Darwin process-identity Python
calls use the same deadline. PR metadata, repository authority, writer identity,
comments, contributor authors, and author permissions prefer REST, with GraphQL
fallback on confirmed primary core quota exhaustion. Review snapshots omit unused
check rollups, and preparation reads only the live head fields it consumes.
Repository discovery uses the CLI's local default and host resolution, without a
quota-dependent HEAD request. Host-qualified locators go directly to the API;
review metadata reuses the resolved URL.
Each PR-head observation and merge snapshot explicitly requests
`Cache-Control: max-age=0`: the relay revalidates that read and may publish its
result, while separate before/after observations must never reuse one cached fact.
The landing-snapshot GraphQL query must exactly match the shipped Octopool shim's allowlist; branch identity comes from the existing REST source-acquisition and cleanup reads.
Writer identity uses the protected CLI with included headers on both transports
to retain the native writer route. Reviewer assignment requires REST and verifies
the retained assignee. The CI watcher polls GraphQL summaries, expanding details
for failures or pending checks after CI succeeds; primary quota exhaustion selects
REST with complete check/status and workflow evidence.

Successful authentication is reused within one shell operation and its nested
worktree entries; new processes and changed credential selection require a new
probe. This private process state is never inherited or written to artifacts.
`merge_verify` takes one options record with `replacementHead`,
`autoMergeRequested`, and `observation`; a null observation requests a fresh read.
Repository identity comes from the same PR observation as its head facts. Callers
carry that observation through source acquisition and hosted gates; acquisition
still independently rereads complete source identity after the immutable fetch.
Publication revalidates immediately before each Git/GraphQL write, after transport
preparation, and compares the successful publication observation before acquisition.

Ordinary immediate squash prefers REST. Explicit recovery of a validated retained
intent starts with GraphQL; normal fallback and immediate-only recovery gates
still apply. Admission reads switch transports only
for confirmed primary quota exhaustion or unsupported REST policy or mergeability
projections, including UNKNOWN; secondary throttles and access failures never authorize a switch. REST requires proven absence
of classic protection and merge queues, supported effective rules, exact-head publisher-bound
checks, and the retained-outcome lifecycle. It preserves configured message content
from pinned published commits or the PR body and leaves the title to GitHub.
Choose the transport before dispatch; never replay an uncertain mutation through
another API. Completion comments use the receipt observation's transport and keep
their one-attempt marker. Auto-merge, queues, admin admission, and non-squash merges
require GraphQL; GitHub has no REST auto-merge endpoint. Legacy hosted workflow
proof requires REST. Fallback never waives a required gate.
API failures preserve safe quota and retry metadata from the original response.
When that response has no usable HTTP framing, a separate GraphQL/core quota
probe is labeled supplemental and does not establish the failed request's reset.
Diagnostics never add automatic retries.

### Octopool string rewrite protection

Keep `gh` on the Octopool shim; never disable string rewrite protection or select
the raw GitHub CLI to get a landing through. `review-init` resolves the repository
with the local `gh browse` command and a child-only URL-printing launcher. Older
Octopool versions reject this singleton command before their guarded best-effort
path. Upgrade to Octopool 0.7.1 or later; setting an explicit
host-qualified `GH_REPO=github.com/openclaw/openclaw` also avoids discovery while
preserving the subsequent authoritative API checks.

Ordinary immediate REST squash uses `gh api --method PUT repos/OWNER/REPO/pulls/NUMBER/merge-async
--input <absolute-file>` with JSON containing the full prepared 40-hex `sha`,
`merge_method: "squash"`, `merge_action: "direct_merge"`, `bypass_rules: false`, and
the inspected `commit_message`. It refuses stacked PRs because this workflow
reviews one PR. The outcome retains the returned UUID before polling; subsequent
`merge-run` calls read that UUID once and reconcile the authoritative PR/tree.
Acceptance and `enqueued` are not merge completion. Failed, expired, conflicting,
or lost responses never authorize automatic resubmission or another transport.
Existing auto/queue/admin and GraphQL-quota routes keep their own contracts; the
explicit prior-CI admin route below still uses the synchronous `/merge` endpoint.
Async PUT and status GET prepend `-H 'X-Octopool-Require: merge-async-v1'` as the first
API option, before `--hostname`. This requires the structural async merge guard in
[Octopool PR #231](https://github.com/openclaw/octopool/pull/231): older protected wrappers reject the marker before rewriting or native
GitHub I/O. Upgrade Octopool if refused; never remove the marker or replay an
uncertain intent. Native `gh` and empty rewrite policies pass the harmless header
through without rewriting authority. No Worker deployment or credential change
is required. Checking a response after dispatch cannot replace this guard.
The shared GitHub subprocess owner stages internal
`--input -` payload bytes in a private temporary file, keeps child stdin empty,
and removes the file after synchronous completion. Keep the explicit SHA even
when newer Octopool can resolve a missing one. Auto-merge needs Octopool's protected auto-merge support
(openclaw/octopool#179), a numeric PR, `--squash --auto --match-head-commit SHA`,
an explicit `--subject`, and `--body-file`. The wrapper supplies GitHub's
current-head `viewerMergeHeadlineText` preview so repository title defaults stay
intact. Octopool 0.6.10 and `641ce3c` do not support that auto shape.

Prepare's reviewer assignment uses the exact issue-assignee POST with raw
`assignees[]` fields. Fork commit publication declares its GraphQL JSON with
`--input`, so the guard can inspect it; Octopool's aggregate input bound still
applies. Native CLI admin, non-squash, queue, and auto-cancellation variants are not
covered by the accepted shapes above. Do not replace them with an immediate REST
merge, which changes admission semantics. A blocked dispatch still follows the
retained-outcome recovery rules below; the generic guard error is not authority
to clear or retry an intent.

The explicit `merge-run --admin-evidence <file> --confirmed-operator-admin` mode
is a separate immediate-squash admission, not a fallback from auto/queue or a
failed request. It verifies a prior successful CI attempt and its PR/head
provenance, binds the reviewed prior-to-prepared delta and scoped-check
attestations, and revalidates active organization/repository-admin authority and
effective review rules. For attributed pre-existing failures only, it also
accepts repository write access plus active organization membership and the
actual writer's live `always`/`pull_requests_only` bypass of every effective
repository-owned CI-only ruleset. The ruleset must contain only GitHub Actions
`openclaw/ci-gate`; mixed review/security policy cannot delegate this exception.
Policy and grants are rechecked after CI/security inspection and retained with
the existing outcome. Scoped land authority includes this inherited-failure
exception; the confirmed-operator flag records that scope without asserting that
the bot is an administrator. No grant changes or alternate credentials occur.
The existing authoritative classic-protection absence gate remains mandatory:
generic REST 404s and permission-projected GraphQL nulls do not prove absence.
Missing policy-read capability is an external authority blocker, not an
implicit fallback or permission to elevate the writer.
The original conflict-resolution route permits only
pending/skipped `openclaw/ci-gate`. An explicitly approved `pre-existing-failure`
attribution instead binds the current failed attempt, effective gate check-run,
tested merge/base, unchanged failure inputs, and inspected qualification artifacts.
Every failed job and fail-fast cancellation must be accounted for; cancelled
coverage stays unrun. Current `openclaw/openclaw` PR reruns let every Node matrix
leg finish; only PRs in other workflow repositories use native matrix fail-fast.
Historical runs retain their tested workflow's cancellation policy, so the matrix
attribution route still verifies that exact expression and run context.
An independently attributed cancelled Node test,
`check-prod-types`, or real-Gateway UI root can use
`failures[].failedStep: { number, workflowJob }`, with
`checks-node-core-test-nondist-shard`, `check-shard`, or
`checks-ui-e2e-real-gateway`, respectively.
Admission binds its live check-run, complete steps, single failed execution step,
timestamps, and unchanged audited workflow. The production-type and UI routes also
match every declared source step and its ordered timeline. The UI route permits
only its explicit optional runner setup/cleanup pair and requires the successful
private-QA build before its audited test entrypoint. Other steps must
succeed or be skipped through successful cleanup.
Retain the cancelled conclusion in the root proof; this is not passing coverage.
A collateral cancelled job's failed step remains blocking except for
the explicitly qualified historical skipped-producer/missing-artifact case in
the landing workflow. Its secondary evidence stays under cancellation, never
in the causal root list; test, cleanup, and upload transport failures remain blocked.
The review retains `tests.result: "fail"` with exact
`tests.preExistingCi` head/run/attempt attribution. Ordinary merge admission refuses
that review; the confirmed admin route must verify the same failed attempt.
Without a failed-step binding, an attributed cancelled Node root requires its
matching live GitHub Actions check-run and complete deadline/cancellation annotations,
consistent head/suite/timestamps, elapsed deadline, one cancelled test step, no
additional failed steps, and unchanged workflow. Retain that cancelled status in
the root proof; it is not fail-fast collateral or passing coverage. Manual or
unverified cancellation remains refused.
Branch-caused or unattributed failures, other required checks, security, and
required reviews remain blocking.
Exact-head `github_pending` preparation remains pending. GraphQL owns
observations and reconciliation; the protected REST PUT above owns the SHA-pinned
dispatch. The existing retained outcome owns `priorCiAdmin` evidence and retains
its baseline/prior head and tested merge objects. Exact PR/policy facts and the
landing-parent audit still apply; active prior-CI admission may accept verified
forward-main movement as described below. See the [landing workflow](../.agents/skills/openclaw-pr-maintainer/references/landing.md#explicit-prior-ci-admin-landing)
for the evidence fields and supported policy limits.

## Generated Outputs

- If a script writes generated artifacts, keep the source-of-truth generator, the package script, and the matching verification/check command aligned.
- Prefer additive generator/check pairs like `*:gen` and `*:check` over one-off undocumented scripts.

## Scope

- Keep script-runner behavior, wrapper expectations, and generated-artifact guidance here.
- Leave repo-global verification policy in the root `AGENTS.md`.

## Native Merge Outcome Recovery

- Fresh merge admission on every route (ordinary, prior-CI admin, and Crabbox) accepts forward main movement only after proving descent from the observed and verified main anchors and checking the prepared-head merge tree is conflict-free and nonempty. PR identity, head, base, lifecycle, draft state, and policy facts stay pinned. Mergeability projections may recalculate; UNKNOWN settles for at most three observations, then MERGEABLE and the selected route's policy requirements must hold. The verified-main cursor advances separately from the original intent and landing-parent audit anchor. `OPENCLAW_PR_STRICT_DRIFT=1` restores abort-on-main-change during observation and final Crabbox validation, in addition to its merge-verify drift gate. Prior-CI authority retains its existing ordering: For already-selected REST, the last complete observation and main materialization precede one final live authority verification. GraphQL retains its post-authority local-only reread (no lazy or explicit fetch), refusing a newly unavailable main before intent; late REST fallback retains that boundary and rechecks authority. No materialization follows final authority verification. OPEN/CLOSED/pending/uncertain reconciliation retains exact full PR/main snapshot stability. Only a validated MERGED receipt may accept forward main advancement between its two observations: every PR fact must remain equal, acquire the reread's exact main commit through the same canonical trusted URL when absent locally, and prove the original observed main is its ancestor. Equal snapshots keep the fast path. Both snapshots stay pinned; never add a third reread loop. This completes an already-proven merge, never grants authority for a future merge; historical tree/source-base checks and receipt/comment/cleanup ownership remain unchanged.
- Local object-availability probes and strict retained-record reads use command-scoped `GIT_NO_LAZY_FETCH=1`. Upstream Git 2.45 first supports this environment variable; older Git may still hydrate objects implicitly and cannot promise local-only probes. The immutable-head reuse probe and final GraphQL prior-CI local-only check also use Git's explicit `--no-lazy-fetch` switch: unsupported Git falls back to canonical head acquisition or refuses that final main-advance optimization. This is not a new all-command minimum or an offline workflow: explicit canonical fetches and actual tree/diff/archive/push/checkout operations remain available. Completed-receipt correctness depends on pinned facts and ancestry/tree proof, not this download avoidance.
- Initial admission alone waits for UNKNOWN mergeability projections for at most three observations, sleeping one then two seconds, with PR and policy facts and each already-known projection pinned; full final rereads and retained-outcome reconciliation never poll. Before intent on PRs without a merge queue, ordinary merges reject gh's BLOCKED/BEHIND/DIRTY refusals and admin merges reject DIRTY; queue and auto retain their distinct admission contracts.
- Explicit prior-CI admission may select the complete REST observation owner after a valid GraphQL snapshot has an UNKNOWN projection. The next observation must preserve every known PR/projection fact; REST rereads retain repository identity, exact head, main, rules, and complete required-check evidence without converting BLOCKED to CLEAN. That reader remains selected through the attempt. During active prior-CI admission, both main endpoints of a complete REST read pass through the same forward-ancestry and merge-composition owner before normalization; branch policy is rechecked, and transient read bounds never enter retained outcomes. The latest validated main is tracked separately from the intent anchor. Only a new proven forward advance may open a three-observation recalculation window (waiting 1 then 2 seconds); exact PR/policy/check facts and original known projection values stay pinned, each subsequent main must advance from the latest read, and UNKNOWN never authorizes dispatch. The final already-selected REST window materializes both endpoints and the verified anchor before authority verification, including recalculation reads. GraphQL and late REST fallback retain their post-authority local-only window. If that GraphQL window observes a new main whose raw object is conclusively absent, it discards the active authority proof and returns to pre-authority materialization of that exact tip. Both earlier pins must remain readable; failed queries, stderr, corruption, permission errors, and unsupported Git never imply absence. Each new round preserves the observed tip as an ancestry lower bound and repeats complete live CI, head, review, evidence, security, and admin verification against the original proof fingerprint. At most three authority rounds may run before a refusal without intent or dispatch; no fetch occurs inside a qualified final authority window. Outside active admission, OPEN/CLOSED snapshot stability remains strict. Both observation and new intent record REST transport, while the existing prior-CI verifier still owns all CI exceptions, enforced reviews, and security clearance. Already-selected REST runs it once after the final complete reread, before unchanged evidence/artifact checks and intent CAS; it does not reopen a redundant observation and verification window. Unknown or malformed REST projections, conflicts, unsupported policy, and changed authority refuse admission. Ordinary REST remains passing-check/CLEAN-only; Crabbox and retained-outcome reconciliation gain no new dispatch authority.
- When GraphQL is selected, ordinary immediate squash dispatch uses the selected writer's exact-head mutation directly after one final explicit pre-merge revalidation. It preserves the captured body, omits the headline so GitHub retains its existing defaults, and cannot enqueue or arm auto-merge. Its initial and final public snapshots bind the head; existing REST source acquisition binds the branch, and both independent post-dispatch receipt observations remain fresh. Queue, auto, admin, merge, and rebase retain native `gh pr merge` dispatch and their additional authority windows.
- `merge-run` owns remote dispatch separately from the process lock. Before any merge/auto/queue request it records the exact repository identity, PR, main target, prepared head, observed main, method, route, and attempt in `refs/openclaw/pr-merge-outcomes/<PR>`. Private Git commits retain the required objects across worktree removal and GC. Do not delete or push these refs; process-lock recovery never clears them.
- A failed request can already have merged. After the reported exact process-lock recovery, repeat `scripts/pr merge-run <PR>` only for reconciliation. `OPEN`, a different head, reverted/partially applied content, elapsed time, or an absent process never proves non-execution. There is no automatic clear/retry override. Inspect the PR timeline, authoritative main history, and `git show refs/openclaw/pr-merge-outcomes/<PR>:outcome.json`; unresolved uncertainty requires operator action outside this automatic path. Keep the record for that investigation. If an older wrapper left `.local/merge-output.log` without an outcome record, even an empty capture blocks a fresh dispatch; preserve it and reconcile the earlier request manually.
- An explicit land/merge/ship request supplies standing operator authorization for investigated recovery on the same prepared head and merge method, including a newly reviewed/prepared replacement head that repairs the same authorized scope. Do not ask for renewed chat approval solely because main moved or a request failed. Investigate each retained outcome before deciding on a bounded recovery attempt; standing authorization does not establish non-execution or permit blind resubmission of accepted, pending, or unresolved requests.
- To repair an accepted or uncertain non-queue auto request, use `merge-recover <PR> <OUTCOME_OID> --confirmed-operator-recovery --cancel-auto` before replacing the remote head. The exact retained intent and matching open PR/head/base are required; a present request must also match the retained method. Cancellation is recorded before dispatch, preserves the original acknowledgment state, captures and ancestry, and reconciles a concurrent merge. Its two stability rereads may change only `mergeable` and `mergeStateStatus`, which do not authorize cancellation; every identity, head, main, queue, request, and policy fact stays pinned. Ordinary merge admission and other recovery comparisons remain unchanged. An already absent request is recorded as retired without a cancellation mutation; absence does not prove that the earlier submission never executed. This investigated operator decision uses standing land authority, not renewed approval or a replacement PR. An uncertain cancellation is observation-only on retry. Only confirmed retirement admits ordinary recovery on the retained or explicitly reviewed/prepared replacement head, with completed gates. Queue/admin cancellation is unsupported. Never clear outcome refs or edit receipts by hand.
- After that investigation, ordinary recovery uses `scripts/pr merge-recover <PR> <OUTCOME_OID> --confirmed-operator-recovery` under the standing authorization above or explicit operator authorization for one new attempt. This is an operator decision, never proof that the prior request did not execute. It requires the exact current retained intent with either no recorded acceptance or confirmed auto cancellation, the same prepared head and merge method, fresh ordinary admission, and an immediate route for the new attempt. For a newly reviewed/prepared replacement head within the existing landing scope, explicitly select and append `--replacement-head <SHA>` with that exact full lowercase 40-character SHA; standing landing authority covers that repair without another chat approval. A scope or merge-method change still needs its own authorization. Never infer the selected head from PR/main/prep state. Replacement requires matching PR review stamps and prepare context, prepared-tree/gate bindings, completed CI proof, and a completed ClawSweeper review under the canonical freshness policy. Local evidence must remain unchanged through admission. Without the argument, changed-head recovery still fails. Recovery never rebases or bypasses CI, contributor-ancestry, branch, or owner gates. The successor-intent CAS consumes the exact outcome OID, retains the old outcome and objects as ancestry, and records the operator plus the explicit replacement head when supplied; each dispatch has its own capture. Replacement intent also snapshots existing regular capture files in its private Git tree under their original basenames, preserving the bytes through successful worktree cleanup and GC; symlink captures fail closed. Reusing the old outcome OID fails. Never infer authorization from an error string, an OPEN read, or a routine retry, and never clear the outcome ref.
- A confirmed-cancelled auto squash may recover an explicitly selected reviewed head, including the unchanged retained head, with `merge-recover <PR> <OUTCOME_OID> --confirmed-operator-recovery --replacement-head <SHA> --admin-evidence <path> --confirmed-operator-admin`. Current selected-head review, exact-head `github_pending` preparation, and all live prior-CI admin checks are required. The successor retains the original intent, cancellation, captures, and explicit replacement through the existing CAS ancestry; it never invents provider-rejection or pre-dispatch-refusal evidence. CI failure attribution must bind the selected head and current attempt. Explicit `--replacement-head` selection is still required for a retired-auto admin transition even when the SHA is unchanged; the no-argument rejected-admin recovery route stays separate. Unconfirmed retirement, renewed auto/queue requests, stale outcome/head/artifact bindings, and unrelated admin routes remain refused.
- Exception to the unaccepted-intent requirement: accepted immediate REST intents with a retained UUID, `asyncMerge.status: "failed"`, and null SHA may use the same explicit `merge-recover` command on the unchanged head and method. Re-read the authoritative async result before fresh ordinary OPEN-head admission; retain `recovery.asyncFailure` and the exact prior outcome through successor CAS ancestry. Pending, enqueued, missing/expired, SHA-bearing, or changed results remain refused; never clear refs or automatically resubmit.
- Explicit same-head prior-CI admin recovery may pair `merge-recover <PR> <OUTCOME_OID> --confirmed-operator-recovery` with `--admin-evidence <path> --confirmed-operator-admin` only for the complete known GitHub REST HTTP 405 base-modified rejection and matching `gh` diagnostic. The request was sent; `recovery.providerRejection` records its qualified rejection separately from local pre-dispatch refusals. Preserve the exact original regular capture and any previously qualified captures. The successor CAS retains those bytes and the prior intent, including through acceptance, completion, worktree cleanup, and GC. Fresh review, security, current admin authority, evidence integrity, merge-tree, and exact-head checks remain required; the same-head `github_pending` stamp is never rewritten as success. Unknown extra captures, changed or symlink captures, other 405s, timeouts, 5xx/mixed/truncated responses, accepted intents, other admin routes, and head replacement remain refused. Each further recovery requires its new outcome OID and explicit confirmation; never infer authority from an OPEN read or retry automatically.
- An unaccepted prior-CI REST admin intent on a retired head may transition to a fresh current-head auto request only with `merge-recover <PR> <OUTCOME_OID> --confirmed-operator-recovery --replacement-head <SHA> --auto-merge`. The explicit replacement must differ from the retained admin head. Its exact reviewed/prepared `github_pending` head must still be OPEN, `MERGEABLE/BLOCKED` or `MERGEABLE/BEHIND`, free of an existing auto/queue request, and pass the normal required-check, ClawSweeper, security, and owner gates. This route does not use `--admin-evidence`: the old exact-SHA REST request remains uncertain but is fenced from the different live head, while `recovery.staleHeadRetirement` retains its intent ancestry and every regular capture without interpreting its bytes; an empty capture is valid. The successor route is `auto`, never admin or immediate. Same-head, accepted, stale-OID, changed-head, missing/symlink/extra-capture, admission-time capture mutation, route/method, lifecycle, gate, and authority drift remain refused.
- An inspected Octopool refusal for a retained, unaccepted auto squash intent may use `merge-recover <PR> <OUTCOME_OID> --confirmed-operator-recovery --pre-dispatch-refusal <evidence-directory>` with an optional explicitly selected, reviewed/prepared replacement head under the landing authority above. Preserve the sole original `merge-output.<attempt>.log` and `qualification.json` in that directory. Qualification pins `outcome`, the capture Git blob OID as `capture`, and `inspected: true`; it is an operator attestation, never an automatic retry inferred from an error. For `kind: "octopool-0.6.10-auto-refusal"`, include the inspected `version`, `sourceRevision`, `parserSha256`, and exact `args` array: the helper accepts only the audited 0.6.10 parser that rejected `--auto` before dispatch and its complete refusal. `kind: "octopool-0.7.1-missing-subject-refusal"` uses those same fields, pinned to version `0.7.1`, source `7ab9b348c99a7be4fdc82c75cb06ebce44e0007e`, and parser SHA-256 `b32cb960537f5ffa1336a7689674afba9b4a2485b05e449acd2684a251ff8970`; it accepts only the complete refusal for the inspected auto-squash invocation with its body file but no `--subject`, which that parser rejects before starting the mutation child. `kind: "octopool-0.7.1-policy-timeout-refusal"` qualifies only the inspected initial policy-fetch timeout from the exact released 0.7.1 Darwin arm64 executable and eight source files pinned in `merge-pre-dispatch-refusal.mjs`. In addition to the common pins, attest `producer: "octopool"`, `command: "pr merge"`, `diagnosticsEnabled: true`, `version`, `sourceRevision`, `executableSha256`, and the exact `sourceSha256` path/digest map. This branch accepts only the complete single `class=timeout` error line; diagnostics, policy denials, and additional output remain refused. The retained native intent binds repo/PR/head/method/route; no uncaptured subject or full argv is required. That source revision returns this initial error before diagnostic setup or mutation dispatch; never manufacture a diagnostic. The new attempt still passes the actual string-rewrite policy and every existing review, CI, authority, and receipt gate. For `kind: "octopool-merge-diagnostics"`, attest `producer: "octopool"` and `diagnosticsEnabled: true`; the capture must contain exactly one complete diagnostic with `child_started=false`, a known pre-start outcome, no mutation exit status, and no response headers. Native GraphQL dispatch requests these diagnostics and supplies the captured current-head squash headline and body to the publication guard. Missing, changed, symlink, extra, accepted, or ambiguous evidence stays fenced. Recovery retains the qualification and capture bytes with the prior outcome ancestry. Same-head and replacement qualification both bind local review, preparation, and gates to the approved head, then recheck artifact bytes and the prepared branch after awaited admission. A head-bound `github_pending` stamp may be used only for this qualified recovery once the enforced CI gate and all required checks pass, with fresh `MERGEABLE/CLEAN` immediate admission; the stamp is never rewritten as successful proof, and pending, admin, queue, or auto recovery is refused.
- An operator-qualified legacy gh v2.98 DIRTY refusal may use `merge-recover <PR> <CAPTURE_BLOB_OID> --confirmed-operator-recovery --legacy-refusal <evidence-directory> --replacement-head <SHA>`. Freeze the original `merge-output.log`, `prep.env`, `prep.md`, and `gates.env` before refreshing preparation. The command requires no existing outcome, the sole original regular capture, its exact Git blob hash and complete source-qualified pre-dispatch refusal, historical PR/head/base identity, and all ordinary current review/preparation/CI/admission gates. Empty, uncertain, extra, changed or symlink captures remain blocked. Standing recovery authority and inspected caller/source evidence qualify the refusal; matching text alone does not authorize a retry. The new current intent retains original files and source commits with explicit `legacyRefusal` provenance; it never invents a historical intent or deletes the original capture. Subsequent recovery uses the recorded current outcome normally.
- Fresh direct PR/main reads and stable re-reads narrow races; they do not provide global exactly-once execution or a base-OID merge precondition. Immediate squash refuses `NO NET CHANGE` without claiming the PR merged or all intended content remains present. Normal squash/merge receipts reconstruct the tree at the actual landed parent; merge also requires prepared-head ancestry. Rebase and queue receipts verify the aggregate reviewed delta in the historical landed tree using the unique source fork base of retained main/head, not the final rebased parent or recorded main itself. Missing or ambiguous source bases fail closed. Later main advancement or reverts do not authorize reapplication. A normal recorded squash that was empty at its landed parent warns for investigation; its receipt remains confirmed, with no resubmission or automatic revert.
- Worktree cleanup (including GC dry-run and stale-entry provisioning) preserves `.local/merge-output.log` at its original path unless the corresponding outcome passes local record and retained-object validation. Empty captures and dangling capture symlinks count. Preserve the worktree, metadata, and local branches for manual reconciliation; do not trash, rename, or manufacture a receipt. `CLOSED`/`MERGED` and an absent process do not resolve dispatch uncertainty. Valid retained outcomes remain available after eligible cleanup; cleanup does not reconcile them or change process-lock recovery.
- Before recording intent, `--auto-merge` selects immediate pinned squash for `MERGEABLE/CLEAN` or auto for `MERGEABLE/BEHIND` or `MERGEABLE/BLOCKED`, subject to all admission gates and queue policy. Accepted auto/queue requests are visible pending outcomes, not completion. The request carries `--match-head-commit`; confirmation still requires the exact attempted head. This is a submission-time head precondition, not a server-side freeze against later collaborator pushes. Existing or ambiguous requests are never automatically cancelled, re-armed, or followed by an immediate fallback; an explicitly investigated accepted auto request uses the cancellation recovery above. Ordinary `gh pr merge` can enqueue when queue policy applies.
- A confirmed merge receipt precedes audits, comments, and cleanup. A comment POST has one attempt marker and is never blindly repeated. Recovery searches authoritative comments for that marker, reports completion pending, and leaves cleanup to the operator after ownership checks; it works without the original worktree/prep artifacts. Normal uninterrupted completion preserves comments and cleanup, with exact-head leased remote deletion. Authoritative branch absence completes cleanup; inspect warnings for advanced or inaccessible branches. Delayed recovery never deletes a recreated branch by name.
- After ownership-checked cleanup, explicitly finish a verified receipt with `scripts/pr merge-complete <PR> <OUTCOME_OID> --confirmed-operator-completion`. It revalidates the exact retained receipt and remote merge, requires native worktree/local branch/remote head branch absence, and never dispatches a merge or deletes resources. A `merged` receipt may post its first completion comment; `commenting`/`commented` require the existing exact attempt marker and never repost. Missing or ambiguous comments preserve pending state. For a retained prior-CI admin receipt, delayed completion reconstructs the historical parent comparison from retained admission main and the verified landed commit before checking cleanup absence. It labels the audit reconstructed after merge, claims no original at-landing audit, and retains the historical CI caveat. Legacy admin receipts without retained prior-CI proof still require owner review; no original audit is fabricated. Read the current outcome OID again after a state transition; stale OIDs are refused. Default `merge-run` remains reconciliation-only.
=======
- PR operations: follow [maintainer workflow](../.agents/skills/openclaw-pr-maintainer/SKILL.md). Unset `OPENCLAW_PR_GATES_REMOTE` = GitHub default; explicit `OPENCLAW_PR_GATES_REMOTE=github` equivalent. Default handoff: `merge-run --auto-merge`. Old full local gates: explicit `OPENCLAW_PR_GATES_REMOTE=local`. `OPENCLAW_TESTBOX=1` + unset remote selector retains hosted mode. Pending admission ≠ successful proof/merge completion.
- Landing subcommands require canonical/origin-main wrapper code. Never bypass wrapper trust, operation locks, exact-head review/gate bindings, live authority checks, or Octopool string rewrite protection; never select raw `gh` to get landing through.
- Before returning: join all PR-state-mutating children. Drained self-exited failures auto-release their operation lock; interrupted/uncertain locks stay held — verify no child tools remain before reported exact-OID `scripts/pr lock-recover` command. Never delete lock refs manually.
- Preserve transition journals, preparation evidence, outcome refs, captures. Never clear/push `refs/openclaw/pr-merge-outcomes/<PR>`, hand-edit receipts, or infer non-execution from failed command, elapsed time, absent process, or open PR.
- Accepted/pending/uncertain writes: investigate through [native recovery](../docs/reference/scripts/merge-recovery.md). Never blindly resubmit/switch transports. Existing land authority covers investigated same-scope recovery, not gate bypasses/new scope/method.
- Before comments/ownership-checked cleanup: confirm merge receipt. Completion comments: one attempt; reconcile uncertain comments by marker. Preserve worktrees/captures with unresolved outcome; never delete recreated branch by name.
>>>>>>> 97b6e87616f

## Execution Gotchas

Commands apply within task authority/safety boundaries. Prefer bounded local proof when dependencies and current host capacity are qualified.

- Fs-safe dependency trouble: follow [on-demand vendoring instructions](vendor-fs-safe.md); vendor contents local, registry dependencies default.
- Trusted normal checkout missing dependencies: `pnpm install --frozen-lockfile`, retry once before diagnosing code defect. Never reconcile shared/worktree install while other jobs use it.
- CLI: `pnpm openclaw ...` or `pnpm dev`, never `node --import tsx src/index.ts`; supported wrappers own build freshness + process setup.
- Formatting: installed `oxfmt`; typechecking: repository `tsgo` lanes. Scope: `pnpm changed:lanes --json`; targeted tests/checks. Avoiding worktree reconciliation: `node scripts/check-changed.mjs` or `node scripts/run-vitest.mjs` with ready dependencies.
