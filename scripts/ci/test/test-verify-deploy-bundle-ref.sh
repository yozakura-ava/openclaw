#!/usr/bin/env bash
# Test suite for verify-deploy-bundle-ref.sh.
#
# Each test sets up a mock `gh` binary in a temp directory, prepends
# it to PATH, and runs the validation script with canned API responses.
# The mock `gh` has response bodies embedded as bash variables and
# matches them against the URL path from each call.
#
# Coverage (per Rin's rework brief):
#   - Fake release tag not in Releases API → rejected
#   - API 404/5xx → fail closed
#   - Draft release → rejected
#   - SHA on published release → accepted
# Plus the baseline acceptance paths and rejection paths.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VALIDATE_SCRIPT="${SCRIPT_DIR}/../verify-deploy-bundle-ref.sh"

if [[ ! -x "${VALIDATE_SCRIPT}" ]]; then
  echo "FAIL: ${VALIDATE_SCRIPT} not found or not executable"
  exit 1
fi

# Test result counters
PASS=0
FAIL=0
FAILED_TESTS=()

# --- Helper: run a single test case ---
# Args:
#   $1 — test name
#   $2 — expected exit code (0 or 1, or 2 for usage error)
#   $3 — ref to validate
#   $4 — path to mock-gh script (must handle --api-base style calls)
#   $5 — optional: substring expected in stderr (for ::error:: messages)
run_test() {
  local name="$1"
  local expected_exit="$2"
  local ref="$3"
  local mock_gh="$4"
  local expected_stderr="${5:-}"

  local tmpdir
  tmpdir="$(mktemp -d)"
  local mock_bin="${tmpdir}/bin"
  mkdir -p "${mock_bin}"

  cp "${mock_gh}" "${mock_bin}/gh"
  chmod +x "${mock_bin}/gh"

  local stdout_file="${tmpdir}/stdout"
  local stderr_file="${tmpdir}/stderr"
  local actual_exit=0

  # Run validation script with mock gh in PATH
  PATH="${mock_bin}:${PATH}" \
  GH_TOKEN="test-token" \
  GITHUB_REPOSITORY="yozakura-ava/openclaw" \
    "${VALIDATE_SCRIPT}" --ref "${ref}" \
      >"${stdout_file}" 2>"${stderr_file}" || actual_exit=$?

  local ok=1
  if [[ "${actual_exit}" -ne "${expected_exit}" ]]; then
    echo "  ✗ ${name}: expected exit ${expected_exit}, got ${actual_exit}"
    echo "    stderr: $(head -3 "${stderr_file}")"
    ok=0
  fi
  if [[ -n "${expected_stderr}" ]]; then
    if ! grep -qF -e "${expected_stderr}" "${stderr_file}"; then
      echo "  ✗ ${name}: expected stderr to contain '${expected_stderr}'"
      echo "    actual stderr: $(head -3 "${stderr_file}")"
      ok=0
    fi
  fi

  if [[ "${ok}" -eq 1 ]]; then
    echo "  ✓ ${name}"
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    FAILED_TESTS+=("${name}")
  fi

  rm -rf "${tmpdir}"
}

# --- Mock gh generator ---
# Creates a self-contained mock gh script with embedded response specs.
# Args:
#   $1 — output directory (mock script written as $1/mock_gh)
#   $2+ — response specs in format "URL_PATTERN|STATUS|BODY"
#         where URL_PATTERN is a substring matched against the API path,
#         STATUS is "200" (success) or any other (error), and BODY is
#         the response body (JSON for 200, error message for non-200).
make_mock_gh() {
  local outdir="$1"
  shift
  local specs=("$@")

  local mock_script="${outdir}/mock_gh"

  # Generate the mock script with specs embedded as a bash array
  {
    echo '#!/usr/bin/env bash'
    echo '# Mock gh for testing verify-deploy-bundle-ref.sh'
    echo '# Specs embedded as a bash array of PATTERN|STATUS|BODY triples.'
    echo 'set -uo pipefail'
    echo ''
    echo '# Extract the URL from arguments. gh api receives either a path'
    echo '# (/repos/...) or a full URL (https://api.github.com/repos/...).'
    echo '# Match any arg that contains a slash and looks like a URL/path.'
    echo 'URL_PATH=""'
    echo 'for arg in "$@"; do'
    echo '  # Skip flags (start with -)'
    echo '  [[ "$arg" == -* ]] && continue'
    echo '  # Match if it contains /repos/ or starts with http'
    echo '  if [[ "$arg" == *"/repos/"* ]] || [[ "$arg" == http* ]]; then'
    echo '    URL_PATH="$arg"'
    echo '    break'
    echo '  fi'
    echo 'done'
    echo ''
    echo '# Strip protocol+host prefix to get path+query form, so path-only specs match'
    echo 'URL_PATH="${URL_PATH#https://}"'
    echo 'URL_PATH="${URL_PATH#http://}"'
    echo '# Strip host portion (everything before first /)'
    echo 'URL_PATH="/${URL_PATH#*/}"'
    echo '# Keep query string for matching (so per_page/page specs can differentiate)'
    echo ''
    echo '# Specs: PATTERN|STATUS|BODY'
    echo 'SPECS=('
    for spec in "${specs[@]}"; do
      # Use single quotes for safe embedding; specs must not contain single quotes.
      # JSON bodies use double quotes which are safe inside single-quoted bash strings.
      printf "  '%s'\n" "${spec}"
    done
    echo ')'
    echo ''
    echo 'for spec in "${SPECS[@]}"; do'
    echo '  pattern="${spec%%|*}"'
    echo '  rest="${spec#*|}"'
    echo '  status="${rest%%|*}"'
    echo '  body="${rest#*|}"'
    echo '  if [[ "$URL_PATH" == *"$pattern"* ]]; then'
    echo '    if [[ "$status" == "200" ]]; then'
    echo '      printf "%s" "$body"'
    echo '      exit 0'
    echo '    else'
    echo '      printf "%s" "$body" >&2'
    echo '      exit 1'
    echo '    fi'
    echo '  fi'
    echo 'done'
    echo ''
    echo 'echo "MOCK_GH: no response matched for URL: $URL_PATH" >&2'
    echo 'exit 1'
  } > "${mock_script}"

  chmod +x "${mock_script}"
}

