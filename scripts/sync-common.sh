#!/usr/bin/env bash
#
# Reports drift between the files vendored from Silencer and their upstream.
#
# Captionist deliberately keeps its own copies rather than a submodule, so this
# is the safety net: it says when a shared fix landed upstream and has not been
# carried across. It only warns - divergence is sometimes correct, and
# extension/js/env.js is intentionally not tracked here because Captionist's
# version is a generalisation rather than a copy.
set -uo pipefail

UPSTREAM="${UPSTREAM:-https://github.com/NiteRix/Silencer.git}"
REF="${REF:-HEAD}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# local path <- upstream path
PAIRS="
extension/js/common/cep.js|extension/js/lib/cep.js
extension/js/common/host.js|extension/js/host.js
extension/jsx/common/json2.jsx|extension/jsx/json2.jsx
scripts/build-ffmpeg.sh|scripts/build-ffmpeg.sh
"

echo "Comparing vendored files against $UPSTREAM@$REF"
git clone --depth 1 --quiet "$UPSTREAM" "$WORK/up" || { echo "could not clone upstream"; exit 0; }

drift=0
while IFS='|' read -r mine theirs; do
  [ -z "$mine" ] && continue
  if [ ! -f "$mine" ] || [ ! -f "$WORK/up/$theirs" ]; then
    echo "  ?  $mine (missing on one side)"
    continue
  fi
  # Ignore the provenance header we prepend and the $.silencer -> $.captionist rename.
  if diff -q \
      <(grep -v 'VENDORED from NiteRix/Silencer' "$mine" | grep -v 'Keep in step with upstream' | sed 's/captionist/silencer/g; s/Captionist/Silencer/g') \
      <(sed 's/captionist/silencer/g; s/Captionist/Silencer/g' "$WORK/up/$theirs") >/dev/null 2>&1; then
    echo "  ok $mine"
  else
    echo "  DRIFT $mine  (upstream: $theirs)"
    drift=$((drift + 1))
  fi
done <<< "$PAIRS"

echo
if [ "$drift" -gt 0 ]; then
  echo "$drift file(s) differ from upstream. Review whether the change should come across."
else
  echo "No drift."
fi
exit 0
