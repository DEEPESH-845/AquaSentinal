#!/usr/bin/env bash
# Vercel "Ignored Build Step": exit 0 skips the build, exit 1 builds.
# Compare with the last successful deployment of this branch, not just the previous commit, so a push that bundles a
# frontend commit with a later backend-only commit still deploys. No previous deployment, or a commit outside
# Vercel's shallow clone, means build.
base="${VERCEL_GIT_PREVIOUS_SHA:-}"
if [[ -n "$base" ]] && git diff --quiet "$base" HEAD -- . ':!backend' ':!docs' ':!e2e' ':!shared/fixtures' ':!*.md' ':!docker-compose.yml' ':!render.yaml' ':!playwright.config.ts'; then
  echo "no frontend changes since $base: skipping the build"
  exit 0
fi
exit 1