echo "Running verify-deploy-bundle-ref.sh test suite..."
echo ""

# ============================================================
# Test 1: Tag on published, non-draft release → ACCEPTED
# ============================================================
TMP="$(mktemp -d)"
make_mock_gh "${TMP}" \
  "/repos/yozakura-ava/openclaw/releases/tags/v1.2.3|200|{\"tag_name\":\"v1.2.3\",\"draft\":false,\"prerelease\":false,\"target_commitish\":\"abc123\"}"
run_test "tag v1.2.3 on published release → accepted" 0 "v1.2.3" "${TMP}/mock_gh" "trusted release ref accepted"
rm -rf "${TMP}"

# ============================================================
# Test 2: Tag on published prerelease → ACCEPTED (prerelease: allowed)
# ============================================================
TMP="$(mktemp -d)"
make_mock_gh "${TMP}" \
  "/repos/yozakura-ava/openclaw/releases/tags/v1.2.3-rc.1|200|{\"tag_name\":\"v1.2.3-rc.1\",\"draft\":false,\"prerelease\":true,\"target_commitish\":\"abc123\"}"
run_test "tag v1.2.3-rc.1 on published prerelease → accepted" 0 "v1.2.3-rc.1" "${TMP}/mock_gh" "trusted release ref accepted"
rm -rf "${TMP}"

# ============================================================
# Test 3: Tag on draft release → REJECTED (draft: exclude)
# ============================================================
TMP="$(mktemp -d)"
make_mock_gh "${TMP}" \
  "/repos/yozakura-ava/openclaw/releases/tags/v1.2.3|200|{\"tag_name\":\"v1.2.3\",\"draft\":true,\"prerelease\":false,\"target_commitish\":\"abc123\"}"
run_test "tag v1.2.3 on draft release → rejected" 1 "v1.2.3" "${TMP}/mock_gh" "draft release"
rm -rf "${TMP}"

# ============================================================
# Test 4: Fake tag (matching pattern but not in Releases API) → REJECTED (404)
# ============================================================
TMP="$(mktemp -d)"
make_mock_gh "${TMP}" \
  "/repos/yozakura-ava/openclaw/releases/tags/v9.9.9|404|{\"message\":\"Not Found\"}"
run_test "fake tag v9.9.9 not in Releases API → rejected" 1 "v9.9.9" "${TMP}/mock_gh" "fail closed"
rm -rf "${TMP}"

# ============================================================
# Test 5: API 500 → FAIL CLOSED
# ============================================================
TMP="$(mktemp -d)"
make_mock_gh "${TMP}" \
  "/repos/yozakura-ava/openclaw/releases/tags/v1.2.3|500|{\"message\":\"Internal Server Error\"}"
run_test "API 500 for tag query → fail closed" 1 "v1.2.3" "${TMP}/mock_gh" "fail closed"
rm -rf "${TMP}"

# ============================================================
# Test 6: API returns 200 but with wrong tag_name → REJECTED
# ============================================================
TMP="$(mktemp -d)"
make_mock_gh "${TMP}" \
  "/repos/yozakura-ava/openclaw/releases/tags/v1.2.3|200|{\"tag_name\":\"v2.0.0\",\"draft\":false,\"prerelease\":false}"
