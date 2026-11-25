#!/usr/bin/env bash
# W5 — encrypted archive of a snapshot (closes the zero-encrypted-backup gap,
# canonical spec WP-02 "top open gap"; the restore drill is a hard precondition).
#
# Key separation: BACKUP KEYS ≠ DATA KEYS. The archive key is a DEDICATED
# backup key resolved via SecretRef ONLY:
#   1. AVA_BACKUP_SECRET_RESOLVER — command run with the ref name as argv[1];
#      key expected on stdout (e.g. a remote fetch over the tailnet).
#   2. $AVA_BACKUP_SECRETS_DIR/<ref>, else /etc/ava-staging/secrets/<ref>,
#      else ~/.ava-staging/secrets/<ref> — key file MUST be 0600/0400.
# Key bytes exist ONLY in memory and the secrets store: never on disk outside
# it, never in logs, receipts, or meta files (refs are recorded as NAMES only).
#
# Cipher: openssl enc -aes-256-cbc -pbkdf2 -iter 600000 (salt in header).
# Archive: tar | zstd (preferred) | gzip fallback | openssl — STREAMED; no
# plaintext archive ever touches disk.
#
# Usage:
#   encrypt.sh --snapshot DIR --out FILE [--secretref NAME]
#   encrypt.sh --decrypt IN --out OUT [--secretref NAME]   # drill/debug helper
# Env: AVA_BACKUP_KEYREF AVA_BACKUP_SECRET_RESOLVER AVA_BACKUP_SECRETS_DIR
set -euo pipefail

MODE=encrypt
SNAP=""
IN=""
OUT=""
META=""
REF="${AVA_BACKUP_KEYREF:-backup-drill-key}"

die() { echo "encrypt: $1" >&2; exit "${2:-1}"; }
usage() { sed -n '/^# Usage:/,/^set -euo/p' "$0" | sed 's/^# \{0,1\}//' | head -n -1; exit 0; }

while [ $# -gt 0 ]; do
  case "$1" in
    --snapshot) SNAP=$2; shift 2;;
    --decrypt) MODE=decrypt; IN=$2; shift 2;;
    --in) IN=$2; shift 2;;
    --meta) META=$2; shift 2;;
    --out) OUT=$2; shift 2;;
    --secretref) REF=$2; shift 2;;
    -h|--help) usage;;
    *) die "unknown argument: $1 (see --help)";;
  esac
done
[ -n "$OUT" ] || die "--out is required"
command -v openssl >/dev/null || die "openssl not found"
command -v sha256sum >/dev/null || die "sha256sum not found"

OUTDIR=$(dirname "$OUT")
mkdir -p "$OUTDIR" 2>/dev/null || die "output dir not creatable: $OUTDIR" 3
[ -w "$OUTDIR" ] || die "output dir not writable: $OUTDIR" 3
exec 9>"$OUTDIR/.encrypt.lock"
flock -n 9 || { echo "encrypt: another encrypt holds the lock for $OUTDIR — single-flight refuses" >&2; exit 2; }

TS=$(date -u +%Y%m%dT%H%M%SZ)

# resolve_key REF -> key bytes on stdout (memory only)
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
  [ -n "$key" ] || die "secretref:$1 unresolved (set AVA_BACKUP_SECRET_RESOLVER or provision the key file)" 3
  key="${key%$'\n'}"
  [ "${#key}" -ge 32 ] || die "resolved key too short (<32 chars) for secretref:$1" 3
  printf '%s' "$key"
}

