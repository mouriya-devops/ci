#!/usr/bin/env bash
# Fixture `release` task for the release-artifact workflow self-test. Writes one
# file named after the platform. An acceptance branch may add
# selftest/release/violation (empty | subdir | sums | same-name) to produce
# output the workflow must reject.
set -euo pipefail
violation=$(cat "$(dirname "$0")/violation" 2>/dev/null || true)
case "$violation" in
  '') printf 'ci release selftest %s %s %s\n' "$CI_RELEASE_PLATFORM" "$CI_RELEASE_TAG" "$CI_REVISION" \
        >"$CI_RELEASE_DIR/ci-selftest-$CI_RELEASE_PLATFORM.txt" ;;
  empty) ;;
  subdir) mkdir "$CI_RELEASE_DIR/nested" && echo x >"$CI_RELEASE_DIR/nested/file.txt" ;;
  sums) echo x >"$CI_RELEASE_DIR/SHA256SUMS" ;;
  same-name) echo "$CI_RELEASE_PLATFORM" >"$CI_RELEASE_DIR/ci-selftest-shared.txt" ;;
  *) echo "unknown violation '$violation'" >&2; exit 2 ;;
esac
