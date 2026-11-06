#!/usr/bin/env bash
# Single-flight staging IaC apply with paired auto-revert (brick-avoidance).
# Usage: sudo-less from ava-agent (passwordless sudo per Phase2 elevation conf).
# Every privileged op batch records a receipt + revert BEFORE mutating.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RECEIPT_DIR=/var/lib/staging-iac/receipts
TS=$(date -u +%Y%m%dT%H%M%SZ)
LOCK=/var/lib/staging-iac/apply.lock
sudo mkdir -p "$RECEIPT_DIR"
sudo chown ava-agent:ava-agent "$RECEIPT_DIR" || true
sudo touch "$LOCK"; sudo chown ava-agent:ava-agent "$LOCK" || true
exec 9>"$LOCK"
flock -n 9 || { echo "apply: another apply holds the lock — single-flight refuses" >&2; exit 2; }
RECEIPT="$RECEIPT_DIR/$TS-first-apply.receipt"
LOG="$RECEIPT_DIR/$TS-first-apply.log"
revert() {  # paired revert — runs on failure
  echo "[revert] rolling back batch $TS" | tee -a "$LOG"
  for svc in gateway hindsight backup; do
    sudo systemctl disable --now staging-$svc 2>>"$LOG" || true
    sudo rm -f "/etc/systemd/system/staging-$svc.service" 2>>"$LOG" || true
    sudo userdel svc-stg-$svc 2>>"$LOG" || true
  done
  sudo systemctl daemon-reload 2>>"$LOG" || true
  echo "[revert] batch $TS complete" | tee -a "$LOG"
}
trap 'ec=$?; [ $ec -ne 0 ] && revert; exit $ec' EXIT
{
  echo "receipt $TS user=$(id -un) branch=$(git -C "$ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null) commit=$(git -C "$ROOT" rev-parse HEAD 2>/dev/null)"
  echo "paired-revert: stop+rm units x3, userdel x3, daemon-reload (see revert() in this script)"
} | sudo tee "$RECEIPT" >/dev/null
for svc in gateway hindsight backup; do
  if ! id svc-stg-$svc >/dev/null 2>&1; then
    sudo useradd --system --shell /usr/sbin/nologin --home-dir /nonexistent svc-stg-$svc 2>&1 | tee -a "$LOG"
  fi
  sudo install -m 0644 "$ROOT/units/staging-$svc.service" "/etc/systemd/system/staging-$svc.service" 2>&1 | tee -a "$LOG"
done
sudo systemctl daemon-reload 2>&1 | tee -a "$LOG"
for svc in gateway hindsight backup; do
  sudo systemctl enable --now staging-$svc 2>&1 | tee -a "$LOG"   # oneshot /bin/true + RemainAfterExit
done
bash "$ROOT/bin/verify.sh" 2>&1 | tee -a "$LOG"
trap - EXIT
echo "apply: OK — receipt $RECEIPT"
