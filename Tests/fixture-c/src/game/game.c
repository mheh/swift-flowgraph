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

int status(void);

API_EXPORT api_t *GetAPI(void) {
    static api_t api;
    api.version = API_VERSION;
    api.frame = G_Frame;
    api.shutdown = G_Shutdown;
    return &api;
}

int status(void) { return report(); }

int G_Command(int kind, int amount) {
    switch (kind) {
    case 1:
        for (int i = 0; i < amount; i++)
            counter += i;
        break;
    case 2:
        if (amount < 0) {
            return -1;
        } else if (amount == 0)
            G_Shutdown();
        else
            counter = clamp(amount,
                            1000);
        break;
    default:
#ifdef API_TRACE
        report();
#else
        counter = 0;
#endif
    }
    do {
        amount--;
    } while (amount > API_VERSION);
    return status();
}
