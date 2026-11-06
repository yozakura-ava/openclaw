#!/usr/bin/env bash
# Scoped static tests (HR5). LIVE=1 adds host checks via verify.sh.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fail=0
t() { if eval "$2"; then echo "ok - $1"; else echo "NOT OK - $1" >&2; fail=1; fi; }
for svc in gateway hindsight backup; do
  t "unit file exists: $svc" "test -f '$ROOT/units/staging-$svc.service'"
  t "dedicated user: $svc" "grep -q '^User=svc-stg-$svc' '$ROOT/units/staging-$svc.service'"
  t "memory limit: $svc" "grep -q '^MemoryMax=' '$ROOT/units/staging-$svc.service'"
  t "swap zero: $svc" "grep -q '^MemorySwapMax=0' '$ROOT/units/staging-$svc.service'"
  t "cpu accounting: $svc" "grep -q '^CPUAccounting=yes' '$ROOT/units/staging-$svc.service'"  # implicit at runtime on systemd >=252
  t "hardening: $svc" "grep -q '^NoNewPrivileges=yes' '$ROOT/units/staging-$svc.service'"
  t "no root user: $svc" "! grep -q '^User=root' '$ROOT/units/staging-$svc.service'"
done
t "manifest roster complete" "grep -c 'name: staging-' '$ROOT/manifest.yml' | grep -q 3"
t "secret-scan green" "bash '$ROOT/bin/secret-scan.sh'"
t "apply.sh single-flight flock" "grep -q 'flock -n' '$ROOT/bin/apply.sh'"
t "apply.sh paired revert" "grep -q 'revert()' '$ROOT/bin/apply.sh'"
t "verify.sh bypass detection" "grep -q 'bypass' '$ROOT/bin/verify.sh'"
t "no :latest tags" "! grep -rn ':latest' '$ROOT' --include='*.yml' --include='*.service'"
if [ "${LIVE:-0}" = "1" ]; then bash "$ROOT/bin/verify.sh" || fail=1; fi
[ $fail -eq 0 ] && echo "test_staging_iac: ALL PASS" || { echo "test_staging_iac: FAILED" >&2; exit 1; }
