#!/bin/sh
# Runs each test of this directory on the page, in headless Chrome.
# Usage: check.sh <flowgraph> <head.json> <base.json> [test ...]
# The two snapshots are of one project at two commits. Two tests are not in the default set: speed prints times for head.json,
# and exporter needs EXPORTER, the program of Wasm/build.sh, and INDEX, the index store of a C build. It needs node, python3, and Google Chrome.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
flowgraph=$1; head=$2; base=$3; shift 3
[ $# -gt 0 ] || set -- library start changes controls trace
site=$(mktemp -d /tmp/flowgraph-page.XXXXXX)
port=8793

"$flowgraph" site --out "$site" ${EXPORTER:+--exporter "$EXPORTER"} >/dev/null
if [ -n "${INDEX:-}" ]; then
  cp -R "$INDEX" "$site/index"
  (cd "$site" && find index -type f > index.txt)
fi
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
  out=$(node "$here/cdp.mjs" "http://127.0.0.1:$port/test-$name.html" '^(PASS|FAIL|PAGEERR)' 120 || true)
  echo "$out" | sed -n 's/^TIME /  /p'
  if echo "$out" | grep -q '^PASS'; then echo "ok: $name"; else echo "$out" | grep -E '^(FAIL|PAGEERR|no line)' || echo "FAIL $name: no result"; failed=1; fi
done
exit $failed
