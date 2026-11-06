#!/usr/bin/env bash
# W5 backup drill machinery — consistent snapshot of ava-staging state.
# Card 6b277b28 (infra/backup). Spec: canonical v0.3 WP-02 — consistent
# snapshot-based extraction + census generated FROM THE SAME snapshot
# (re-census diff must be 0) + live-SQL COUNT verification data.
#
# A finalized snapshot dir $BACKUP_ROOT/<snap-id>/ contains:
#   state/         copy of the gateway state dir (.openclaw; includes the
#                  memory index / LanceDB / embedding cache when present)
#   workspace/     copy of the gateway workspace (omitted when absent)
#   SNAPSHOT.json  metadata — NO secrets (sources, census sha, sqlite row
#                  counts, tool versions, memory index paths)
#   census.tsv     "#census-v1" + rows "<sha256>\t<size>\t<path>" covering
#                  state/ + workspace/ (the data payload only)
#
# Credential policy: this layer handles NO credentials. The snapshot is
# plaintext on the snapshot root (root/service-owned area); encryption with a
# dedicated backup key (SecretRef-only) is encrypt.sh's job.
#
# Single-flight via flock; paired revert removes ONLY this run's in-flight
# dir on failure (receipts are kept for audit); atomic finalize via rename.
#
# Usage:
#   snapshot.sh [--state-dir DIR] [--workspace DIR] [--root DIR]
#               [--label TEXT] [-h|--help]
# Env overrides: AVA_BACKUP_STATE_DIR AVA_BACKUP_ROOT AVA_BACKUP_WORKSPACE
set -euo pipefail

STATE_DIR="${AVA_BACKUP_STATE_DIR:-/var/lib/ava-staging/gateway/.openclaw}"
BACKUP_ROOT="${AVA_BACKUP_ROOT:-/var/backups/ava-staging}"
WORKSPACE_ARG="${AVA_BACKUP_WORKSPACE:-}"
LABEL=""

die() { echo "snapshot: $*" >&2; exit "${2:-1}"; }
usage() { sed -n '/^# Usage:/,/^set -euo/p' "$0" | sed 's/^# \{0,1\}//' | head -n -1; exit 0; }

while [ $# -gt 0 ]; do
  case "$1" in
    --state-dir) STATE_DIR=$2; shift 2;;
    --workspace) WORKSPACE_ARG=$2; shift 2;;
    --root) BACKUP_ROOT=$2; shift 2;;
    --label) LABEL=$2; shift 2;;
    -h|--help) usage;;
    *) die "unknown argument: $1 (see --help)";;
  esac
done

command -v rsync >/dev/null || die "rsync not found"
command -v sha256sum >/dev/null || die "sha256sum not found"
command -v flock >/dev/null || die "flock not found"

TS=$(date -u +%Y%m%dT%H%M%SZ)
SNAP_ID="snap-$TS"
RECEIPT_DIR="$BACKUP_ROOT/receipts"
LOCK="$BACKUP_ROOT/.snapshot.lock"
WORK="$BACKUP_ROOT/.inflight-snapshot-$TS"
RECEIPT="$RECEIPT_DIR/$TS-snapshot.receipt"
LOG="$RECEIPT_DIR/$TS-snapshot.log"
DEST="$BACKUP_ROOT/$SNAP_ID"

mkdir -p "$BACKUP_ROOT" "$RECEIPT_DIR" 2>/dev/null \
  || die "backup root not creatable: $BACKUP_ROOT — run privileged or pass --root <dir>" 3

exec 9>"$LOCK"
flock -n 9 || { echo "snapshot: another snapshot/apply holds the lock — single-flight refuses" >&2; exit 2; }

# paired revert — remove ONLY this run's in-flight dir; keep receipt for audit
revert() {
  echo "[revert] discarding in-flight snapshot $WORK" | tee -a "$LOG" >&2 || true
  [ -d "$WORK" ] && rm -rf "$WORK"
  echo "status: FAILED" >> "$RECEIPT" 2>/dev/null || true
}
trap 'ec=$?; [ $ec -ne 0 ] && revert; exit $ec' EXIT

# preflight — fail closed BEFORE any mutation
[ -d "$STATE_DIR" ] || die "state dir missing: $STATE_DIR" 3
[ -r "$STATE_DIR" ] || die "state dir not readable by $(id -un): $STATE_DIR — run under root / the staging-backup service context (fail-closed; no partial snapshot)" 3
[ -w "$BACKUP_ROOT" ] || die "backup root not writable by $(id -un): $BACKUP_ROOT" 3

mkdir -p "$WORK"
log() { echo "[$(date -u +%H:%M:%SZ)] $*" | tee -a "$LOG" >&2; }  # stdout stays reserved for the final snapshot path

{
  echo "receipt $TS user=$(id -un) host=$(hostname) label=$LABEL"
  echo "sources: state=$STATE_DIR workspace=${WORKSPACE_ARG:-<auto-detect>}"
  echo "paired-revert: rm -rf $WORK (in-flight only; finalized snapshots are never touched)"
  echo "plan: rsync state+workspace -> sqlite .backup pass -> census FROM SNAPSHOT -> re-census diff=0 gate -> atomic finalize"
} >> "$RECEIPT"

