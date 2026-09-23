#!/usr/bin/env bash
# verify-deploy-bundle-ref.sh — GitHub Releases provenance guard for
# .github/workflows/deploy-bundle.yml inputs.ref.
#
# Context: deploy-bundle.yml is a privileged workflow that runs
# `pnpm install` + `pnpm run build:package` and ships a deploy tarball
# consumed by the staging server. A naming-convention check on the ref
# (e.g. `^v<semver>$`) is not provenance — an attacker able to push a
# matching tag can drive the privileged build against attacker-controlled
# source. This script verifies that the ref corresponds to an actual
# published GitHub Release via the REST API.
#
# Accepted inputs:
#   1) v<major>.<minor>.<patch>[-suffix] tag that maps to a published,
#      non-draft GitHub Release (prereleases allowed — the repo uses
#      -rc suffixes). Verified via
#      GET /repos/{repo}/releases/tags/{tag}: require HTTP 200 with a
#      matching .tag_name and .draft == false.
#   2) 40-character commit SHA that is the .target_commitish or the
#      resolved commit of a published, non-draft GitHub Release.
#      Verified by paginating GET /repos/{repo}/releases (filtered to
#      non-draft) and cross-referencing each release's tag via
#      GET /repos/{repo}/git/ref/tags/{tag_name}.
#
# Fail-closed: any API error (network, 5xx, 404, malformed JSON,
# non-matching tag_name) rejects the ref. A transient GitHub outage
# never silently widens the allowlist.
#
# Usage:
#   verify-deploy-bundle-ref.sh --ref <ref> [--repo <owner/repo>]
#                                [--api-base <url>]
#                                [--github-output <file>]
#
# Exit codes:
#   0 — ref accepted
#   1 — ref rejected (::error:: message on stderr)
#   2 — usage error
#
# Environment:
#   GH_TOKEN — GitHub token (required for live API calls; tests override
#              the gh_api_get function instead)
#   GITHUB_REPOSITORY — fallback for --repo when not specified

set -euo pipefail

REF=""
REPO="${GITHUB_REPOSITORY:-}"
API_BASE="https://api.github.com"
GITHUB_OUTPUT_FILE="${GITHUB_OUTPUT:-}"

SEMVER_RE='^v[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$'
SHA_RE='^[0-9a-fA-F]{40}$'
MAX_RELEASE_PAGES=20

usage() {
  cat >&2 <<'EOF'
Usage: verify-deploy-bundle-ref.sh --ref <ref> [--repo <owner/repo>] [--api-base <url>] [--github-output <file>]

Validates that <ref> corresponds to a published, non-draft GitHub Release.
Accepts:
  - v<semver>[-suffix] tag that maps to a published Release
  - 40-char SHA that is the target_commitish or commit of a published Release

Exits 0 on accept, 1 on reject (fail-closed on API errors).
EOF
}

die_usage() {
  echo "::error::$1" >&2
  usage >&2
  exit 2
}

reject_ref() {
  echo "::error::$1" >&2
  exit 1
}

# --- CLI parsing ---
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ref)            REF="${2:-}"; shift 2 ;;
    --repo)           REPO="${2:-}"; shift 2 ;;
    --api-base)       API_BASE="${2:-}"; shift 2 ;;
    --github-output)  GITHUB_OUTPUT_FILE="${2:-}"; shift 2 ;;
    -h|--help)        usage; exit 0 ;;
    *)                die_usage "unknown argument: $1" ;;
  esac
done

if [[ -z "${REF}" ]]; then
  die_usage "--ref is required"
fi
if [[ -z "${REPO}" ]]; then
  die_usage "--repo is required (or set GITHUB_REPOSITORY)"
fi

# --- API helper (overridable for tests) ---
# Tests source this script and override gh_api_get to return canned
# responses from fixture files. In production, this calls `gh api`
# with the workflow's GITHUB_TOKEN.
gh_api_get() {
  local path="$1"
  gh api \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "${API_BASE%/}${path}"
}

