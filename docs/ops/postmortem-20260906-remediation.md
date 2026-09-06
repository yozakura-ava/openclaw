# Post-mortem: Workboard/DBOS remediation and deployment

**Date:** 2026-09-06 UTC  
**Scope:** Workboard, DBOS/PostgreSQL authority, gateway lifecycle, dashboard
artifact integrity, Buzz plugin repair, deployment, and live validation  
**Status:** Deployed and live-validated. Seven-day observation and retention
remain open; admission, autonomous-closure, and BQES freezes remain active.

## Executive summary

The work completed today reconciled the preserved Workboard/DBOS remediation
with the fork's `origin/main`, merged it normally, built one immutable
post-merge artifact, promoted it, restarted DBOS before the gateway, repaired
the host-compatible Buzz installation, and validated the live system.

Two production-facing failures were confirmed and addressed:

1. The Workboard database file was healthy, but the gateway's Workboard store
   guard had not started because the process skipped `onGatewayStart`. The
   resulting lifecycle state stayed paused and every `workboard_*` call failed
   with the unavailable-store message. The guard now starts independently at
   plugin registration, probes immediately, and owns retry/recovery behavior.
2. The deployment contained a gateway build from `00:01` and an older control
   UI/service-worker bundle from `23:43`. The browser correctly rejected the
   stale UI with WebSocket close code 4008. A build-time runtime/UI identity
   gate was added, and the final artifact was rebuilt from one commit.

No rollback was required. The final live checks showed healthy gateway, DBOS,
PostgreSQL, Workboard, dashboard, and Buzz behavior.

## Impact and symptoms

- During the reported 13:21–13:31 UTC incident window, Workboard changed from
  normal responses to `Workboard SQLite store is unavailable; lifecycle
  services are paused`.
- Evidence showed no SQLite lock, corruption, disable event, or failed retry
  loop. This was a dead or never-started in-process guard, not a damaged DB.
- A mixed deployment artifact made every browser present an older UI build and
  fail the gateway's version check, even after clearing browser state.
- The initially installed global Buzz copy resolved from an older deployment,
  lacked `nostr-tools`, and repeatedly failed its trusted/plugin lifecycle.

Normal application activity, expected optimistic-concurrency conflicts,
oversized-comment rejection, and orchestrator-only force-close rejection were
not treated as deployment failures.

## Root causes

### Workboard lifecycle guard

The old gateway process skipped the `onGatewayStart` path. The Workboard store
guard therefore never initialized its recovery loop, although the database
file itself remained healthy. The remediation registers the authority guard as
an independent service and starts the probe/recovery path during plugin
registration, so recovery no longer depends on a gateway lifecycle callback.

### Mixed gateway/UI artifact

The faulty deployment had `dist/build-info.json` stamped
`2026-09-06T00-01-04.959Z`, while `dist/control-ui/sw.js` and the control UI
were stamped `2026-09-05T23-43-20.260Z`. The gateway's rejection of the stale
browser was correct; the packaging process was not. The new
`scripts/check-build-artifact-identity.mts` gate runs as part of the build and
the final service worker matches the final gateway build ID.

### Buzz installation drift

The live plugin inventory initially selected a global Buzz installation from an
old deployment. The newest npm release was not compatible with OpenClaw
2026.8.2, so the supported manager installed and pinned the host-compatible
`@openclaw/buzz@2026.8.2` with capability acceptance. After restart, Buzz
resolved from the current bundled candidate and connected successfully.

### Recovery and operational weaknesses found during the work

- The named backup branch and stash were not present in the active clone. The
  preserved refs and patches were located in the recovery bundle, verified,
  and the backup ref was restored. The original checksum manifest also had an
  invalid self-entry; a corrected payload-only manifest was created.
- A diagnostic `git fsck` scan remained active and consumed excessive CPU due
  to an unbounded/piped invocation. It was terminated safely. A separate
  high-CPU `git index-pack` during the intentional 2.5 GB recovery-bundle
  import completed normally. No diagnostic scan remained at wrap-up.
