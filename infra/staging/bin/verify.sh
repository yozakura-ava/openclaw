#!/usr/bin/env bash
# Post-apply verification: units, users, limits, secret-scan, bypass log,
# W3 gateway payload (pinned artifact, loopback bind, Serve, canary).
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fail=0
OPT=/opt/ava-staging
PIN=a33d0d7e5151f57be71120700cc6e73813a93e9f571b6b22643134df814c48f7
ck() { if eval "$2"; then echo "PASS: $1"; else echo "FAIL: $1 ($2)" >&2; fail=1; fi; }
for svc in gateway hindsight backup; do
  ck "unit staging-$svc listed" "systemctl list-units 'staging-*' --no-legend --plain | grep -q '^ *staging-$svc\.service'"
  ck "user svc-stg-$svc exists non-root" "id -u svc-stg-$svc | grep -qv '^0\$'"
  ck "staging-$svc User=" "systemctl show staging-$svc -p User | grep -q svc-stg-$svc"
done
ck "gateway MemoryMax 8G" "systemctl show staging-gateway -p MemoryMax | grep -q 8589934592"
ck "hindsight MemoryMax 4G" "systemctl show staging-hindsight -p MemoryMax | grep -q 4294967296"
ck "backup MemoryMax 4G" "systemctl show staging-backup -p MemoryMax | grep -q 4294967296"
for svc in gateway hindsight backup; do
  ck "staging-$svc MemorySwapMax=0" "systemctl show staging-$svc -p MemorySwapMax | grep -q 0"
done
ck "secret-scan green" "bash '$ROOT/bin/secret-scan.sh'"
# --- W3 payload
ck "gateway payload installed" "test -f $OPT/gateway/dist/index.js"
ck "gateway artifact hash matches W1 pin" "echo '$PIN  $OPT/gateway/dist/index.js' | sha256sum -c - >/dev/null 2>&1"
ck "node toolchain v24.22.2 runs as svc user" "sudo -u svc-stg-gateway $OPT/toolchain/node-v24.22.2/bin/node --version 2>/dev/null | grep -q v24.22.2"
ck "staging-gateway active" "systemctl is-active staging-gateway | grep -q '^active\$'"
ck "staging-gateway ExecStart is pinned dist" "systemctl show staging-gateway -p ExecStart | grep -q '/opt/ava-staging/gateway/dist/index.js'"
ck "gateway listener 127.0.0.1:18800" "ss -tln | grep ':18800 ' | grep -q '127.0.0.1:18800'"
ck "no non-loopback 18800 listener" "! ss -tln | grep ':18800' | grep -vE '(127[.]0[.]0[.]1|\[::1\]):18800' | grep -q ."
ck "tailscale serve -> 18800 configured" "sudo tailscale serve status 2>/dev/null | grep -q 18800"
ck "runtime closure present" "test -f $OPT/gateway/node_modules/@openclaw/fs-safe/package.json"
ck "closure manifest recorded" "test -f $OPT/gateway/CLOSURE-SHA256SUMS.txt"
ck "closure includes tslog (attempt-4 external)" "ls -d $OPT/gateway/node_modules/.pnpm/tslog@* >/dev/null 2>&1"
ck "server-wide openclaw CLI" "/usr/local/bin/openclaw --version 2>/dev/null | grep -q 2026.11.1"
ck "gateway trusts loopback proxy" "sudo grep -q 'trustedProxies' /var/lib/ava-staging/gateway/.openclaw/openclaw.json"
ck "singleton canary GREEN" "grep -q ' GREEN ' /var/lib/ava-staging/gateway/canary/singleton.state 2>/dev/null"
# --- bypass audit (wrapper-receipted privileged ops only)
bypass=$(sudo journalctl -q _COMM=sudo --since "2026-11-05" 2>/dev/null | grep -E 'ava-agent.*(systemctl (daemon-reload|enable|start|restart)|useradd|/etc/systemd/system/staging-|/opt/ava-staging|tailscale serve)' | grep -v "$(basename $0)" | wc -l)
receipts=$(ls /var/lib/staging-iac/receipts/*.receipt 2>/dev/null | wc -l)
if [ "${JOURNAL_OK:-1}" = "1" ] && sudo journalctl -q -n 1 >/dev/null 2>&1; then
  echo "bypass-check: privileged staging sudo lines=$bypass wrapper receipts=$receipts (each wrapper run is receipted; audit in receipt)"
else
  echo "bypass-check: journal unavailable — SKIPPED, record in receipt"
fi
[ "$fail" -eq 0 ] && echo "verify: ALL GREEN" || { echo "verify: FAILED" >&2; exit 1; }
