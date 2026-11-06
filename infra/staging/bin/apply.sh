#!/usr/bin/env bash
# Single-flight staging IaC apply with paired auto-revert (brick-avoidance).
# W2: units + users skeleton. W3: gateway payload — pinned artifact to /opt,
# node toolchain, staging-gateway restart, Tailscale Serve :443 (tailnet-only).
# Every privileged op batch records a receipt + revert BEFORE mutating.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RECEIPT_DIR=/var/lib/staging-iac/receipts
TS=$(date -u +%Y%m%dT%H%M%SZ)
LOCK=/var/lib/staging-iac/apply.lock
SRC_DIST="$HOME/staging/worktrees/openclaw-w1-reland/dist"
SUMS="$HOME/staging/w1.1-artifact/W1-DIST-SHA256SUMS.txt"
PIN=a33d0d7e5151f57be71120700cc6e73813a93e9f571b6b22643134df814c48f7
SUMS_PIN=27c23ea6009a796eaf2d37dd135203435d0672f1440bbf4c3560999232ebc3ca
NODE_SRC="$HOME/staging/toolchain/node-v24.22.2-linux-x64/bin/node"
OPT=/opt/ava-staging

sudo mkdir -p "$RECEIPT_DIR"
sudo chown ava-agent:ava-agent "$RECEIPT_DIR" || true
sudo touch "$LOCK"; sudo chown ava-agent:ava-agent "$LOCK" || true
exec 9>"$LOCK"
flock -n 9 || { echo "apply: another apply holds the lock — single-flight refuses" >&2; exit 2; }
RECEIPT="$RECEIPT_DIR/$TS-first-apply.receipt"
LOG="$RECEIPT_DIR/$TS-first-apply.log"
revert() {  # paired revert — W3 scope: gateway payload only. W2 skeleton
            # (hindsight/backup units, svc users) is NOT rolled back here;
            # the gateway skeleton unit is restorable from git main's apply.sh.
  echo "[revert] rolling back batch $TS" | tee -a "$LOG"
  sudo systemctl disable --now staging-gateway 2>>"$LOG" || true
  sudo rm -f /etc/systemd/system/staging-gateway.service 2>>"$LOG" || true
  sudo tailscale serve off 2>>"$LOG" || true
  sudo rm -rf "$OPT" 2>>"$LOG" || true
  sudo systemctl daemon-reload 2>>"$LOG" || true
  echo "[revert] batch $TS complete" | tee -a "$LOG"
}
trap 'ec=$?; [ $ec -ne 0 ] && revert; exit $ec' EXIT
{
  echo "receipt $TS user=$(id -un) branch=$(git -C "$ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null) commit=$(git -C "$ROOT" rev-parse HEAD 2>/dev/null)"
  echo "paired-revert: stop+rm staging-gateway, serve off, rm -rf /opt/ava-staging, daemon-reload (W2 users/hindsight/backup untouched)"
  echo "artifact: pin=$PIN source=$SRC_DIST sums=$(sha256sum "$SUMS" | cut -d" " -f1)"
} | sudo tee "$RECEIPT" >/dev/null

# --- W3 preflight: pinned-artifact gate, fail closed BEFORE any mutation
[ -f "$SRC_DIST/index.js" ] || { echo "apply: source dist missing: $SRC_DIST" >&2; exit 3; }
echo "$PIN  $SRC_DIST/index.js" | sha256sum -c - || { echo "apply: source dist hash mismatch vs W1 pin" >&2; exit 3; }
echo "$SUMS_PIN  $SUMS" | sha256sum -c - || { echo "apply: SUMS file sha mismatch vs W1.1 artifact-of-record pin" >&2; exit 3; }

# --- users (idempotent, W2)
for svc in gateway hindsight backup; do
  if ! id svc-stg-$svc >/dev/null 2>&1; then
    sudo useradd --system --shell /usr/sbin/nologin --home-dir /nonexistent svc-stg-$svc 2>&1 | tee -a "$LOG"
  fi
done

