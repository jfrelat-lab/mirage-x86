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

// VEX-encoded operations (AVX, AVX2): the Linux sizecoding intros of the 2020s reach for a handful —
// Outline 2021-2023's 256-byte intros by The Orz (VPADDUSB, VPSHUFD, VMOVD, VPSRAVD, VPMOVZXBD, VMOVDQU
// on YMM). The YMM registers are the XMM ones and an upper half each (cpu.ymmHi): a legacy SSE
// operation leaves that half alone, a VEX.128 one zeroes it, a VEX.256 one works on all 32 bytes.
export const VEX = {
  MOVDQU_LD: 0, PMOVZXBD: 1, PSRAVD: 2, PADDUSB: 3, MOVD_LD: 4, PSHUFD: 5, PBROADCASTB: 6, BROADCASTSS: 7,
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

  // ---- VEX: the YMM upper halves and the operations on them ----
  const hi = new Uint8Array(16 * 9);
  cpu.ymmHi = hi;
  const Y = new Uint8Array(32), Yv = new Uint8Array(32), Ys = new Uint8Array(32);   // working copies
  const yI = new Int32Array(Y.buffer), yvI = new Int32Array(Yv.buffer), ysI = new Int32Array(Ys.buffer);
  const get = (reg, to) => { to.set(u8.subarray(reg * 16, reg * 16 + 16), 0); to.set(hi.subarray(reg * 16, reg * 16 + 16), 16); };
  /** Up to 32 bytes of guest memory into the scratch register (low half, then upper). */
  cpu.vexLoad = (lin, len) => {
    const m = cpu.mem, b = XMM_SCRATCH * 16;
    for (let k = 0; k < 32; k++) { const v = k < len ? m.r8((lin + k) >>> 0) : 0; if (k < 16) u8[b + k] = v; else hi[b + k - 16] = v; }
  };
  cpu.vexStore = (lin, reg, len) => {
    const m = cpu.mem, b = reg * 16;
    for (let k = 0; k < len; k++) m.w8((lin + k) >>> 0, k < 16 ? u8[b + k] : hi[b + k - 16]);
  };
  /** One VEX operation: `L` 0 for 128 bits (the upper half zeroed), 1 for 256; `d` the destination,
   *  `v` the first source (VEX.vvvv), `s` the second (ModRM.rm, or the scratch slot), `imm` its byte. */
  cpu.vex = (code, L, d, v, s, imm) => {
    get(v, Yv); get(s, Ys); Y.fill(0);
    const n = L ? 32 : 16;
    switch (code) {
      case VEX.MOVDQU_LD: Y.set(Ys.subarray(0, n)); break;
      case VEX.PMOVZXBD: for (let k = 0; k < n / 4; k++) yI[k] = Ys[k]; break;          // bytes to dwords, zero-extended
      // Each dword shifted right arithmetically by its own count; 32 or more fills it with its sign.
      case VEX.PSRAVD: for (let k = 0; k < n / 4; k++) { const c = ysI[k] >>> 0; yI[k] = yvI[k] >> (c > 31 ? 31 : c); } break;
      case VEX.PADDUSB: for (let k = 0; k < n; k++) Y[k] = sat8u(Yv[k] + Ys[k]); break;
      case VEX.MOVD_LD: yI[0] = imm | 0; break;                                            // the dword comes as `imm`
      // Within each 128-bit lane, dword k takes the source's dword (imm >> 2k) & 3 of that lane.
      case VEX.PSHUFD: for (let k = 0; k < n / 4; k++) yI[k] = ysI[(k & ~3) + ((imm >> ((k & 3) * 2)) & 3)]; break;
      case VEX.PBROADCASTB: Y.fill(Ys[0], 0, n); break;
      case VEX.BROADCASTSS: for (let k = 0; k < n / 4; k++) yI[k] = ysI[0]; break;          // the source's low dword everywhere                                   // the source's low byte everywhere
      default: throw new Error(`mirage: VEX operation ${code} not implemented`);
    }
    u8.set(Y.subarray(0, 16), d * 16); hi.set(Y.subarray(16, 32), d * 16);
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
