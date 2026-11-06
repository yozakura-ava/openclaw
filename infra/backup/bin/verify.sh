#!/usr/bin/env bash
# W5 — verification kit for snapshots, encrypted archives, and restore drills.
#
# Modes:
#   verify.sh --snapshot DIR                 snapshot integrity: census re-gen
#                                            diff=0, SNAPSHOT.json sane (census
#                                            sha/rows/bytes re-derived)
#   verify.sh --drill DIR                    restore rehearsal: restored tree
#                                            census diff=0, canaries re-run,
#                                            receipt present with RTO stamping
#   verify.sh --archive F --meta F.meta.json encrypted archive: ciphertext sha
#                                            vs meta, meta parses, SecretRef
#                                            named, hygiene scan (no key
#                                            material in artifacts)
#
# Exit 0 with a "verify: OK ..." line on success; non-zero otherwise.
set -euo pipefail

MODE=""
SNAP=""
DRILL=""
ARCHIVE=""
META=""

die() { echo "verify: $1" >&2; exit "${2:-1}"; }
usage() { sed -n '/^# Modes:/,/^set -euo/p' "$0" | sed 's/^# \{0,1\}//' | head -n -1; exit 0; }

while [ $# -gt 0 ]; do
  case "$1" in
    --snapshot) MODE=snapshot; SNAP=$2; shift 2;;
    --drill) MODE=drill; DRILL=$2; shift 2;;
    --archive) MODE=archive; ARCHIVE=$2; shift 2;;
    --meta) META=$2; shift 2;;
    -h|--help) usage;;
    *) die "unknown argument: $1 (see --help)";;
  esac
done
command -v sha256sum >/dev/null || die "sha256sum not found"

census_generate() { # mirrors snapshot.sh / restore.sh (census-v1)
  local d
  echo "#census-v1"
  for d in state workspace; do
    [ -d "$1/$d" ] || continue
    ( cd "$1" && LC_ALL=C find "$d" -type f 2>/dev/null | LC_ALL=C sort | while IFS= read -r f; do
        printf '%s\t%s\t%s\n' "$(sha256sum "$f" | cut -d' ' -f1)" "$(stat -c %s "$f")" "$f"
      done )
  done
}

# census_check TREE — compares tree against TREE/census.tsv; emits diff status
census_check() {
  local tmp
  tmp=$(mktemp)
  census_generate "$1" > "$tmp"
  if cmp -s "$1/census.tsv" "$tmp"; then rm -f "$tmp"; echo 0; else rm -f "$tmp"; echo 1; fi
}

case "$MODE" in
  snapshot)
    [ -d "$SNAP" ] || die "snapshot dir missing: $SNAP" 3
    [ -f "$SNAP/SNAPSHOT.json" ] || die "SNAPSHOT.json missing in $SNAP" 3
    [ -f "$SNAP/census.tsv" ] || die "census.tsv missing in $SNAP" 3
    DIFF=$(census_check "$SNAP")
    [ "$DIFF" = 0 ] || die "re-census diff != 0 for snapshot $SNAP" 4
    SNAPID=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["snapshot_id"])' "$SNAP/SNAPSHOT.json") \
      || die "SNAPSHOT.json does not parse" 3
    CEN_SHA=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["census"]["sha256"])' "$SNAP/SNAPSHOT.json")
    ACT_SHA=$(sha256sum "$SNAP/census.tsv" | cut -d' ' -f1)
    [ "$CEN_SHA" = "$ACT_SHA" ] || die "census sha mismatch: SNAPSHOT.json=$CEN_SHA actual=$ACT_SHA" 4
    ROWS_ACTUAL=$(($(wc -l < "$SNAP/census.tsv") - 1))
    BYTES_ACTUAL=$(tail -n +2 "$SNAP/census.tsv" | cut -f2 | awk '{s+=$1} END{printf "%d", s + 0}')
    python3 - "$SNAP/SNAPSHOT.json" "$ROWS_ACTUAL" "$BYTES_ACTUAL" <<'PY' || die "SNAPSHOT.json census counters mismatch" 4
import json, sys
snap = json.load(open(sys.argv[1]))
rows, bts = int(sys.argv[2]), int(sys.argv[3])
c = snap.get("census", {})
assert c.get("rows") == rows, f"rows {c.get('rows')} != {rows}"
assert c.get("bytes") == bts, f"bytes {c.get('bytes')} != {bts}"
PY
    echo "verify: SNAPSHOT OK $SNAP (id=$SNAPID rows=$ROWS_ACTUAL bytes=$BYTES_ACTUAL)"
    ;;
  drill)
    [ -d "$DRILL" ] || die "drill dir missing: $DRILL" 3
    RESTORED="$DRILL/restored"
    [ -d "$RESTORED" ] || die "no restored/ tree in $DRILL" 3
    [ -f "$RESTORED/SNAPSHOT.json" ] || die "restored tree missing SNAPSHOT.json" 3
    [ -f "$RESTORED/census.tsv" ] || die "restored tree missing census.tsv" 3
    RCPT="$DRILL/restore-receipt.json"
    [ -f "$RCPT" ] || die "restore-receipt.json missing in $DRILL" 3
    DIFF=$(census_check "$RESTORED")
    [ "$DIFF" = 0 ] || die "re-census diff != 0 for restored tree in $DRILL" 4
    python3 - "$RCPT" <<'PY' || die "receipt checks failed" 4
