// x86-sse-cases.mjs — differential cases for the XMM subset, run against Unicorn by test-x86-uc.mjs.
//
// The oracle compares GP registers, flags and 256 bytes of scratch at DS:0 — it never reads XMM. So
// every case here ENDS by storing its result back into the scratch, which is what makes the XMM state
// observable to a harness that knows nothing about XMM. BX is 0, so [bx] is DS:0.
//
// Inputs are built rather than taken raw: PMOVZXBD widens four scratch bytes to four dwords (0..255)
// and CVTDQ2PS turns those into exact small floats. Feeding the raw byte pattern as float32 would
// test denormal handling instead of the operation, and would make every case's expectation hinge on
// something neither implementation is really being asked about here.

const LD0 = [0x0f, 0x28, 0x07];              // movaps xmm0,[bx]
const LD1 = [0x0f, 0x28, 0x4f, 0x10];        // movaps xmm1,[bx+16]
const ST0 = [0x0f, 0x29, 0x47, 0x20];        // movaps [bx+32],xmm0
const ST1 = [0x0f, 0x29, 0x4f, 0x30];        // movaps [bx+48],xmm1
// Small exact floats in xmm0/xmm1: four bytes -> four dwords (0..255) -> four float32.
const F0 = [0x66, 0x0f, 0x38, 0x31, 0x07, 0x0f, 0x5b, 0xc0];             // pmovzxbd xmm0,[bx]; cvtdq2ps xmm0,xmm0
const F1 = [0x66, 0x0f, 0x38, 0x31, 0x4f, 0x08, 0x0f, 0x5b, 0xc9];       // pmovzxbd xmm1,[bx+8]; cvtdq2ps xmm1,xmm1

const c = (n, ...parts) => ({ n, code: parts.flat(), regs: { ebx: 0 } });

export const SSE_CASES = [
  // ---- moves ----
  c('movaps xmm,m128 + store', LD0, ST0),
  c('movaps xmm,xmm', LD0, [0x0f, 0x28, 0xc8], ST1),                      // movaps xmm1,xmm0
  c('movss xmm,m32 zeroes the upper lanes', LD0, [0xf3, 0x0f, 0x10, 0x07], ST0),
  c('movss xmm,xmm keeps the upper lanes', LD0, LD1, [0xf3, 0x0f, 0x10, 0xc1], ST0),
  c('movss m32,xmm', LD0, [0xf3, 0x0f, 0x11, 0x47, 0x20], ST1),

  // ---- packed single-precision arithmetic ----
  c('addps', F0, F1, [0x0f, 0x58, 0xc1], ST0),
  c('subps', F0, F1, [0x0f, 0x5c, 0xc1], ST0),
  c('mulps', F0, F1, [0x0f, 0x59, 0xc1], ST0),
  c('mulps xmm,m128', F0, [0x0f, 0x59, 0x07], ST0),
  c('xorps', LD0, LD1, [0x0f, 0x57, 0xc1], ST0),
  c('xorps self zeroes', LD0, [0x0f, 0x57, 0xc0], ST0),
  c('rsqrtps', F0, [0x0f, 0x52, 0xc8], ST1),                              // rsqrtps xmm1,xmm0

  // ---- shuffles ----
  c('shufps 00', F0, F1, [0x0f, 0xc6, 0xc1, 0x00], ST0),
  c('shufps 1b', F0, F1, [0x0f, 0xc6, 0xc1, 0x1b], ST0),
  c('shufps e4 (identity)', F0, F1, [0x0f, 0xc6, 0xc1, 0xe4], ST0),
  c('shufps same register', F0, [0x0f, 0xc6, 0xc0, 0x39], ST0),

  // ---- conversions ----
  c('cvtdq2ps', LD0, [0x0f, 0x5b, 0xc8], ST1),
  c('cvtps2dq round-to-even', F0, [0x66, 0x0f, 0x5b, 0xc8], ST1),
  c('pmovzxbd', LD0, [0x66, 0x0f, 0x38, 0x31, 0xc8], ST1),
  c('pmovsxwd', LD0, [0x66, 0x0f, 0x38, 0x23, 0xc8], ST1),

  // ---- packed integer ----
  c('pcmpeqd equal', LD0, [0x0f, 0x28, 0xc8], [0x66, 0x0f, 0x76, 0xc1], ST0),
  c('pcmpeqd unequal', LD0, LD1, [0x66, 0x0f, 0x76, 0xc1], ST0),
  c('packuswb', LD0, LD1, [0x66, 0x0f, 0x67, 0xc1], ST0),
  c('packssdw', LD0, LD1, [0x66, 0x0f, 0x6b, 0xc1], ST0),
  c('pavgb', LD0, LD1, [0x66, 0x0f, 0xe0, 0xc1], ST0),

  // ---- SSE4.1 ----
  c('dpps 77 (the Chrome Revenge form)', F0, F1, [0x66, 0x0f, 0x3a, 0x40, 0xc1, 0x77], ST0),
  c('dpps ff', F0, F1, [0x66, 0x0f, 0x3a, 0x40, 0xc1, 0xff], ST0),
  c('dpps 31', F0, F1, [0x66, 0x0f, 0x3a, 0x40, 0xc1, 0x31], ST0),
  c('insertps 0x20', F0, F1, [0x66, 0x0f, 0x3a, 0x21, 0xc1, 0x20], ST0),
  c('insertps with zero mask', F0, F1, [0x66, 0x0f, 0x3a, 0x21, 0xc1, 0x4a], ST0),
];

