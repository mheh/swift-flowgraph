// The index reader needs one type of the AST reader only.
#pragma once
#include "llvm/ADT/SmallVector.h"
#include <cstdint>
namespace clang { class ASTReader { public: using RecordData = llvm::SmallVector<uint64_t, 64>; }; }
