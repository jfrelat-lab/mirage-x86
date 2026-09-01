// x87-stack-cases.mjs — the x87 STATE: stack depth and overflow, the tag word, the full status word,
// and the control word's rounding and precision fields.
//
// The x87-cases.mjs batch covers what each instruction COMPUTES. This one covers what the unit
// REMEMBERS, which is the half a program reads back: FNSTSW to branch on a compare, FNSTCW/FLDCW to
// change rounding for a cast, the tag word to find out how deep the stack is. None of it had ever
// been compared to anything either.
//
// FNSTSW AX lands in a general register, which the harness already compares. Everything else is
// stored into the scratch. FNSTENV also writes the FPU instruction and data pointers, which MIRAGE
// does not model at all and which encode the address of the last x87 instruction — those eight bytes
// are declared `skip`, and nothing else is.

const LD1 = [0xd9, 0xe8];                    // fld1
const LDPI = [0xd9, 0xeb];                   // fldpi
const LDZ = [0xd9, 0xee];                    // fldz
const FILD0 = [0xdb, 0x07];                  // fild dword [bx]
const NINIT = [0xdb, 0xe3];                  // fninit
const SW_AX = [0xdf, 0xe0];                  // fnstsw ax
const STCW = [0xd9, 0x7f, 0x10];             // fnstcw  word [bx+16]
const LDCW = [0xd9, 0x6f, 0x10];             // fldcw   word [bx+16]
const STENV = [0xd9, 0x77, 0x20];            // fnstenv      [bx+32]  (14 bytes in 16-bit mode)
const FISTP16 = [0xdf, 0x5f, 0x18];          // fistp   word [bx+24]
const STPQ = [0xdd, 0x5f, 0x18];             // fstp   qword [bx+24]

// MOV word [bx+16], imm16 — used to plant a control word before FLDCW.
const setCW = (v) => [0xc7, 0x47, 0x10, v & 0xff, (v >> 8) & 0xff];

const c = (n, ...parts) => ({ n, code: parts.flat(), regs: { ebx: 0 } });
// FNSTENV's instruction/data pointer fields (offsets 6..13 of the 14-byte real-mode image) record
// where the last x87 instruction was. MIRAGE keeps no such pointer, so they are declared unequal
// rather than silently tolerated everywhere; the control, status and tag words are still compared.
const env = (n, ...parts) => ({ ...c(n, ...parts), skip: [{ off: 32 + 6, len: 8 }] });

export const X87_STACK_CASES = [
  // ---- the control word, and what it controls ----
  // (No case for the control word BEFORE FNINIT: the power-on value is not architecturally fixed —
  //  Unicorn starts at 0x0000, a 387 at 0x037F — so it would test the environment, not the engine.)
  c('fninit then fnstcw', NINIT, STCW),
  c('fldcw round-trip', setCW(0x0f7f), LDCW, [0xd9, 0x7f, 0x12], STCW),   // fnstcw [bx+18] too
  c('RC=nearest: fistp pi', setCW(0x037f), LDCW, LDPI, FISTP16),
  c('RC=down: fistp pi', setCW(0x077f), LDCW, LDPI, FISTP16),
  c('RC=up: fistp pi', setCW(0x0b7f), LDCW, LDPI, FISTP16),
  c('RC=truncate: fistp pi', setCW(0x0f7f), LDCW, LDPI, FISTP16),
  c('RC=down: fistp -pi', setCW(0x077f), LDCW, LDPI, [0xd9, 0xe0], FISTP16),
  c('RC=up: frndint pi', setCW(0x0b7f), LDCW, LDPI, [0xd9, 0xfc], STPQ),
  c('RC=truncate: frndint pi', setCW(0x0f7f), LDCW, LDPI, [0xd9, 0xfc], STPQ),
  c('PC=single: 1/3', setCW(0x003f), LDCW, LD1, FILD0, [0xde, 0xf9], STPQ),
  c('PC=double: 1/3', setCW(0x023f), LDCW, LD1, FILD0, [0xde, 0xf9], STPQ),

  // ---- the status word ----
  c('fnstsw after fninit', NINIT, SW_AX),
  c('fnstsw TOP after one push', NINIT, LD1, SW_AX),
  c('fnstsw TOP after three pushes', NINIT, LD1, LD1, LD1, SW_AX),
  c('fnstsw TOP after fincstp', NINIT, [0xd9, 0xf7], SW_AX),
  c('fnstsw TOP after fdecstp', NINIT, [0xd9, 0xf6], SW_AX),
  c('ftst of pi', NINIT, LDPI, [0xd9, 0xe4], SW_AX),
  c('ftst of zero', NINIT, LDZ, [0xd9, 0xe4], SW_AX),
  c('ftst of -pi', NINIT, LDPI, [0xd9, 0xe0], [0xd9, 0xe4], SW_AX),
  c('fxam of +normal', NINIT, LDPI, [0xd9, 0xe5], SW_AX),
  c('fxam of -normal', NINIT, LDPI, [0xd9, 0xe0], [0xd9, 0xe5], SW_AX),
  c('fxam of zero', NINIT, LDZ, [0xd9, 0xe5], SW_AX),
  c('fxam of empty', NINIT, [0xd9, 0xe5], SW_AX),
  c('fxam of infinity', NINIT, LD1, LDZ, [0xde, 0xf9], [0xd9, 0xe5], SW_AX),

  // ---- stack overflow and underflow ----
  c('eight pushes fill the stack', NINIT, LD1, LD1, LD1, LD1, LD1, LD1, LD1, LD1, SW_AX),
  c('ninth push overflows', NINIT, LD1, LD1, LD1, LD1, LD1, LD1, LD1, LD1, LD1, SW_AX),
  c('overflow leaves indefinite', NINIT, LD1, LD1, LD1, LD1, LD1, LD1, LD1, LD1, LD1, STPQ),
  c('pop from an empty stack underflows', NINIT, STPQ, SW_AX),
  c('fnclex clears the exceptions', NINIT, STPQ, [0xdb, 0xe2], SW_AX),

  // ---- the tag word, through FNSTENV ----
  env('fnstenv after fninit', NINIT, STENV),
  env('fnstenv with two values', NINIT, LD1, LDPI, STENV),
  env('fnstenv after ffree st0', NINIT, LD1, LDPI, [0xdd, 0xc0], STENV),
  env('fnstenv tags a zero', NINIT, LDZ, STENV),
];
