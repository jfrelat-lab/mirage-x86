// sse.js — the XMM register file and the SSE/SSE2/SSE4.1 operations MIRAGE implements.
//
// Scope is deliberately the set real DOS software reaches for, not the whole ISA: Chrome Revenge
// (Abaddon, 1K, Assembly 2020) is an SSE raytracer that draws in VESA 640x480x32, and its published
// source names exactly sixteen XMM instructions. Everything here was transcribed from that list and
// from the Intel semantics for each opcode — not guessed from the mnemonic.
//
// One ArrayBuffer, three views. A lane is (reg * 4 + i): `f` reads it as float32, `i` as int32, `u8`
// as bytes. Slot 8 is a scratch register the recompiler loads a memory operand into, so every
// operation below sees two REGISTERS and never has to care where its source came from.

export const XMM_SCRATCH = 8;                 // one past the eight architectural registers

// Operation codes. The recompiler bakes these in as constants, so the switch below is the only
// place the encoding-to-semantics mapping lives.
export const SSE = {
  MOVAPS_LD: 0, MOVAPS_ST: 1, MOVSS_LD: 2, MOVSS_LD_M: 3, MOVSS_ST: 4,
  ADDPS: 5, SUBPS: 6, MULPS: 7, XORPS: 8, RSQRTPS: 9, SHUFPS: 10,
  CVTDQ2PS: 11, CVTPS2DQ: 12, PCMPEQD: 13, PACKUSWB: 14, PACKSSDW: 15, PAVGB: 16,
  PMOVSXWD: 17, PMOVZXBD: 18, INSERTPS: 19, DPPS: 20,
};

const sat8u = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
const sat16s = (v) => (v < -32768 ? -32768 : v > 32767 ? 32767 : v);

