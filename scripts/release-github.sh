#!/usr/bin/env bash
# Bump package.json version, commit, tag, and push to trigger CI build + GitHub Release.
# Prerequisite: clean git working tree.
#
# Usage:
#   ./scripts/release-github.sh 0.0.98
# Remote defaults to `teamclaw`; override: REMOTE=origin ./scripts/release-github.sh 0.0.98

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <semver>   # example: $0 0.0.98"
  exit 1
fi

VERSION="$1"
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Version must look like 0.0.98 (three numeric segments)."
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

REMOTE="${REMOTE:-teamclaw}"
TAG="v${VERSION}"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree is not clean. Commit or stash changes before releasing."
  exit 1
fi

if ! git remote get-url "$REMOTE" &>/dev/null; then
  echo "Git remote '$REMOTE' not found. Set REMOTE=your-remote or: git remote add teamclaw <url>"
  exit 1
fi

if [[ "$(uname -s)" == "Darwin" ]]; then
  sed -i '' "s/\"version\": \"[^\"]*\"/\"version\": \"${VERSION}\"/" package.json
else
  sed -i "s/\"version\": \"[^\"]*\"/\"version\": \"${VERSION}\"/" package.json
fi

git add package.json
git commit -m "chore: bump version to ${VERSION}"
git tag "${TAG}"

git push "${REMOTE}" main
git push "${REMOTE}" "${TAG}"

echo ""
echo "Done. Pushed ${TAG} → ${REMOTE}. GitHub Actions (CI & Release) will build and attach artifacts to:"
echo "  https://github.com/zhangdszq/teamclaw/releases"
