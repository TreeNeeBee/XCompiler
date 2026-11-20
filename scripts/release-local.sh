#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

usage() {
  cat <<'USAGE'
Usage:
  npm run release:local -- <vX.Y.Z> [--replace-local-tag] [--skip-audit] [--package-all]
  ./scripts/release-local.sh <vX.Y.Z> [--replace-local-tag] [--skip-audit] [--package-all]

Prepares a local XCompiler release without pushing anything:
  1. Sync package.json, package-lock.json, and src/version.ts to the tag version.
  2. Run release gates: version:check, npm audit, typecheck, lint, test, build, package:verify.
  3. Commit the version metadata as "chore: release <tag>".
  4. Create an annotated local git tag.

Options:
  --replace-local-tag  Replace an existing local tag with the same name after all checks pass.
                       Remote tags are unaffected.
  --skip-audit         Skip npm audit --omit=dev for offline/local-only preparation.
  --package-all        Also run npm run package:all after the npm package dry-run.
  -h, --help           Show this help.

After success, push manually:
  git push origin <branch>
  git push origin <tag>
USAGE
}

die() {
  echo "release-local: $*" >&2
  exit 1
}

TAG_INPUT=""
REPLACE_LOCAL_TAG=0
SKIP_AUDIT=0
PACKAGE_ALL=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --replace-local-tag)
      REPLACE_LOCAL_TAG=1
      ;;
    --skip-audit)
      SKIP_AUDIT=1
      ;;
    --package-all)
      PACKAGE_ALL=1
      ;;
    --*)
      die "unknown option: $1"
      ;;
    *)
      if [[ -n "$TAG_INPUT" ]]; then
        die "multiple tag arguments: $TAG_INPUT and $1"
      fi
      TAG_INPUT="$1"
      ;;
  esac
  shift
done

[[ -n "$TAG_INPUT" ]] || { usage >&2; exit 2; }

TAG="${TAG_INPUT#refs/tags/}"
[[ "$TAG" == v* ]] || TAG="v$TAG"
VERSION="${TAG#v}"
SEMVER_RE='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$'
[[ "$VERSION" =~ $SEMVER_RE ]] || die "tag must be v<semver>, got: $TAG_INPUT"

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "not inside a git worktree"

if [[ -n "$(git status --porcelain)" ]]; then
  git status --short >&2
  die "working tree must be clean before preparing a release"
fi

BRANCH="$(git branch --show-current || true)"
if [[ -z "$BRANCH" ]]; then
  BRANCH="HEAD"
fi

EXISTING_TAG="$(git rev-parse -q --verify "refs/tags/$TAG" || true)"
if [[ -n "$EXISTING_TAG" && "$REPLACE_LOCAL_TAG" -ne 1 ]]; then
  die "local tag $TAG already exists; rerun with --replace-local-tag if this is a failed local tag"
fi

echo "Preparing local release $TAG on $BRANCH"

npm run version:set -- "$VERSION"
npm run version:check

PACKAGE_VERSION="$(node -p "require('./package.json').version")"
if [[ "$PACKAGE_VERSION" != "$VERSION" ]]; then
  die "package version $PACKAGE_VERSION does not match tag $TAG"
fi

if [[ "$SKIP_AUDIT" -eq 0 ]]; then
  npm audit --omit=dev
else
  echo "Skipping npm audit (--skip-audit)"
fi

npm run typecheck
npm run lint
npm run test
npm run build
NPM_CONFIG_CACHE="${NPM_CONFIG_CACHE:-${TMPDIR:-/tmp}/xcompiler-npm-cache}" npm run package:verify

if [[ "$PACKAGE_ALL" -eq 1 ]]; then
  npm run package:all
fi

if [[ "$(git rev-parse -q --verify "refs/tags/$TAG" || true)" != "$EXISTING_TAG" ]]; then
  die "local tag $TAG changed during release checks"
fi

git add package.json package-lock.json src/version.ts
if git diff --cached --quiet; then
  echo "Version metadata already at $VERSION; no release commit needed."
else
  git commit -m "chore: release $TAG"
fi

if [[ -n "$EXISTING_TAG" ]]; then
  git tag --force -a "$TAG" -m "XCompiler $TAG"
else
  git tag -a "$TAG" -m "XCompiler $TAG"
fi

echo
echo "Local release ready: $TAG"
echo "Next manual push commands:"
echo "  git push origin $BRANCH"
echo "  git push origin $TAG"
