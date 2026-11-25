#!/bin/sh
# Runs each test of this directory on the page, in headless Chrome.
# Usage: check.sh <flowgraph> <head.json> <base.json> [test ...]
# The two snapshots are of one project at two commits. It needs node, python3, and Google Chrome.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
flowgraph=$1; head=$2; base=$3; shift 3
[ $# -gt 0 ] || set -- library start changes
site=$(mktemp -d /tmp/flowgraph-page.XXXXXX)
port=8793

"$flowgraph" site --out "$site" >/dev/null
cp "$head" "$site/head.json"
cp "$base" "$site/base.json"
python3 -m http.server "$port" --bind 127.0.0.1 --directory "$site" >/dev/null 2>&1 &
server=$!
trap 'kill $server' EXIT
sleep 1

failed=0
for name in "$@"; do
  cp "$here/$name.js" "$site/test-$name.js"
  sed "s|</html>|<script src=\"test-$name.js\"></script></html>|" "$site/index.html" > "$site/test-$name.html"
  node "$here/cdp.mjs" "http://127.0.0.1:$port/test-$name.html" '^(PASS|FAIL|PAGEERR)' 60 | grep -E '^(PASS|FAIL|PAGEERR|no line)' | grep -v '^PASS' && failed=1 || echo "ok: $name"
done
exit $failed
