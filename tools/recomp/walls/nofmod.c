/* fmod.c's loop with the remainder computed by hand (exact here: integral values below 2^53). */
#include <stdio.h>
#include <math.h>
int main(void) {
  int i, s = 0;
  double ic = 0;
  for (i = 0; i < 20000000; i++) { double pos = ic - floor(ic / 47486.0) * 47486.0; s += pos >= 42304.0; ic += 3; }
  printf("%d\n", s);
  return 0;
}