// x87 compares that write EFLAGS (P6): FCOMI/FUCOMI (DB F0+i / DB E8+i) and their popping forms
// (DF F0+i / DF E8+i). Every other x87 compare writes the STATUS WORD, which the harness does not
// read — these four are the ones a Jcc can act on, and they were silently no-ops. The -IP cases end
// with FSTP so the pop is observable in memory too, not just in the flags.
const FILD0 = [0xdb, 0x07];                  // fild dword [bx]
const FILD4 = [0xdb, 0x47, 0x04];            // fild dword [bx+4]
const FSTP8 = [0xd9, 0x5f, 0x08];            // fstp dword [bx+8]

export const X87_CMP_CASES = [
  c('fucomi st0,st1', FILD0, FILD4, [0xdb, 0xe9]),
  c('fucomi st0,st1 reversed', FILD4, FILD0, [0xdb, 0xe9]),
  c('fucomi equal', FILD0, FILD0, [0xdb, 0xe9]),
  c('fcomi st0,st1', FILD0, FILD4, [0xdb, 0xf1]),
  c('fcomi st0,st1 reversed', FILD4, FILD0, [0xdb, 0xf1]),
  c('fucomip st0,st1 pops', FILD0, FILD4, [0xdf, 0xe9], FSTP8),
  c('fcomip st0,st1 pops', FILD4, FILD0, [0xdf, 0xf1], FSTP8),
  c('fucomi st0,st2', FILD0, FILD4, FILD0, [0xdb, 0xea]),
];

// FCMOVcc (P6): DA C0..DF move on a true EFLAGS condition, DB C0..DF on its negation. Like FCOMI
// they cross between EFLAGS and the x87 stack, and `fpu.js` had no DA arm at all — so its whole
// register space, FUCOMPP included, was a no-op. FUCOMPP matters twice over: it must POP TWICE, and
// a missing pop drifts the stack for everything after it. Each case ends with FSTP into the compared
// scratch, so both the moved value and the stack depth are observable.
const FILD8 = [0xdb, 0x47, 0x08];            // fild dword [bx+8]
const FSTP12 = [0xd9, 0x5f, 0x0c];           // fstp dword [bx+12]
const cf = (n, flags, ...parts) => ({ n, code: parts.flat(), regs: { ebx: 0 }, flags });
const CF_ = 0x001, PF_ = 0x004, ZF_ = 0x040;

export const X87_CMOV_CASES = [
  cf('fcmovb taken (CF=1)', CF_, FILD0, FILD4, [0xda, 0xc1], FSTP12),
  cf('fcmovb not taken (CF=0)', 0, FILD0, FILD4, [0xda, 0xc1], FSTP12),
  cf('fcmove taken (ZF=1)', ZF_, FILD0, FILD4, [0xda, 0xc9], FSTP12),
  cf('fcmove not taken', 0, FILD0, FILD4, [0xda, 0xc9], FSTP12),
  cf('fcmovbe taken (ZF only)', ZF_, FILD0, FILD4, [0xda, 0xd1], FSTP12),
  cf('fcmovbe not taken', 0, FILD0, FILD4, [0xda, 0xd1], FSTP12),
  cf('fcmovu taken (PF=1)', PF_, FILD0, FILD4, [0xda, 0xd9], FSTP12),
  cf('fcmovnb taken (CF=0)', 0, FILD0, FILD4, [0xdb, 0xc1], FSTP12),
  cf('fcmovnb not taken (CF=1)', CF_, FILD0, FILD4, [0xdb, 0xc1], FSTP12),
  cf('fcmovne taken', 0, FILD0, FILD4, [0xdb, 0xc9], FSTP12),
  cf('fcmovnbe not taken (CF=1)', CF_, FILD0, FILD4, [0xdb, 0xd1], FSTP12),
  cf('fcmovnu taken (PF=0)', 0, FILD0, FILD4, [0xdb, 0xd9], FSTP12),
  cf('fucompp pops twice', 0, FILD8, FILD0, FILD4, [0xda, 0xe9], FSTP12),
];