ACCEPTED=0
MATCHED_TAG=""
MATCHED_REASON=""
PINNED_SHA=""

# --- Tag → commit SHA resolver (shared between Case 1 and Case 2) ---
#
# Resolves a tag name to its commit SHA via GET /repos/{repo}/git/ref/tags/{tag}.
# Handles annotated tag nesting:
#   - lightweight tag:  object.type == "commit" → object.sha is the commit
#   - annotated tag:    object.type == "tag"   → object.object.sha is the commit
#
# On success: prints the 40-char SHA to stdout, returns 0.
# On failure: prints an error message to stderr and returns non-zero (caller
# must reject the ref — fail closed).
resolve_tag_commit() {
  local tag_name="$1"
  local ref_json=""
  if ! ref_json="$(gh_api_get "/repos/${REPO}/git/ref/tags/${tag_name}")"; then
    echo "::error::failed to resolve tag ${tag_name} via /git/ref/tags/ API (fail closed)" >&2
    return 1
  fi

  local commit_sha
  commit_sha="$(echo "${ref_json}" | jq -r '
    if .object.type == "commit" then .object.sha
    elif .object.type == "tag" then .object.object.sha
    else empty
    end
  ')"

  if [[ -z "${commit_sha}" ]] || [[ ! "${commit_sha}" =~ ${SHA_RE} ]]; then
    echo "::error::tag ${tag_name} resolved to empty or malformed commit SHA via /git/ref/tags/ API" >&2
    return 1
  fi

  echo "${commit_sha}"
}

# --- Case 1: semver tag → must resolve to a published, non-draft Release ---
if [[ "${REF}" =~ ${SEMVER_RE} ]]; then
  RELEASE_JSON="$(gh_api_get "/repos/${REPO}/releases/tags/${REF}")" \
    || reject_ref "failed to query GitHub Releases API for tag ${REF} (fail closed)"

  TAG_NAME="$(echo "${RELEASE_JSON}" | jq -r '.tag_name // empty')"
  # Fail closed: if .draft is missing or null, treat as draft.
  # jq's // operator treats false as falsy, so we use explicit has() check.
  IS_DRAFT="$(echo "${RELEASE_JSON}" | jq -r 'if has("draft") then .draft else true end | tostring')"

  if [[ -z "${TAG_NAME}" ]]; then
    reject_ref "tag ${REF} does not correspond to any GitHub Release (empty tag_name in API response)"
  fi
  if [[ "${TAG_NAME}" != "${REF}" ]]; then
    reject_ref "release tag_name mismatch: requested=${REF} returned=${TAG_NAME}"
  fi
  if [[ "${IS_DRAFT}" == "true" ]]; then
    reject_ref "tag ${REF} points to a draft release; draft releases are not trusted"
  fi

  # Pin to the tag's resolved commit SHA INSIDE this script (not at
  # checkout time) so a post-validation retarget cannot redirect the
  # build. The workflow checks out this pinned SHA — the user-supplied
  # tag is never checked out directly. If the tag is retargeted after
  # this point, the equality check after checkout will see the
  # mismatch and fail the build.
  PINNED_SHA="$(resolve_tag_commit "${TAG_NAME}")" \
    || reject_ref "tag ${REF} could not be resolved to a commit SHA via /git/ref/tags/ API (fail closed)"

  ACCEPTED=1
  MATCHED_TAG="${TAG_NAME}"
  MATCHED_REASON="tag maps to published Release"
fi

