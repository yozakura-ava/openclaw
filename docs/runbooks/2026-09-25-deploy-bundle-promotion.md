# Runbook: Deploy Bundle Promotion — Live Cutover (HR2-gated, atomic rollback ≤24h)

**Owners:** Ava (orchestration), Tomoe (infra/build), Rin (independent review), Craig (HR2 final cutover approval)
**Anchors:**

- Pipeline design: `gateway-ci-staging-pipeline.md` (Craig-endorsed 2026-09-24; design doc lives in the sprint planning workspace, not in-repo)
- Postmortem driver: `2026-09-24-openclaw-9-6-rollout.md` (gateway workspace postmortem, not in-repo)
- Build card: workboard card `7e196d76-03b1-4571-9727-0d5aea52299d` (PR-K)
- Build workflow: [`.github/workflows/deploy-bundle.yml`](../../.github/workflows/deploy-bundle.yml)
- Staging smoke: [`scripts/health/staging_smoke.py`](../../scripts/health/staging_smoke.py)

## Scope

This runbook covers **Phase 3 (promotion to live)** of the deploy-bundle pipeline. It assumes:

- Phase 0 (preflight provenance + import-closure runtime resolvability check) ran and recorded the provenance tuple on the staging art card.
- Phase 1 (GitHub Actions build) produced a bundle artifact whose import-closure gate passed.
- Phase 2 (local staging on port 18800) ran `scripts/health/staging_smoke.py` live and exited 0 within the last 60 minutes.

## Postmortem RC traceability

The 2026-09-24 rollout postmortem surfaced four runtime hazards; this runbook and the bundle pipeline map each one to the mechanism that prevents recurrence:

- **RC#1 — private contract runtime resolvability.** `@openclaw/workboard-contract` is a legitimate bundled runtime dependency on this base (Tsubaki STOP finding, card `44909d8c`: imported as runtime values in 10 non-test files — `src/cli.ts`, `command.ts`, `store-card-helpers.ts`, `tools-card-mutations.ts`, `gateway-helpers.ts`, plus five browser files). The postmortem's actual lesson is "no runtime import may fail to resolve." The **import-closure gate** (Phase 1) walks every generated `.setup/.mjs` and rejects bare-package imports absent from the staged production `node_modules` — that is RC#1 enforcement. A separate devDependencies-boundary assertion is intentionally NOT used: keeping the contract in `dependencies` is correct on this base, and the import-closure gate catches the actual failure mode (an unresolved import at runtime).
- **RC#5 — long graceful drain.** Reproduced when the live service holds a half-stopped gateway while draining. Mitigated by the bounded `MemoryHigh=768M` / `MemoryMax=1G` / `TimeoutStopSec=20` on `openclaw-staging.service` so staging cannot recreate the pattern, and by Phase 3 step 6 (restart under `TimeoutStopSec=330` cap; explicit cgroup kill if exceeded).
- **RC#6 — stale dashboard build id.** Mitigated by `scripts/health/staging_smoke.py::check_build_id_freshness` capturing the served `gatewayBuild` and asserting it carries the staged artifact's `artifact_sha` prefix. Operator comms in this runbook remind operators to hard-refresh on any UI stamp change.

**No step below is permitted to run without explicit, verbatim Craig approval quote in the chat (HR2).** Operator bypass keywords ("overnight", "small", "low risk") do NOT satisfy HR2.

## Pre-promotion gates (BEFORE requesting Craig approval)

Every item below MUST be true and recorded on the art card. If any fails, STOP and route to a Tsubaki/Tomoe workboard card — do not request Craig approval.