export function installSSE(cpu) {
  const buf = new ArrayBuffer(16 * 9);        // 8 architectural registers + the scratch slot
  const f = new Float32Array(buf);
  const i32 = new Int32Array(buf);
  const u8 = new Uint8Array(buf);
  cpu.xmm = { buf, f, i32, u8 };

  /** Load 16 bytes of guest memory into the scratch register. `len` lets MOVSS/PMOVZXBD read less
   *  without touching memory they are not entitled to — a 4-byte read at the end of a segment must
   *  not fault on the 16 bytes an unconditional load would take. */
  cpu.xmmLoad = (lin, len) => {
    const m = cpu.mem, base = XMM_SCRATCH * 16;
    for (let k = 0; k < 16; k++) u8[base + k] = k < len ? m.r8((lin + k) >>> 0) : 0;
  };
  cpu.xmmStore = (lin, reg, len) => {
    const m = cpu.mem, base = reg * 16;
    for (let k = 0; k < len; k++) m.w8((lin + k) >>> 0, u8[base + k]);
  };

  /** Every operation, on two register slots. `d` and `s` are register indices; `imm` is the
   *  immediate byte for the three instructions that take one. */
  cpu.sse = (code, d, s, imm) => {
    const D = d * 4, S = s * 4;
    switch (code) {
      case SSE.MOVAPS_LD: case SSE.MOVAPS_ST:
        i32[D] = i32[S]; i32[D + 1] = i32[S + 1]; i32[D + 2] = i32[S + 2]; i32[D + 3] = i32[S + 3]; return;
      // Register form keeps the upper three lanes; the memory form zeroes them. Two codes, because
      // by the time we are here the operand has already become a register either way.
      case SSE.MOVSS_LD: i32[D] = i32[S]; return;
      case SSE.MOVSS_LD_M: i32[D] = i32[S]; i32[D + 1] = 0; i32[D + 2] = 0; i32[D + 3] = 0; return;
      case SSE.MOVSS_ST: i32[D] = i32[S]; return;
      case SSE.ADDPS: for (let k = 0; k < 4; k++) f[D + k] = Math.fround(f[D + k] + f[S + k]); return;
      case SSE.SUBPS: for (let k = 0; k < 4; k++) f[D + k] = Math.fround(f[D + k] - f[S + k]); return;
      case SSE.MULPS: for (let k = 0; k < 4; k++) f[D + k] = Math.fround(f[D + k] * f[S + k]); return;
      case SSE.XORPS: for (let k = 0; k < 4; k++) i32[D + k] ^= i32[S + k]; return;
      // Silicon gives a 12-bit approximation (relative error < 1.5*2^-12) and any result inside that
      // band is architecturally legal, so there is no single right answer here. We match the ORACLE
      // we check against — QEMU computes float32(1 / float32(sqrt x)), rounding the square root to
      // single precision BEFORE the divide. Rounding only at the end differs by an ulp, which is how
      // this arm came to exist.
      case SSE.RSQRTPS: for (let k = 0; k < 4; k++) f[D + k] = Math.fround(1 / Math.fround(Math.sqrt(f[S + k]))); return;
      case SSE.SHUFPS: {
        const a0 = f[D + (imm & 3)], a1 = f[D + ((imm >> 2) & 3)];
        const b0 = f[S + ((imm >> 4) & 3)], b1 = f[S + ((imm >> 6) & 3)];
        f[D] = a0; f[D + 1] = a1; f[D + 2] = b0; f[D + 3] = b1; return;   // low two from dst, high two from src
      }
      case SSE.CVTDQ2PS: for (let k = 0; k < 4; k++) f[D + k] = Math.fround(i32[S + k]); return;
      // Round to nearest, ties to even — the default MXCSR rounding mode, which nothing here changes.
      case SSE.CVTPS2DQ: for (let k = 0; k < 4; k++) {
        const v = f[S + k], r = Math.round(v);
        i32[D + k] = (Math.abs(v - Math.trunc(v)) === 0.5 && (r & 1)) ? r - Math.sign(v) : r;
      } return;
      case SSE.PCMPEQD: for (let k = 0; k < 4; k++) i32[D + k] = i32[D + k] === i32[S + k] ? -1 : 0; return;
      // Pack with saturation: the destination's own halves come first, then the source's.
      case SSE.PACKUSWB: {
        const t = new Uint8Array(16);
        for (let k = 0; k < 8; k++) t[k] = sat8u((i32[D + (k >> 1)] << (k & 1 ? 0 : 16)) >> 16);
        for (let k = 0; k < 8; k++) t[8 + k] = sat8u((i32[S + (k >> 1)] << (k & 1 ? 0 : 16)) >> 16);
        for (let k = 0; k < 16; k++) u8[D * 4 + k] = t[k];
        return;
      }
      case SSE.PACKSSDW: {
        const w = [sat16s(i32[D]), sat16s(i32[D + 1]), sat16s(i32[D + 2]), sat16s(i32[D + 3]),
                   sat16s(i32[S]), sat16s(i32[S + 1]), sat16s(i32[S + 2]), sat16s(i32[S + 3])];
        for (let k = 0; k < 4; k++) i32[D + k] = ((w[k * 2 + 1] & 0xffff) << 16) | (w[k * 2] & 0xffff);
        return;
      }
      case SSE.PAVGB: for (let k = 0; k < 16; k++) u8[D * 4 + k] = (u8[D * 4 + k] + u8[S * 4 + k] + 1) >> 1; return;
      // The sign/zero-extending moves read only the LOW half (PMOVSXWD) or quarter (PMOVZXBD) of the
      // source, so they must be evaluated before the destination is written — same register is legal.
      case SSE.PMOVSXWD: {
        const w = [i32[S] << 16 >> 16, i32[S] >> 16, i32[S + 1] << 16 >> 16, i32[S + 1] >> 16];
        for (let k = 0; k < 4; k++) i32[D + k] = w[k];
        return;
      }
      case SSE.PMOVZXBD: {
        const b = [u8[S * 4], u8[S * 4 + 1], u8[S * 4 + 2], u8[S * 4 + 3]];
        for (let k = 0; k < 4; k++) i32[D + k] = b[k];
        return;
      }
      case SSE.INSERTPS: {
        const src = f[S + ((imm >> 6) & 3)];
        f[D + ((imm >> 4) & 3)] = src;
        for (let k = 0; k < 4; k++) if (imm & (1 << k)) i32[D + k] = 0;   // the zero mask runs after
        return;
      }
      case SSE.DPPS: {
        let sum = 0;
        for (let k = 0; k < 4; k++) if (imm & (0x10 << k)) sum = Math.fround(sum + Math.fround(f[D + k] * f[S + k]));
        for (let k = 0; k < 4; k++) f[D + k] = (imm & (1 << k)) ? sum : 0;
        return;
      }
    }
  };

  cpu.sseReset = () => { for (let k = 0; k < i32.length; k++) i32[k] = 0; };
}
