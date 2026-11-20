/* The same as nested.c, the inner function written into the outer one. */
#include <stdio.h>
#include <math.h>
static int flat(double x) { double fl = floor(x), d = x - fl, r = d < 0.5 ? fl : fl + 1; return r < 32768.0 ? (int)r : 0; }
int main(void) {
  int i, s = 0;
  double x = 0.3;
  for (i = 0; i < 50000000; i++) { s += flat(x); x += 0.001; }
  printf("%d\n", s);
  return 0;
}
