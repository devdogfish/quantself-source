#!/usr/bin/env bash
set -euo pipefail

image=${1:?Expected an image tag}
{
  docker image inspect "$image" --format 'Image {{index .RepoTags 0}} bytes: {{.Size}}'
  echo 'Layers (top first):'
  docker history --format '{{.Size}} {{.CreatedBy}}' "$image"
} | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"