import json, sys
r = json.load(open(sys.argv[1]))
assert r.get("status") == "ok", f"receipt status: {r.get('status')}"
rto = r.get("rto_seconds")
assert isinstance(rto, int) and rto >= 0, f"rto_seconds not stamped: {rto!r}"
assert r.get("census_diff") == "0", f"receipt census_diff: {r.get('census_diff')}"
PY
    CANARIES=$(python3 - "$RESTORED" <<'PY'
import json, os, sqlite3, sys
work = sys.argv[1]
snap = json.load(open(os.path.join(work, "SNAPSHOT.json")))
checks = {}
cfg = os.path.join(work, "state", "openclaw.json")
if os.path.exists(cfg):
    try:
        json.load(open(cfg)); checks["config_json_parses"] = True
    except Exception:
        checks["config_json_parses"] = False
else:
    checks["config_json_parses"] = "skipped (absent in snapshot)"
checks["singleton_state_present"] = os.path.exists(os.path.join(work, "state", "canary", "singleton.state"))
if snap.get("sources", {}).get("workspace_present"):
    ws = os.path.join(work, "workspace")
    checks["workspace_nonempty"] = os.path.isdir(ws) and any(os.scandir(ws))
else:
    checks["workspace_nonempty"] = "skipped (workspace absent in snapshot)"
for rel in snap.get("memory_index_paths", []):
    checks["memory_index:" + rel] = os.path.isdir(os.path.join(work, rel))
for rel, counts in (snap.get("sql_row_counts") or {}).items():
    if not isinstance(counts, dict) or "error" in counts:
        checks["sqlcount:" + rel] = "skipped (no clean source counts)"
        continue
    try:
        con = sqlite3.connect(f"file:{os.path.join(work, rel)}?mode=ro", uri=True)
        bad = []
        for t, n in counts.items():
            got = int(con.execute('SELECT COUNT(*) FROM "%s"' % t).fetchone()[0])
            if got != n:
                bad.append("%s:%d!=%d" % (t, got, n))
        con.close()
        checks["sqlcount:" + rel] = bad if bad else True
    except Exception as e:
        checks["sqlcount:" + rel] = str(e)[:120]
failures = [k for k, v in checks.items() if v is False or isinstance(v, str) and not v.startswith("skipped")]
print(f"{len(failures)} {json.dumps(failures)}")
PY
)
    NFAIL=${CANARIES%% *}
    [ "$NFAIL" = "0" ] || die "canaries FAILED: ${CANARIES#* }" 4
    echo "verify: DRILL OK $DRILL (census=0 canaries=0 receipt+rto=stamped)"
    ;;
  archive)
    [ -n "$ARCHIVE" ] || die "--archive required"
    [ -n "$META" ] || { [ -f "$ARCHIVE.meta.json" ] && META="$ARCHIVE.meta.json"; }
    [ -n "$META" ] || die "--meta required (or place .meta.json sidecar)" 3
    [ -f "$ARCHIVE" ] || die "archive missing: $ARCHIVE" 3
    [ -f "$META" ] || die "meta missing: $META" 3
    ACT=$(sha256sum "$ARCHIVE" | cut -d' ' -f1)
    EXP=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["sha256"])' "$META")
    [ "$ACT" = "$EXP" ] || die "archive sha mismatch vs meta (tamper?): $ACT != $EXP" 4
    if grep -Eq 'BEGIN [A-Z ]*PRIVATE KEY|AKIA[0-9A-Z]{16}' "$META"; then
      die "meta hygiene scan FAILED — key-material pattern present" 4
    fi
    python3 - "$META" <<'PY' || die "meta checks failed" 4
import json, sys
m = json.load(open(sys.argv[1]))
assert m.get("secretref", "").startswith("secretref:"), "meta must name its secretref"
assert m.get("cipher") and m.get("kdf"), "meta missing cipher/kdf"
PY
    echo "verify: ARCHIVE OK $ARCHIVE (sha match, meta clean, secretref named)"
    ;;
  *)
    die "no mode given — use --snapshot DIR | --drill DIR | --archive F [--meta M]; see --help" 3
    ;;
esac