# --- workspace auto-detect: openclaw.json gateway.workspace, else state/workspace
WORKSPACE=""
if [ -n "$WORKSPACE_ARG" ]; then
  WORKSPACE=$WORKSPACE_ARG
elif [ -r "$STATE_DIR/openclaw.json" ]; then
  WORKSPACE=$(python3 - "$STATE_DIR/openclaw.json" <<'PY' 2>>"$LOG" || true
import json, sys
try:
    cfg = json.load(open(sys.argv[1]))
    ws = (cfg.get("gateway") or {}).get("workspace") or ""
    print(ws if isinstance(ws, str) else "")
except Exception:
    print("")
PY
)
fi
[ -n "$WORKSPACE" ] || WORKSPACE="$STATE_DIR/workspace"
WORKSPACE_PRESENT=false
if [ -d "$WORKSPACE" ]; then WORKSPACE_PRESENT=true; else
  log "WARN: workspace dir absent — recorded as absent: $WORKSPACE"
fi

# --- consistent extraction
log "rsync state -> $WORK/state"
mkdir -p "$WORK/state" "$WORK/workspace"
rsync -a --numeric-ids "$STATE_DIR/" "$WORK/state/" 2>>"$LOG" || die "rsync state failed (partial copy discarded)" 4
if [ "$WORKSPACE_PRESENT" = true ]; then
  log "rsync workspace -> $WORK/workspace"
  rsync -a --numeric-ids "$WORKSPACE/" "$WORK/workspace/" 2>>"$LOG" || die "rsync workspace failed" 4
else
  rmdir "$WORK/workspace" 2>/dev/null || true
fi

# --- sqlite consistency pass: replace rsynced live copies with .backup copies
# (python3 stdlib sqlite3 backup API — the sqlite3 CLI is not assumed on-box)
SQLITE_META=$(python3 - "$WORK" <<'PY' 2>>"$LOG" || die "sqlite consistency pass failed" 4
import json, os, sqlite3, sys
root = sys.argv[1]
consistent = plain = 0
warns = []
for sub in ("state", "workspace"):
    base = os.path.join(root, sub)
    if not os.path.isdir(base):
        continue
    for dirpath, _dirs, files in os.walk(base):
        for name in files:
            if not name.endswith((".sqlite", ".sqlite3", ".db")):
                continue
            p = os.path.join(dirpath, name)
            try:
                with open(p, "rb") as fh:
                    if fh.read(16) != b"SQLite format 3\x00":
                        continue
            except OSError:
                continue
            tmp = p + ".w5backup"
            try:
                src = sqlite3.connect(p)
                dst = sqlite3.connect(tmp)
                with dst:
                    src.backup(dst)
                src.close()
                dst.close()
                os.replace(tmp, p)
                for ext in ("-wal", "-shm"):
                    try:
                        os.remove(p + ext)
                    except FileNotFoundError:
                        pass
                consistent += 1
            except Exception as e:
                for cand in (tmp, tmp + "-wal", tmp + "-shm"):
                    try:
                        if os.path.exists(cand):
                            os.remove(cand)
                    except OSError:
                        pass
                plain += 1
                warns.append({"file": os.path.relpath(p, root), "error": str(e)[:120]})
print(json.dumps({"consistent": consistent, "plain": plain, "warnings": warns}, sort_keys=True))
PY
)
SQLITE_CONSISTENT=$(printf '%s' "$SQLITE_META" | python3 -c 'import json,sys; print(json.load(sys.stdin)["consistent"])')
SQLITE_PLAIN=$(printf '%s' "$SQLITE_META" | python3 -c 'import json,sys; print(json.load(sys.stdin)["plain"])')
SQLITE_WARNS=$(printf '%s' "$SQLITE_META" | python3 -c 'import json,sys; print(" ".join(w["file"] for w in json.load(sys.stdin)["warnings"]))')
[ -z "$SQLITE_WARNS" ] || log "WARN: sqlite .backup failed, kept rsynced copy: $SQLITE_WARNS"

# --- memory index detection (LanceDB / embedding cache under the state dir)
MEMORY_INDEX=$(find "$WORK/state" -type d \( -name '*.lance' -o -iname '*lancedb*' -o -iname '*embedding*' -o -iname '*memories*' \) 2>/dev/null \
  | sed "s|^$WORK/||" | LC_ALL=C sort | head -50 | tr '\n' ' ')

# --- live-SQL COUNT verification data (WP-02): per-table row counts, no secrets
COUNTS_JSON=$(python3 - "$WORK" <<'PY' 2>>"$LOG" || die "live-SQL COUNT pass failed" 4
import json, os, sqlite3, sys
root = sys.argv[1]
out = {}
for sub in ("state", "workspace"):
    base = os.path.join(root, sub)
    if not os.path.isdir(base):
        continue
    for dirpath, _dirs, files in os.walk(base):
        for name in files:
            if not name.endswith((".sqlite", ".sqlite3", ".db")):
                continue
            p = os.path.join(dirpath, name)
            rel = os.path.relpath(p, root)
            try:
                with open(p, "rb") as fh:
                    if fh.read(16) != b"SQLite format 3\x00":
                        continue
                con = sqlite3.connect(f"file:{p}?mode=ro", uri=True)
                tables = [r[0] for r in con.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
                counts = {}
                for t in tables[:40]:
                    try:
                        counts[t] = int(con.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0])
                    except sqlite3.Error:
                        counts[t] = "error"
                con.close()
                out[rel] = counts
            except Exception as e:
                out[rel] = {"error": str(e)[:120]}
print(json.dumps(out, sort_keys=True))
PY
)

