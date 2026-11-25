// WASI has one thread, and its C++ library has no lock types. LLVM names them even with threads off.
// These types have the names and lock nothing.
#include <endian.h>
#ifdef __cplusplus
#include <__config>
#if !_LIBCPP_HAS_THREADS
namespace std {
struct mutex { void lock() {} void unlock() {} bool try_lock() { return true; } };
struct recursive_mutex : mutex {};
struct shared_mutex : mutex { void lock_shared() {} void unlock_shared() {} bool try_lock_shared() { return true; } };
template <class M> struct shared_lock { explicit shared_lock(M &) {} };
}
#endif
#endif
