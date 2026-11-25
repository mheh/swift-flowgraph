// What the whole function table of the reader links beyond reading. The property helpers and the unit name
// are copies from clang/lib/Index (IndexSymbol.cpp, IndexUnitWriter.cpp), whose files need the AST and the writer.
// WASI has nothing that watches a directory, so that one fails.
#include "clang/Index/IndexSymbol.h"
#include "clang/Index/IndexUnitWriter.h"
#include "clang/Basic/PathRemapper.h"
#include "clang/DirectoryWatcher/DirectoryWatcher.h"
#include "llvm/ADT/APInt.h"
#include "llvm/Support/Path.h"
#include "llvm/Support/xxhash.h"
using namespace clang;
using namespace clang::index;
using namespace llvm;


std::optional<SymbolProperty>
index::getSwiftAccessLevelFromSymbolPropertySet(SymbolPropertySet Props) {
  if (uint32_t AccessLevel = Props & (1 << 19 | 1 << 18 | 1 << 17)) {
    return (SymbolProperty)AccessLevel;
  }
  return std::nullopt;
}

void index::applyForEachSymbolProperty(SymbolPropertySet Props,
                                  llvm::function_ref<void(SymbolProperty)> Fn) {
#define APPLY_FOR_PROPERTY(K)                                                  \
  if (Props & (SymbolPropertySet)SymbolProperty::K)                            \
  Fn(SymbolProperty::K)

  APPLY_FOR_PROPERTY(Generic);
  APPLY_FOR_PROPERTY(TemplatePartialSpecialization);
  APPLY_FOR_PROPERTY(TemplateSpecialization);
  APPLY_FOR_PROPERTY(UnitTest);
  APPLY_FOR_PROPERTY(IBAnnotated);
  APPLY_FOR_PROPERTY(IBOutletCollection);
  APPLY_FOR_PROPERTY(GKInspectable);
  APPLY_FOR_PROPERTY(Local);
  APPLY_FOR_PROPERTY(ProtocolInterface);
  APPLY_FOR_PROPERTY(SwiftAsync);

#undef APPLY_FOR_PROPERTY

  /// Access levels are bit-packed, so we need to handle them explicitly.
  if (auto AccessLevel = getSwiftAccessLevelFromSymbolPropertySet(Props)) {
    Fn(*AccessLevel);
  }
}

void IndexUnitWriter::getUnitNameForAbsoluteOutputFile(StringRef FilePath,
                                                   SmallVectorImpl<char> &Str,
                                                 const PathRemapper &Remapper) {
  StringRef Fname = sys::path::filename(FilePath);
  Str.append(Fname.begin(), Fname.end());
  Str.push_back('-');
  // Need to be sure we use the remapped path to keep things hermetic.
  std::string RemappedPath = Remapper.remapPath(FilePath);
  auto PathHashVal = llvm::xxh3_64bits(RemappedPath);
  llvm::APInt(64, PathHashVal).toStringUnsigned(Str, /*Radix*/ 36);
}

llvm::Expected<std::unique_ptr<DirectoryWatcher>> DirectoryWatcher::create(
    llvm::StringRef, std::function<void(llvm::ArrayRef<DirectoryWatcher::Event>, bool)>, bool) {
  return llvm::make_error<llvm::StringError>("no directory watcher on this platform", llvm::inconvertibleErrorCode());
}