- [ ] `openclaw.service` is in active state with no orphan `openclaw doctor` / `openclaw plugins doctor` processes.
- [ ] `systemctl --user status openclaw.service` shows `MainPID` set, `NRestarts=0`, `/readyz` returns 200, listener owned by the MainPID.
- [ ] `ls /usr/lib/node_modules/openclaw/package.json` resolves to a valid install with `version` recorded on the art card.
- [ ] `/root/backups/openclaw-pre-rework-<TIMESTAMP>/` exists with a valid checksum manifest and a non-zero tar size verified by `sha256sum -c`.
- [ ] Provenance tuple captured at staging matches the GH Actions `actions/upload-artifact` metadata for the staging artifact: `commit`, `manifest_sha`, `lockfile_sha`, `node_version`, `artifact_sha`. Diff is empty.
- [ ] Staging smoke last green <60 minutes ago; all five checks recorded PASS with the served `gatewayBuild` matching the staged artifact's `artifact_sha` prefix.
- [ ] Dashboard build id noted for operator comms (postmortem RC#6 — operators must hard-refresh on UI stamp change).
- [ ] No active SEV-0..SEV-2 incidents on the live gateway (Ayumi watchdog clean).

## Promotion procedure (HR2-gated)

Every box below is a **Craig-gated step**. Wait for an explicit, verbatim Craig approval quote. Do not infer consent from silence, schedule, or Ava-side discretion.

1. **State the request in chat.** Paste this block and ask Craig to issue one HR2 token (for example: _"HR2 approve promote build `commit-short` with provenance sha `artifact-sha`"_):

   ```
   Promote deploy-bundle build <commit-short>
     provenance.commit = <commit>
     provenance.manifest_sha = <manifest_sha>
     provenance.lockfile_sha = <lockfile_sha>
     provenance.node_version = <node_version>
     provenance.artifact_sha = <artifact_sha>
   staging_smoke green at <timestamp>
   HR2 approve or refuse with verbatim token
   ```

2. **Receive the HR2 token verbatim.** No rewording, no paraphrase. Record the raw Craig message on the art card.
3. **Pre-flight guard.** Reconfirm all pre-promotion gates within the last 5 minutes (do not rely on stale state).
4. **Final backup.** Save the live runtime under `/root/backups/openclaw-pre-rework-<TIMESTAMP>/` plus a `sha256sum` manifest. Verify backup size > 0 and the tar extract succeeds against a scratch directory.
5. **Stop orphaned maintenance.** `pgrep -fa 'openclaw doctor' || true` MUST be empty. Terminate any leaks cleanly; never ahead of the live service stop.
6. **Stop the live service.** `systemctl --user stop openclaw.service`. Watch for `deactivating/stop-sigterm` — the long graceful drain is documented postmortem RC#5. If the drain exceeds `TimeoutStopSec=330`, kill the cgroup explicitly; do not let a half-stopped gateway remain.
7. **Swap runtime atomically.** `cp -a staging-tmp/` contents to `/usr/lib/node_modules/openclaw/`. The credential wrapper, `/root/.config/systemd/user/openclaw.service`, external plugin projects, and the database stay untouched — only the bundle tree moves.
8. **Restart.** `systemctl --user start openclaw.service`. Wait for `gateway ready` in `journalctl --user -u openclaw.service` — do **not** exceed `TimeoutStopSec=330` (postmortem RC#5 lesson).
9. **Startup-gate log scan.** Verify `/readyz` 200, `/healthz` 200, listener owned by the new `MainPID`, `NRestarts=0`. Grep the journal for `ERR_REQUIRE_ESM_RACE_CONDITION`, `ERR_MODULE_NOT_FOUND`, `plugin failed during load`. Grep for `control-ui-build-mismatch` and abort if present with a stale-client notification.
10. **Sampling schedule.** At t = 0, 2, 5, 10, 20, 30 minutes: log `MainPID`, `/readyz`, RSS, event-loop delay, plugin-load errors, queue depth, database-maintenance errors. Append each sample to `reports/deployments/<DATE>.md`.

## Acceptance (operator-observable)

Promotion is **healthy** only when:

- All ten sampling ticks record green (HTTP 200, RSS within normal band, no plugin errors, no DB maintenance degradation).
- One real `workboard.cards.list` invocation succeeds.
- One Codex plugin tool invocation completes a turn.
- The dashboard build id differs from the prior live build id only if the operator comms already announced the change.

Any single degradation immediately escalates to `Rin` for live review. If Rin flags a SEV-1/2 condition, execute the atomic rollback below WITHOUT waiting for HR2 — operator safety overrides HR2 cadence for SEV-1 or higher.

## Rollback (atomic revert, ≤24h retention)

The previous live build is preserved at the backup path until the new build has been healthy for **at least 24 hours**. Do not delete the backup before the 24h gate elapses.

```sh
# 1. Stop the live service (see RC#5 handling above).
systemctl --user stop openclaw.service || true

# 2. Atomic revert.
sudo rm -rf /usr/lib/node_modules/openclaw
sudo mv /root/backups/openclaw-pre-rework-<TIMESTAMP>/openclaw /usr/lib/node_modules/openclaw

# 3. Restart and verify.
systemctl --user start openclaw.service
journalctl --user -u openclaw.service -n 50 --no-pager | grep -q 'gateway ready'
curl -fsS http://127.0.0.1:18789/readyz
```

Rollback is permitted WITHOUT Craig approval only when Rin flags a SEV-1 or higher, or when the live service is in a `deactivating/stop-sigterm` loop blocking normal restarts. Document the reason on the art card immediately.

## Operator comms

- **Dashboard UI build change.** Send a `maintainer` notice telling operators to close old tabs and either hard-refresh or clear site data for `server.tailf97d51.ts.net`. The gateway intentionally rejects stale WebSocket clients with code 4008.
- **Plugin-load warnings.** If the live journal reports any `plugin failed during load` for plugins other than Workbench/Codex/ACPX, route to a follow-up card without blocking the promotion.
- **Plugin-load failure for Workbench/Codex/ACPX.** Treat as a Phase 1 import-closure gate failure; rollback is mandatory.

## BQES admission wiring

Per the design doc, any card that restarts the live service or writes to the runtime must cite the `gateway-build-deployment` and `pre-build-checklist` skills, and a rollback checkpoint must be recorded on the art card. Admission refuses cards without these references.

## Out of scope (explicit non-goals)

- Phase 1 build inputs.
- Phase 2 staging install.
- Post-9.6 custom-commit rework (separate PR series).
- Session-DB maintenance / RSS capacity (separate work-stream).

## Operator checklist (print + check off)

```
[ ] Provenance tuple verified
[ ] HR2 quote captured verbatim
[ ] Backup taken with checksums
[ ] No orphan doctor processes
[ ] Live service stopped cleanly (no long drain)
[ ] Bundle swapped atomically
[ ] Service restarted, gateway ready observed
[ ] /readyz + /healthz green
[ ] 0/2/5/10/20/30 sampling ticks recorded
[ ] Dashboard build id captured (and comms sent if changed)
[ ] Backup retained for ≥24h post-promotion
```
