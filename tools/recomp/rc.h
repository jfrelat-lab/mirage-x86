/* rc.h -- the platform layer of a program tools/recomp/x86c.mjs generated. The generated C names
   only these: MEM (guest linear address 0), rc_in/rc_out (ports), rc_int (a BIOS interrupt with
   its registers), rc_regs, and RC_ENTRY (the C main that calls rc_main). Two platforms:

   RC_PRISM  PRISM's DJGPP environment (env stdio go32 ports vgadac). Guest memory IS the low
             megabyte of PRISM's flat image: __djgpp_conventional_base is 0 (src/env/go32.js), so
             MEM is the null pointer and A000:0000 is PRISM's own 0xA0000, where mode 13h lives.
   native    tools/recomp/native/rc_sdl.c (clang + SDL2): an array, a VGA DAC, and the frame hooks. */
#ifndef RC_H
#define RC_H
#include <stdio.h>
#include <string.h>
#include <math.h>

typedef struct { int ax, bx, cx, dx, si, di, bp, es, ds; } rc_regs;
int rc_main(void);
extern double rc_ic;

#ifdef RC_PRISM
#include <pc.h>
#include <dpmi.h>
#define MEM ((unsigned char *)0)
#define rc_in(p) inportb(p)
#define rc_out(p, v) outportb((p), (v))
static void rc_int(int n, rc_regs *r) {
  __dpmi_regs d;
  memset(&d, 0, sizeof d);
  d.x.ax = r->ax; d.x.bx = r->bx; d.x.cx = r->cx; d.x.dx = r->dx;
  d.x.si = r->si; d.x.di = r->di; d.x.bp = r->bp; d.x.es = r->es; d.x.ds = r->ds;
  __dpmi_int(n, &d);
  r->ax = d.x.ax; r->bx = d.x.bx; r->cx = d.x.cx; r->dx = d.x.dx;
  r->si = d.x.si; r->di = d.x.di; r->bp = d.x.bp;
}
#define RC_ENTRY int main(void) { return rc_main(); }
#else
extern unsigned char rc_mem[];
#define MEM rc_mem
int rc_in(int port);
void rc_out(int port, int v);
void rc_int(int n, rc_regs *r);
#define RC_ENTRY
#endif

#define RW(a) (*(unsigned short *)(MEM + (a)))
#define RS(a) (*(short *)(MEM + (a)))
#define RF(a) (*(float *)(MEM + (a)))
#endif
