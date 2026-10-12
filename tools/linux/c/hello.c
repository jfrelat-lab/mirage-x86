/* hello.c — printf, argv, malloc and an exit status: the first C program for MIRAGE-LINUX. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int main(int argc, char **argv) {
  printf("hello from i386 Linux, argc=%d\n", argc);
  for (int i = 1; i < argc; i++) printf("argv[%d]=%s\n", i, argv[i]);
  char *p = malloc(100000);
  strcpy(p, "heap ok");
  puts(p);
  free(p);
  double x = 1.0;
  for (int i = 0; i < 10; i++) x = x * 1.5 + 0.25;
  printf("x=%.6f\n", x);
  return 7;
}
