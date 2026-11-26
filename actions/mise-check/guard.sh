#!/usr/bin/env bash
# Inputs (environment): TASK, EVENT_NAME, HEAD_REPO, REPO, RUNNER_ENVIRONMENT.
# Exits non-zero before anything is installed or run when the task name is not
# a plain mise task name, or when a pull request from another repository runs
# on a runner that is not GitHub-hosted.
set -euo pipefail

fail() { echo "::error title=mise-check $1::$2"; exit 1; }

[[ "${TASK:-}" =~ ^[A-Za-z0-9_][A-Za-z0-9_:-]*$ ]] \
  || fail task "task '${TASK:-}' must match ^[A-Za-z0-9_][A-Za-z0-9_:-]*\$"

case "${EVENT_NAME:-}" in
  pull_request|pull_request_target)
    if [ "${HEAD_REPO:-}" != "${REPO:-}" ] && [ "${RUNNER_ENVIRONMENT:-}" != github-hosted ]; then
      fail runner "pull request from '${HEAD_REPO:-<deleted repository>}' must not run on a ${RUNNER_ENVIRONMENT:-unknown} runner of ${REPO:-}"
    fi
    ;;
esac

echo "task '$TASK' on a ${RUNNER_ENVIRONMENT:-unknown} runner for ${EVENT_NAME:-unknown}"
