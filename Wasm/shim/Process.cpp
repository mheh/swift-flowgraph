// The few functions of LLVM's process and signal code that the index reader links.
// WASI has one process, no signals and no terminal colours, so each does the least that is correct.
#include "llvm/Support/Process.h"
#include "llvm/Support/Signals.h"
#include <cerrno>
#include <unistd.h>

using namespace llvm;
using namespace llvm::sys;

std::error_code Process::SafelyCloseFileDescriptor(int FD) {
  return ::close(FD) < 0 ? std::error_code(errno, std::generic_category()) : std::error_code();
}
Expected<unsigned> Process::getPageSize() { return 65536; }
bool Process::ColorNeedsFlush() { return false; }
bool Process::FileDescriptorIsDisplayed(int) { return false; }
bool Process::FileDescriptorHasColors(int) { return false; }
const char *Process::ResetColor() { return ""; }
const char *Process::OutputReverse() { return ""; }
const char *Process::OutputColor(char, bool, bool) { return ""; }
const char *Process::OutputBold(bool) { return ""; }
void llvm::sys::RunInterruptHandlers() {}

extern "C" int posix_madvise(void *, size_t, int) { return 0; }
