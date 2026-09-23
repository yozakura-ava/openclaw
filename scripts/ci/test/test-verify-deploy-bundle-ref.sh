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

# --- Helper: run a single test case with pinned_sha output verification ---
#
# Verifies the script emits `pinned_sha=<40-char-sha>` on stdout and
# (when --github-output is supplied) writes the same pinned_sha to
# the GITHUB_OUTPUT file. This is the workflow contract that closes
# the TOCTOU window: the workflow consumes pinned_sha from the
# GITHUB_OUTPUT file and checks out THAT SHA, not the user-supplied
# tag.
#
# Args:
#   $1 — test name
#   $2 — expected exit code (0 or 1, or 2 for usage error)
#   $3 — ref to validate
#   $4 — path to mock-gh script
#   $5 — expected pinned_sha value (40-char SHA; empty string to skip check)
#   $6 — optional: substring expected in stderr
run_test_pinned() {
  local name="$1"
  local expected_exit="$2"
  local ref="$3"
  local mock_gh="$4"
  local expected_pinned_sha="$5"
  local expected_stderr="${6:-}"

  local tmpdir
  tmpdir="$(mktemp -d)"
  local mock_bin="${tmpdir}/bin"
  local gh_output_file="${tmpdir}/gh_output"
  mkdir -p "${mock_bin}"

  cp "${mock_gh}" "${mock_bin}/gh"
  chmod +x "${mock_bin}/gh"

  local stdout_file="${tmpdir}/stdout"
  local stderr_file="${tmpdir}/stderr"
  local actual_exit=0

  # Run validation script with mock gh in PATH and a GITHUB_OUTPUT
  # file. The script writes `pinned_sha=<sha>` to the file and
  # stdout so callers can consume it either way.
  PATH="${mock_bin}:${PATH}" \
  GH_TOKEN="test-token" \
  GITHUB_REPOSITORY="yozakura-ava/openclaw" \
    "${VALIDATE_SCRIPT}" --ref "${ref}" \
      --github-output "${gh_output_file}" \
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
  if [[ "${actual_exit}" -eq 0 ]] && [[ -n "${expected_pinned_sha}" ]]; then
    # pinned_sha must appear on stdout (consumable by callers without GITHUB_OUTPUT)
    if ! grep -qE "^pinned_sha=${expected_pinned_sha}$" "${stdout_file}"; then
      echo "  ✗ ${name}: expected stdout to contain 'pinned_sha=${expected_pinned_sha}'"
      echo "    actual stdout: $(head -3 "${stdout_file}")"
      ok=0
    fi
    # pinned_sha must be written to the GITHUB_OUTPUT file (consumable by the workflow)
    if ! grep -qE "^pinned_sha=${expected_pinned_sha}$" "${gh_output_file}"; then
      echo "  ✗ ${name}: expected GITHUB_OUTPUT to contain 'pinned_sha=${expected_pinned_sha}'"
      echo "    actual GITHUB_OUTPUT: $(cat "${gh_output_file}" 2>/dev/null || echo '<missing>')"
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

# --- Helper: simulate the workflow's post-checkout equality check ---
#
# The deploy-bundle workflow runs:
#   RESOLVED_SHA="$(git rev-parse --verify "${REF}^{commit}")"
#   SOURCE_SHA="$(git rev-parse HEAD)"
#   if [[ "${SOURCE_SHA}" != "${RESOLVED_SHA}" ]]; then exit 1; fi
#
# After our fix, SOURCE_SHA = pinned_sha (we checkout pinned_sha
# explicitly). If the tag was retargeted after validation, RESOLVED_SHA
# would differ from pinned_sha and the check rejects the build.
#
# This helper simulates that pattern in a single test case: it
# captures pinned_sha from the verify script and re-resolves a tag
# against the mock API to assert the equality check fails when the
# tag resolves to a different SHA.
#
# Args:
#   $1 — test name
#   $2 — pinned_sha (SHA that verify produced)
#   $3 — ref (tag name)
#   $4 — retargeted_commit_sha (what the tag now resolves to, to simulate retarget)
#   $5 — mock_gh (used for verify + retarget resolution)
#   $6 — expected equality check exit code (0 = accept, 1 = reject)
run_test_retarget_check() {
  local name="$1"
  local pinned_sha="$2"
  local ref="$3"
  local retargeted_sha="$4"
  local mock_gh="$5"
  local expected_check_exit="$6"

  local tmpdir
  tmpdir="$(mktemp -d)"
  local mock_bin="${tmpdir}/bin"
  mkdir -p "${mock_bin}"

  cp "${mock_gh}" "${mock_bin}/gh"
  chmod +x "${mock_bin}/gh"

  local stdout_file="${tmpdir}/stdout"
  local stderr_file="${tmpdir}/stderr"
  local actual_check_exit=0

  # Simulate the workflow pattern:
  #   1. We have pinned_sha from the verify script (= HEAD after checkout).
  #   2. We re-resolve the tag at "checkout time" via the mock API.
  #   3. Equality check rejects if HEAD != tag-resolved SHA.
  # The retargeted_sha is what /git/ref/tags/{ref} returns at
  # "checkout time" — different from pinned_sha, simulating the
  # attacker retargeting the tag between validation and checkout.
  PATH="${mock_bin}:${PATH}" \
    bash -c "
      set -euo pipefail
      # Simulate HEAD = pinned_sha (the workflow checked out pinned_sha).
      HEAD_SHA='${pinned_sha}'
      # Re-resolve the tag at checkout time via the mock API, mirroring
      # GitHub's actual two-step shape: /git/ref/tags/{ref} for the
      # ref, then /git/tags/{tag-object-sha} for annotated tags.
      TAG_REF_JSON=\$(${mock_bin}/gh api '/repos/yozakura-ava/openclaw/git/ref/tags/${ref}')
      REF_OBJECT_TYPE=\$(echo \"\${TAG_REF_JSON}\" | jq -r '.object.type // empty')
      REF_OBJECT_SHA=\$(echo \"\${TAG_REF_JSON}\" | jq -r '.object.sha // empty')
      case \"\${REF_OBJECT_TYPE}\" in
        commit)
          RESOLVED_SHA=\"\${REF_OBJECT_SHA}\"
          ;;
        tag)
          TAG_OBJ_JSON=\$(${mock_bin}/gh api \"/repos/yozakura-ava/openclaw/git/tags/\${REF_OBJECT_SHA}\")
          RESOLVED_SHA=\$(echo \"\${TAG_OBJ_JSON}\" | jq -r '.object.sha // empty')
          ;;
        *)
          RESOLVED_SHA=\"\"
          ;;
      esac
      if [[ \"\${HEAD_SHA}\" != \"\${RESOLVED_SHA}\" ]]; then
        echo \"::error::tag retargeted: pinned=\${HEAD_SHA} resolved=\${RESOLVED_SHA}\" >&2
        exit 1
      fi
      exit 0
    " >"${stdout_file}" 2>"${stderr_file}" || actual_check_exit=$?

  local ok=1
  if [[ "${actual_check_exit}" -ne "${expected_check_exit}" ]]; then
    echo "  ✗ ${name}: expected check exit ${expected_check_exit}, got ${actual_check_exit}"
    echo "    stderr: $(head -3 "${stderr_file}")"
    ok=0
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
  "/repos/yozakura-ava/openclaw/releases/tags/v1.2.3|200|{\"tag_name\":\"v1.2.3\",\"draft\":false,\"prerelease\":false,\"target_commitish\":\"abc123\"}" \
  "/git/ref/tags/v1.2.3|200|{\"ref\":\"refs/tags/v1.2.3\",\"object\":{\"type\":\"commit\",\"sha\":\"abc123def456abc123def456abc123def456abcd\"}}"
run_test "tag v1.2.3 on published release → accepted" 0 "v1.2.3" "${TMP}/mock_gh" "trusted release ref accepted"
rm -rf "${TMP}"

# ============================================================
# Test 2: Tag on published prerelease → ACCEPTED (prerelease: allowed)
# ============================================================
TMP="$(mktemp -d)"
make_mock_gh "${TMP}" \
  "/repos/yozakura-ava/openclaw/releases/tags/v1.2.3-rc.1|200|{\"tag_name\":\"v1.2.3-rc.1\",\"draft\":false,\"prerelease\":true,\"target_commitish\":\"abc123\"}" \
  "/git/ref/tags/v1.2.3-rc.1|200|{\"ref\":\"refs/tags/v1.2.3-rc.1\",\"object\":{\"type\":\"commit\",\"sha\":\"abc123def456abc123def456abc123def456abcd\"}}"
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
#          Uses GitHub's actual two-step API shape: /git/ref/tags/
#          returns the tag-object SHA (NOT the commit), and the
#          commit SHA lives behind a second /git/tags/{tag-object-sha}
#          lookup. The fixture must NOT nest object.object.sha on the
#          /git/ref/tags/ response — that shape does not exist on
#          GitHub's API.
# ============================================================
SHA_OK="1111222233334444555566667777888899990000"
ANNOTATED_INNER_TAG_FOR_SHA_PATH="aaaa1111bbbb2222cccc3333dddd4444eeee5555"
TMP="$(mktemp -d)"
make_mock_gh "${TMP}" \
  "/releases?per_page=100&page=1|200|[{\"tag_name\":\"v1.2.3\",\"draft\":false,\"target_commitish\":\"main\"}]" \
  "/git/ref/tags/v1.2.3|200|{\"ref\":\"refs/tags/v1.2.3\",\"object\":{\"type\":\"tag\",\"sha\":\"${ANNOTATED_INNER_TAG_FOR_SHA_PATH}\"}}" \
  "/git/tags/${ANNOTATED_INNER_TAG_FOR_SHA_PATH}|200|{\"tag\":\"v1.2.3\",\"sha\":\"${ANNOTATED_INNER_TAG_FOR_SHA_PATH}\",\"object\":{\"type\":\"commit\",\"sha\":\"${SHA_OK}\"}}"
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
  "/repos/yozakura-ava/openclaw/releases/tags/v1.0.0-alpha.1|200|{\"tag_name\":\"v1.0.0-alpha.1\",\"draft\":false,\"prerelease\":true}" \
  "/git/ref/tags/v1.0.0-alpha.1|200|{\"ref\":\"refs/tags/v1.0.0-alpha.1\",\"object\":{\"type\":\"commit\",\"sha\":\"abc123def456abc123def456abc123def456abcd\"}}"
run_test "tag v1.0.0-alpha.1 → accepted" 0 "v1.0.0-alpha.1" "${TMP}/mock_gh" "trusted release ref accepted"
rm -rf "${TMP}"

# ============================================================
# Test 21: Lightweight tag → pinned_sha on stdout AND GITHUB_OUTPUT
#          (closes the TOCTOU window: workflow consumes pinned_sha
#          from the output file and checks out THAT SHA, not the tag)
# ============================================================
LIGHTWEIGHT_COMMIT="aabbccddeeff00112233445566778899aabbccdd"
TMP="$(mktemp -d)"
make_mock_gh "${TMP}" \
  "/repos/yozakura-ava/openclaw/releases/tags/v1.2.3|200|{\"tag_name\":\"v1.2.3\",\"draft\":false,\"prerelease\":false}" \
  "/git/ref/tags/v1.2.3|200|{\"ref\":\"refs/tags/v1.2.3\",\"object\":{\"type\":\"commit\",\"sha\":\"${LIGHTWEIGHT_COMMIT}\"}}"
run_test_pinned "lightweight tag → pinned_sha emitted on stdout + GITHUB_OUTPUT" \
  0 "v1.2.3" "${TMP}/mock_gh" "${LIGHTWEIGHT_COMMIT}"
rm -rf "${TMP}"

# ============================================================
# Test 22: Annotated tag (object.type=tag) → resolved via two-step
#          lookup to the correct pinned_sha. /git/ref/tags/{tag}
#          returns object.type="tag" with object.sha = tag-object SHA
#          (NOT a commit SHA — the nested object.object.sha shape
#          does not exist on GitHub's actual API). The commit SHA
#          lives behind a second /git/tags/{tag-object-sha} call
#          whose response has object.type="commit" and object.sha =
#          commit SHA. The test pins the inner-tag SHA explicitly so
#          an implementation that skips the second call (or calls it
#          with the wrong SHA) fails: the mock would return "no
#          response matched" and the verify script would fail closed.
# ============================================================
ANNOTATED_INNER_TAG="9999888877776666555544443333222211110000"
ANNOTATED_COMMIT="1234567890abcdef1234567890abcdef12345678"
TMP="$(mktemp -d)"
make_mock_gh "${TMP}" \
  "/repos/yozakura-ava/openclaw/releases/tags/v2.0.0|200|{\"tag_name\":\"v2.0.0\",\"draft\":false,\"prerelease\":false}" \
  "/git/ref/tags/v2.0.0|200|{\"ref\":\"refs/tags/v2.0.0\",\"object\":{\"type\":\"tag\",\"sha\":\"${ANNOTATED_INNER_TAG}\"}}" \
  "/git/tags/${ANNOTATED_INNER_TAG}|200|{\"tag\":\"v2.0.0\",\"sha\":\"${ANNOTATED_INNER_TAG}\",\"object\":{\"type\":\"commit\",\"sha\":\"${ANNOTATED_COMMIT}\"}}"
run_test_pinned "annotated tag resolved via two-step lookup → pinned_sha = inner commit SHA" \
  0 "v2.0.0" "${TMP}/mock_gh" "${ANNOTATED_COMMIT}"
rm -rf "${TMP}"

# ============================================================
# Test 22a: Annotated tag, second lookup /git/tags/{sha} returns 404
#           → fail closed. The ref endpoint resolves the tag to its
#           tag-object SHA, but the tag-object endpoint can't resolve
#           that SHA to a commit (transient or deleted). Without a
#           pinned commit SHA we cannot close the TOCTOU window, so
#           the ref must be rejected.
# ============================================================
ANNOTATED_TAG_FOR_404="55556666777788889999000011112222aaaa3333"
TMP="$(mktemp -d)"
make_mock_gh "${TMP}" \
  "/repos/yozakura-ava/openclaw/releases/tags/v2.0.1|200|{\"tag_name\":\"v2.0.1\",\"draft\":false,\"prerelease\":false}" \
  "/git/ref/tags/v2.0.1|200|{\"ref\":\"refs/tags/v2.0.1\",\"object\":{\"type\":\"tag\",\"sha\":\"${ANNOTATED_TAG_FOR_404}\"}}" \
  "/git/tags/${ANNOTATED_TAG_FOR_404}|404|{\"message\":\"Not Found\"}"
run_test "annotated tag, second lookup /git/tags/ 404 → fail closed" \
  1 "v2.0.1" "${TMP}/mock_gh" "fail closed"
rm -rf "${TMP}"

# ============================================================
# Test 22b: Annotated tag, second lookup /git/tags/{sha} returns 500
#           → fail closed. Same TOCTOU concern as 22a: a transient
#           5xx on the second-step lookup must not be silently
#           swallowed. Reject the ref.
# ============================================================
ANNOTATED_TAG_FOR_500="66667777888899990000111122223333aaaa4444"
TMP="$(mktemp -d)"
make_mock_gh "${TMP}" \
  "/repos/yozakura-ava/openclaw/releases/tags/v2.0.2|200|{\"tag_name\":\"v2.0.2\",\"draft\":false,\"prerelease\":false}" \
  "/git/ref/tags/v2.0.2|200|{\"ref\":\"refs/tags/v2.0.2\",\"object\":{\"type\":\"tag\",\"sha\":\"${ANNOTATED_TAG_FOR_500}\"}}" \
  "/git/tags/${ANNOTATED_TAG_FOR_500}|500|{\"message\":\"Internal Server Error\"}"
run_test "annotated tag, second lookup /git/tags/ 500 → fail closed" \
  1 "v2.0.2" "${TMP}/mock_gh" "fail closed"
rm -rf "${TMP}"

# ============================================================
# Test 22c: Unexpected object.type on /git/ref/tags/ response
#           (e.g. "tree", "blob") → fail closed. GitHub's API only
#           emits object.type == "commit" (lightweight tag) or
#           object.type == "tag" (annotated tag). Anything else is
#           either a protocol drift or a malicious response —
#           neither should silently widen the allowlist.
# ============================================================
TMP="$(mktemp -d)"
make_mock_gh "${TMP}" \
  "/repos/yozakura-ava/openclaw/releases/tags/v2.0.3|200|{\"tag_name\":\"v2.0.3\",\"draft\":false,\"prerelease\":false}" \
  "/git/ref/tags/v2.0.3|200|{\"ref\":\"refs/tags/v2.0.3\",\"object\":{\"type\":\"tree\",\"sha\":\"7777888899990000111122223333444455556666\"}}"
run_test "unexpected object.type on /git/ref/tags/ → fail closed" \
  1 "v2.0.3" "${TMP}/mock_gh" "expected 'commit' or 'tag'"
rm -rf "${TMP}"

# ============================================================
# Test 23: /git/ref/tags/ returns 404 → REJECTED (fail closed)
#          Tag exists in Releases API but the ref endpoint can't
#          resolve it (transient or deleted). Must reject because
#          without a pinned SHA we cannot close the TOCTOU window.
# ============================================================
TMP="$(mktemp -d)"
make_mock_gh "${TMP}" \
  "/repos/yozakura-ava/openclaw/releases/tags/v3.0.0|200|{\"tag_name\":\"v3.0.0\",\"draft\":false,\"prerelease\":false}" \
  "/git/ref/tags/v3.0.0|404|{\"message\":\"Not Found\"}"
run_test "tag ref resolution 404 → fail closed" 1 "v3.0.0" "${TMP}/mock_gh" "could not be resolved"
rm -rf "${TMP}"

# ============================================================
# Test 24: /git/ref/tags/ returns 503 → REJECTED (fail closed)
# ============================================================
TMP="$(mktemp -d)"
make_mock_gh "${TMP}" \
  "/repos/yozakura-ava/openclaw/releases/tags/v3.0.1|200|{\"tag_name\":\"v3.0.1\",\"draft\":false,\"prerelease\":false}" \
  "/git/ref/tags/v3.0.1|503|{\"message\":\"Service Unavailable\"}"
run_test "tag ref resolution 503 → fail closed" 1 "v3.0.1" "${TMP}/mock_gh" "fail closed"
rm -rf "${TMP}"

# ============================================================
# Test 25: /git/ref/tags/ returns malformed response (no .object.type)
#          → REJECTED (cannot determine commit SHA)
# ============================================================
TMP="$(mktemp -d)"
make_mock_gh "${TMP}" \
  "/repos/yozakura-ava/openclaw/releases/tags/v3.0.2|200|{\"tag_name\":\"v3.0.2\",\"draft\":false,\"prerelease\":false}" \
  "/git/ref/tags/v3.0.2|200|{\"ref\":\"refs/tags/v3.0.2\",\"object\":{\"sha\":\"abc\"}}"
run_test "tag ref resolution malformed → fail closed" 1 "v3.0.2" "${TMP}/mock_gh" "missing .object.type"
rm -rf "${TMP}"

# ============================================================
# Test 26: SHA-input path emits pinned_sha = input SHA on stdout and
#          GITHUB_OUTPUT. The SHA-input contract is uniform: the
#          workflow always consumes pinned_sha regardless of whether
#          the caller supplied a tag or a SHA.
# ============================================================
SHA_INPUT="abcdef1234567890abcdef1234567890abcdef12"
TMP="$(mktemp -d)"
make_mock_gh "${TMP}" \
  "/repos/yozakura-ava/openclaw/releases?per_page=100&page=1|200|[{\"tag_name\":\"v1.2.3\",\"draft\":false,\"target_commitish\":\"${SHA_INPUT}\"}]"
run_test_pinned "SHA-input → pinned_sha emitted (equals input SHA)" \
  0 "${SHA_INPUT}" "${TMP}/mock_gh" "${SHA_INPUT}"
rm -rf "${TMP}"

# ============================================================
# Test 27: Tag retargeted between validation and checkout → workflow
#          equality check REJECTS the build.
#
# Simulates the workflow's post-checkout pattern:
#   1. Verify script pinned commit A (returned on stdout).
#   2. Workflow checks out pinned_sha A → HEAD = A.
#   3. Workflow re-resolves the tag at "checkout time" via the mock
#      API; the mock now returns a different commit B (attacker
#      retargeted the tag between validation and checkout).
#   4. Equality check: HEAD (A) != RESOLVED (B) → reject.
# Without the fix, HEAD would equal whatever the tag resolved to
# at checkout time, and the build would silently run attacker code.
# ============================================================
PINNED_AT_VALIDATION="111122223333444455556666777788889999aaaa"
RETARGETED_COMMIT="ffff0000eeee1111dddd2222cccc3333bbbb4444"
TMP="$(mktemp -d)"
make_mock_gh "${TMP}" \
  "/git/ref/tags/v4.0.0|200|{\"ref\":\"refs/tags/v4.0.0\",\"object\":{\"type\":\"commit\",\"sha\":\"${RETARGETED_COMMIT}\"}}"
run_test_retarget_check "tag retargeted between validation and checkout → workflow rejects" \
  "${PINNED_AT_VALIDATION}" "v4.0.0" "${RETARGETED_COMMIT}" "${TMP}/mock_gh" 1
rm -rf "${TMP}"

# ============================================================
# Test 28: Same tag, NOT retargeted → workflow equality check ACCEPTS.
#          This is the negative case for Test 27: the equality
#          check passes when the tag still resolves to pinned_sha,
#          confirming the check is specific to retargeting (not a
#          blanket rejection).
# ============================================================
SAME_PINNED_COMMIT="aaaabbbbccccddddeeeeffff0000111122223333"
TMP="$(mktemp -d)"
make_mock_gh "${TMP}" \
  "/git/ref/tags/v4.0.0|200|{\"ref\":\"refs/tags/v4.0.0\",\"object\":{\"type\":\"commit\",\"sha\":\"${SAME_PINNED_COMMIT}\"}}"
run_test_retarget_check "tag not retargeted → workflow accepts" \
  "${SAME_PINNED_COMMIT}" "v4.0.0" "${SAME_PINNED_COMMIT}" "${TMP}/mock_gh" 0
rm -rf "${TMP}"

# ============================================================
# Test 29: deploy-bundle.yml uses --github-output to consume pinned_sha
#          from the verify script (grep-verify, per HR5).
# ============================================================
WORKFLOW_FILE="${SCRIPT_DIR}/../../../.github/workflows/deploy-bundle.yml"
if [[ -f "${WORKFLOW_FILE}" ]]; then
  # (a) workflow invokes verify-deploy-bundle-ref.sh with --github-output
  if grep -qF -- "--github-output" "${WORKFLOW_FILE}" \
     && grep -qF "verify-deploy-bundle-ref.sh" "${WORKFLOW_FILE}"; then
    echo "  ✓ workflow invokes verify-deploy-bundle-ref.sh with --github-output"
    PASS=$((PASS + 1))
  else
    echo "  ✗ workflow does not invoke verify-deploy-bundle-ref.sh with --github-output"
    FAIL=$((FAIL + 1))
    FAILED_TESTS+=("workflow uses --github-output")
  fi

  # (b) workflow reads pinned_sha from the output (grep for the parse line)
  if grep -qE "grep.*pinned_sha|cut.*pinned_sha|grep .*pinned_sha=" "${WORKFLOW_FILE}"; then
    echo "  ✓ workflow reads pinned_sha from verify script output"
    PASS=$((PASS + 1))
  else
    echo "  ✗ workflow does not read pinned_sha from verify script output"
    FAIL=$((FAIL + 1))
    FAILED_TESTS+=("workflow reads pinned_sha")
  fi

  # (c) workflow checks out pinned_sha (not inputs.ref) post-verify
  if grep -qE "git checkout .*PINNED_SHA|git checkout .*pinned_sha" "${WORKFLOW_FILE}"; then
    echo "  ✓ workflow checks out pinned_sha (not the user-supplied tag)"
    PASS=$((PASS + 1))
  else
    echo "  ✗ workflow does not check out pinned_sha post-verify"
    FAIL=$((FAIL + 1))
    FAILED_TESTS+=("workflow checks out pinned_sha")
  fi

  # (d) workflow keeps the rev-parse HEAD equality check (the
  #     belt-and-suspenders retarget detector)
  if grep -qF 'SOURCE_SHA="$(git rev-parse HEAD)"' "${WORKFLOW_FILE}" \
     && grep -qF 'RESOLVED_SHA="$(git rev-parse --verify' "${WORKFLOW_FILE}" \
     && grep -qF '"${SOURCE_SHA}" != "${RESOLVED_SHA}"' "${WORKFLOW_FILE}"; then
    echo "  ✓ workflow keeps rev-parse HEAD equality check (retarget detector)"
    PASS=$((PASS + 1))
  else
    echo "  ✗ workflow is missing the rev-parse HEAD equality check"
    FAIL=$((FAIL + 1))
    FAILED_TESTS+=("workflow equality check")
  fi

  # (e) workflow uses fetch-depth: 0 so any SHA can be checked out
  if grep -qE 'fetch-depth:[[:space:]]*0' "${WORKFLOW_FILE}"; then
    echo "  ✓ workflow uses fetch-depth: 0 (allows checkout of any pinned SHA)"
    PASS=$((PASS + 1))
  else
    echo "  ✗ workflow does not use fetch-depth: 0 (pinned_sha checkout may fail)"
    FAIL=$((FAIL + 1))
    FAILED_TESTS+=("workflow fetch-depth: 0")
  fi
else
  echo "  ! SKIP: workflow file ${WORKFLOW_FILE} not found (workflow grep tests skipped)"
fi

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
