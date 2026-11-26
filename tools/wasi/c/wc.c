// wc.c — lines, words and bytes of stdin, as wc counts them; then of each file named.
#include <stdio.h>
#include <ctype.h>

static void count(FILE *f, const char *name) {
  long l = 0, w = 0, c = 0; int in = 0, ch;
  while ((ch = getc(f)) != EOF) { c++; if (ch == '\n') l++; if (isspace(ch)) in = 0; else if (!in) { in = 1; w++; } }
  printf("%7ld %7ld %7ld %s\n", l, w, c, name);
}
int main(int argc, char **argv) {
  if (argc < 2) { count(stdin, ""); return 0; }
  int bad = 0;
  for (int i = 1; i < argc; i++) { FILE *f = fopen(argv[i], "r"); if (!f) { perror(argv[i]); bad = 1; continue; } count(f, argv[i]); fclose(f); }
  return bad;
}