run_test "API returns wrong tag_name → rejected" 1 "v1.2.3" "${TMP}/mock_gh" "tag_name mismatch"
rm -rf "${TMP}"

# ============================================================
# Test 7: API returns 200 but empty tag_name (malformed response) → REJECTED
# ============================================================
TMP="$(mktemp -d)"
make_mock_gh "${TMP}" \
  "/repos/yozakura-ava/openclaw/releases/tags/v1.2.3|200|{\"message\":\"some other response\",\"id\":123}"
run_test "API returns empty tag_name → rejected" 1 "v1.2.3" "${TMP}/mock_gh" "empty tag_name"
rm -rf "${TMP}"

# ============================================================
# Test 8: SHA on published release (target_commitish match) → ACCEPTED
# ============================================================
SHA_OK="abcdef1234567890abcdef1234567890abcdef12"
TMP="$(mktemp -d)"
make_mock_gh "${TMP}" \
  "/repos/yozakura-ava/openclaw/releases?per_page=100&page=1|200|[{\"tag_name\":\"v1.2.3\",\"draft\":false,\"target_commitish\":\"${SHA_OK}\"},{\"tag_name\":\"v1.2.2\",\"draft\":false,\"target_commitish\":\"deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\"}]"
run_test "SHA matches target_commitish of published release → accepted" 0 "${SHA_OK}" "${TMP}/mock_gh" "target_commitish"
rm -rf "${TMP}"

# ============================================================
# Test 9: SHA matches commit of lightweight tag on published release → ACCEPTED
# ============================================================
SHA_OK="fedcba0987654321fedcba0987654321fedcba09"
TMP="$(mktemp -d)"
# The mock matches by substring, so the order of specs matters: more specific
# patterns must come first. The /releases?per_page=100&page=1 mock must match
# before the /git/ref/tags/v1.2.3 mock (which is also a substring of the page URL).
# To handle this, we use page=1 explicitly in the page pattern.
make_mock_gh "${TMP}" \
  "/releases?per_page=100&page=1|200|[{\"tag_name\":\"v1.2.3\",\"draft\":false,\"target_commitish\":\"main\"}]" \
  "/git/ref/tags/v1.2.3|200|{\"ref\":\"refs/tags/v1.2.3\",\"object\":{\"type\":\"commit\",\"sha\":\"${SHA_OK}\"}}"
run_test "SHA matches commit of tag on published release → accepted" 0 "${SHA_OK}" "${TMP}/mock_gh" "matches commit of tag"
rm -rf "${TMP}"

# ============================================================
# Test 10: SHA matches annotated tag (object.type=tag) → ACCEPTED
# ============================================================
SHA_OK="1111222233334444555566667777888899990000"
TMP="$(mktemp -d)"
make_mock_gh "${TMP}" \
  "/releases?per_page=100&page=1|200|[{\"tag_name\":\"v1.2.3\",\"draft\":false,\"target_commitish\":\"main\"}]" \
  "/git/ref/tags/v1.2.3|200|{\"ref\":\"refs/tags/v1.2.3\",\"object\":{\"type\":\"tag\",\"sha\":\"aaaa\",\"object\":{\"type\":\"commit\",\"sha\":\"${SHA_OK}\"}}}"
run_test "SHA matches annotated tag's commit → accepted" 0 "${SHA_OK}" "${TMP}/mock_gh" "matches commit of tag"
rm -rf "${TMP}"

# ============================================================
# Test 11: SHA not on any release → REJECTED
# ============================================================
SHA_BAD="0000000000000000000000000000000000000000"
TMP="$(mktemp -d)"
make_mock_gh "${TMP}" \
  "/releases?per_page=100&page=1|200|[{\"tag_name\":\"v1.2.3\",\"draft\":false,\"target_commitish\":\"main\"},{\"tag_name\":\"v1.2.2\",\"draft\":false,\"target_commitish\":\"main\"}]" \
  "/git/ref/tags/v1.2.3|200|{\"ref\":\"refs/tags/v1.2.3\",\"object\":{\"type\":\"commit\",\"sha\":\"abcdef1234567890abcdef1234567890abcdef12\"}}" \
  "/git/ref/tags/v1.2.2|200|{\"ref\":\"refs/tags/v1.2.2\",\"object\":{\"type\":\"commit\",\"sha\":\"deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\"}}" \
  "/releases?per_page=100&page=2|200|[]"
run_test "SHA not on any release → rejected" 1 "${SHA_BAD}" "${TMP}/mock_gh" "not a trusted release ref"
rm -rf "${TMP}"

