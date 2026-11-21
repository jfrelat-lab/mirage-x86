/* rc.h -- the platform layer of a program tools/recomp/x86c.mjs generated. The generated C names
   only what is here: MEM (guest linear address 0), rc_inp/rc_out (ports), rc_bios (a BIOS or DOS
   interrupt, its registers in and out), rc_sync (a frame point of a program that never polls),
   rc_regs, and RC_ENTRY (the C main that calls rc_main). Two platforms:

   RC_PRISM  PRISM's DJGPP environment (env stdio go32 ports vgadac). Guest memory IS the low
             megabyte of PRISM's flat image: __djgpp_conventional_base is 0 (src/env/go32.js), so
             MEM is the null pointer and A000:0000 is PRISM's own 0xA0000, where mode 13h lives.
   native    tools/recomp/native/rc_sdl.c (clang + SDL2): an array, a VGA DAC, and the frame hooks.

   What is the same on both is written once, here, in C: the BIOS services the intros call (mode set
   with MIRAGE's mode-13h DAC, the DAC functions of INT 10h AH=10h, INT 16h's key check) and port
   3DAh, whose beam is computed from the instruction count exactly as MIRAGE computes it headless
   (src/bios.js status1: one instruction is one cycle, the period derived from the PIT's). Port 60h
   (the key) and the DAC ports are the platform's: under PRISM its ports.js and vgadac.js, which the
   harness hooks; natively rc_sdl.c. */
#ifndef RC_H
#define RC_H
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>

typedef struct { int ax, bx, cx, dx, si, di, bp, es, ds, flags; } rc_regs;
int rc_main(void);
extern double rc_ic;           /* the instruction count at the last port read or frame point */

#ifdef RC_PRISM
#include <pc.h>
#include <dpmi.h>
#define MEM ((unsigned char *)0)
#define rc_in(p) inportb(p)
#define rc_out(p, v) outportb((p), (v))
static void rc_setmode(int ax) {
  __dpmi_regs d;
  memset(&d, 0, sizeof d);
  d.x.ax = ax;
  __dpmi_int(0x10, &d);
}
#define RC_ENTRY int main(void) { return rc_main(); }
#define RC_T rc_ic
#else
extern unsigned char rc_mem[];
#define MEM rc_mem
int rc_in(int port);
void rc_out(int port, int v);
void rc_setmode(int ax);
/* The native build's play mode (rc_sdl.c with no options): the beam and the PIT on the real clock, in
   the same units as the instruction count (MIRAGE's headless rate, RC_PITBASE instructions a PIT
   period), so the program runs at its own speed rather than as fast as the host goes. */
extern int rc_play;
double rc_seconds(void);
#define RC_T (rc_play ? rc_seconds() * (RC_PITBASE * 1193182.0 / 65536.0) : rc_ic)
#define RC_ENTRY
#endif

#define RW(a) (*(unsigned short *)(MEM + (a)))
#define RS(a) (*(short *)(MEM + (a)))
#define RF(a) (*(float *)(MEM + (a)))
#define RD(a) (*(double *)(MEM + (a)))
#define RL(a) (*(int *)(MEM + (a)))

/* The beam: RC_VPERIOD and the thresholds come from MIRAGE (tools/recomp/oracle.mjs beamOf), as
   the generated file defines them before including this (rc_sdl.c, which includes this too, does not
   need what follows). */
#ifdef RC_PITBASE
/* A poll loop reads it every three instructions, so the answer is kept until the next count where
   it can change: the nearest threshold ahead (line blank, display end, retrace start and end, the
   frame's end), one instruction short of it for safety. Two fmod()s a read cost xormunch more than
   all the rest of its frame in PRISM. */
static double rc_bNext = -1;
static int rc_bVal;
static int rc_beam(void) {
  double pos, lp, m, t = RC_T;
  if (t < rc_bNext) return rc_bVal;
  pos = fmod(t, (double)RC_VPERIOD);
  lp = fmod(pos, RC_CLINE);
  rc_bVal = (pos >= RC_CBLANK || lp >= RC_CHD ? 0x01 : 0) | (pos >= RC_CRS && pos < RC_CRE ? 0x08 : 0);
  m = lp < RC_CHD ? RC_CHD - lp : RC_CLINE - lp;
  if (pos < RC_CBLANK && RC_CBLANK - pos < m) m = RC_CBLANK - pos;
  if (pos < RC_CRS && RC_CRS - pos < m) m = RC_CRS - pos;
  if (pos < RC_CRE && RC_CRE - pos < m) m = RC_CRE - pos;
  if (RC_VPERIOD - pos < m) m = RC_VPERIOD - pos;
  rc_bNext = t + floor(m) - 1;
  return rc_bVal;
}

/* PIT channel 0 as MIRAGE counts it headless with its timer off (src/machine.js, ports 40h/43h): the
   count runs from the reload written, at RC_PITBASE instructions per 65536 clocks, by two a clock in
   mode 3; read low byte then high byte. Programs read it for randomness (kaneda) and timing. No
   interrupt is delivered: that is MIRAGE's oracle configuration too. */
