// x87-cases.mjs — differential cases for the x87 CORE, run against Unicorn by test-x86-uc.mjs.
//
// Until now the oracle had zero cases whose opcode was D8-DF: the 8088 vectors predate the FPU, the
// 80386 corpus ships no x87 files, and neither the hand-written nor the generated cases reach it. The
// arithmetic every intro leans on had never been compared to anything, which is how FCOMI, FCMOVcc
// and FUCOMPP all sat there as silent no-ops.
//
// Same trick as the SSE cases: the harness compares 256 bytes of scratch at DS:0, so each case ENDS
// by storing its result there. Results go out as QWORD wherever precision is the point — MIRAGE holds
// the stack as float64 and silicon (and QEMU) as 80-bit extended, so a qword store is exactly where
// that difference becomes visible instead of being hidden by a narrower store.
//
// Arguments are built from x87's own constants (FLD1/FLDPI/FLDLN2) rather than from the scratch
// pattern: the pattern read as a float is denormal noise, which would test denormal handling instead
// of the operation asked about.

const LD1 = [0xd9, 0xe8];                    // fld1
const LDPI = [0xd9, 0xeb];                   // fldpi
const LDLN2 = [0xd9, 0xed];                  // fldln2
const LDZ = [0xd9, 0xee];                    // fldz
const FILD0 = [0xdb, 0x07];                  // fild dword [bx]
const FILD4 = [0xdb, 0x47, 0x04];            // fild dword [bx+4]
const STPQ = [0xdd, 0x5f, 0x10];             // fstp qword [bx+16]
const STPQ2 = [0xdd, 0x5f, 0x18];            // fstp qword [bx+24]
const STPD = [0xd9, 0x5f, 0x10];             // fstp dword [bx+16]
const FISTP = [0xdb, 0x5f, 0x10];            // fistp dword [bx+16]

const c = (n, ...parts) => ({ n, code: parts.flat(), regs: { ebx: 0 } });

export const X87_CASES = [
  // ---- the constants themselves: 80-bit on silicon, rounded on the way out ----
  c('fld1 -> qword', LD1, STPQ),
  c('fldpi -> qword', LDPI, STPQ),
  c('fldl2t -> qword', [0xd9, 0xe9], STPQ),
  c('fldl2e -> qword', [0xd9, 0xea], STPQ),
  c('fldlg2 -> qword', [0xd9, 0xec], STPQ),
  c('fldln2 -> qword', LDLN2, STPQ),

  // ---- arithmetic, exact and inexact ----
  c('faddp integers', FILD0, FILD4, [0xde, 0xc1], STPQ),
  c('fsubp integers', FILD0, FILD4, [0xde, 0xe9], STPQ),
  c('fmulp integers', FILD0, FILD4, [0xde, 0xc9], STPQ),
  c('fdivp inexact', FILD0, FILD4, [0xde, 0xf9], STPQ),
  c('fdivp 1/3', LD1, FILD0, [0xde, 0xf9], STPQ),
  c('fdiv by zero', LD1, LDZ, [0xde, 0xf9], STPQ),
  c('fadd m32', FILD0, [0xd8, 0x47, 0x04], STPQ),          // fadd dword [bx+4]
  c('fmul m64', FILD0, [0xdc, 0x4f, 0x08], STPQ),          // fmul qword [bx+8]
  c('fiadd m16', LDPI, [0xde, 0x47, 0x04], STPQ),          // fiadd word [bx+4]

  // ---- roots and transcendentals ----
  { ...c('fsqrt pi', LDPI, [0xd9, 0xfa], STPQ), fp: { off: 16, ulp: 2 } },
  c('fsqrt 2', LD1, LD1, [0xde, 0xc1], [0xd9, 0xfa], STPQ),
  c('fsin 1', LD1, [0xd9, 0xfe], STPQ),
  c('fcos 1', LD1, [0xd9, 0xff], STPQ),
  c('fsincos 1 (two results)', LD1, [0xd9, 0xfb], STPQ, STPQ2),
  { ...c('fptan 1 (pushes 1.0)', LD1, [0xd9, 0xf2], STPQ, STPQ2), fp: { off: 24, ulp: 2 } },
  c('fpatan', LD1, LDPI, [0xd9, 0xf3], STPQ),
  c('f2xm1 ln2', LDLN2, [0xd9, 0xf0], STPQ),
  { ...c('fyl2x log2(pi)', LD1, LDPI, [0xd9, 0xf1], STPQ), fp: { off: 16, ulp: 2 } },
  { ...c('fyl2xp1', LD1, LDLN2, [0xd9, 0xf9], STPQ), fp: { off: 16, ulp: 2 } },

  // ---- the awkward corners ----
  c('fprem pi mod 1', LD1, LDPI, [0xd9, 0xf8], STPQ),
  c('fprem1 pi mod 1', LD1, LDPI, [0xd9, 0xf5], STPQ),
  c('fscale pi by 1', LD1, LDPI, [0xd9, 0xfd], STPQ),
  c('frndint pi', LDPI, [0xd9, 0xfc], STPQ),
  c('frndint 2.5 ties-to-even', LD1, LD1, [0xde, 0xc1], LD1, LD1, [0xde, 0xc1], [0xde, 0xf9],
    LDPI, [0xde, 0xc9], [0xd9, 0xfc], STPQ),
  c('fxtract pi', LDPI, [0xd9, 0xf4], STPQ, STPQ2),
  c('fabs of -pi', LDPI, [0xd9, 0xe0], [0xd9, 0xe1], STPQ),
  c('fchs', LDPI, [0xd9, 0xe0], STPQ),
  c('fxch then store', LD1, LDPI, [0xd9, 0xc9], STPQ),

  // ---- conversions and the status word ----
  c('fistp rounds to even', LDPI, FISTP),
  c('fistp of 2.5', LD1, LD1, [0xde, 0xc1], LD1, LD1, [0xde, 0xc1], [0xde, 0xf9], LDPI, [0xde, 0xc9], FISTP),
  c('fstp m32 narrows', LDPI, STPD),
  c('fst then fstp keeps the value', LDPI, [0xd9, 0x57, 0x10], STPQ2),   // fst dword [bx+16]
  c('fnstsw after fucompp', FILD0, FILD4, [0xda, 0xe9], [0xdf, 0xe0]),
  c('fnstsw after fucom equal', FILD0, FILD0, [0xdd, 0xe1], [0xdf, 0xe0]),
  // ---- the 64-bit integer and 80-bit extended memory forms ----
  // Both were decoded and then IGNORED, so the instruction silently left memory untouched. Borland's
  // __ftol is `fistp qword`, which made every float-to-long cast in a Borland program return the
  // caller's stack garbage. Values here are exact in float64 so the extended form's extra mantissa
  // bits, which this model does not have, cannot make the comparison fail for the wrong reason.
  c('fistp m64 of pi', LDPI, [0xdf, 0x7f, 0x10]),                       // fistp qword [bx+16]
  c('fild m64 round trip', LDPI, [0xdf, 0x7f, 0x10], [0xdf, 0x6f, 0x10], STPQ2),  // + fild qword [bx+16]
  c('fstp m80 of 1.0', LD1, [0xdb, 0x7f, 0x10]),                        // fstp tword [bx+16]
  c('fld m80 round trip', LD1, [0xdb, 0x7f, 0x10], [0xdb, 0x6f, 0x10], [0xdd, 0x5f, 0x20]),
];
