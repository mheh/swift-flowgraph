#include "api.h"

// This file is compiled into both binaries.
int clamp(int value, int limit) {
    return value > limit ? limit : value;
}