static int rc_pitMode = 3, rc_pitAccess = 3, rc_pitReadHi, rc_pitHiNext, rc_pitLo;
static double rc_pitTicks = 65536, rc_pitLoad;
static void rc_pitw(int port, int v) {
  v &= 0xff;
  if (port == 0x43) {
    int access = (v >> 4) & 3;
    if (((v >> 6) & 3) != 0) return;
    rc_pitReadHi = 0;
    if (!access) return;
    rc_pitAccess = access; rc_pitHiNext = 0;
    rc_pitMode = (v >> 1) & 7; if (rc_pitMode > 5) rc_pitMode -= 4;
    return;
  }
  {
    int reload;
    if (rc_pitAccess == 1) reload = v;
    else if (rc_pitAccess == 2) reload = v << 8;
    else { if (!rc_pitHiNext) { rc_pitLo = v; rc_pitHiNext = 1; return; } reload = (v << 8) | rc_pitLo; rc_pitHiNext = 0; }
    rc_pitTicks = reload == 0 ? 65536 : reload; rc_pitLoad = RC_T;
  }
}
static int rc_pitr(void) {
  double el = fmod(floor((RC_T - rc_pitLoad) * 65536.0 / RC_PITBASE), rc_pitTicks);
  int n = (int)rc_pitTicks, e = (int)el, count, b;
  if (rc_pitMode != 3) count = (n - e) & 0xffff;
  else { int h = (n + 1) >> 1; count = ((n & ~1) - 2 * (e < h ? e : e - h)) & 0xffff; }
  if (rc_pitAccess == 1) return count & 0xff;
  if (rc_pitAccess == 2) return (count >> 8) & 0xff;
  b = rc_pitReadHi ? (count >> 8) & 0xff : count & 0xff;
  rc_pitReadHi = !rc_pitReadHi;
  return b;
}
/* Macros, not functions: a static function calling another is not inlined by V8 in PRISM's output
   (measured, tools/recomp/run.mjs), and a poll loop runs this every three instructions. */
#ifdef RC_REALTIME
/* The page (tools/recomp/web): the beam is the worker's, on the real clock, so the intro runs at its own pace. */
#define rc_inp(p) ((p) == 0x40 ? rc_pitr() : rc_in(p))
#else
#define rc_inp(p) ((p) == 0x3da ? rc_beam() : (p) == 0x40 ? rc_pitr() : rc_in(p))
#endif
static void rc_outp(int p, int v) { if (p == 0x40 || p == 0x43) rc_pitw(p, v); rc_out(p, v); }
#endif

/* A frame point of a program that does not poll the keyboard: the platform's port 60h read is the
   frame (the harness samples there), and an answer of 1 (ESC) means the run is over. */
#define rc_sync() (rc_in(0x60) == 1)

/* Mode 13h's DAC as MIRAGE's BIOS loads it (src/bios.js loadModeDAC), emitted by the translator. */
extern const unsigned char RC_DAC13[768];

#ifdef RC_PITBASE
/* Returns 0, or the interrupt it does not model (the program then stops: never a silent no-op). */
static int rc_bios(int n, rc_regs *r) {
  int ah = (r->ax >> 8) & 0xff, al = r->ax & 0xff, i;
  if (n == 0x10) {
    if (ah == 0x00) {
      rc_setmode(r->ax);
      if ((al & 0x7f) == 0x13) {
        if (!(al & 0x80)) memset(MEM + 0xa0000, 0, 64000);
        rc_out(0x3c8, 0);
        for (i = 0; i < 768; i++) rc_out(0x3c9, RC_DAC13[i]);
      }
      MEM[0x449] = al & 0x7f;
      return 0;
    }
    if (ah == 0x10 && al == 0x10) {          /* set one DAC register: BX, DH red, CH green, CL blue */
      rc_out(0x3c8, r->bx & 0xff); rc_out(0x3c9, (r->dx >> 8) & 0x3f); rc_out(0x3c9, (r->cx >> 8) & 0x3f); rc_out(0x3c9, r->cx & 0x3f);
      return 0;
    }
    if (ah == 0x10 && al == 0x12) {          /* set a block: BX first, CX count, ES:DX the table */
      int a = r->es * 16 + r->dx;
      rc_out(0x3c8, r->bx & 0xff);
      for (i = 0; i < (r->cx & 0xffff) * 3; i++) rc_out(0x3c9, MEM[a + i] & 0x3f);
      return 0;
    }
    return 0x1000 | r->ax;
  }
  if (n == 0x12) { r->ax = RW(0x413); return 0; }   /* memory size, from the BIOS data area */
  if (n == 0x16) {
    if (ah == 0x01 || ah == 0x11) {          /* key waiting? ZF=1 no; ESC when the run is over */
      if (rc_in(0x60) == 1) { r->ax = 0x011b; r->flags &= ~0x40; } else r->flags |= 0x40;
      return 0;
    }
    if (ah == 0x00 || ah == 0x10) { rc_in(0x60); r->ax = 0x011b; return 0; }
    return 0x1600 | ah;
  }
  if (n == 0x21 && ah == 0x0c && al == 0) return 0;   /* flush the keyboard buffer, call nothing */
  return n << 8;
}
#endif
#endif
