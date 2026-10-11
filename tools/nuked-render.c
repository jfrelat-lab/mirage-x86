/* nuked-render.c — Nuked-OPL3 as a black-box reference for src/opl.js (tools/opl-compare.mjs):
 * a register log in, native-rate samples out. Nuked-OPL3 is LGPL and is NOT part of MIRAGE; fetch it
 * and build this outside the repository:
 *   curl -O https://raw.githubusercontent.com/nukeykt/Nuked-OPL3/master/opl3.c
 *   curl -O https://raw.githubusercontent.com/nukeykt/Nuked-OPL3/master/opl3.h
 *   cc -O2 -o render nuked-render.c opl3.c
 * log: records of { uint32 sample; uint16 reg (bank << 8 | index); uint8 value } little-endian.
 * usage: render <log> <total samples> <out.raw>   (int16 stereo, 49716 Hz) */
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include "opl3.h"
int main(int argc, char **argv) {
  if (argc < 4) return 2;
  FILE *f = fopen(argv[1], "rb"), *o = fopen(argv[3], "wb");
  uint32_t total = (uint32_t)atol(argv[2]);
  static opl3_chip chip; OPL3_Reset(&chip, 49716);
  uint8_t rec[7]; int have = fread(rec, 1, 7, f) == 7;
  for (uint32_t s = 0; s < total; s++) {
    while (have && (rec[0] | rec[1] << 8 | rec[2] << 16 | (uint32_t)rec[3] << 24) <= s) {
      OPL3_WriteReg(&chip, rec[4] | rec[5] << 8, rec[6]);
      have = fread(rec, 1, 7, f) == 7;
    }
    int16_t buf[4]; OPL3_Generate(&chip, buf); fwrite(buf, 2, 2, o);
  }
  fclose(o); return 0;
}
