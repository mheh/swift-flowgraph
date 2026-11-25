// What LLVM's Unix file code names and WASI does not have: users, owners, file locks, a umask.
// Each stand-in fails or does nothing, and the index reader calls none of them.
#define _GNU_SOURCE 1
#include <dlfcn.h>
#include <sys/types.h>
#include <sys/statvfs.h>
#include <fcntl.h>
#include <errno.h>
struct passwd { char *pw_name; char *pw_dir; uid_t pw_uid; gid_t pw_gid; };
static inline struct passwd *getpwuid(uid_t) { return 0; }
static inline struct passwd *getpwnam(const char *) { return 0; }
static inline int getpwuid_r(uid_t, struct passwd *, char *, size_t, struct passwd **result) { *result = 0; return ENOSYS; }
static inline int getpwnam_r(const char *, struct passwd *, char *, size_t, struct passwd **result) { *result = 0; return ENOSYS; }
static inline uid_t getuid(void) { return 0; }
static inline mode_t umask(mode_t) { return 022; }
static inline int fchown(int, uid_t, gid_t) { errno = ENOSYS; return -1; }
#ifndef F_SETLK
#define F_RDLCK 0
#define F_WRLCK 1
#define F_UNLCK 2
#define F_SETLK 6
#define F_SETLKW 7
#endif
#define MNT_LOCAL 0
#define f_flags f_flag
typedef struct { const char *dli_fname; void *dli_fbase; const char *dli_sname; void *dli_saddr; } Dl_info;
static inline int dladdr(const void *, Dl_info *) { return 0; }