if [ "$MODE" = decrypt ]; then
  [ -f "$IN" ] || die "archive missing: $IN" 3
  KEY=$(resolve_key "$REF")
  # compressor: sidecar meta when present, else archive-name inference
  [ -n "$META" ] || { [ -f "$IN.meta.json" ] && META="$IN.meta.json"; }
  if [ -n "$META" ]; then
    [ -f "$META" ] || die "meta missing: $META" 3
    COMP=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["compressor"])' "$META")
  else
    case "$IN" in
      *.tar.zst|*.zst.enc) COMP="zstd";;
      *.tar.gz|*.tgz|*.gz.enc) COMP="gzip";;
      *) die "cannot infer compressor for $IN (pass --meta)" 3;;
    esac
  fi
  case "$COMP" in
    zstd) DECOMP="zstd -dc";;
    gzip) DECOMP="gzip -dc";;
    *) die "unknown compressor in meta: $COMP" 3;;
  esac
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -pass "fd:3" -in "$IN" 3< <(printf '%s' "$KEY") \
    | $DECOMP > "$OUT.part" || { rm -f "$OUT.part"; die "decrypt failed (wrong key or corrupt archive?)" 4; }
  unset KEY
  mv -f "$OUT.part" "$OUT"
  echo "decrypt: OK $OUT"
  exit 0
fi

# --- encrypt mode
[ -n "$SNAP" ] || die "--snapshot is required in encrypt mode"
[ -d "$SNAP" ] || die "snapshot dir missing: $SNAP" 3
[ -f "$SNAP/SNAPSHOT.json" ] || die "not a finalized snapshot (SNAPSHOT.json missing): $SNAP" 3
[ -f "$SNAP/census.tsv" ] || die "not a finalized snapshot (census.tsv missing): $SNAP" 3

if command -v zstd >/dev/null 2>&1 && tar --zstd --version >/dev/null 2>&1; then
  TARCOMP="--zstd"; COMPRESSOR="zstd"
else
  TARCOMP="-z"; COMPRESSOR="gzip"
fi

MEMBERS="state SNAPSHOT.json census.tsv"
[ -d "$SNAP/workspace" ] && MEMBERS="workspace $MEMBERS"

KEY=$(resolve_key "$REF")
tar $TARCOMP -C "$SNAP" -cf - $MEMBERS \
  | openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt -pass "fd:3" -out "$OUT.part" 3< <(printf '%s' "$KEY") \
  || { rm -f "$OUT.part"; die "encrypt pipeline failed" 4; }
unset KEY
mv -f "$OUT.part" "$OUT"
ARCHIVE_SHA=$(sha256sum "$OUT" | cut -d' ' -f1)
SNAP_ID=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["snapshot_id"])' "$SNAP/SNAPSHOT.json")
CENSUS_SHA=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["census"]["sha256"])' "$SNAP/SNAPSHOT.json")

export W5_E_ARCHIVE="$(basename "$OUT")" W5_E_SHA="$ARCHIVE_SHA" W5_E_COMPRESSOR="$COMPRESSOR" \
  W5_E_REF="$REF" W5_E_SNAPID="$SNAP_ID" W5_E_CENSUS_SHA="$CENSUS_SHA" W5_E_TS="$TS"
python3 - "$OUT.meta.json" <<'PY'
import json, os, socket, sys
meta = {
    "schema": "ava-backup-archive-meta-v1",
    "archive": os.environ["W5_E_ARCHIVE"],
    "sha256": os.environ["W5_E_SHA"],
    "cipher": "aes-256-cbc",
    "kdf": "pbkdf2",
    "iterations": 600000,
    "compressor": os.environ["W5_E_COMPRESSOR"],
    "secretref": "secretref:" + os.environ["W5_E_REF"],
    "snapshot_id": os.environ["W5_E_SNAPID"],
    "census_sha256": os.environ["W5_E_CENSUS_SHA"],
    "created_utc": os.environ["W5_E_TS"],
    "host": socket.gethostname(),
    "note": "key material is NEVER recorded here — resolve the SecretRef to decrypt",
}
with open(sys.argv[1], "w") as f:
    json.dump(meta, f, indent=2, sort_keys=True)
    f.write("\n")
PY
# hygiene gate: no key material may appear in the meta artifact
if grep -Eq 'BEGIN [A-Z ]*PRIVATE KEY|AKIA[0-9A-Z]{16}|secretref:[^"]*://' "$OUT.meta.json"; then
  rm -f "$OUT.meta.json"
  die "meta hygiene scan failed — refusing to ship meta" 4
fi
echo "encrypt: OK $OUT sha=$ARCHIVE_SHA secretref=secretref:$REF compressor=$COMPRESSOR"
