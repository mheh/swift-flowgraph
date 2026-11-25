#include "../shared/api.h"

static int counter;

static int G_Frame(int time) {
    counter = clamp(counter + time, 1000);
    return counter;
}

static void G_Shutdown(void) {
    counter = 0;
}

static int report(void) { return counter; }

API_EXPORT api_t *GetAPI(void) {
    static api_t api;
    api.version = API_VERSION;
    api.frame = G_Frame;
    api.shutdown = G_Shutdown;
    return &api;
}

int status(void) { return report(); }
