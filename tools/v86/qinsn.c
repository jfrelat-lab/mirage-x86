// qinsn.c — a QEMU TCG plugin that counts guest instructions and writes the running total once a
// second, so QEMU's throughput can be set beside MIRAGE's (M cycles/host-s) and v86's
// (get_instruction_counter). Homebrew's QEMU accepts -plugin and installs qemu-plugin.h, but ships
// no compiled plugins; this is the smallest one that answers "how many instructions per second".
//
//   cc -shared -fPIC -O2 -I/opt/homebrew/include -I/opt/homebrew/include/glib-2.0 \
//      -I/opt/homebrew/lib/glib-2.0/include -undefined dynamic_lookup -o /tmp/libqinsn.so tools/v86/qinsn.c
//   qemu-system-i386 ... -plugin /tmp/libqinsn.so,out=/tmp/qinsn.log
//
// Each line of the log is "<wall seconds since start> <instructions retired so far>". The count is
// per translation block (an inline add of the block's instruction count on entry), which is exact
// unless a block is left early by an exception — the same granularity as MIRAGE's cpu.cycles.
#include <qemu-plugin.h>
#include <pthread.h>
#include <stdio.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

QEMU_PLUGIN_EXPORT int qemu_plugin_version = QEMU_PLUGIN_VERSION;

static struct qemu_plugin_scoreboard *counts;
static qemu_plugin_u64 insns;
static FILE *out;
static volatile int running = 1;

static void tb_trans(struct qemu_plugin_tb *tb, void *userdata)
{
    qemu_plugin_register_vcpu_tb_exec_inline_per_vcpu(tb, QEMU_PLUGIN_INLINE_ADD_U64, insns,
                                                      qemu_plugin_tb_n_insns(tb));
}

static void *reporter(void *arg)
{
    struct timespec t0, t;
    clock_gettime(CLOCK_MONOTONIC, &t0);
    while (running) {
        sleep(1);
        clock_gettime(CLOCK_MONOTONIC, &t);
        double s = (t.tv_sec - t0.tv_sec) + (t.tv_nsec - t0.tv_nsec) / 1e9;
        fprintf(out, "%.1f %llu\n", s, (unsigned long long)qemu_plugin_u64_sum(insns));
        fflush(out);
    }
    return NULL;
}

static void at_exit(void *userdata)
{
    running = 0;
    fprintf(out, "total %llu\n", (unsigned long long)qemu_plugin_u64_sum(insns));
    fflush(out);
}

QEMU_PLUGIN_EXPORT int qemu_plugin_install(qemu_plugin_id_t id, const qemu_info_t *info,
                                           int argc, char **argv)
{
    const char *path = "qinsn.log";
    for (int i = 0; i < argc; i++)
        if (strncmp(argv[i], "out=", 4) == 0) path = argv[i] + 4;
    out = fopen(path, "w");
    if (!out) return -1;
    counts = qemu_plugin_scoreboard_new(sizeof(uint64_t));
    insns = qemu_plugin_scoreboard_u64(counts);
    qemu_plugin_register_vcpu_tb_trans_cb(id, tb_trans, NULL);
    qemu_plugin_register_atexit_cb(id, at_exit, NULL);
    pthread_t th;
    pthread_create(&th, NULL, reporter, NULL);
    return 0;
}