# --- Case 2: 40-char SHA → must be target_commitish or commit of a published Release ---
if [[ "${ACCEPTED}" -eq 0 ]] && [[ "${REF}" =~ ${SHA_RE} ]]; then
  SHA="${REF}"
  PAGE=1
  while :; do
    PAGE_JSON="$(gh_api_get "/repos/${REPO}/releases?per_page=100&page=${PAGE}")" \
      || reject_ref "failed to enumerate GitHub Releases (page ${PAGE}) for SHA verification (fail closed)"

    PAGE_LEN="$(echo "${PAGE_JSON}" | jq 'length // 0')"
    if [[ "${PAGE_LEN}" -eq 0 ]]; then
      break
    fi

    while IFS=$'\t' read -r TAG_NAME TARGET_COMMITTISH; do
      [[ -z "${TAG_NAME}" ]] && continue

      # Case A: target_commitish is the SHA directly
      if [[ "${TARGET_COMMITTISH}" == "${SHA}" ]]; then
        # Pin to the discovered commit SHA. For SHA-input paths the
        # input is already the commit, so PINNED_SHA equals REF, but
        # we still emit it for a uniform workflow contract.
        ACCEPTED=1
        MATCHED_TAG="${TAG_NAME}"
        MATCHED_REASON="SHA matches target_commitish of published Release"
        PINNED_SHA="${SHA}"
        break
      fi

      # Case B: resolve the tag to its commit SHA and compare.
      # If the tag can't be resolved (transient API error, deleted tag,
      # etc.), skip it and continue — the overall fail-closed verdict
      # applies after exhausting all pages, not per-tag.
      if ! TAG_REF_JSON="$(gh_api_get "/repos/${REPO}/git/ref/tags/${TAG_NAME}")"; then
        echo "::warning::failed to resolve tag ${TAG_NAME} to commit SHA; skipping" >&2
        continue
      fi

      TAG_COMMIT="$(echo "${TAG_REF_JSON}" | jq -r '
        if .object.type == "commit" then .object.sha
        elif .object.type == "tag" then .object.object.sha
        else empty
        end
      ')"

      if [[ "${TAG_COMMIT}" == "${SHA}" ]]; then
        # Pin to the discovered commit SHA. For SHA-input paths the
        # input is already the commit, so PINNED_SHA equals REF, but
        # we still emit it for a uniform workflow contract.
        ACCEPTED=1
        MATCHED_TAG="${TAG_NAME}"
        MATCHED_REASON="SHA matches commit of tag ${TAG_NAME} on published Release"
        PINNED_SHA="${TAG_COMMIT}"
        break
      fi
    done < <(echo "${PAGE_JSON}" \
              | jq -r '.[] | select(.draft == false) | [(.tag_name // ""), (.target_commitish // "")] | @tsv')

    if [[ "${ACCEPTED}" -eq 1 ]]; then
      break
    fi

    PAGE=$((PAGE + 1))
    if [[ "${PAGE}" -gt ${MAX_RELEASE_PAGES} ]]; then
      reject_ref "exceeded ${MAX_RELEASE_PAGES} pages of releases while searching for SHA ${SHA}"
    fi
  done
fi

if [[ "${ACCEPTED}" -ne 1 ]]; then
  reject_ref "ref ${REF} is not a trusted release ref (must be a v<major>.<minor>.<patch> tag mapped to a published Release, or a 40-char SHA that is the target_commitish or commit of a published Release)"
fi

echo "::notice::trusted release ref accepted: ${REF} — ${MATCHED_REASON} (tag=${MATCHED_TAG} pinned_sha=${PINNED_SHA})" >&2
# Emit pinned_sha to stdout so callers can consume it without a
# GITHUB_OUTPUT file (tests, manual invocation). The workflow should
# prefer the GITHUB_OUTPUT path below.
echo "pinned_sha=${PINNED_SHA}"
if [[ -n "${GITHUB_OUTPUT_FILE}" ]] && [[ -d "$(dirname "${GITHUB_OUTPUT_FILE}")" ]]; then
  {
    echo "matched_tag=${MATCHED_TAG}"
    echo "pinned_sha=${PINNED_SHA}"
  } >> "${GITHUB_OUTPUT_FILE}"
fi
exit 0