- A first gateway convergence start refused readiness after stale managed
  plugin cleanup; systemd restarted it successfully. The later Buzz repair
  stop exceeded the graceful timeout while draining work and completed with
  SIGKILL before a clean restart. No data-loss or readiness regression was
  observed.

## Work completed

- Reconciled preserved changes by subsystem on the 2026.8.2 `origin/main`
  implementation rather than wholesale-applying the old stash.
- Delivered the Workboard force-close/cascade protections, claim/run fencing,
  idempotency, audit outcomes, bounded SQLite writer/lifecycle recovery,
  durable event intake, audit spool, and PostgreSQL authority path already
  covered by the remediation test lanes.
- Added the runtime/UI build identity check and tests.
- Ran relevant CI gates and merged PR [#8](https://github.com/yozakura-ava/openclaw/pull/8)
  normally; no CI waiver was used for remediation failures.
- Built and promoted the exact post-merge artifact, restarted DBOS first, then
  the gateway, and retained the prior deployment as rollback target.
- Repaired Buzz through the supported plugin manager and verified relay,
  lifecycle, Telegram, and plugin-health state.
- Sent the corrected completion notice to Ava's Telegram destination after the
  final green-light checks.

## Verification and evidence

The deployed source is:

- Commit: `36656b049a5bd0f21a809a11a962671a59088856`
- Tree: `926991b00b49093a06292342e5c2e20ac4331faa`
- Package: `2026.8.2`
- Artifact: `openclaw-2026.8.2-remediation-20260906T014200Z-36656b049a5-candidate`
- Build ID: `2026.8.2-36656b049a5b-2026-09-06T01-40-58.139Z`

The final artifact passed the full build, strict smoke build, artifact
identity check, relevant type/lint gates, Workboard tests (23 files, 407
tests), extension gates, and QA smoke profiles. The CI failures reviewed as
unrelated pre-existing workflow problems were the `OPENCLAW_*` budget limit
(`515/500`) and missing GitHub App private-key configuration in auto-response
and label workflows.

Live validation confirmed:

- gateway and DBOS services active;
- PostgreSQL 15.18, database `dbos_db`, primary mode, authenticated as the
  intended service identity;
- `/ready` returned `ready=true` with no failing components after recovery;
- Workboard returned 1,024 cards through the promoted gateway;
- Workboard guard probe failures recovered and remained healthy, with no
  `store unavailable` or `lifecycle paused` response;
- the served dashboard and no-cache service worker matched the deployed build;
- Buzz was bundled, loaded, connected, and had zero reconnect attempts and no
  last error;
- no duplicate OpenClaw supervisor or leftover diagnostic scan process was
  present at wrap-up.

## Safety controls and remaining work

`OPENCLAW_KILL_ADMISSION=1` and
`OPENCLAW_KILL_AUTONOMOUS_CLOSURE=1` remain enabled, along with the BQES
admission fence. The prior known-good deployment, recovery archive, corrected
checksums, manifests, and restored backup ref remain retained. The rollback
target is:

`/root/.openclaw/deployments/openclaw-2026.8.2-workboard-remediation-20260905T043000Z-final`

The only remaining acceptance work is the required seven-day healthy
observation/retention period and subsequent cleanup under the documented
reachability rules. No second Workboard card was claimed.

## References

- [Workboard remediation record](./workboard-remediation-20260905.md)
- [Deployment record](/root/.openclaw/deployments/openclaw-2026.8.2-remediation-20260906T014200Z-36656b049a5-candidate/deployment-record.txt)
- Recovery bundle: `/home/TacoPants/openclaw-evidence/remediation-20260905/recovery-bundle/`
- Reconciled recovery checksums: `/home/TacoPants/openclaw-evidence/remediation-20260905/recovery-bundle/SHA256SUMS.reconciled`
- Restored backup ref: `backup/canonical-bqes-dbos-cutover-pre-remote-sync-20260905`

