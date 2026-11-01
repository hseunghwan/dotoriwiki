#!/bin/zsh
# Puts one commit on the live gateway and restarts it. The live gateway runs from its own
# worktree, so sessions editing this checkout never change what is running.
#
#   scripts/deploy.sh            deploy this checkout's HEAD
#   scripts/deploy.sh <commit>   deploy a specific commit
set -euo pipefail

REPO=${0:A:h:h}
DEPLOY=${DOTORIWIKI_DEPLOY_DIR:-$HOME/dotoriwiki-gateway}
SHA=$(git -C $REPO rev-parse --verify "${1:-HEAD}^{commit}")

if [[ ! -d $DEPLOY ]]; then
  git -C $REPO worktree add --detach $DEPLOY $SHA
elif [[ -n $(git -C $DEPLOY status --porcelain --untracked-files=no) ]]; then
  echo "refusing: $DEPLOY has local edits" >&2
  exit 1
fi
git -C $DEPLOY checkout --detach -q $SHA
(cd $DEPLOY && npm ci --omit=dev --no-audit --no-fund --silent)
$DEPLOY/scripts/install-launchd.sh
echo "deployed $(git -C $DEPLOY log --oneline -1)"
