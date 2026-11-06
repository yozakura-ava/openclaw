#!/usr/bin/env bash
# W5 — restore rehearsal (DRILL). Canonical spec WP-02: restore rehearsal is a
# hard precondition. Two modes:
#
#   local       rehearse on THIS host into a scratch target (default:
#               $AVA_BACKUP_REHEARSAL_ROOT/<snapshot_id> under the backup root).
#   xeon-drill  run ON the xeon gateway host: pull the encrypted archive from
#               ava-primary over the tailnet (rsync/ssh) and rehearse into
#               /root/backups/ava-primary-drills/<snapshot_id>/ — this script
#               writes ONLY inside that drill root (enforced; --allow-target
#               overrides for tests). The xeon production gateway state
#               (/root/.openclaw) is never touched.
#
# Pipeline per run: single-flight lock -> resolve backup key via SecretRef
# (resolver cmd -> local 0600 key files -> remote ssh fetch for xeon-drill;
# key lives in MEMORY ONLY) -> obtain archive (local path or rsync pull) ->
# RTO clock starts -> stream decrypt+extract into target/work -> census
# re-census diff = 0 gate -> canaries (config parse, singleton state,
# workspace, memory index, live-SQL COUNT verification) -> receipt with RTO
# stamping -> atomic finalize work/ -> restored/. Paired revert removes ONLY
# this run's work/incoming dirs on failure; the receipt (status: failed)
# is kept for audit.
#
# Usage:
#   restore.sh --archive FILE [--meta FILE] [--target DIR] [--mode local]
#   restore.sh --mode xeon-drill --remote ava-harness --remote-archive PATH \
#              [--meta PATH] [--target DIR] [--secretref NAME] [--allow-target]
# Env: AVA_BACKUP_REHEARSAL_ROOT AVA_BACKUP_KEYREF AVA_BACKUP_SECRETS_DIR
#      AVA_BACKUP_SECRET_RESOLVER
set -euo pipefail

MODE="local"
ARCHIVE=""
META=""
REMOTE=""
REMOTE_ARCHIVE=""
TARGET=""
ALLOW_TARGET=false
REF="${AVA_BACKUP_KEYREF:-backup-drill-key}"

die() { echo "restore: $1" >&2; exit "${2:-1}"; }
usage() { sed -n '/^# Usage:/,/^set -euo/p' "$0" | sed 's/^# \{0,1\}//' | head -n -1; exit 0; }

while [ $# -gt 0 ]; do
  case "$1" in
    --mode) MODE=$2; shift 2;;
    --archive) ARCHIVE=$2; shift 2;;
    --meta) META=$2; shift 2;;
    --remote) REMOTE=$2; shift 2;;
    --remote-archive) REMOTE_ARCHIVE=$2; shift 2;;
    --target) TARGET=$2; shift 2;;
    --secretref) REF=$2; shift 2;;
    --allow-target) ALLOW_TARGET=true; shift;;
    -h|--help) usage;;
    *) die "unknown argument: $1 (see --help)";;
  esac
done

case "$MODE" in
  local|xeon-drill) ;;
  *) die "mode must be local or xeon-drill (got: $MODE)";;
esac
command -v openssl >/dev/null || die "openssl not found"
command -v rsync >/dev/null || die "rsync not found"
command -v sha256sum >/dev/null || die "sha256sum not found"
command -v flock >/dev/null || die "flock not found"

TS=$(date -u +%Y%m%dT%H%M%SZ)
T0=$(date +%s)

# --- key resolution: memory only, never written to disk
# 1. AVA_BACKUP_SECRET_RESOLVER command; 2. local 0600 key files;
# 3. (xeon-drill only) remote ssh fetch from the backup host.
resolve_key() {
  local key=""
  if [ -n "${AVA_BACKUP_SECRET_RESOLVER:-}" ]; then
    key=$("$AVA_BACKUP_SECRET_RESOLVER" "$1") || die "secret resolver failed for secretref:$1" 3
  else
    local dir f perms
    for dir in "${AVA_BACKUP_SECRETS_DIR:-}" /etc/ava-staging/secrets "$HOME/.ava-staging/secrets"; do
      [ -n "$dir" ] || continue
      f="$dir/$1"
      if [ -f "$f" ]; then
        perms=$(stat -c %a "$f" 2>/dev/null || echo "?")
        case "$perms" in 600|400) ;; *) die "key file $f must be 0600/0400 (got $perms) — refusing" 3;; esac
        key=$(cat "$f") || die "cannot read key file: $f" 3
        break
      fi
    done
  fi
  if [ -z "$key" ] && [ "$MODE" = "xeon-drill" ] && [ -n "$REMOTE" ]; then
    key=$(ssh -o BatchMode=yes "$REMOTE" "cat .ava-staging/secrets/$1" 2>/dev/null) || key=""
    key=$(printf '%s' "$key" | tail -n 1)   # last line guards against any banner noise
  fi
  [ -n "$key" ] || die "secretref:$1 unresolved (resolver, local key file, or --remote fetch)" 3
  key="${key%$'\n'}"
  [ "${#key}" -ge 32 ] || die "resolved key too short (<32 chars) for secretref:$1" 3
  printf '%s' "$key"
}

