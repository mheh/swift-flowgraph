#!/bin/sh
# The release build of flowgraph. The Dockerfile and the CI workflow both run it.
# usage: Scripts/build.sh <output-dir>     The directory gets the binary and its resources folder.
set -eu
out="$1"
# A restored build tree can hold the resources of an older commit. The copy runs again when its output is gone.
rm -rf .build/release/flowgraph_flowgraph.resources .build/release/flowgraph_flowgraph.bundle
swift build -c release
mkdir -p "$out"
for file in flowgraph flowgraph.exe flowgraph_flowgraph.resources flowgraph_flowgraph.bundle; do
  [ -e ".build/release/$file" ] || continue
  rm -rf "${out:?}/$file"
  cp -R ".build/release/$file" "$out/"
done
