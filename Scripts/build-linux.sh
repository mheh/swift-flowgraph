#!/bin/sh
# The release build of flowgraph on Linux, in a Swift image. The Dockerfile and the CI workflow both run it.
# IndexStoreDB has C++ that includes dispatch and Block, which the Linux toolchain keeps beside the Swift libraries.
# usage: Scripts/build-linux.sh <output-dir>     The directory gets the binary and its resources folder.
set -eu
out="$1"
# A restored build tree can hold the resources of an older commit, and the copy task does not always see that. The copy runs again when its output is gone.
rm -rf .build/release/flowgraph_flowgraph.resources
swift build -c release --build-system native \
  -Xcxx -I/usr/lib/swift -Xcxx -I/usr/lib/swift/Block -Xcc -I/usr/lib/swift -Xcc -I/usr/lib/swift/Block
mkdir -p "$out"
cp .build/release/flowgraph "$out/"
rm -rf "$out/flowgraph_flowgraph.resources"
cp -R .build/release/flowgraph_flowgraph.resources "$out/"
