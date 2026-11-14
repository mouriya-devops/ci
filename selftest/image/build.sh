#!/usr/bin/env bash
# Fixture `build` task for the image workflow self-test: builds two minimal
# images, one per CI_IMAGES entry, with the Actions cache; the last path
# segment of each repository is its role.
set -euo pipefail
for var in ACTIONS_RUNTIME_TOKEN ACTIONS_RESULTS_URL; do
  if [ -n "${!var:-}" ]; then echo "$var is set"; else echo "$var is empty"; fi
done
docker buildx inspect ci-selftest >/dev/null 2>&1 \
  || docker buildx create --name ci-selftest --driver docker-container >/dev/null
while IFS= read -r image; do
  [ -n "$image" ] || continue
  role=${image##*/}
  docker buildx build --builder ci-selftest --load \
    --build-arg ROLE="$role" --build-arg NONCE="${GITHUB_RUN_ID:-local}" \
    --label org.opencontainers.image.revision="$CI_REVISION" \
    --label org.opencontainers.image.source="https://github.com/${GITHUB_REPOSITORY:-mouriya-devops/ci}" \
    --cache-from "type=gha,scope=ci-selftest-$role" \
    --cache-to "type=gha,scope=ci-selftest-$role,mode=max" \
    --progress plain \
    -t "$image:$CI_IMAGE_TAG" "$(dirname "$0")"
done <<<"$CI_IMAGES"
