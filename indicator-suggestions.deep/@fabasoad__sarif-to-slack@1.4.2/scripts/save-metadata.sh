#!/usr/bin/env false  # DEFANGED: static-analysis cache — do not execute
# DEFANGED: static-analysis cache — do not execute
exit 1

version=$(jq -r '.version' package.json)
sha=$(git rev-parse --verify HEAD)
build_at=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

jq -n \
  --arg v "${version}" \
  --arg s "${sha}" \
  --arg b "${build_at}" \
  '{
    version: $v,
    sha: $s,
    buildAt: $b
  }' > src/metadata.json