# --- census manifest generated FROM THE SAME snapshot (payload dirs only)
census_generate() { # $1 = snapshot root; stdout = deterministic census stream
  local d
  echo "#census-v1"
  for d in state workspace; do
    [ -d "$1/$d" ] || continue
    ( cd "$1" && LC_ALL=C find "$d" -type f 2>/dev/null | LC_ALL=C sort | while IFS= read -r f; do
        printf '%s\t%s\t%s\n' "$(sha256sum "$f" | cut -d' ' -f1)" "$(stat -c %s "$f")" "$f"
      done )
  done
}
census_generate "$WORK" > "$WORK/census.tsv"

# re-census diff = 0 gate — same snapshot, second independent pass
census_generate "$WORK" > "$WORK/.recensus.tmp"
if ! cmp -s "$WORK/census.tsv" "$WORK/.recensus.tmp"; then
  rm -f "$WORK/.recensus.tmp"
  die "re-census diff != 0 — snapshot changed mid-flight; discarding in-flight copy" 4
fi
rm -f "$WORK/.recensus.tmp"
CENSUS_SHA=$(sha256sum "$WORK/census.tsv" | cut -d' ' -f1)
CENSUS_ROWS=$(($(wc -l < "$WORK/census.tsv") - 1))
CENSUS_BYTES=$(tail -n +2 "$WORK/census.tsv" | cut -f2 | awk '{s+=$1} END{printf "%d", s + 0}')

# --- SNAPSHOT.json (no secrets; census covers state/+workspace/, not this file)
export W5_SNAP_ID="$SNAP_ID" W5_TS="$TS" W5_STATE_DIR="$STATE_DIR" W5_WORKSPACE="$WORKSPACE" \
  W5_WS_PRESENT="$WORKSPACE_PRESENT" W5_LABEL="$LABEL" W5_SQLITE_META="$SQLITE_META" \
  W5_MEMIDX="$MEMORY_INDEX" W5_CENSUS_SHA="$CENSUS_SHA" \
  W5_CENSUS_ROWS="$CENSUS_ROWS" W5_CENSUS_BYTES="$CENSUS_BYTES" W5_COUNTS_JSON="$COUNTS_JSON"
python3 - "$WORK" <<'PY'
import datetime, json, os, sys
def env(k, d=""):
    return os.environ.get(k, d)
snap = {
    "schema": "ava-backup-snapshot-v1",
    "snapshot_id": env("W5_SNAP_ID"),
    "created_utc": env("W5_TS"),
    "host": os.uname().nodename,
    "label": env("W5_LABEL"),
    "sources": {
        "state_dir": env("W5_STATE_DIR"),
        "workspace": env("W5_WORKSPACE"),
        "workspace_present": env("W5_WS_PRESENT") == "true",
    },
    "memory_index_paths": env("W5_MEMIDX").split(),
    "memory_index_present": bool(env("W5_MEMIDX").strip()),
    "sqlite": json.loads(env("W5_SQLITE_META") or "{}"),
    "census": {
        "file": "census.tsv",
        "sha256": env("W5_CENSUS_SHA"),
        "rows": int(env("W5_CENSUS_ROWS") or 0),
        "bytes": int(env("W5_CENSUS_BYTES") or 0),
        "covers": ["state/", "workspace/"],
        "format": "census-v1: sha256<TAB>size<TAB>path, LC_ALL=C path order",
    },
    "sql_row_counts": json.loads(env("W5_COUNTS_JSON") or "{}"),
    "secretrefs": [],
    "retention_note": "retention is owner-configured (spec §5.5) — see infra/backup/README.md",
}
with open(os.path.join(sys.argv[1], "SNAPSHOT.json"), "w") as f:
    json.dump(snap, f, indent=2, sort_keys=True)
    f.write("\n")
PY
[ -s "$WORK/SNAPSHOT.json" ] || die "SNAPSHOT.json not written" 4

# --- atomic finalize (same filesystem rename)
mv "$WORK" "$DEST"
{
  echo "census: rows=$CENSUS_ROWS bytes=$CENSUS_BYTES sha=$CENSUS_SHA"
  echo "sqlite: consistent=$SQLITE_CONSISTENT plain=$SQLITE_PLAIN memidx=${MEMORY_INDEX:-none}"
  echo "snapshot_dir: $DEST"
  echo "status: OK"
} >> "$RECEIPT"
log "census rows=$CENSUS_ROWS bytes=$CENSUS_BYTES sha=$CENSUS_SHA"
log "snapshot OK: $DEST"
trap - EXIT
echo "$DEST"
