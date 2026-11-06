#!/usr/bin/env bash
# W4 hindsight payload apply — single-flight with paired auto-revert.
# Deploys the import adapter payload to /opt/ava-staging/hindsight and
# upgrades the staging-hindsight unit (skeleton /bin/true -> adapter verify).
# PRESERVES W2 pins: User/Group svc-stg-hindsight, MemoryMax=4G, MemorySwapMax=0.
# Every privileged op batch records a receipt + revert BEFORE mutating.
# Never touches staging-gateway; asserts it is still active at the end.
set -euo pipefail

TS=$(date -u +%Y%m%dT%H%M%SZ)
RECEIPT_DIR=/var/lib/staging-iac/receipts
LOG_DIR=/var/lib/staging-iac/logs
LOG="$LOG_DIR/w4-hindsight-$TS.log"
DEST=/opt/ava-staging/hindsight
UNIT_DST=/etc/systemd/system/staging-hindsight.service
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PKG_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"            # infra/hindsight
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"             # repo root (3 levels: bin->hindsight->infra->root)
UNIT_SRC="$REPO_ROOT/infra/staging/units/staging-hindsight.service"

mkdir -p "$RECEIPT_DIR" "$LOG_DIR"
exec 9>/var/lib/staging-iac/locks/w4-hindsight.lock
flock -n 9 || { echo "apply: another hindsight apply is in flight" >&2; exit 1; }

receipt() { # receipt <name> <text>
  printf 'receipt %s op=%s: %s\n' "$TS" "$1" "$2" | sudo tee "$RECEIPT_DIR/$TS-$1.receipt" >/dev/null
  echo "receipt: $TS-$1"
}

revert_needed=0
payload_bak=""; unit_bak=""
revert() {
  if [ "$revert_needed" -eq 1 ]; then
    echo "[revert] rolling back W4 hindsight batch $TS" | tee -a "$LOG"
    [ -n "$unit_bak" ]  && sudo cp "$unit_bak" "$UNIT_DST" 2>>"$LOG"
    if [ -n "$payload_bak" ] && [ -d "$payload_bak" ]; then
      sudo rm -rf "$DEST" 2>>"$LOG" || true
      sudo mv "$payload_bak" "$DEST" 2>>"$LOG"
    fi
    sudo systemctl daemon-reload 2>>"$LOG" || true
    sudo systemctl restart staging-hindsight 2>>"$LOG" || true
    receipt "w4-hindsight-revert" "paired auto-revert executed for batch $TS"
  fi
}
trap revert ERR

echo "[1/4] payload deploy -> $DEST" | tee -a "$LOG"
test -f "$PKG_ROOT/adapter/config.json"
test -f "$PKG_ROOT/bin/verify.sh"
test -f "$UNIT_SRC"
if sudo test -d "$DEST"; then
  payload_bak="$DEST.bak-$TS"
  sudo mv "$DEST" "$payload_bak"
  revert_needed=1
fi
sudo mkdir -p "$DEST"
sudo cp -a "$PKG_ROOT/adapter" "$DEST/adapter"
sudo mkdir -p "$DEST/bin"
sudo cp -a "$PKG_ROOT/bin/verify.sh" "$DEST/bin/verify.sh"
sudo cp -a "$PKG_ROOT/README.md" "$DEST/README.md"
sudo chown -R root:root "$DEST"
sudo chmod -R a+rX "$DEST"
sudo chmod 755 "$DEST/bin/verify.sh"
revert_needed=1
receipt "w4-hindsight-payload" "adapter payload deployed to $DEST (adapter/, bin/verify.sh, README.md)"

echo "[2/4] unit upgrade (W2 pins preserved)" | tee -a "$LOG"
if sudo test -f "$UNIT_DST"; then
  unit_bak="$UNIT_DST.bak-$TS"
  sudo cp "$UNIT_DST" "$unit_bak"
fi
sudo cp "$UNIT_SRC" "$UNIT_DST"
sudo systemctl daemon-reload
sudo systemctl restart staging-hindsight
receipt "w4-hindsight-unit" "unit upgraded to W4 adapter-verify oneshot; W2 pins preserved (svc-stg-hindsight, MemoryMax=4G, MemorySwapMax=0)"

echo "[3/4] health checks" | tee -a "$LOG"
state=$(systemctl is-active staging-hindsight)
[ "$state" = "active" ] || { echo "verify: staging-hindsight not active ($state)" >&2; exit 1; }
echo "PASS: unit active ($state)"
result_state=$(systemctl show -p Result --value staging-hindsight)
[ "$result_state" = "success" ] || { echo "verify: unit Result=$result_state" >&2; exit 1; }
echo "PASS: unit Result=success"
sudo -u svc-stg-hindsight env PYTHONDONTWRITEBYTECODE=1 "$DEST/bin/verify.sh" | tee -a "$LOG"

echo "[4/4] staging-gateway interference check" | tee -a "$LOG"
gw=$(systemctl is-active staging-gateway)
[ "$gw" = "active" ] || { echo "verify: staging-gateway unexpectedly inactive ($gw)" >&2; exit 1; }
echo "PASS: staging-gateway untouched and active"
receipt "w4-hindsight-apply" "W4 hindsight apply complete: payload + unit + health green; gateway active"

trap - ERR
echo "apply: ALL GREEN (batch $TS)"
