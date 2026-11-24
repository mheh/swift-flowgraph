#!/bin/sh
# Runs the image on the fixture package and checks what the snapshot holds.
# usage: Tests/fixture/check.sh <image>
set -eu
image="$1"
here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
cp -R "$here/Package.swift" "$here/Sources" "$work/"
run() { docker run --rm -v "$work:/work" "$@"; }

run --entrypoint swift "$image" build
run "$image" snapshot . --sources Sources/App --out snapshot.json --html page.html
run "$image" list entries . --sources Sources/App > "$work/entries.txt"
run "$image" site --out site

fail() { echo "FAILED: $1"; exit 1; }
grep -q '"format":"flowgraph"' "$work/snapshot.json" || fail "the snapshot has no format field"
grep -q 'post("upload")' "$work/entries.txt" || fail "the function that is handed to post(\"upload\") is no entry point"
grep -q 'get("users") { }' "$work/entries.txt" || fail "the closure of get(\"users\") is no entry point"
[ "$(grep -c . "$work/entries.txt")" = 4 ] || fail "expected 4 entry points, got: $(cat "$work/entries.txt")"
grep -q '"bodies":{"' "$work/snapshot.json" || fail "the snapshot has no bodies"
grep -q 'OldStore.find' "$work/snapshot.json" || fail "the snapshot does not name the symbols of the dependency module"
[ -s "$work/page.html" ] && [ -f "$work/site/index.html" ] && [ -f "$work/site/core.js" ] || fail "the page or the site is missing"
echo "ok: $(grep -c . "$work/entries.txt") entry points, snapshot of $(wc -c < "$work/snapshot.json") bytes"
