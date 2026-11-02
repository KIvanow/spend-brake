#!/usr/bin/env bash
# Every commit in the range must carry "Signed-off-by:" with its author's name and email (DCO).
# Usage: scripts/check-signoff.sh <base>..<head>   (no argument: every commit on HEAD)
set -euo pipefail
range="${1:-HEAD}"
# Commits GitHub made itself when the Pages custom domain was set (docs/CNAME only); they are on
# the public main branch, so they are listed here rather than rewritten.
exempt=" 687fb45d433dea9452f41254cc41ed07b1c53076 ae1e65a0dd160aaea7104243422b58a458f90dde "
fail=0
for sha in $(git rev-list --no-merges "$range"); do
  [[ "$exempt" == *" $sha "* ]] && continue
  author="$(git log -1 --format='%an <%ae>' "$sha")"
  if ! git log -1 --format='%(trailers:key=Signed-off-by,valueonly)' "$sha" | grep -qxF "$author"; then
    echo "::error::commit $(git log -1 --format='%h %s' "$sha") has no 'Signed-off-by: $author'"
    fail=1
  fi
done
if [ "$fail" -ne 0 ]; then
  echo "Sign off your commits (git commit -s; to fix a branch: git rebase --signoff <base>)."
  exit 1
fi
echo "All commits in $range are signed off."
