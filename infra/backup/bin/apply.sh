#!/usr/bin/env bash
# W5 — single-flight backup pipeline with paired revert + receipts, following
# the infra/staging/bin/apply.sh pattern (read as pattern reference, not
# modified by this card).
#
# Pipeline: snapshot -> encrypt (SecretRef backup key) -> verify snapshot
#   -> [ --drill-local ] restore rehearsal (local) -> verify drill.
# The XEON drill is NOT executed from ava-primary: this script prints the
# exact command to run ON the xeon gateway host (drill execution is
# orchestrator-owned; this builder never touches xeon state).
#
# Every batch records a receipt BEFORE mutating; on any stage failure the
# paired revert removes ONLY the artifacts this run created (in-flight
# snapshot, archive, rehearsal), keeps the receipt marked failed.
#
# Usage:
#   apply.sh [--root DIR] [--label TEXT] [--no-encrypt] [--drill-local]
# Env: AVA_BACKUP_ROOT (default /var/backups/ava-staging)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_ROOT="${AVA_BACKUP_ROOT:-/var/backups/ava-staging}"
LABEL=""
DO_ENCRYPT=true
DO_DRILL=false

die() { echo "apply: $1" >&2; exit "${2:-1}"; }
usage() { sed -n '/^# Usage:/,/^set -euo/p' "$0" | sed 's/^# \{0,1\}//' | head -n -1; exit 0; }

while [ $# -gt 0 ]; do
  case "$1" in
    --root) BACKUP_ROOT=$2; shift 2;;
    --label) LABEL=$2; shift 2;;
    --no-encrypt) DO_ENCRYPT=false; shift;;
    --drill-local) DO_DRILL=true; shift;;
    -h|--help) usage;;
    *) die "unknown argument: $1 (see --help)";;
  esac
done

TS=$(date -u +%Y%m%dT%H%M%SZ)
RECEIPT_DIR="$BACKUP_ROOT/receipts"
ARCHIVE_DIR="$BACKUP_ROOT/archives"
REHEARSAL_ROOT="$BACKUP_ROOT/rehearsals"
LOCK="$BACKUP_ROOT/apply.lock"
RECEIPT="$RECEIPT_DIR/$TS-w5-apply.receipt"
LOG="$RECEIPT_DIR/$TS-w5-apply.log"

SNAP_DIR=""
ARCHIVE=""
ARCHIVE_META=""
REHEARSAL=""

mkdir -p "$BACKUP_ROOT" "$RECEIPT_DIR" "$ARCHIVE_DIR" "$REHEARSAL_ROOT" 2>/dev/null \
  || die "backup root not creatable: $BACKUP_ROOT — run privileged or pass --root <dir>" 3

exec 9>"$LOCK"
flock -n 9 || { echo "apply: another apply holds the lock — single-flight refuses" >&2; exit 2; }

# paired revert — remove ONLY artifacts this batch created
revert() {
  echo "[revert] rolling back batch $TS" | tee -a "$LOG"
  if [ -d "$REHEARSAL" ]; then rm -rf "$REHEARSAL"; fi
  if [ -n "$ARCHIVE" ]; then rm -f "$ARCHIVE"; fi
  if [ -n "$ARCHIVE_META" ]; then rm -f "$ARCHIVE_META"; fi
  if [ -d "$SNAP_DIR" ]; then rm -rf "$SNAP_DIR"; fi
  echo "[revert] batch $TS complete (receipts/logs kept)" | tee -a "$LOG"
}
trap 'ec=$?; [ $ec -ne 0 ] && revert; echo "status: FAILED" >> "$RECEIPT" 2>/dev/null || true; exit $ec' EXIT

{
  echo "receipt $TS user=$(id -un) host=$(hostname) label=$LABEL branch=$(git -C "$ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null) commit=$(git -C "$ROOT" rev-parse HEAD 2>/dev/null)"
  echo "paired-revert: rm -rf rehearsal/ + rm archive + rm snapshot dir created by THIS batch (receipts/logs kept)"
  echo "plan: snapshot -> encrypt(SecretRef backup key) -> verify snapshot$( [ "$DO_DRILL" = true ] && echo ' -> restore rehearsal local -> verify drill' )"
  echo "note: xeon drill is orchestrator-owned; this pipeline only prints the xeon-side command"
} | tee "$RECEIPT" > "$LOG"

log() { echo "[$(date -u +%H:%M:%SZ)] $*" | tee -a "$LOG" >&2; }

# --- stage 1: snapshot
log "stage 1/4: snapshot"
SNAP_DIR=$(bash "$ROOT/bin/snapshot.sh" --root "$BACKUP_ROOT" --label "$LABEL")
SNAP_ID=$(basename "$SNAP_DIR")
log "snapshot: $SNAP_DIR"
echo "snapshot: $SNAP_DIR" >> "$RECEIPT"

# --- stage 2: encrypt
if [ "$DO_ENCRYPT" = true ]; then
  log "stage 2/4: encrypt"
  if command -v zstd >/dev/null 2>&1 && tar --zstd --version >/dev/null 2>&1; then EXT=".tar.zst.enc"; else EXT=".tar.gz.enc"; fi
  ARCHIVE="$ARCHIVE_DIR/$SNAP_ID$EXT"
  ARCHIVE_META="$ARCHIVE.meta.json"
  ENC_OUT=$(bash "$ROOT/bin/encrypt.sh" --snapshot "$SNAP_DIR" --out "$ARCHIVE" | tee -a "$LOG")
  log "$ENC_OUT"
  echo "archive: $ARCHIVE" >> "$RECEIPT"
  bash "$ROOT/bin/verify.sh" --archive "$ARCHIVE" --meta "$ARCHIVE_META" | tee -a "$LOG"
else
  log "stage 2/4: skipped (--no-encrypt)"
fi

# --- stage 3: verify snapshot
log "stage 3/4: verify snapshot"
bash "$ROOT/bin/verify.sh" --snapshot "$SNAP_DIR" | tee -a "$LOG"

# --- stage 4: local restore rehearsal (optional)
if [ "$DO_DRILL" = true ]; then
  log "stage 4/4: restore rehearsal (local)"
  REHEARSAL="$REHEARSAL_ROOT/$SNAP_ID"
  RST_OUT=$(bash "$ROOT/bin/restore.sh" --archive "$ARCHIVE" --meta "$ARCHIVE_META" --target "$REHEARSAL" | tee -a "$LOG")
  log "rehearsal: $RST_OUT"
  bash "$ROOT/bin/verify.sh" --drill "$REHEARSAL" | tee -a "$LOG"
  echo "rehearsal: $REHEARSAL" >> "$RECEIPT"
else
  log "stage 4/4: skipped (pass --drill-local to rehearse on this host)"
fi

# --- xeon drill handoff line (orchestrator-owned execution)
if [ "$DO_ENCRYPT" = true ]; then
  cat <<EOF | tee -a "$LOG" >&2
xeon-drill (run ON the xeon gateway host, orchestrator-owned):
  infra/backup/bin/restore.sh --mode xeon-drill --remote ava-harness \
    --remote-archive "$ARCHIVE"
  (pulls over the tailnet; rehearsed under /root/backups/ava-primary-drills/$SNAP_ID/)
EOF
  echo "xeon_drill_command: restore.sh --mode xeon-drill --remote ava-harness --remote-archive $ARCHIVE" >> "$RECEIPT"
fi

trap - EXIT
echo "status: OK" >> "$RECEIPT"
echo "apply: OK — receipt $RECEIPT"
