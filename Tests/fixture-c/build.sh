#!/bin/sh
# Compiles the C fixture into two binaries, with an index store, in the way that a CMake build names its object files.
# usage: Tests/fixture-c/build.sh <source-dir> <build-dir>
set -eu
src="$1"
out="$2"
mkdir -p "$out/CMakeFiles/host.dir" "$out/CMakeFiles/game.dir"
cc="${CC:-clang}"
"$cc" -c "$src/host/main.c" -o "$out/CMakeFiles/host.dir/main.c.o" -index-store-path "$out/idx"
"$cc" -c "$src/shared/util.c" -o "$out/CMakeFiles/host.dir/util.c.o" -index-store-path "$out/idx"
"$cc" -c "$src/game/game.c" -o "$out/CMakeFiles/game.dir/game.c.o" -index-store-path "$out/idx"
"$cc" -c "$src/shared/util.c" -o "$out/CMakeFiles/game.dir/util.c.o" -index-store-path "$out/idx"
