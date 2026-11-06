#!/usr/bin/env bash
# Hindsight adapter verify — config lint + loopback contract self-test + unit
# state. Read-only: safe under ProtectSystem=strict (no writes; python runs
# with PYTHONDONTWRITEBYTECODE=1). W2 style: PASS/FAIL lines, exit 1 on fail.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fail=0
ck() { if eval "$2"; then echo "PASS: $1"; else echo "FAIL: $1" >&2; fail=1; fi; }

ck "config lint (pins, no 'latest', SecretRef-only, replace prohibited, ghost window)" \
  'PYTHONDONTWRITEBYTECODE=1 python3 - "$ROOT/adapter/config.json" <<'"'"'PYLINT'"'"'
import json, re, sys
cfg = json.load(open(sys.argv[1], encoding="utf-8"))
errors = []
def walk(node, path="$"):
    if isinstance(node, dict):
        for k, v in node.items(): walk(v, f"{path}.{k}")
    elif isinstance(node, list):
        for i, v in enumerate(node): walk(v, f"{path}[{i}]")
    elif isinstance(node, str) and node.strip().lower() == "latest":
        errors.append(f"'latest' forbidden at {path}")
walk(cfg)
pins = cfg.get("pinned_versions", {})
for key in ("hindsight_engine", "hindsight_openclaw_plugin"):
    v = str(pins.get(key, ""))
    if not re.match(r"^\d+\.\d+\.\d+$", v):
        errors.append(f"pinned_versions.{key} not semver: {v!r}")
if not pins.get("embedVersion") or str(pins["embedVersion"]).lower() == "latest":
    errors.append("embedVersion missing or latest")
emp = pins.get("embedding_model_pin") or {}
for k in ("identity", "dimension", "normalization", "artifact_sha256"):
    if k not in emp:
        errors.append(f"embedding_model_pin.{k} missing (one-way-door pin slot)")
pending = emp.get("status") == "pending-p3-provider-qualification"
if any(emp.get(k) is None for k in ("identity", "dimension", "normalization", "artifact_sha256")) and not pending:
    errors.append("embedding_model_pin unresolved without pending-p3 status")
creds = cfg.get("credentials", {})
if creds.get("mode") != "SecretRef-only":
    errors.append("credentials.mode must be SecretRef-only")
for name, ref in (creds.get("refs") or {}).items():
    if ref.get("ref_source") not in ("env", "file", "exec"):
        errors.append(f"credentials.refs.{name}: inline or unknown ref_source")
imp = cfg.get("import", {})
if imp.get("replace_prohibited") is not True:
    errors.append("import.replace_prohibited must be true")
if imp.get("exclusion", {}).get("ghost_window") != ["2026-10-28T04:00:00Z", "2026-11-05T04:00:00Z"]:
    errors.append("ghost_window pin drifted from pinned constant (diet-design §2)")
if imp.get("consolidation") != "off":
    errors.append("consolidation must be 'off' for backfill+benchmark phase")
if errors:
    print("config lint FAILED:"); [print("  -", e) for e in errors]; sys.exit(1)
print("config lint clean (pins, SecretRef-only, replace prohibited, ghost window pinned)")
PYLINT'
ck "contract self-test (loopback write->read-back, replace reject, hash halt)" \
  'PYTHONDONTWRITEBYTECODE=1 python3 - "$ROOT" <<'"'"'PYSELF'"'"'
import hashlib, sys
sys.path.insert(0, sys.argv[1])
from adapter.import_contract import (BatchHaltedError, BatchSubmitter, ContractStore,
                                    ReplaceProhibitedError, correction_payload)
content = "verify self-test record"
payload = {
    "canonical_id": "openclaw:message:verify-1", "source_system": "openclaw",
    "source_uri": "verify://selftest", "source_sha256": hashlib.sha256(content.encode()).hexdigest(),
    "content": content, "record_type": "message", "trust_class": "A",
    "sensitivity": "internal", "target_bank": "verify-bank",
}
store = ContractStore()
r = BatchSubmitter(store).submit_batch([payload], batch_id="verify-batch")
assert len(r.submitted) == 1, "submit failed"
doc = store.get_operation(r.submitted[0])
assert doc["record"].content == content, "read-back content mismatch"
try:
    BatchSubmitter(store).submit_batch([dict(payload, update_mode="replace")], batch_id="v2")
    raise SystemExit("replace was not rejected")
except ReplaceProhibitedError:
    pass
bad = dict(payload, canonical_id="openclaw:message:verify-2",
           source_sha256="0" * 64)
try:
    BatchSubmitter(store).submit_batch([bad], originals={"openclaw:message:verify-2": b"other bytes"}, batch_id="v3")
    raise SystemExit("hash mismatch did not halt")
except BatchHaltedError:
    pass
print("contract self-test green (write/read-back, replace prohibited, hash-mismatch halt)")
PYSELF'
if command -v systemctl >/dev/null 2>&1 && sudo -n test -f /etc/systemd/system/staging-hindsight.service 2>/dev/null; then
  ck "unit active" '"$(systemctl is-active staging-hindsight)" = "active"'
  ck "unit Result=success" '"$(systemctl show -p Result --value staging-hindsight)" = "success"'
else
  echo "SKIP: unit state check (systemctl/unit unavailable in this context)"
fi

[ "$fail" -eq 0 ] && echo "verify: ALL GREEN" || { echo "verify: FAILED" >&2; exit 1; }
