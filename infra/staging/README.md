# Staging IaC skeleton (Ava vNext harness — W2)

Staging environment infrastructure-as-code for ava-primary. Skeleton landed in W2;
service payloads land in W3 (gateway boot), W4 (Hindsight), W5 (backup).

## Isolation model (binding, spec v0.3 + Tailscale annex)
- Credential ABSENCE is the primary isolation: staging holds ZERO production
  channel/broker credentials. Secrets never live in this tree — SecretRef only.
- Per-service dedicated non-root Unix users (svc-stg-*), no login shell, no sudo.
- Staging Tailscale tag is deny-by-default toward production principals (ACLs are
  owner-managed; this repo never touches firewall/ACL state).
- No `:latest` tags anywhere; all versions pinned.

## Layout
- manifest.yml        — service roster: users, resource limits (source of truth)
- units/*.service     — systemd unit files (skeleton: ExecStart=/bin/true + RemainAfterExit)
- bin/apply.sh        — single-flight privileged apply with paired auto-revert
- bin/verify.sh       — post-apply live verification
- bin/secret-scan.sh  — secret pattern scan (gate: must exit 0)
- tests/              — scoped static + live tests (HR5)

## Applying
All privileged changes go through `bash infra/staging/bin/apply.sh` — direct
systemctl/useradd/unit-file writes outside the wrapper are logged as bypass
incidents by verify.sh (council Nora, 2026-11-05). Every first apply writes a
receipt with the paired revert under /var/lib/staging-iac/receipts/.
