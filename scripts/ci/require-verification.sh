#!/usr/bin/env bash
set -euo pipefail

sha=${GITHUB_SHA:?Expected an Actions revision}
repo=${GITHUB_REPOSITORY:?Expected an Actions repository}
if [[ "${GITHUB_REF:-}" != refs/heads/main || ! "$sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Production requires an exact main revision." >&2
  exit 1
fi
main_sha=$(gh api "repos/$repo/git/ref/heads/main" --jq .object.sha)
if [[ "$main_sha" != "$sha" ]]; then
  echo "Production requires the current origin/main ($main_sha)." >&2
  exit 1
fi

# Select the latest matching push run before checking its conclusion. A pending
# or failed attempt must never be hidden by an earlier successful attempt.
run=$(gh api "repos/$repo/actions/workflows/verify.yml/runs" --method GET \
  -f branch=main -f event=push -f head_sha="$sha" -F per_page=1)
if ! jq -e --arg sha "$sha" --arg repo "$repo" '
  .workflow_runs[0] |
  .head_sha == $sha and .head_branch == "main" and .event == "push" and
  .head_repository.full_name == $repo and .status == "completed" and .conclusion == "success"
' <<< "$run" >/dev/null; then
  echo "No successful main verification for $sha." >&2
  jq -r '.workflow_runs[0] // {} | "Verification: \(.status // "missing") \(.conclusion // "") \(.html_url // "")"' <<< "$run" >&2
  exit 1
fi
jq -r '.workflow_runs[0] | "Verified main revision \(.head_sha): \(.html_url)"' <<< "$run"
