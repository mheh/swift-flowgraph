#!/bin/sh
# The release build of flowgraph, on Linux or on macOS. The Dockerfile and the CI workflow both run it.
# usage: Scripts/build.sh <output-dir>     The directory gets the binary and its resources folder.
set -eu
out="$1"
# A restored build tree can hold the resources of an older commit. The copy runs again when its output is gone.
rm -rf .build/release/flowgraph_flowgraph.resources .build/release/flowgraph_flowgraph.bundle
swift build -c release
mkdir -p "$out"
cp .build/release/flowgraph "$out/"
for resources in .build/release/flowgraph_flowgraph.resources .build/release/flowgraph_flowgraph.bundle; do
  [ -e "$resources" ] || continue
  rm -rf "$out/$(basename "$resources")"
  cp -R "$resources" "$out/"
done
