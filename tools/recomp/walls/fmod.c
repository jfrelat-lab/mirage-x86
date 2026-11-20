/* fmod in a hot loop (rc.h's 3DAh beam before it was cached): PRISM emits M.rt.fmod(...). */
#include <stdio.h>
#include <math.h>
int main(void) {
  int i, s = 0;
  double ic = 0;
  for (i = 0; i < 20000000; i++) { double pos = fmod(ic, 47486.0); s += pos >= 42304.0; ic += 3; }
  printf("%d\n", s);
  return 0;
}
