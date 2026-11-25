#include "../shared/api.h"

api_t *GetAPI(void);

static int report(void) { return clamp(7, 5); }

static int run(api_t *api) {
    int total = api->frame(16);
    api->shutdown();
    return total + report();
}

int main(void) {
    return run(GetAPI());
}
