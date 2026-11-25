// The two role helpers of clang/lib/Index/IndexSymbol.cpp, which the reader needs. The rest of that file needs the AST.
#include "clang/Index/IndexSymbol.h"
using namespace clang;
using namespace clang::index;

bool index::applyForEachSymbolRoleInterruptible(SymbolRoleSet Roles,
                                   llvm::function_ref<bool(SymbolRole)> Fn) {
#define APPLY_FOR_ROLE(Role) \
  if (Roles & (unsigned)SymbolRole::Role) \
    if (!Fn(SymbolRole::Role)) \
      return false;

  APPLY_FOR_ROLE(Declaration);
  APPLY_FOR_ROLE(Definition);
  APPLY_FOR_ROLE(Reference);
  APPLY_FOR_ROLE(Read);
  APPLY_FOR_ROLE(Write);
  APPLY_FOR_ROLE(Call);
  APPLY_FOR_ROLE(Dynamic);
  APPLY_FOR_ROLE(AddressOf);
  APPLY_FOR_ROLE(Implicit);
  APPLY_FOR_ROLE(Undefinition);
  APPLY_FOR_ROLE(RelationChildOf);
  APPLY_FOR_ROLE(RelationBaseOf);
  APPLY_FOR_ROLE(RelationOverrideOf);
  APPLY_FOR_ROLE(RelationReceivedBy);
  APPLY_FOR_ROLE(RelationCalledBy);
  APPLY_FOR_ROLE(RelationExtendedBy);
  APPLY_FOR_ROLE(RelationAccessorOf);
  APPLY_FOR_ROLE(RelationContainedBy);
  APPLY_FOR_ROLE(RelationIBTypeOf);
  APPLY_FOR_ROLE(RelationSpecializationOf);
  APPLY_FOR_ROLE(NameReference);

#undef APPLY_FOR_ROLE

  return true;
}

void index::applyForEachSymbolRole(SymbolRoleSet Roles,
                                   llvm::function_ref<void(SymbolRole)> Fn) {
  applyForEachSymbolRoleInterruptible(Roles, [&](SymbolRole r) -> bool {
    Fn(r);
    return true;
  });
}
