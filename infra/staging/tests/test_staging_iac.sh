#!/usr/bin/env bash
# Scoped IaC test (HR5): static assertions on the infra/staging tree.
# LIVE=1 additionally runs bin/verify.sh against the host.
set -uo pipefail
fail=0
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
t() { if eval "$2" >/dev/null 2>&1; then echo "PASS: $1"; else echo "FAIL: $1" >&2; fail=1; fi; }
t "manifest roster complete" "grep -c 'name: staging-' '$ROOT/manifest.yml' | grep -q 3"
t "secret-scan green" "bash '$ROOT/bin/secret-scan.sh'"
t "apply.sh single-flight flock" "grep -q 'flock -n' '$ROOT/bin/apply.sh'"
t "apply.sh paired revert" "grep -q 'revert()' '$ROOT/bin/apply.sh'"
t "verify.sh bypass detection" "grep -q 'bypass' '$ROOT/bin/verify.sh'"
t "no :latest tags" "! grep -rn ':latest' '$ROOT' --include='*.yml' --include='*.service'"
t "W3 unit ExecStart pinned artifact" "grep -q '/opt/ava-staging/gateway/dist/index.js gateway' '$ROOT/units/staging-gateway.service'"
t "W3 unit loopback bind" "grep -q -- '--bind loopback' '$ROOT/units/staging-gateway.service'"
t "W3 unit port 18800" "grep -q -- '--port 18800' '$ROOT/units/staging-gateway.service'"
t "W3 unit state dir + limits" "grep -q 'StateDirectory=ava-staging/gateway' '$ROOT/units/staging-gateway.service' && grep -q 'MemoryMax=8G' '$ROOT/units/staging-gateway.service' && grep -q 'MemorySwapMax=0' '$ROOT/units/staging-gateway.service'"
t "W3 manifest artifact pin" "grep -q 'a33d0d7e5151f57be71120700cc6e73813a93e9f571b6b22643134df814c48f7' '$ROOT/manifest.yml'"
t "W3 canary script executable" "test -x '$ROOT/bin/singleton-canary.sh'"
t "W3 canary single-request nonce logic" "grep -q 'X-Singleton-Canary' '$ROOT/bin/singleton-canary.sh'"
t "apply.sh source-hash fail-closed gate" "grep -q 'a33d0d7e' '$ROOT/bin/apply.sh' && grep -q 'sha256sum -c' '$ROOT/bin/apply.sh'"
t "unit/apply node path parity" "grep -q 'toolchain/node-v24.22.2/bin/node' '$ROOT/units/staging-gateway.service' && grep -q 'toolchain/node-v24.22.2/bin/node' '$ROOT/bin/apply.sh'"
t "apply.sh installs runtime closure (worktree subset)" "grep -q 'cp -a .\$SRC_WT/node_modules' '$ROOT/bin/apply.sh' && grep -q 'cp -a .\$SRC_WT/packages' '$ROOT/bin/apply.sh' && grep -q 'cp -a .\$SRC_WT/extensions' '$ROOT/bin/apply.sh' && grep -q 'cp -a .\$SRC_WT/ui' '$ROOT/bin/apply.sh' && grep -q 'cp -a .\$SRC_WT/examples' '$ROOT/bin/apply.sh'"
t "apply.sh dangling-link audit gate" "grep -q 'xtype l' '$ROOT/bin/apply.sh'"
t "apply.sh closure resolution gate (imports)" "grep -q 'closure resolution gate' '$ROOT/bin/apply.sh'"
t "apply.sh closure gates tslog" "grep -q tslog '$ROOT/bin/apply.sh'"
t "apply.sh pre-restart smoke gate" "grep -q -- '--version' '$ROOT/bin/apply.sh'"
t "apply.sh pins W1.1 SUMS set" "grep -q 27c23ea6009a796eaf2d37dd135203435d0672f1440bbf4c3560999232ebc3ca '$ROOT/bin/apply.sh'"
t "apply.sh serve tailnet-only 443" "grep -q 'tailscale serve --bg 18800' '$ROOT/bin/apply.sh'"
t "apply.sh reverts serve + /opt" "grep -q 'serve off' '$ROOT/bin/apply.sh' && grep -q 'rm -rf \"\$OPT\"' '$ROOT/bin/apply.sh'"
t "verify.sh checks artifact hash" "grep -q 'a33d0d7e' '$ROOT/bin/verify.sh'"
t "verify.sh checks canary state" "grep -q 'singleton.state' '$ROOT/bin/verify.sh'"
t "verify.sh checks loopback listener" "grep -q '127.0.0.1:18800' '$ROOT/bin/verify.sh'"
if [ "${LIVE:-0}" = "1" ]; then bash "$ROOT/bin/verify.sh" || fail=1; fi
[ $fail -eq 0 ] && echo "test_staging_iac: ALL PASS" || { echo "test_staging_iac: FAILED" >&2; exit 1; }
