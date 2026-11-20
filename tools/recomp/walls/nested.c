/* A static function calling another, in a hot loop (x86c's fi16n -> frnear). */
#include <stdio.h>
#include <math.h>
static double inner(double x) { double fl = floor(x), d = x - fl; return d < 0.5 ? fl : fl + 1; }
static int nested(double x) { double r = inner(x); return r < 32768.0 ? (int)r : 0; }
static int flat(double x) { double fl = floor(x), d = x - fl, r = d < 0.5 ? fl : fl + 1; return r < 32768.0 ? (int)r : 0; }
int main(int argc, char **argv) {
  int i, s = 0;
  double x = 0.3;
  if (argc > 5) { for (i = 0; i < 50000000; i++) { s += flat(x); x += 0.001; } }
  else { for (i = 0; i < 50000000; i++) { s += nested(x); x += 0.001; } }
  printf("%d\n", s);
  return 0;
}
