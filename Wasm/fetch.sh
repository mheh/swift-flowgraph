#!/bin/sh
# Gets what Wasm/build.sh needs beside a toolchain: the Swift SDK for WebAssembly, and the part of LLVM that holds the index reader.
# usage: Wasm/fetch.sh <dir>     The directory gets sdk/<bundle>.artifactbundle and llvm-project.
set -eu
dir="$1"
release=swift-6.4.2-RELEASE
sum=83baca83553f8c443cda7b84800912e6e709c3acd2e7ebf277794ca5836c0da5
mkdir -p "$dir/sdk"
curl -fsSL --retry 2 -o "$dir/sdk.tar.gz" \
  "https://download.swift.org/swift-6.4.2-release/wasm-sdk/$release/${release}_wasm.artifactbundle.tar.gz"
if command -v sha256sum > /dev/null; then check="sha256sum -c -"; else check="shasum -a 256 -c -"; fi
echo "$sum  $dir/sdk.tar.gz" | $check
tar -xzf "$dir/sdk.tar.gz" -C "$dir/sdk"
rm "$dir/sdk.tar.gz"
git -c advice.detachedHead=false clone --quiet --depth 1 --filter=blob:none --sparse --branch "$release" https://github.com/swiftlang/llvm-project "$dir/llvm-project"
git -C "$dir/llvm-project" sparse-checkout set --no-cone /cmake/ /third-party/ '/llvm/*' \
  /clang/tools/IndexStore/ /clang/lib/IndexDataStore/ /clang/lib/Index/ /clang/include/clang/Index/ /clang/include/indexstore/ \
  /clang/include/clang/Basic/ /clang/include/clang/DirectoryWatcher/ /clang/lib/DirectoryWatcher/