# --- inputs
if [ -z "$ARCHIVE" ]; then
  [ "$MODE" = "xeon-drill" ] || die "--archive is required in local mode"
  [ -n "$REMOTE_ARCHIVE" ] || die "--remote-archive is required for xeon-drill without --archive"
  [ -n "$REMOTE" ] || die "--remote is required for xeon-drill pull"
fi
[ -n "$META" ] || { [ -n "$ARCHIVE" ] && [ -f "$ARCHIVE.meta.json" ] && META="$ARCHIVE.meta.json"; }

# --- target selection + drill-root enforcement
SNAP_ID=""
if [ -n "$META" ]; then
  [ -f "$META" ] || die "meta missing: $META" 3
  SNAP_ID=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["snapshot_id"])' "$META") \
    || die "meta unreadable: $META" 3
fi
if [ -z "$TARGET" ]; then
  case "$MODE" in
    local)
      ROOT="${AVA_BACKUP_REHEARSAL_ROOT:-/var/backups/ava-staging/rehearsals}"
      TARGET="$ROOT/${SNAP_ID:-restore-$TS}"
      ;;
    xeon-drill)
      [ -n "$SNAP_ID" ] || die "xeon-drill needs --meta (for snapshot_id) or an explicit --target"
      TARGET="/root/backups/ava-primary-drills/$SNAP_ID"
      ;;
  esac
