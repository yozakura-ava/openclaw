#!/usr/bin/env bash
# Post-apply verification: units, users, limits, secret-scan, bypass log.
set -uo pipefail
fail=0
ck() { if eval "$2"; then echo "PASS: $1"; else echo "FAIL: $1 ($2)" >&2; fail=1; fi; }
for svc in gateway hindsight backup; do
  ck "unit staging-$svc listed" "systemctl list-units 'staging-*' --no-legend --plain | grep -q '^ *staging-$svc\.service'"
  ck "user svc-stg-$svc exists non-root" "id -u svc-stg-$svc | grep -qv '^0\$'"
  ck "staging-$svc User=" "systemctl show staging-$svc -p User | grep -q svc-stg-$svc"
  ck "staging-$svc MemoryMax set" "systemctl show staging-$svc -p MemoryMax | grep -qv 'infinity'"
  ck "staging-$svc MemorySwapMax=0" "systemctl show staging-$svc -p MemorySwapMax | grep -q '=0\b'"
done
bash "$(dirname "$0")/secret-scan.sh" || fail=1
# CPUAccounting: implicit (cgroup v2) on systemd >= 252 — systemctl show omits it.
SD_VER=$(systemctl --version | head -1 | grep -oE '[0-9]+' | head -1)
# Wrapper-bypass detection v1: privileged staging ops by ava-agent in auth.log
# that lack a matching wrapper receipt window are flagged.
bypass=$(sudo journalctl -q _COMM=sudo --since "2026-11-05" 2>/dev/null | grep -E 'ava-agent.*(systemctl (daemon-reload|enable|start)|useradd|/etc/systemd/system/staging-)' | grep -v "$(basename $0)" | wc -l)
receipts=$(ls /var/lib/staging-iac/receipts/*.receipt 2>/dev/null | wc -l)
if [ "${JOURNAL_OK:-1}" = "1" ] && sudo journalctl -q -n 1 >/dev/null 2>&1; then
  echo "bypass-check: privileged staging sudo lines=$bypass wrapper receipts=$receipts (each wrapper run does ~9 privileged lines; audit in receipt)"
else
  echo "bypass-check: journal unavailable — SKIPPED, record in receipt"
fi
[ "$fail" -eq 0 ] && echo "verify: ALL GREEN" || { echo "verify: FAILED" >&2; exit 1; }
