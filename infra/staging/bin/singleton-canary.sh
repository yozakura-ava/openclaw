#!/usr/bin/env bash
# Singleton exactly-one-response canary (W3 arm; roster hardening is W8).
# Credential-free by design: rides the local ingress, not any channel.
# Sends exactly ONE nonce-marked request and asserts exactly ONE HTTP
# response (single connection, no follow, no retry). State file is the
# assertion surface read by verify.sh; the canary never fails the unit.
set -uo pipefail
PORT=18800
STATE_DIR=/var/lib/ava-staging/gateway/canary
STATE="$STATE_DIR/singleton.state"
mkdir -p "$STATE_DIR" 2>/dev/null || true
ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# Wait for first boot to answer (StateDirectory init can take tens of seconds).
for i in $(seq 1 45); do   # ceiling ~135s, stays under unit TimeoutStartSec=180
  curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$PORT/" && break
  sleep 2
done

NONCE="w3-$(date -u +%Y%m%dT%H%M%SZ)-$RANDOM$RANDOM"
BODY=$(mktemp /tmp/w3canary.XXXXXX); HDRS=$(mktemp /tmp/w3canary.hXXXXXX)
code=$(curl -s -o "$BODY" -D "$HDRS" --max-time 10 --connect-timeout 5 \
       -H "X-Singleton-Canary: $NONCE" -w '%{http_code}' \
       "http://127.0.0.1:$PORT/" 2>/dev/null)
rc=$?
resp=$(grep -c '^HTTP/' "$HDRS" 2>/dev/null || true); resp=${resp:-0}
bytes=$(wc -c < "$BODY" 2>/dev/null || echo 0)

if [ "$rc" -eq 0 ] && [ "$resp" -eq 1 ] && [ -n "$code" ]; then
  echo "$(ts) GREEN nonce=$NONCE status=$code responses=$resp bytes=$bytes" > "$STATE"
  echo "singleton-canary: GREEN nonce=$NONCE status=$code responses=$resp"
else
  echo "$(ts) RED nonce=$NONCE curl_rc=$rc responses=$resp code=$code" > "$STATE"
  echo "singleton-canary: RED nonce=$NONCE curl_rc=$rc responses=$resp" >&2
fi
rm -f "$BODY" "$HDRS"
exit 0