# --- W3 artifact + toolchain install (/opt, root-owned, read-only to services)
T0=$(date +%s)
sudo mkdir -p "$OPT/gateway/bin" "$OPT/toolchain/node-v24.22.2/bin"
sudo rm -rf "$OPT/gateway/dist"
sudo cp -a "$SRC_DIST" "$OPT/gateway/dist" 2>&1 | tee -a "$LOG"
sudo chown -R root:root "$OPT"
echo "$PIN  $OPT/gateway/dist/index.js" | sha256sum -c - || { echo "apply: /opt dist index.js hash mismatch" >&2; exit 4; }
sudo cp -a "$SUMS" "$OPT/gateway/W1-DIST-SHA256SUMS.installed.txt"
if ! ( cd "$OPT/gateway" && sudo sha256sum -c --quiet W1-DIST-SHA256SUMS.installed.txt ) 2>>"$LOG"; then
  echo "apply: full 21920-row SUMS verification FAILED" >&2; exit 4
fi
T1=$(date +%s); echo "artifact: 21920 files SUMS-verified in $((T1-T0))s" | tee -a "$LOG"
sudo install -m 0755 "$NODE_SRC" "$OPT/toolchain/node-v24.22.2/bin/node"
sudo -u svc-stg-gateway "$OPT/toolchain/node-v24.22.2/bin/node" --version 2>&1 | tee -a "$LOG" | grep -q 'v24.22.2' || { echo "apply: node toolchain check failed" >&2; exit 5; }
sudo install -m 0755 "$ROOT/bin/singleton-canary.sh" "$OPT/gateway/bin/singleton-canary.sh"

# --- W3 runtime dependency closure: dist bundles npm externals but keeps
# @openclaw/* workspace siblings external (production ships node_modules/@openclaw/*).
SRC_WT="$HOME/staging/worktrees/openclaw-w1-reland"
sudo rm -rf "$OPT/gateway/node_modules"
sudo mkdir -p "$OPT/gateway/node_modules"
sudo cp -aL "$SRC_WT/node_modules/@openclaw" "$OPT/gateway/node_modules/@openclaw" 2>&1 | tee -a "$LOG"
sudo cp -a "$SRC_WT/package.json" "$OPT/gateway/package.json"
sudo chown -R root:root "$OPT/gateway/node_modules" "$OPT/gateway/package.json"
sudo -u svc-stg-gateway test -f "$OPT/gateway/node_modules/@openclaw/fs-safe/package.json" || { echo "apply: closure resolve check failed" >&2; exit 6; }
( cd "$OPT/gateway/node_modules" && sudo find . -type f -exec sha256sum {} + | sort -k2 ) | sudo tee "$OPT/gateway/CLOSURE-SHA256SUMS.txt" >/dev/null
CLOSURE_SHA=$(sudo sha256sum "$OPT/gateway/CLOSURE-SHA256SUMS.txt" | cut -d" " -f1)
CLOSURE_N=$(sudo find "$OPT/gateway/node_modules" -type f | wc -l)
echo "closure: $CLOSURE_N files manifest-sha=$CLOSURE_SHA" | tee -a "$LOG"

# --- pre-restart smoke gate: full module graph must load as the service user
SMOKE_OUT=$(sudo -u svc-stg-gateway "$OPT/toolchain/node-v24.22.2/bin/node" "$OPT/gateway/dist/index.js" --version 2>&1 | tee -a "$LOG")
echo "$SMOKE_OUT" | grep -q "2026.11.1" || { echo "apply: /opt smoke gate FAILED: $SMOKE_OUT" >&2; exit 7; }
echo "smoke: $SMOKE_OUT" | tee -a "$LOG"

# --- units (W2 loop, unchanged for hindsight/backup)
for svc in gateway hindsight backup; do
  sudo install -m 0644 "$ROOT/units/staging-$svc.service" "/etc/systemd/system/staging-$svc.service" 2>&1 | tee -a "$LOG"
done
sudo systemctl daemon-reload 2>&1 | tee -a "$LOG"
for svc in hindsight backup; do
  sudo systemctl enable --now staging-$svc 2>&1 | tee -a "$LOG"   # skeletons stay oneshot
done
sudo systemctl enable staging-gateway 2>&1 | tee -a "$LOG"
sudo systemctl restart staging-gateway 2>&1 | tee -a "$LOG"        # oneshot skeleton -> live payload

# --- dashboard via Tailscale Serve :443 (tailnet-only; NOT Funnel; no ACL edits)
sudo tailscale serve --bg 18800 2>&1 | tee -a "$LOG"

# --- wait for first-boot canary state before verifying
for i in $(seq 1 60); do
  [ -f /var/lib/ava-staging/gateway/canary/singleton.state ] && break
  sleep 3
done

bash "$ROOT/bin/verify.sh" 2>&1 | tee -a "$LOG"
trap - EXIT
echo "apply: OK — receipt $RECEIPT"
