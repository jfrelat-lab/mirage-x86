// fpu.js — a minimal x87 FPU coprocessor, attached as a modular device.
//
// The 8087 register file is a stack of eight 80-bit reals addressed relative to
// TOP (ST(0)..ST(7)); we model the values as JS float64 (more than enough for
// demos) with a faithful TOP pointer so push/pop wrap exactly like the hardware.
// We implement the full systematic memory-operand grid (load/store/arith over
// f32/f64/i16/i32) plus the common register-form ops. That is enough to run real
// 256-byte intros — HellMood's "Memories", for instance, needs only fild/fidivr/
// fstp, but the broader set means transcendental intros work too.

import { CF, PF, AF, ZF, SF, OF } from './cpu.js';

export function installFPU(cpu) {
  const st = new Float64Array(8);
  cpu.fst = st;
  cpu.ftop = 0;            // TOP: ST(i) is physical register (TOP + i) & 7
  cpu.fsw = 0;             // condition-code bits C3 C2 C1 C0 of the status word
  cpu.fcw = 0x037f;        // control word: all exceptions masked, PC=extended, RC=nearest
  // Which PHYSICAL registers hold a value. The tag word is DERIVED from this plus the value itself
  // (00 valid, 01 zero, 10 special, 11 empty) rather than stored: the recompiler writes st[] inline
  // all over the place, so a stored tag would need every one of those sites to maintain it, while
  // occupancy changes in exactly four places — push, pop, FFREE and FNINIT. A typed array rather than
  // a bitmask on `cpu`: the emitted blocks alias it as a local, and a read-modify-write of a property
  // on the CPU object cost 4% of `tube` where an indexed store costs nothing measurable.
  cpu.focc = new Uint8Array(8);   // 1 = this physical register holds a value
  const dv = cpu.mem.dv, mask = cpu.mem.mask;

  const ST = (i) => st[(cpu.ftop + i) & 7];
  const setST = (i, v) => { st[(cpu.ftop + i) & 7] = v; };
  const push = (v) => { cpu.ftop = (cpu.ftop - 1) & 7; st[cpu.ftop] = v; cpu.focc[cpu.ftop] = 1; };
  const pop = () => { cpu.focc[cpu.ftop] = 0; cpu.ftop = (cpu.ftop + 1) & 7; };

  const f32l = (a) => dv.getFloat32(a & mask, true);
  const f64l = (a) => dv.getFloat64(a & mask, true);
  // Float stores must honour the SMC dirty check like the integer w8/w16/w32 do —
  // a program that FSTs into a page holding compiled code must invalidate those blocks.
  const cp = cpu.mem.codePage;
  const f32s = (a, v) => { a &= mask; dv.setFloat32(a, v, true); if (cp[a >>> 12] || cp[((a + 3) & mask) >>> 12]) cpu.mem._dirty(a, 4); };
  const f64s = (a, v) => { a &= mask; dv.setFloat64(a, v, true); if (cp[a >>> 12] || cp[((a + 7) & mask) >>> 12]) cpu.mem._dirty(a, 8); };
  const i16 = (a) => dv.getInt16(a & mask, true);
  const i32 = (a) => dv.getInt32(a & mask, true);

  /** Round to integer under the control word's ROUNDING CONTROL (bits 10-11): 00 nearest-even,
   *  01 down, 10 up, 11 truncate toward zero. This was hardcoded to nearest, so a compiler that sets
   *  RC=truncate around a cast — which is what most of them do — got the wrong integer, and only for
   *  the values where the two modes disagree. Every float-to-int path goes through here, including
   *  FRNDINT and the recompiler's inline emission (which calls it as cpu.f2i). */
  const toInt = (x) => {
    switch ((cpu.fcw >> 10) & 3) {
      case 1: return Math.floor(x);
      case 2: return Math.ceil(x);
      case 3: return Math.trunc(x);
      default: { const fl = Math.floor(x), d = x - fl; return d < 0.5 ? fl : d > 0.5 ? fl + 1 : (fl % 2 === 0 ? fl : fl + 1); }
    }
  };

  /** PRECISION CONTROL (bits 8-9): 00 rounds every result to single precision. 10 (double) and 11
   *  (extended) are both this model's native float64 — we cannot be more precise than we are, and
   *  say so rather than pretending. One predictable branch, called from the arithmetic paths. */
  cpu.fprec = (v) => ((cpu.fcw & 0x300) === 0 ? Math.fround(v) : v);

  /** The tag word FNSTENV/FNSAVE publish: two bits per PHYSICAL register, register 0 in bits 0-1. */
  const tagWord = () => {
    let t = 0;
    for (let p = 0; p < 8; p++) {
      const v = st[p];
      const tag = !cpu.focc[p] ? 3 : v === 0 ? 1 : Number.isFinite(v) ? 0 : 2;
      t |= tag << (p * 2);
    }
    return t;
  };
  cpu.ftagWord = tagWord;

  /** FXAM classifies ST(0) into C3/C2/C0 and puts its SIGN in C1 — the one x87 compare that reports
   *  on a register rather than on a relation, and the only way a program can ask "is this slot even
   *  occupied". It was a no-op in both copies, commented "cc omitted". */
  cpu.fxam = () => {
    const v = ST(0), sign = (v < 0 || Object.is(v, -0)) ? 0x0200 : 0;
    let cc;
    if (!cpu.focc[cpu.ftop]) cc = 0x4100;                     // empty:    C3=1 C0=1
    else if (Number.isNaN(v)) cc = 0x0100;                    // NaN:      C0=1
    else if (!Number.isFinite(v)) cc = 0x0500;                // infinity: C2=1 C0=1
    else if (v === 0) cc = 0x4000;                            // zero:     C3=1
    else cc = 0x0400;                                         // normal:   C2=1
    cpu.fsw = (cpu.fsw & ~0x4700) | cc | sign;
  };

  /** FTST compares ST(0) against +0.0 into the status word. Also a no-op before this, and it passed
   *  its only positive-value case by accident: for x > 0 every condition code is 0 either way. */
  cpu.ftst = () => setcc(ST(0), 0);

  cpu.ffree = (i) => { cpu.focc[(cpu.ftop + i) & 7] = 0; };
  /** A change to PRECISION CONTROL is folded into the emitted code at translation time (see the
   *  recompiler's FPREC24), so the blocks compiled under the old setting have to go. Rounding control
   *  is read at run time and needs no such thing. */
  cpu.fldcw = (v) => {
    const before = cpu.fcw;
    cpu.fcw = v & 0xffff;
    if (((before ^ cpu.fcw) & 0x300) && cpu.onFcwPrecChange) cpu.onFcwPrecChange();
  };

  /** Division sets the zero-divide flag, which FXAM and FNSTSW report. `x/y` alone does not. */
  cpu.fdiv = (x, y) => {
    if (y === 0 && x !== 0 && !Number.isNaN(x)) cpu.fsw |= 0x04;
    return cpu.fprec(x / y);
  };

  /** FNSTENV writes the 14-byte real-mode environment: control, status and tag words, then the FPU
   *  instruction and data pointers. We keep no such pointers and write zeros — the oracle cases
   *  declare those eight bytes uncomparable rather than letting them look equal. */
  cpu.fnstenv = (a) => {
    cpu.mem.w16(a, cpu.fcw); cpu.mem.w16(a + 2, cpu.fpuStatus()); cpu.mem.w16(a + 4, tagWord());
    for (let k = 6; k < 14; k += 2) cpu.mem.w16(a + k, 0);
  };
  cpu.fldenv = (a) => {
    cpu.fcw = cpu.mem.r16(a); const sw = cpu.mem.r16(a + 2);
    cpu.fsw = sw & 0x47ff; cpu.ftop = (sw >> 11) & 7;
    const tw = cpu.mem.r16(a + 4);
    for (let p = 0; p < 8; p++) cpu.focc[p] = ((tw >> (p * 2)) & 3) !== 3 ? 1 : 0;
  };

  // set condition codes from a compare (C3,C2,C0 in status word bits 14,10,8)
  // FCOMI/FUCOMI (P6) write EFLAGS DIRECTLY, unlike every other x87 compare, which writes the status
  // word: unordered -> ZF=PF=CF=1, less -> CF, equal -> ZF, and OF/SF/AF cleared. They are the only
  // x87 compare a Jcc can read without an FNSTSW/SAHF round trip, so leaving them as no-ops does not
  // fail loudly — the branch just reads whatever flags happened to be there. Chrome Revenge gates its
  // whole ray/sphere test on three of them and drew a black screen for exactly that reason.
  const cmpi = (a, b) => {
    let fl = cpu.flags & ~(CF | PF | AF | ZF | SF | OF);
    if (Number.isNaN(a) || Number.isNaN(b)) fl |= CF | PF | ZF;
    else if (a < b) fl |= CF;
    else if (a === b) fl |= ZF;
    cpu.flags = fl;
  };

  // FCMOVcc (P6): move ST(i) into ST(0) when an EFLAGS condition holds. DA C0..DF are the plain
  // forms (B / E / BE / U) and DB C0..DF their negations. Like FCOMI these read or write EFLAGS
  // rather than the status word, and like FCOMI doing nothing is silent: the value simply never
  // arrives. qblove draws its entire logo through two of them.
  const fcmov = (b, negated) => {
    const fl = cpu.flags, k = (b >> 3) & 3;
    const cond = k === 0 ? !!(fl & CF) : k === 1 ? !!(fl & ZF)
      : k === 2 ? !!(fl & (CF | ZF)) : !!(fl & PF);
    if (cond !== negated) setST(0, ST(b & 7));
  };

  // ---- three operations that were wrong or absent, each found by the x87 oracle ----
  const dvx = new DataView(new ArrayBuffer(8));

  /** FXTRACT: exponent into ST(0), then PUSH the significand (1 <= |m| < 2). Split on the BITS —
   *  going through log2 puts the exponent one too high for a value just under a power of two. What
   *  was here before split integer from fraction, which is a different operation entirely, and it
   *  was labelled "fxtract-ish" in both copies. */
  cpu.fxtract = () => {
    const x = ST(0);
    if (x === 0) { setST(0, -Infinity); push(x); return; }              // hardware also raises #Z
    if (!Number.isFinite(x)) { setST(0, Number.isNaN(x) ? x : Infinity); push(x); return; }
    let v = x, bias = 0;
    dvx.setFloat64(0, v);
    if (((dvx.getUint32(0) >>> 20) & 0x7ff) === 0) {                     // denormal: normalise first
      v = x * 0x10000000000000; bias = -52; dvx.setFloat64(0, v);
    }
    const e = (((dvx.getUint32(0) >>> 20) & 0x7ff) - 1023) + bias;
    dvx.setUint32(0, (dvx.getUint32(0) & 0x800fffff) | (1023 << 20));    // force the exponent to 2^0
    const m = dvx.getFloat64(0);
    setST(0, e); push(m);
  };

  /** FPREM1 is the IEEE remainder: its quotient rounds to NEAREST, ties to even, where FPREM's
   *  truncates toward zero. JS `%` is FPREM exactly, which is why that one was already right — and
   *  why reusing it for FPREM1 (or leaving FPREM1 out, as here) is silently wrong. */
  cpu.frem1 = (a, b) => {
    if (b === 0 || !Number.isFinite(a)) return NaN;
    const q = a / b, f = Math.floor(q), d = q - f;
    const n = d > 0.5 ? f + 1 : d < 0.5 ? f : (f % 2 === 0 ? f : f + 1);
    return a - b * n;
  };

  /** log2(1+x). FYL2XP1 exists precisely because it is accurate for x near 0, so it goes through
   *  log1p rather than log2(1+x). It was absent entirely: the instruction left ST unchanged. */
  cpu.flog2p1 = (x) => Math.log1p(x) / Math.LN2;

  const setcc = (a, b) => {
    cpu.fsw &= ~0x4500;
    if (Number.isNaN(a) || Number.isNaN(b)) cpu.fsw |= 0x4500;
    else if (a < b) cpu.fsw |= 0x0100;          // C0
    else if (a === b) cpu.fsw |= 0x4000;        // C3
  };

  cpu.fpuStatus = () => (cpu.fsw & 0x47ff) | ((cpu.ftop & 7) << 11);

  // Exposed so the recompiler can call them from inlined FPU code: the
  // round-to-integer (banker's rounding) and compare/condition-code helpers. Keeping
  // them as monomorphic functions lets V8 inline them while the emitted blocks stay small.
  cpu.f2i = toInt;
  cpu.fcmp = setcc;

  // ---- memory-operand forms (op = D8..DF, reg = modrm.reg field) -----------
  cpu.fpuMem = (op, reg, a) => {
    switch (op) {
      case 0xd9:                                            // f32 load/store + control
        if (reg === 0) push(f32l(a));
        else if (reg === 2) f32s(a, ST(0));
        else if (reg === 3) { f32s(a, ST(0)); pop(); }
        else if (reg === 4) cpu.fldenv(a);                  // fldenv
        else if (reg === 5) cpu.fldcw(cpu.mem.r16(a));      // fldcw
        else if (reg === 6) cpu.fnstenv(a);                 // fnstenv
        else if (reg === 7) cpu.mem.w16(a, cpu.fcw);        // fnstcw
        return;
      case 0xdd:                                            // f64 load/store
        if (reg === 0) push(f64l(a));
        else if (reg === 2) f64s(a, ST(0));
        else if (reg === 3) { f64s(a, ST(0)); pop(); }
        else if (reg === 7) cpu.mem.w16(a, cpu.fpuStatus()); // fnstsw mem
        return;
      case 0xdb:                                            // i32 load/store
        if (reg === 0) push(i32(a));
        else if (reg === 2) cpu.mem.w32(a, toInt(ST(0)) >>> 0);
        else if (reg === 3) { cpu.mem.w32(a, toInt(ST(0)) >>> 0); pop(); }
        return;
      case 0xdf:                                            // i16 load/store
        if (reg === 0) push(i16(a));
        else if (reg === 2) cpu.mem.w16(a, toInt(ST(0)) & 0xffff);
        else if (reg === 3) { cpu.mem.w16(a, toInt(ST(0)) & 0xffff); pop(); }
        return;
    }
    // arithmetic with a memory source: D8=f32, DC=f64, DA=i32, DE=i16
    const v = op === 0xd8 ? f32l(a) : op === 0xdc ? f64l(a) : op === 0xda ? i32(a) : i16(a);
    const x = ST(0);
    switch (reg) {
      case 2: setcc(x, v); break;                           // fcom / ficom
      case 3: setcc(x, v); pop(); break;                    // fcomp / ficomp
      default: setST(0, arith(reg, x, v)); break;           // the same operand order as the reg form
    }
  };

  // ---- register / no-operand forms -----------------------------------------
  cpu.fpuReg = (op, reg, rm) => {
    const b = 0xc0 | (reg << 3) | rm;                       // the full second byte (mod=3, so >= 0xC0)
    switch (op) {
      case 0xd9:
        if (b < 0xc8) { push(ST(rm)); return; }             // fld st(i)  (reads pre-push ST)
        if (b < 0xd0) { const t = ST(0); setST(0, ST(rm)); setST(rm, t); return; } // fxch
        switch (b) {
          case 0xe0: setST(0, -ST(0)); return;              // fchs
          case 0xe1: setST(0, Math.abs(ST(0))); return;     // fabs
          case 0xe4: cpu.ftst(); return;                    // ftst
          case 0xe5: cpu.fxam(); return;                    // fxam
          case 0xe8: push(1); return;                       // fld1
          case 0xe9: push(Math.log2(10)); return;           // fldl2t
          case 0xea: push(Math.LOG2E); return;              // fldl2e
          case 0xeb: push(Math.PI); return;                 // fldpi
          case 0xec: push(Math.log10(2)); return;           // fldlg2
          case 0xed: push(Math.LN2); return;                // fldln2
          case 0xee: push(0); return;                       // fldz
          case 0xf0: setST(0, Math.pow(2, ST(0)) - 1); return; // f2xm1
          case 0xf1: setST(1, ST(1) * Math.log2(ST(0))); pop(); return; // fyl2x
          case 0xf2: { const t = Math.tan(ST(0)); setST(0, t); push(1); return; } // fptan
          case 0xf3: { const r = Math.atan2(ST(1), ST(0)); setST(1, r); pop(); return; } // fpatan
          case 0xf4: cpu.fxtract(); return;                 // fxtract
          case 0xf5: setST(0, cpu.frem1(ST(0), ST(1))); return;   // fprem1 (IEEE remainder)
          case 0xf8: setST(0, ST(0) % ST(1)); return;       // fprem (truncating quotient)
          case 0xf9: setST(1, ST(1) * cpu.flog2p1(ST(0))); pop(); return;   // fyl2xp1
          case 0xfa: setST(0, Math.sqrt(ST(0))); return;    // fsqrt
          case 0xfb: { const x = ST(0); setST(0, Math.sin(x)); push(Math.cos(x)); return; } // fsincos → ST0=cos, ST1=sin
          case 0xf6: cpu.ftop = (cpu.ftop - 1) & 7; return; // fdecstp (tags untouched)
          case 0xf7: cpu.ftop = (cpu.ftop + 1) & 7; return; // fincstp
          case 0xfc: setST(0, toInt(ST(0))); return;        // frndint
          case 0xfd: setST(0, ST(0) * Math.pow(2, Math.trunc(ST(1)))); return; // fscale
          case 0xfe: setST(0, Math.sin(ST(0))); return;     // fsin
          case 0xff: setST(0, Math.cos(ST(0))); return;     // fcos
        }
        return;
      case 0xd8: { const i = rm; const x = ST(0), y = ST(i); setST(0, arith(reg, x, y)); if (reg === 2 || reg === 3) setcc(x, y); if (reg === 3) pop(); return; }
      // DC/DE write ST(i): their reg-form sub/div are REVERSED vs D8 (the classic
      // x87 quirk) — feed arith as (ST(0), ST(i)) so reg4/6 reverse, reg5/7 are plain.
      case 0xdc: { const i = rm; if (reg === 2 || reg === 3) { setcc(ST(0), ST(i)); if (reg === 3) pop(); return; } setST(i, arith(reg, ST(0), ST(i))); return; }
      case 0xde:                                            // arithmetic + pop (faddp etc.)
        if (b === 0xd9) { setcc(ST(0), ST(1)); pop(); pop(); return; } // fcompp
        setST(rm, arith(reg, ST(0), ST(rm))); pop(); return;
      case 0xdd:
        if (b < 0xc8) { cpu.ffree(rm); return; }            // ffree st(i)
        if (b < 0xd8) { setST(rm, ST(0)); return; }         // fst st(i)
        if (b < 0xe0) { setST(rm, ST(0)); pop(); return; }  // fstp st(i)
        setcc(ST(0), ST(rm)); if (b >= 0xe8) pop(); return; // fucom / fucomp
      // DA had no arm at all: its whole register space was a no-op, FUCOMPP included — and that one
      // must POP TWICE, so the x87 stack drifted every time a program used it.
      case 0xda:
        if (b < 0xe0) return fcmov(b, false);                                // fcmovb/e/be/u
        if (b === 0xe9) { setcc(ST(0), ST(1)); pop(); return pop(); }        // fucompp
        return;
      case 0xdb:
        if (b < 0xe0) return fcmov(b, true);                                 // fcmovnb/ne/nbe/nu
        if (b === 0xe3) { cpu.ftop = 0; cpu.fsw = 0; cpu.fcw = 0x037f; cpu.focc.fill(0); st.fill(0); return; }   // fninit
        if (b >= 0xe8 && b <= 0xef) return cmpi(ST(0), ST(b - 0xe8));        // fucomi st0,st(i)
        if (b >= 0xf0 && b <= 0xf7) return cmpi(ST(0), ST(b - 0xf0));        // fcomi  st0,st(i)
        return;                                             // (feni/fdisi/fnclex: no-op)
      case 0xdf:
        if (b === 0xe0) { cpu.ax = cpu.fpuStatus(); return; }                // fnstsw ax
        if (b >= 0xe8 && b <= 0xef) { cmpi(ST(0), ST(b - 0xe8)); return pop(); }   // fucomip
        if (b >= 0xf0 && b <= 0xf7) { cmpi(ST(0), ST(b - 0xf0)); return pop(); }   // fcomip
        return;
    }
  };

  // fadd/fmul/fcom/fcomp/fsub/fsubr/fdiv/fdivr selector for register arithmetic
  function arith(reg, x, y) {
    switch (reg) {
      case 0: return cpu.fprec(x + y); case 1: return cpu.fprec(x * y);
      case 4: return cpu.fprec(x - y); case 5: return cpu.fprec(y - x);
      case 6: return cpu.fdiv(x, y);   case 7: return cpu.fdiv(y, x);
    }
    return x;   // 2/3 are compares, handled by the caller
  }
}
