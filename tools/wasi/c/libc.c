// libc.c — wasi-libc's own work, little of it the host's: formatting, floats, the heap, sorting, strings,
// the clocks, the environment, an exit status of its own.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <time.h>
#include <errno.h>

static int cmp(const void *a, const void *b) { return *(const int *)a - *(const int *)b; }

int main(int argc, char **argv) {
  printf("%d args:", argc); for (int i = 1; i < argc; i++) printf(" [%s]", argv[i]); printf("\n");
  printf("%5d|%-5d|%05.1f|%e|%g|%x|%llu|%s|%c\n", 42, 42, 3.14159, 1e-7, sqrt(2.0), 0xbeef, 18446744073709551615ULL, "str", 'c');
  printf("%.17g %.17g %.17g\n", sin(1.0), exp(10.0), pow(2.0, 0.5));
  size_t total = 0;
  for (int i = 1; i <= 2000; i++) { char *p = malloc(i * 37); if (!p) { printf("malloc failed\n"); return 1; } memset(p, i, i * 37); total += i * 37; if (i % 3) free(p); }
  printf("allocated %zu\n", total);
  char *big = malloc(32 << 20); printf("32 MiB: %s\n", big ? "yes" : "no"); if (big) { big[(32 << 20) - 1] = 1; free(big); }
  int v[1000]; unsigned s = 12345; for (int i = 0; i < 1000; i++) { s = s * 1103515245 + 12345; v[i] = (s >> 8) % 100000; }
  qsort(v, 1000, sizeof v[0], cmp); printf("sorted: %d %d %d\n", v[0], v[500], v[999]);
  char buf[64]; snprintf(buf, sizeof buf, "%s-%s", "abc", "def"); printf("%s %zu %s %d\n", buf, strlen(buf), strstr(buf, "c-d"), strcmp("a", "b"));
  printf("strtol %ld strtod %g atoi %d\n", strtol("-0x1f", NULL, 16), strtod("2.5e3", NULL), atoi("77"));
  struct timespec a, b; clock_gettime(CLOCK_MONOTONIC, &a); clock_gettime(CLOCK_MONOTONIC, &b);
  printf("monotonic: %s; realtime after 2020: %s\n", (b.tv_sec > a.tv_sec || (b.tv_sec == a.tv_sec && b.tv_nsec >= a.tv_nsec)) ? "ordered" : "backwards", time(NULL) > 1577836800 ? "yes" : "no");
  printf("LANG=%s NOPE=%s\n", getenv("LANG"), getenv("NOPE") ? "set" : "(null)");
  errno = ENOENT; printf("strerror: %s\n", strerror(errno));
  fprintf(stderr, "to stderr\n");
  return 42;
}
