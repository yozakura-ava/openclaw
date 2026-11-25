#!/usr/bin/env bash
# Secret pattern scan over infra/staging — gate for "zero embedded secrets".
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PATTERNS=(
  'BEGIN (RSA|EC|OPENSSH|DSA) PRIVATE KEY'
  'AKIA[0-9A-Z]{16}'
  'gh[pousr]_[A-Za-z0-9]{20,}'
  'xox[baprs]-[A-Za-z0-9-]{10,}'
  '(?i)(password|passwd|secret|token|api[_-]?key)\s*[:=]\s*["'"'"']?[^\s"'"'"']{8,}'
)
hits=0
while IFS= read -r -d '' f; do
  for i in "${!PATTERNS[@]}"; do
    if grep -nEH "${PATTERNS[$i]}" "$f" | grep -vE 'secret[_-]?refs?: \[\]|SecretRef'; then
      echo "SECRET-SCAN HIT (pattern $i): $f" >&2
      hits=$((hits+1))
    fi
  done
done < <(find "$ROOT" -type f -print0)
if [ "$hits" -gt 0 ]; then echo "secret-scan: FAIL ($hits hits)" >&2; exit 1; fi
echo "secret-scan: OK (0 findings in $ROOT)"
