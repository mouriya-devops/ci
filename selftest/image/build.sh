#!/usr/bin/env bash
# Fixture `build` task for the image workflow self-test: builds two minimal
# images (alpha, beta) with the Actions cache, whatever CI_IMAGES lists.
set -euo pipefail
for var in ACTIONS_RUNTIME_TOKEN ACTIONS_RESULTS_URL; do
  if [ -n "${!var:-}" ]; then echo "$var is set"; else echo "$var is empty"; fi
done
docker buildx inspect ci-selftest >/dev/null 2>&1 \
  || docker buildx create --name ci-selftest --driver docker-container >/dev/null
for role in alpha beta; do
  image="registry.237575.xyz/ci-selftest/$role"
  docker buildx build --builder ci-selftest --load \
    --build-arg ROLE="$role" \
    --label org.opencontainers.image.revision="$CI_REVISION" \
    --cache-from "type=gha,scope=ci-selftest-$role" \
    --cache-to "type=gha,scope=ci-selftest-$role,mode=max" \
    --progress plain \
    -t "$image:$CI_IMAGE_TAG" "$(dirname "$0")"
done
