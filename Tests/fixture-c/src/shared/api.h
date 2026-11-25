// The table of functions that the game hands to the host.
#define API_EXPORT __attribute__((visibility("default")))
#define API_VERSION 3
#define API_UNUSED 99

typedef struct {
    int version;
    int (*frame)(int time);
    void (*shutdown)(void);
} api_t;

int clamp(int value, int limit);
