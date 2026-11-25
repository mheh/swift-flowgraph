#!/bin/sh
# Builds the exporter as a WebAssembly program, which the page runs on an index store that the user picks.
# usage: Wasm/build.sh <toolchain-bin> <sdk-bundle> <llvm-project> <work-dir> <out.wasm>
#   toolchain-bin  usr/bin of a swift.org toolchain, which has clang and wasm-ld
#   sdk-bundle     the Swift SDK for WebAssembly of the same release (*_wasm.artifactbundle)
#   llvm-project   a checkout of swiftlang/llvm-project of the same release
set -eu
tools="$1"; bundle="$2"; llvm="$3"; work="$4"; out="$5"
here="$(cd "$(dirname "$0")" && pwd)"
repo="$here/.."
sdk="$(basename "$bundle" .artifactbundle)"
sysroot="$bundle/$sdk/wasm32-unknown-wasip1/WASI.sdk"
emulated="-D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_MMAN -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_GETPID"
flags="-I$here/shim -include $here/shim/single-thread.h $emulated -fno-exceptions"
mkdir -p "$work/llvm" "$work/obj" "$work/lib"

# LLVM's support library. The files that need processes, threads or signals do not compile for WASI, and the reader needs none of them.
export WASI_TOOLS="$tools" WASI_SYSROOT="$sysroot"
cmake -S "$llvm/llvm" -B "$work/llvm" -G "Unix Makefiles" -DCMAKE_TOOLCHAIN_FILE="$here/wasi.cmake" -DUNIX=1 \
  -DCMAKE_BUILD_TYPE=MinSizeRel -DCMAKE_C_FLAGS="$flags" -DCMAKE_CXX_FLAGS="$flags" \
  -DLLVM_HOST_TRIPLE=wasm32-unknown-wasip1 -DLLVM_DEFAULT_TARGET_TRIPLE=wasm32-unknown-wasip1 \
  -DLLVM_TARGETS_TO_BUILD= -DLLVM_ENABLE_PROJECTS= \
  -DLLVM_ENABLE_ZLIB=OFF -DLLVM_ENABLE_ZSTD=OFF -DLLVM_ENABLE_LIBXML2=OFF -DLLVM_ENABLE_TERMINFO=OFF \
  -DLLVM_ENABLE_THREADS=OFF -DLLVM_ENABLE_PIC=OFF -DLLVM_INCLUDE_TESTS=OFF -DLLVM_INCLUDE_BENCHMARKS=OFF \
  -DLLVM_INCLUDE_EXAMPLES=OFF -DLLVM_INCLUDE_UTILS=OFF -DLLVM_BUILD_TOOLS=OFF -DLLVM_INCLUDE_TOOLS=OFF \
  -DLLVM_INCLUDE_DOCS=OFF -DLLVM_ENABLE_BINDINGS=OFF -DLLVM_ENABLE_LIBEDIT=OFF -DLLVM_ENABLE_LIBPFM=OFF > "$work/cmake.log"
make -C "$work/llvm" -j8 -k LLVMSupport > "$work/make.log" 2>&1 || true
rm -f "$work/lib/libSupportPart.a"
find "$work/llvm/lib/Support" -name '*.o' -print0 | xargs -0 "$tools/llvm-ar" rcs "$work/lib/libSupportPart.a"

# The index reader of clang, with the stand-ins of Wasm/shim for what it names of the rest of clang.
compile="$tools/clang++ --target=wasm32-unknown-wasip1 --sysroot=$sysroot -Os -fno-rtti -std=c++17 $flags
  -include llvm/Support/Compression.h -include llvm/Support/Allocator.h
  -I$llvm/clang/include -I$llvm/llvm/include -I$work/llvm/include -I$llvm/clang/lib/Index"
for source in clang/lib/Index/IndexRecordReader.cpp clang/lib/Index/IndexUnitReader.cpp clang/lib/Index/IndexDataStoreUtils.cpp \
  clang/lib/IndexDataStore/IndexDataStore.cpp clang/tools/IndexStore/IndexStore.cpp llvm/lib/Bitstream/Reader/BitstreamReader.cpp; do
  $compile -c "$llvm/$source" -o "$work/obj/$(basename "$source" .cpp).o"
done
$compile -include "$here/shim/posix-missing.h" -c "$llvm/llvm/lib/Support/Path.cpp" -o "$work/obj/Path.o"
for source in SymbolRoles Extras Process; do $compile -c "$here/shim/$source.cpp" -o "$work/obj/$source.o"; done
rm -f "$work/lib/libIndexReader.a"
"$tools/llvm-ar" rcs "$work/lib/libIndexReader.a" "$work"/obj/*.o

# The package: the sources of the tool without what needs a process or the Swift parser, and the index module with the reader linked in.
package="$work/package"
index="$repo/.build/checkouts/indexstore-db/Sources"
mkdir -p "$package/Sources/flowgraph" "$package/Sources/IndexStore" "$package/Sources/IndexStoreCAPI"
cp "$repo"/Sources/flowgraph/*.swift "$index"/IndexStore/*.swift "$package/Sources/"
for file in SwiftBodies Checkout Commands Page main dlopen indexstore_functions+init IndexStoreLibrary; do rm "$package/Sources/$file.swift"; done
mv "$package"/Sources/IndexStore*.swift "$package/Sources/IndexStore/"
mv "$package"/Sources/*.swift "$package/Sources/flowgraph/"
cp "$here/Sources/IndexStoreLibrary.swift" "$package/Sources/IndexStore/"
cp "$here/Sources/main.swift" "$here/Sources/Commands.swift" "$package/Sources/flowgraph/"
cp -R "$index/IndexStoreCAPI/include" "$package/Sources/IndexStoreCAPI/"
chmod -R u+w "$package"
cp "$here/Sources/linked.c" "$package/Sources/IndexStoreCAPI/"
echo 'indexstore_functions_t indexstore_linked_functions(void);' >> "$package/Sources/IndexStoreCAPI/include/IndexStoreCAPI/indexstore_functions.h"
sed "s|@LIB@|$work|g" "$here/Package.swift.in" > "$package/Package.swift"

"$tools/swift" build --package-path "$package" --swift-sdks-path "$(dirname "$bundle")" --swift-sdk "$sdk" -c release
"$tools/llvm-objcopy" --strip-all "$(find "$package/.build" -name flowgraph.wasm -not -path '*.dSYM*' | head -1)" "$out"
ls -l "$out"