# ============================================================
# Test 12: Draft releases excluded from SHA enumeration
# ============================================================
SHA_OK="abcdef1234567890abcdef1234567890abcdef12"
TMP="$(mktemp -d)"
make_mock_gh "${TMP}" \
  "/releases?per_page=100&page=1|200|[{\"tag_name\":\"v2.0.0-draft\",\"draft\":true,\"target_commitish\":\"${SHA_OK}\"}]" \
  "/releases?per_page=100&page=2|200|[]"
run_test "SHA on draft release only → rejected (drafts excluded)" 1 "${SHA_OK}" "${TMP}/mock_gh" "not a trusted release ref"
rm -rf "${TMP}"

# ============================================================
# Test 13: API 5xx during SHA enumeration → FAIL CLOSED
# ============================================================
SHA_BAD="0000000000000000000000000000000000000000"
TMP="$(mktemp -d)"
make_mock_gh "${TMP}" \
  "/releases?per_page=100&page=1|503|{\"message\":\"Service Unavailable\"}"
run_test "API 503 during SHA enumeration → fail closed" 1 "${SHA_BAD}" "${TMP}/mock_gh" "fail closed"
rm -rf "${TMP}"

# ============================================================
# Test 14: Empty ref → REJECTED (usage error → exit 2)
# ============================================================
TMP="$(mktemp -d)"
make_mock_gh "${TMP}"
run_test "empty ref → rejected" 2 "" "${TMP}/mock_gh" "--ref is required"
rm -rf "${TMP}"

# ============================================================
# Test 15: Ref matching neither tag nor SHA pattern → REJECTED
# ============================================================
TMP="$(mktemp -d)"
make_mock_gh "${TMP}"
run_test "ref matching neither pattern → rejected" 1 "main" "${TMP}/mock_gh" "not a trusted release ref"
rm -rf "${TMP}"

# ============================================================
# Test 16: 39-char SHA (not 40) → REJECTED
# ============================================================
TMP="$(mktemp -d)"
make_mock_gh "${TMP}"
run_test "39-char SHA → rejected (not a valid SHA)" 1 "abcdef1234567890abcdef1234567890abcdef1" "${TMP}/mock_gh" "not a trusted release ref"
rm -rf "${TMP}"

# ============================================================
# Test 17: Feature branch ref → REJECTED
# ============================================================
TMP="$(mktemp -d)"
make_mock_gh "${TMP}"
run_test "feature-branch-style ref → rejected" 1 "feature/my-branch" "${TMP}/mock_gh" "not a trusted release ref"
rm -rf "${TMP}"

# ============================================================
# Test 18: Release with missing draft field → REJECTED (defaults to draft)
# ============================================================
TMP="$(mktemp -d)"
make_mock_gh "${TMP}" \
  "/repos/yozakura-ava/openclaw/releases/tags/v1.2.3|200|{\"tag_name\":\"v1.2.3\"}"
run_test "release with missing draft field → rejected" 1 "v1.2.3" "${TMP}/mock_gh" "draft release"
rm -rf "${TMP}"

# ============================================================
# Test 19: SHA pagination — second page contains matching release
# ============================================================
SHA_OK="abcdef1234567890abcdef1234567890abcdef12"
TMP="$(mktemp -d)"
make_mock_gh "${TMP}" \
  "/releases?per_page=100&page=1|200|[{\"tag_name\":\"v1.2.0\",\"draft\":false,\"target_commitish\":\"aaaa\"},{\"tag_name\":\"v1.1.0\",\"draft\":false,\"target_commitish\":\"bbbb\"}]" \
  "/releases?per_page=100&page=2|200|[{\"tag_name\":\"v1.0.0\",\"draft\":false,\"target_commitish\":\"${SHA_OK}\"}]"
run_test "SHA found on second page → accepted" 0 "${SHA_OK}" "${TMP}/mock_gh" "target_commitish"
rm -rf "${TMP}"

# ============================================================
# Test 20: Tag with suffix v1.0.0-alpha.1 → ACCEPTED
# ============================================================
TMP="$(mktemp -d)"
make_mock_gh "${TMP}" \
  "/repos/yozakura-ava/openclaw/releases/tags/v1.0.0-alpha.1|200|{\"tag_name\":\"v1.0.0-alpha.1\",\"draft\":false,\"prerelease\":true}"
run_test "tag v1.0.0-alpha.1 → accepted" 0 "v1.0.0-alpha.1" "${TMP}/mock_gh" "trusted release ref accepted"
rm -rf "${TMP}"

# ============================================================
# Summary
# ============================================================
echo ""
TOTAL=$((PASS + FAIL))
echo "Results: ${PASS}/${TOTAL} passed"

if [[ "${FAIL}" -gt 0 ]]; then
  echo ""
  echo "FAILED tests:"
  for t in "${FAILED_TESTS[@]}"; do
    echo "  - ${t}"
  done
  exit 1
fi

exit 0