fi
if [ "$MODE" = "xeon-drill" ] && [ "$ALLOW_TARGET" = false ]; then
  case "$TARGET" in
    /root/backups/ava-primary-drills/*) ;;
    *) die "xeon-drill may only write inside /root/backups/ava-primary-drills/ (got: $TARGET) — use --allow-target only for tests" 3;;
  esac
fi

mkdir -p "$TARGET" 2>/dev/null || die "target not creatable: $TARGET" 3
[ -w "$TARGET" ] || die "target not writable by $(id -un): $TARGET" 3
exec 9>"$TARGET/.restore.lock"
flock -n 9 || { echo "restore: another restore holds the lock for $TARGET — single-flight refuses" >&2; exit 2; }

WORK="$TARGET/work"
INCOMING="$TARGET/incoming"
# paired revert — remove ONLY this run's in-flight dirs; receipt stays for audit
revert() {
  echo "[revert] discarding in-flight restore work under $TARGET" >&2 || true
  [ -d "$WORK" ] && rm -rf "$WORK"
  [ -d "$INCOMING" ] && [ "$MODE" = "xeon-drill" ] && rm -rf "$INCOMING"
  python3 - "$TARGET/restore-receipt.json" <<'PYFAIL' 2>/dev/null || true
import json, os, sys
p = sys.argv[1]
try:
    r = json.load(open(p))
except Exception:
    r = {"schema": "ava-restore-receipt-v1"}
r["status"] = "failed"
r["finished_utc"] = __import__("datetime").datetime.now(__import__("datetime").timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
with open(p, "w") as f:
    json.dump(r, f, indent=2, sort_keys=True)
    f.write("\n")
PYFAIL
}
trap 'ec=$?; [ $ec -ne 0 ] && revert; exit $ec' EXIT

log() { echo "[$(date -u +%H:%M:%SZ)] $*" | tee -a "$TARGET/restore.log" >&2; }

{
  echo "receipt $TS user=$(id -un) host=$(hostname) mode=$MODE"
  echo "target: $TARGET"
  echo "secretref: secretref:$REF (name only — key bytes never recorded)"
  echo "paired-revert: rm -rf $WORK (+ incoming for xeon-drill pull); receipt marked failed"
  echo "plan: pull? -> decrypt+extract (RTO clock) -> census diff=0 gate -> canaries -> receipt -> atomic finalize"
} > "$TARGET/restore-receipt.txt"

# --- obtain archive
if [ -z "$ARCHIVE" ]; then
  mkdir -p "$INCOMING"
  log "rsync pull $REMOTE:$REMOTE_ARCHIVE -> $INCOMING/"
  rsync -a --sparse -e "ssh -o BatchMode=yes" "$REMOTE:$REMOTE_ARCHIVE" "$INCOMING/" 2>>"$TARGET/restore.log" \
    || die "rsync pull failed" 4
  ARCHIVE="$INCOMING/$(basename "$REMOTE_ARCHIVE")"
fi
[ -f "$ARCHIVE" ] || die "archive missing: $ARCHIVE" 3
ARCHIVE_SHA=$(sha256sum "$ARCHIVE" | cut -d' ' -f1)
SHA_MATCH="null"
if [ -n "$META" ]; then
  META_SHA=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["sha256"])' "$META")
  if [ "$META_SHA" = "$ARCHIVE_SHA" ]; then SHA_MATCH="true"; else SHA_MATCH="false"; fi
  [ "$SHA_MATCH" = "true" ] || die "archive sha mismatch vs meta ($ARCHIVE_SHA != $META_SHA) — refusing drill" 4
fi

# compressor from meta (fallback: name)
COMP=""
if [ -n "$META" ]; then
  COMP=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["compressor"])' "$META")
else
  case "$ARCHIVE" in
    *.tar.zst|*.zst.enc) COMP="zstd";;
    *.tar.gz|*.tgz|*.gz.enc) COMP="gzip";;
    *) die "cannot infer compressor for $ARCHIVE (pass --meta)" 3;;
  esac
fi
case "$COMP" in
  zstd) DECOMP="zstd -dc";;
  gzip) DECOMP="gzip -dc";;
  *) die "unknown compressor: $COMP" 3;;
esac

# --- RTO clock starts BEFORE decrypt; restore into work/
mkdir -p "$WORK"
KEY=$(resolve_key "$REF")
log "decrypt+extract -> $WORK/"
openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -pass "fd:3" -in "$ARCHIVE" 3< <(printf '%s' "$KEY") \
  | $DECOMP | tar -xf - -C "$WORK" 2>>"$TARGET/restore.log" \
  || { rm -f "$WORK/.tar-x"; die "decrypt/extract failed (wrong key or corrupt archive?)" 4; }
unset KEY
[ -f "$WORK/SNAPSHOT.json" ] || die "extracted tree missing SNAPSHOT.json" 4
[ -f "$WORK/census.tsv" ] || die "extracted tree missing census.tsv" 4

# --- census gate: re-census the restored payload, diff must be 0
census_generate() { # $1 = tree root; mirrors snapshot.sh/verify.sh census-v1
  local d
  echo "#census-v1"
  for d in state workspace; do
    [ -d "$1/$d" ] || continue
    ( cd "$1" && LC_ALL=C find "$d" -type f 2>/dev/null | LC_ALL=C sort | while IFS= read -r f; do
        printf '%s\t%s\t%s\n' "$(sha256sum "$f" | cut -d' ' -f1)" "$(stat -c %s "$f")" "$f"
      done )
  done
}
census_generate "$WORK" > "$WORK/.recensus"
CENSUS_DIFF=0
cmp -s "$WORK/census.tsv" "$WORK/.recensus" || CENSUS_DIFF=1
rm -f "$WORK/.recensus"
[ "$CENSUS_DIFF" = 0 ] || die "census diff != 0 on restored tree — restore integrity FAILED" 5

# --- canaries (schema/count/hash spot-checks per WP-02)
CANARIES_JSON=$(python3 - "$WORK" <<'PY' 2>>"$TARGET/restore.log" || die "canary pass crashed" 5
import json, os, sqlite3, sys
work = sys.argv[1]
snap = json.load(open(os.path.join(work, "SNAPSHOT.json")))
checks = {}
# census files
checks["snapshot_json_present"] = os.path.isfile(os.path.join(work, "SNAPSHOT.json"))
checks["census_tsv_present"] = os.path.isfile(os.path.join(work, "census.tsv"))
# config canary: openclaw.json parses if it was part of the snapshot
cfg = os.path.join(work, "state", "openclaw.json")
if os.path.exists(cfg):
    try:
        json.load(open(cfg))
        checks["config_json_parses"] = True
    except Exception:
        checks["config_json_parses"] = False
else:
    checks["config_json_parses"] = "skipped (absent in snapshot)"
# singleton canary state
sing = os.path.join(work, "state", "canary", "singleton.state")
checks["singleton_state_present"] = os.path.exists(sing)
# workspace canary
if snap.get("sources", {}).get("workspace_present"):
    ws = os.path.join(work, "workspace")
    checks["workspace_nonempty"] = os.path.isdir(ws) and any(os.scandir(ws))
else:
    checks["workspace_nonempty"] = "skipped (workspace absent in snapshot)"
# memory index canaries
for rel in snap.get("memory_index_paths", []):
    checks["memory_index:" + rel] = os.path.isdir(os.path.join(work, rel))
# live-SQL COUNT verification (schema/count spot-checks)
for rel, counts in (snap.get("sql_row_counts") or {}).items():
    p = os.path.join(work, rel)
    if not isinstance(counts, dict) or "error" in counts:
        checks["sqlcount:" + rel] = "skipped (no clean source counts)"
        continue
    try:
        con = sqlite3.connect(f"file:{p}?mode=ro", uri=True)
        bad = []
        for t, n in counts.items():
            got = int(con.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0])
            if got != n:
                bad.append(f"{t}:{got}!={n}")
        con.close()
        checks["sqlcount:" + rel] = bad if bad else True
    except Exception as e:
        checks["sqlcount:" + rel] = str(e)[:120]
failures = [k for k, v in checks.items() if v is False or isinstance(v, str) and not v.startswith("skipped")]
print(json.dumps({"checks": checks, "failures": failures}, sort_keys=True))
PY
)
CANARY_FAIL=$(printf '%s' "$CANARIES_JSON" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["failures"]))')
if [ "$CANARY_FAIL" != "0" ]; then
  printf '%s\n' "$CANARIES_JSON" | python3 -m json.tool >&2 || true
  die "canaries FAILED ($CANARY_FAIL)" 5
fi

# --- RTO stamping + receipt
T1=$(date +%s)
RTO=$((T1 - T0))
export W5_R_MODE="$MODE" W5_R_ARCHIVE="$ARCHIVE" W5_R_SHA="$ARCHIVE_SHA" W5_R_MATCH="$SHA_MATCH" \
  W5_R_SNAPID="$SNAP_ID" W5_R_TARGET="$TARGET" W5_R_REF="$REF" W5_R_TS="$TS" \
  W5_R_RTO="$RTO" W5_R_CANARIES="$CANARIES_JSON" W5_R_CENSUS_DIFF="$CENSUS_DIFF"
python3 - "$TARGET/restore-receipt.json" <<'PY'
import datetime, json, os, socket, sys
now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
r = {
    "schema": "ava-restore-receipt-v1",
    "status": "ok",
    "mode": os.environ["W5_R_MODE"],
    "snapshot_id": os.environ["W5_R_SNAPID"] or None,
    "archive": os.environ["W5_R_ARCHIVE"],
    "archive_sha256": os.environ["W5_R_SHA"],
    "archive_sha256_matches_meta": {"true": True, "false": False, "null": None}[os.environ["W5_R_MATCH"]],
    "census_diff": os.environ["W5_R_CENSUS_DIFF"],
    "canaries": json.loads(os.environ["W5_R_CANARIES"]),
    "rto_seconds": int(os.environ["W5_R_RTO"]),
    "started_utc": os.environ["W5_R_TS"],
    "finished_utc": now,
    "host": socket.gethostname(),
    "target": os.environ["W5_R_TARGET"],
    "secretref": "secretref:" + os.environ["W5_R_REF"],
    "note": "drill rehearsal — never wrote outside target; xeon production state untouched",
}
with open(sys.argv[1], "w") as f:
    json.dump(r, f, indent=2, sort_keys=True)
    f.write("\n")
PY
mv "$WORK" "$TARGET/restored"
{
  echo "census_diff: $CENSUS_DIFF"
  echo "canaries: OK"
  echo "rto_seconds: $RTO"
  echo "restored: $TARGET/restored"
  echo "status: OK"
} >> "$TARGET/restore-receipt.txt"
log "restore drill OK — rto=${RTO}s receipt=$TARGET/restore-receipt.json"
trap - EXIT
echo "$TARGET/restored"
