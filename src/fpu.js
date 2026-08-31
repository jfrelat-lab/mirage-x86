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
  const dv = cpu.mem.dv, mask = cpu.mem.mask;

  const ST = (i) => st[(cpu.ftop + i) & 7];
  const setST = (i, v) => { st[(cpu.ftop + i) & 7] = v; };
  const push = (v) => { cpu.ftop = (cpu.ftop - 1) & 7; st[cpu.ftop] = v; };
  const pop = () => { cpu.ftop = (cpu.ftop + 1) & 7; };

  const f32l = (a) => dv.getFloat32(a & mask, true);
  const f64l = (a) => dv.getFloat64(a & mask, true);
  // Float stores must honour the SMC dirty check like the integer w8/w16/w32 do —
  // a program that FSTs into a page holding compiled code must invalidate those blocks.
  const cp = cpu.mem.codePage;
  const f32s = (a, v) => { a &= mask; dv.setFloat32(a, v, true); if (cp[a >>> 12] || cp[((a + 3) & mask) >>> 12]) cpu.mem._dirty(a, 4); };
  const f64s = (a, v) => { a &= mask; dv.setFloat64(a, v, true); if (cp[a >>> 12] || cp[((a + 7) & mask) >>> 12]) cpu.mem._dirty(a, 8); };
  const i16 = (a) => dv.getInt16(a & mask, true);
  const i32 = (a) => dv.getInt32(a & mask, true);

  // round to integer using the default mode (round half to even)
  const toInt = (x) => { const fl = Math.floor(x), d = x - fl; return d < 0.5 ? fl : d > 0.5 ? fl + 1 : (fl % 2 === 0 ? fl : fl + 1); };

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
        else if (reg === 7) cpu.mem.w16(a, 0x037f);         // fnstcw
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
      case 0: setST(0, x + v); break;                       // fadd / fiadd
      case 1: setST(0, x * v); break;                       // fmul / fimul
      case 2: setcc(x, v); break;                           // fcom / ficom
      case 3: setcc(x, v); pop(); break;                    // fcomp / ficomp
      case 4: setST(0, x - v); break;                       // fsub / fisub
      case 5: setST(0, v - x); break;                       // fsubr / fisubr
      case 6: setST(0, x / v); break;                       // fdiv / fidiv
      case 7: setST(0, v / x); break;                       // fdivr / fidivr
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
          case 0xe5: return;                                // fxam (cc omitted)
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
          case 0xf4: { const x = ST(0); setST(0, x - Math.trunc(x)); push(Math.trunc(x)); return; } // fxtract-ish
          case 0xf8: setST(0, ST(0) % ST(1)); return;       // fprem
          case 0xfa: setST(0, Math.sqrt(ST(0))); return;    // fsqrt
          case 0xfb: { const x = ST(0); setST(0, Math.sin(x)); push(Math.cos(x)); return; } // fsincos → ST0=cos, ST1=sin
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
        if (b < 0xc8) return;                               // ffree st(i)
        if (b < 0xd8) { setST(rm, ST(0)); return; }         // fst st(i)
        if (b < 0xe0) { setST(rm, ST(0)); pop(); return; }  // fstp st(i)
        setcc(ST(0), ST(rm)); if (b >= 0xe8) pop(); return; // fucom / fucomp
      case 0xdb:
        if (b === 0xe3) { cpu.ftop = 0; cpu.fsw = 0; st.fill(0); return; }   // fninit
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
    switch (reg) { case 0: return x + y; case 1: return x * y; case 4: return x - y; case 5: return y - x; case 6: return x / y; case 7: return y / x; }
    return x;   // 2/3 are compares, handled by the caller
  }
}
