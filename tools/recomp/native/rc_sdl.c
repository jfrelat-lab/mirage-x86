/* rc_sdl.c -- the native platform of tools/recomp: the same generated C that PRISM compiles, built
   with clang against this file and SDL2. It is the reference that separates the translator's bugs
   from PRISM's: if this matches MIRAGE's frames and PRISM does not, the fault is PRISM's.

   What it supplies (rc.h): guest memory as a 1 MiB + 64 KB array, the VGA DAC behind ports
   3C7h-3C9h (six bits, as MIRAGE's src/bios.js keeps it), the video mode number, and port 60h,
   which the intros poll once per frame (rc.h turns INT 16h's key check and a frame point of a
   program that never polls into the same read) -- so that is where a frame is taken: written raw (64,000 pixels + 768 DAC bytes) for the harness to hash, written as
   a PPM for a person to look at, or shown in an SDL window.

     rc_<name> [--frames=N] [--key=156] [--dump=dir] [--ppm=dir --shots=1,84] [--window] [--quiet]

   Prints one line per frame: index, guest instruction count at the poll, host milliseconds since the
   previous poll. After N frames the poll answers ESC (1), so the intro leaves by its own exit path. */
#include <SDL.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "../rc.h"

unsigned char rc_mem[0x110000];
static unsigned char dac[768];
static int dacW, dacR, latchW, latchR, mode = 3;
static int frames = 30, key = 0x9c, frame, quiet, every = 1, window, shotList[64], nShots;
static const char *dumpDir, *ppmDir;
static SDL_Window *win;
static SDL_Renderer *ren;
static SDL_Texture *tex;
static Uint64 last;

void rc_out(int port, int v) {
  v &= 0xff;
  if (port == 0x3c8) { dacW = v; latchW = 0; }
  else if (port == 0x3c7) { dacR = v; latchR = 0; }
  else if (port == 0x3c9) { dac[dacW * 3 + latchW] = v & 0x3f; if (++latchW == 3) { latchW = 0; dacW = (dacW + 1) & 0xff; } }
}

static void present(void) {
  Uint32 pal[256], *px;
  int pitch, i;
  SDL_Event e;
  for (i = 0; i < 256; i++) {
    int r = dac[i * 3], g = dac[i * 3 + 1], b = dac[i * 3 + 2];
    pal[i] = 0xff000000u | (Uint32)((r << 2 | r >> 4) << 16) | (Uint32)((g << 2 | g >> 4) << 8) | (Uint32)(b << 2 | b >> 4);
  }
  SDL_LockTexture(tex, NULL, (void **)&px, &pitch);
  for (i = 0; i < 64000; i++) px[(i / 320) * (pitch / 4) + i % 320] = pal[rc_mem[0xa0000 + i]];
  SDL_UnlockTexture(tex);
  SDL_RenderClear(ren);
  SDL_RenderCopy(ren, tex, NULL, NULL);
  SDL_RenderPresent(ren);
  while (SDL_PollEvent(&e)) {
    if (e.type == SDL_QUIT || (e.type == SDL_KEYDOWN && e.key.keysym.sym == SDLK_ESCAPE)) frames = frame;
  }
}

static void writeFrame(const char *dir, int n, int ppm) {
  char path[1024];
  FILE *f;
  int i;
  snprintf(path, sizeof path, ppm ? "%s/f%04d.ppm" : "%s/f%04d.bin", dir, n);
  f = fopen(path, "wb");
  if (!f) { perror(path); exit(2); }
  if (!ppm) { fwrite(rc_mem + 0xa0000, 1, 64000, f); fwrite(dac, 1, 768, f); }
  else {
    fprintf(f, "P6\n320 200\n255\n");
    for (i = 0; i < 64000; i++) {
      const unsigned char *c = dac + rc_mem[0xa0000 + i] * 3;
      unsigned char rgb[3] = { (unsigned char)(c[0] << 2 | c[0] >> 4), (unsigned char)(c[1] << 2 | c[1] >> 4), (unsigned char)(c[2] << 2 | c[2] >> 4) };
      fwrite(rgb, 1, 3, f);
    }
  }
  fclose(f);
}

int rc_in(int port) {
  if (port == 0x3c9) { int v = dac[dacR * 3 + latchR]; if (++latchR == 3) { latchR = 0; dacR = (dacR + 1) & 0xff; } return v; }
  if (port != 0x60) return 0xff;
  {
    Uint64 now = SDL_GetPerformanceCounter();
    double ms = last ? (double)(now - last) * 1000.0 / (double)SDL_GetPerformanceFrequency() : 0;
    int i;
    frame++;
    if (frame % every && frame < frames) return key;   /* --every=K: only each K-th poll is a frame */
    if (dumpDir) writeFrame(dumpDir, frame, 0);
    for (i = 0; i < nShots; i++) if (shotList[i] == frame && ppmDir) writeFrame(ppmDir, frame, 1);
    if (window) present();
    if (!quiet) printf("%d %.0f %.3f\n", frame, rc_ic, ms);
    last = SDL_GetPerformanceCounter();   /* the frame's own I/O is not the program's time */
  }
  return frame >= frames ? 1 : key;
}

void rc_setmode(int ax) { mode = ax & 0x7f; }

int main(int argc, char **argv) {
  int i, code;
  for (i = 1; i < argc; i++) {
    const char *a = argv[i];
    if (!strncmp(a, "--frames=", 9)) frames = atoi(a + 9);
    else if (!strncmp(a, "--key=", 6)) key = atoi(a + 6);
    else if (!strncmp(a, "--dump=", 7)) dumpDir = a + 7;
    else if (!strncmp(a, "--ppm=", 6)) ppmDir = a + 6;
    else if (!strncmp(a, "--shots=", 8)) { const char *p = a + 8; while (*p && nShots < 64) { shotList[nShots++] = atoi(p); while (*p && *p != ',') p++; if (*p) p++; } }
    else if (!strcmp(a, "--window")) window = 1;
    else if (!strncmp(a, "--every=", 8)) every = atoi(a + 8);
    else if (!strcmp(a, "--quiet")) quiet = 1;
    else { fprintf(stderr, "unknown option %s\n", a); return 2; }
  }
  if (window) {
    if (SDL_Init(SDL_INIT_VIDEO)) { fprintf(stderr, "SDL_Init: %s\n", SDL_GetError()); return 2; }
    win = SDL_CreateWindow("MIRAGE recomp", SDL_WINDOWPOS_CENTERED, SDL_WINDOWPOS_CENTERED, 960, 600, 0);
    ren = SDL_CreateRenderer(win, -1, 0);
    tex = SDL_CreateTexture(ren, SDL_PIXELFORMAT_ARGB8888, SDL_TEXTUREACCESS_STREAMING, 320, 200);
  }
  code = rc_main();
  if (window) SDL_Quit();
  fprintf(stderr, "exit %d after %d frames, mode %02xh\n", code, frame, mode);
  return code;
}
