// cpu.js — CPU architectural state for a real-mode 8086/186/286 (32-bit register
// file kept so 386 work can grow in without a rewrite).
//
// Registers follow Intel's ModR/M encoding so the recompiler can index them
// straight from decoded instruction fields:
//   reg32:  0=EAX 1=ECX 2=EDX 3=EBX 4=ESP 5=EBP 6=ESI 7=EDI
//   sreg:   0=ES  1=CS  2=SS  3=DS  4=FS  5=GS
//   reg8:   0=AL 1=CL 2=DL 3=BL 4=AH 5=CH 6=DH 7=BH
//
// Flags are computed eagerly into one EFLAGS integer. That is a deliberate v1
// choice: correctness first, with lazy flags as a known performance follow-up.

// EFLAGS bit masks
export const CF = 1 << 0, PF = 1 << 2, AF = 1 << 4, ZF = 1 << 6,
             SF = 1 << 7, TF = 1 << 8, IF = 1 << 9, DF = 1 << 10, OF = 1 << 11;

// Segment register indices
export const ES = 0, CS = 1, SS = 2, DS = 3, FS = 4, GS = 5;

const PARITY = (() => { const t = new Uint8Array(256);
  for (let i = 0; i < 256; i++) { let p = 1, x = i; while (x) { p ^= 1; x &= x - 1; } t[i] = p; }
  return t; })();

export class CPU {
  constructor(mem) {
    this.mem = mem;
    this.reg = new Uint32Array(8);   // general registers
    this.seg = new Uint16Array(6);   // segment selectors
    this.base = new Uint32Array(6);  // cached linear base (selector << 4 in real mode)
    this.eip = 0;
    this.flags = 0x0002 | IF;        // reserved bit 1 = 1, interrupts enabled
    this.halted = false;
    this.cr0 = 0x00000010;           // machine status word: real mode (PE=0), ET=1 (387 present). SMSW reads it,
                                     // LMSW writes its low 4 bits. We stay real-mode, so PE transitions are ignored.

    // Interrupt plumbing. swInt() is filled in by the Machine: it routes a
    // software interrupt either to a JS handler or to a guest-hooked ISR.
    this.swInt = (n) => { throw new Error('Unhandled INT ' + n.toString(16)); };
    this.ioRead = () => 0xff;        // (port,size) => value
    this.ioWrite = () => {};         // (port,size,value) => void

    this.cycles = 0;                 // coarse instruction counter (timing/budget)
    this.deadline = Infinity;        // cpu.cycles at which a tier-2 region must bail so the run
                                     // loop can deliver a due PIT tick (set per-slice by rec.run)
  }

  // ---- register accessors (used by handlers/loaders, not the hot path) -----
  get ax() { return this.reg[0] & 0xffff; }  set ax(v) { this.reg[0] = (this.reg[0] & ~0xffff) | (v & 0xffff); }
  get bx() { return this.reg[3] & 0xffff; }  set bx(v) { this.reg[3] = (this.reg[3] & ~0xffff) | (v & 0xffff); }
  get cx() { return this.reg[1] & 0xffff; }  set cx(v) { this.reg[1] = (this.reg[1] & ~0xffff) | (v & 0xffff); }
  get dx() { return this.reg[2] & 0xffff; }  set dx(v) { this.reg[2] = (this.reg[2] & ~0xffff) | (v & 0xffff); }
  get si() { return this.reg[6] & 0xffff; }  set si(v) { this.reg[6] = (this.reg[6] & ~0xffff) | (v & 0xffff); }
  get di() { return this.reg[7] & 0xffff; }  set di(v) { this.reg[7] = (this.reg[7] & ~0xffff) | (v & 0xffff); }
  get bp() { return this.reg[5] & 0xffff; }  set bp(v) { this.reg[5] = (this.reg[5] & ~0xffff) | (v & 0xffff); }
  get sp() { return this.reg[4] & 0xffff; }  set sp(v) { this.reg[4] = (this.reg[4] & ~0xffff) | (v & 0xffff); }
  get al() { return this.reg[0] & 0xff; }    set al(v) { this.reg[0] = (this.reg[0] & ~0xff) | (v & 0xff); }
  get ah() { return (this.reg[0] >> 8) & 0xff; } set ah(v) { this.reg[0] = (this.reg[0] & ~0xff00) | ((v & 0xff) << 8); }

  setSeg(i, sel) { this.seg[i] = sel & 0xffff; this.base[i] = (sel & 0xffff) << 4; }

  /** Linear address of CS:IP — where the recompiler fetches the next block. */
  csip() { return (this.base[CS] + (this.eip & 0xffff)) & this.mem.mask; }

  // ---- real-mode stack -----------------------------------------------------
  push16(v) {
    this.reg[4] = (this.reg[4] & ~0xffff) | ((this.sp - 2) & 0xffff);
    this.mem.w16((this.base[SS] + this.sp) & this.mem.mask, v & 0xffff);
  }
  pop16() {
    const v = this.mem.r16((this.base[SS] + this.sp) & this.mem.mask);
    this.reg[4] = (this.reg[4] & ~0xffff) | ((this.sp + 2) & 0xffff);
    return v;
  }
  push32(v) {
    this.reg[4] = (this.reg[4] & ~0xffff) | ((this.sp - 4) & 0xffff);
    this.mem.w32((this.base[SS] + this.sp) & this.mem.mask, v >>> 0);
  }
  pop32() {
    const v = this.mem.r32((this.base[SS] + this.sp) & this.mem.mask);
    this.reg[4] = (this.reg[4] & ~0xffff) | ((this.sp + 4) & 0xffff);
    return v >>> 0;
  }

  // ---- flag computation (called from generated code) -----------------------
  setAdd(a, b, r, bits, withCarry = true) {
    const m = bits === 32 ? 0xffffffff : (1 << bits) - 1, msb = 1 << (bits - 1);
    r &= m; a &= m; b &= m;
    let f = this.flags & ~(PF | AF | ZF | SF | OF | (withCarry ? CF : 0));
    if (withCarry && ((a >>> 0) + (b >>> 0)) > m) f |= CF;
    if (r === 0) f |= ZF;
    if (r & msb) f |= SF;
    if ((~(a ^ b) & (a ^ r)) & msb) f |= OF;
    if ((a ^ b ^ r) & 0x10) f |= AF;
    if (PARITY[r & 0xff]) f |= PF;
    this.flags = f;
  }
  setSub(a, b, r, bits, withCarry = true) {
    const m = bits === 32 ? 0xffffffff : (1 << bits) - 1, msb = 1 << (bits - 1);
    r &= m; a &= m; b &= m;
    let f = this.flags & ~(PF | AF | ZF | SF | OF | (withCarry ? CF : 0));
    if (withCarry && (a >>> 0) < (b >>> 0)) f |= CF;
    if (r === 0) f |= ZF;
    if (r & msb) f |= SF;
    if (((a ^ b) & (a ^ r)) & msb) f |= OF;
    if ((a ^ b ^ r) & 0x10) f |= AF;
    if (PARITY[r & 0xff]) f |= PF;
    this.flags = f;
  }
  setLogic(r, bits) {
    const m = bits === 32 ? 0xffffffff : (1 << bits) - 1, msb = 1 << (bits - 1);
    r &= m;
    let f = this.flags & ~(CF | PF | AF | ZF | SF | OF);
    if (r === 0) f |= ZF;
    if (r & msb) f |= SF;
    if (PARITY[r & 0xff]) f |= PF;
    this.flags = f;
  }
  /** Set CF/OF explicitly (shifts, rotates, mul); recompute ZF/SF/PF unless asked not to. */
  setShiftResult(r, bits, cf, of, touchSZP = true) {
    const m = bits === 32 ? 0xffffffff : (1 << bits) - 1, msb = 1 << (bits - 1);
    r &= m;
    let f = this.flags & ~(CF | OF | (touchSZP ? (PF | ZF | SF) : 0));
    if (cf) f |= CF;
    if (of) f |= OF;
    if (touchSZP) {
      if (r === 0) f |= ZF;
      if (r & msb) f |= SF;
      if (PARITY[r & 0xff]) f |= PF;
    }
    this.flags = f;
  }

  setAdc(a, b, cin, r, bits) {
    const m = bits === 32 ? 0xffffffff : (1 << bits) - 1, msb = 1 << (bits - 1);
    a &= m; b &= m; r &= m;
    let f = this.flags & ~(CF | PF | AF | ZF | SF | OF);
    if (((a >>> 0) + (b >>> 0) + cin) > m) f |= CF;
    if (r === 0) f |= ZF;
    if (r & msb) f |= SF;
    if ((~(a ^ b) & (a ^ r)) & msb) f |= OF;
    if ((a ^ b ^ r) & 0x10) f |= AF;
    if (PARITY[r & 0xff]) f |= PF;
    this.flags = f;
  }
  setSbb(a, b, cin, r, bits) {
    const m = bits === 32 ? 0xffffffff : (1 << bits) - 1, msb = 1 << (bits - 1);
    a &= m; b &= m; r &= m;
    let f = this.flags & ~(CF | PF | AF | ZF | SF | OF);
    if ((a >>> 0) < ((b >>> 0) + cin)) f |= CF;
    if (r === 0) f |= ZF;
    if (r & msb) f |= SF;
    if (((a ^ b) & (a ^ r)) & msb) f |= OF;
    if ((a ^ b ^ r) & 0x10) f |= AF;
    if (PARITY[r & 0xff]) f |= PF;
    this.flags = f;
  }

  // ---- shifts & rotates (return result, set CF/OF; shifts also set SZP) ----
  // 286+ semantics: the shift/rotate count is masked to 5 bits (this is a "186/286-targeted core"
  // running 286/386-era games & demos, which depend on the mask — see conformance.js).
  shl(v, c, bits) {
    const m = bits === 32 ? 0xffffffff : (1 << bits) - 1, msb = bits - 1;
    v &= m; c &= 0x1f; if (!c) return v;
    const cf = c <= bits ? (v >>> (bits - c)) & 1 : 0;
    const res = (v << c) & m;
    const of = c === 1 ? (((res >>> msb) & 1) ^ cf) : 0;
    this.setShiftResult(res, bits, !!cf, !!of); return res;
  }
  shr(v, c, bits) {
    const m = bits === 32 ? 0xffffffff : (1 << bits) - 1, msb = bits - 1;
    v &= m; c &= 0x1f; if (!c) return v;
    const cf = (v >>> (c - 1)) & 1, res = (v >>> c) & m;
    const of = c === 1 ? (v >>> msb) & 1 : 0;
    this.setShiftResult(res, bits, !!cf, !!of); return res;
  }
  sar(v, c, bits) {
    const m = bits === 32 ? 0xffffffff : (1 << bits) - 1, msb = 1 << (bits - 1);
    v &= m; c &= 0x1f; if (!c) return v;
    const sv = ((v & msb) ? (v | ~m) : v) | 0;
    const cf = (sv >> (c - 1)) & 1, res = (sv >> c) & m;
    this.setShiftResult(res, bits, !!cf, false); return res;
  }
  // ROL/ROR: count masked to 5 bits (286+); period = bits. When the masked count is a nonzero
  // multiple of the period the value is unchanged but CF is STILL written (= LSB for ROL, MSB for
  // ROR) — a genuine bug in the old `if(!effective) return` path, independent of the count mask.
  rol(v, c, bits) {
    const m = bits === 32 ? 0xffffffff : (1 << bits) - 1;
    v &= m; c &= 0x1f; if (!c) return v;
    const e = c % bits;
    const res = e ? (((v << e) | (v >>> (bits - e))) & m) : v, cf = res & 1;
    const of = c === 1 ? (((res >>> (bits - 1)) & 1) ^ cf) : 0;
    this.setShiftResult(res, bits, !!cf, !!of, false); return res;
  }
  ror(v, c, bits) {
    const m = bits === 32 ? 0xffffffff : (1 << bits) - 1, msb = bits - 1;
    v &= m; c &= 0x1f; if (!c) return v;
    const e = c % bits;
    const res = e ? (((v >>> e) | (v << (bits - e))) & m) : v, cf = (res >>> msb) & 1;
    const of = c === 1 ? (((res >>> msb) & 1) ^ ((res >>> (msb - 1)) & 1)) : 0;
    this.setShiftResult(res, bits, !!cf, !!of, false); return res;
  }
  // RCL/RCR: through-carry, period = bits+1; count masked to 5 bits (286+). A full period restores
  // both value and CF, so an effective count of 0 returns unchanged with no flag write.
  rcl(v, c, bits) {
    const m = bits === 32 ? 0xffffffff : (1 << bits) - 1;
    v &= m; c &= 0x1f; c %= (bits + 1); if (!c) return v;
    let cf = (this.flags & CF) ? 1 : 0;
    for (let i = 0; i < c; i++) { const nb = (v >>> (bits - 1)) & 1; v = ((v << 1) | cf) & m; cf = nb; }
    const of = (((v >>> (bits - 1)) & 1) ^ cf);
    this.setShiftResult(v, bits, !!cf, !!of, false); return v;
  }
  rcr(v, c, bits) {
    const m = bits === 32 ? 0xffffffff : (1 << bits) - 1, msb = 1 << (bits - 1);
    v &= m; c &= 0x1f; c %= (bits + 1); if (!c) return v;
    let cf = (this.flags & CF) ? 1 : 0;
    const of = ((v >>> (bits - 1)) & 1) ^ cf;
    for (let i = 0; i < c; i++) { const nb = v & 1; v = (v >>> 1) | (cf ? msb : 0); cf = nb; }
    this.setShiftResult(v, bits, !!cf, !!of, false); return v;
  }

  // ---- multiply / divide (operate on AX/DX:AX directly) -------------------
  mul8(s)  { s &= 0xff;  const p = (this.reg[0] & 0xff) * s; this.ax = p; const c = (p & 0xff00) !== 0; this.setShiftResult(0, 16, c, c, false); }
  mul16(s) { s &= 0xffff; const p = (this.reg[0] & 0xffff) * s; this.ax = p & 0xffff; this.dx = (p / 65536) & 0xffff; const c = this.dx !== 0; this.setShiftResult(0, 16, c, c, false); }
  imul8(s) { s = (s << 24 >> 24); const p = ((this.reg[0] & 0xff) << 24 >> 24) * s; this.ax = p & 0xffff; const c = (p < -128 || p > 127); this.setShiftResult(0, 16, c, c, false); }
  imul16(s){ s = (s << 16 >> 16); const p = ((this.reg[0] & 0xffff) << 16 >> 16) * s; this.ax = p & 0xffff; this.dx = (p >> 16) & 0xffff; const c = (p < -32768 || p > 32767); this.setShiftResult(0, 16, c, c, false); }
  div8(s)  { s &= 0xff;  if (!s) return this.swInt(0); const n = this.ax, q = (n / s) | 0; if (q > 0xff) return this.swInt(0); this.al = q; this.ah = n % s; }
  div16(s) { s &= 0xffff; if (!s) return this.swInt(0); const n = (this.dx & 0xffff) * 65536 + (this.ax & 0xffff), q = Math.floor(n / s); if (q > 0xffff) return this.swInt(0); this.ax = q; this.dx = n % s; }
  idiv8(s) { s = (s << 24 >> 24); if (!s) return this.swInt(0); const n = (this.ax << 16 >> 16), q = (n / s) | 0; if (q < -128 || q > 127) return this.swInt(0); this.al = q & 0xff; this.ah = (n % s) & 0xff; }
  idiv16(s){ s = (s << 16 >> 16); if (!s) return this.swInt(0); const n = (((this.dx & 0xffff) << 16) | (this.ax & 0xffff)) | 0, q = (n / s) | 0; if (q < -32768 || q > 32767) return this.swInt(0); this.ax = q & 0xffff; this.dx = (n % s) & 0xffff; }
  // 32-bit MUL/IMUL/DIV/IDIV: EDX:EAX is a 64-bit value, beyond float64's exact range, so
  // compute with BigInt. reg[0]=EAX, reg[2]=EDX.
  mul32(s)  { const p = BigInt(this.reg[0] >>> 0) * BigInt(s >>> 0); this.reg[0] = Number(BigInt.asUintN(32, p)); this.reg[2] = Number(BigInt.asUintN(32, p >> 32n)); const c = this.reg[2] !== 0; this.setShiftResult(0, 32, c, c, false); }
  imul32(s) { const p = BigInt(this.reg[0] | 0) * BigInt(s | 0); this.reg[0] = Number(BigInt.asUintN(32, p)); this.reg[2] = Number(BigInt.asUintN(32, p >> 32n)); const c = p < -2147483648n || p > 2147483647n; this.setShiftResult(0, 32, c, c, false); }
  div32(s)  { s >>>= 0; if (!s) return this.swInt(0); const n = (BigInt(this.reg[2] >>> 0) << 32n) | BigInt(this.reg[0] >>> 0), bs = BigInt(s), q = n / bs; if (q > 0xffffffffn) return this.swInt(0); this.reg[0] = Number(q); this.reg[2] = Number(n % bs); }
  idiv32(s) { s |= 0; if (!s) return this.swInt(0); const n = BigInt.asIntN(64, (BigInt(this.reg[2] >>> 0) << 32n) | BigInt(this.reg[0] >>> 0)), bs = BigInt(s), q = n / bs; if (q > 2147483647n || q < -2147483648n) return this.swInt(0); this.reg[0] = Number(BigInt.asUintN(32, q)); this.reg[2] = Number(BigInt.asUintN(32, n % bs)); }

  // three-operand / 0F IMUL: signed multiply, result in this._mr, sets CF/OF
  imul16x(a, b, bits) {
    if (bits === 16) { a = a << 16 >> 16; b = b << 16 >> 16; const p = a * b; this._mr = p & 0xffff; const c = (p < -32768 || p > 32767); this.setShiftResult(0, 16, c, c, false); }
    else { a |= 0; b |= 0; this._mr = Math.imul(a, b) >>> 0; const p = a * b; const c = (this._mr | 0) !== p; this.setShiftResult(0, 32, c, c, false); }
  }
  aam(base) { if (base === 0) return this.swInt(0); const al = this.reg[0] & 0xff; this.ah = (al / base) | 0; this.al = al % base; this.setLogic(this.reg[0] & 0xff, 8); }
  aad(base) { const al = this.reg[0] & 0xff, ah = (this.reg[0] >> 8) & 0xff; const r = (al + ah * base) & 0xff; this.reg[0] = (this.reg[0] & ~0xffff) | r; this.setLogic(r, 8); }

  // ---- BCD adjust (DAA/DAS/AAA/AAS); OF (and AAA/AAS SF/ZF/PF) left undefined
  _szp(al) { let f = this.flags & ~(ZF | SF | PF); if (al === 0) f |= ZF; if (al & 0x80) f |= SF; if (PARITY[al & 0xff]) f |= PF; this.flags = f; }
  daa() {
    const oldAL = this.reg[0] & 0xff, oldCF = this.flags & CF ? 1 : 0; let al = oldAL, cf = 0, af = 0;
    if ((al & 0x0f) > 9 || (this.flags & AF)) { const s = al + 6; al = s & 0xff; cf = (oldCF || s > 0xff) ? 1 : 0; af = 1; }
    if (oldAL > ((this.flags & AF) ? 0x9f : 0x99) || oldCF) { al = (al + 0x60) & 0xff; cf = 1; }
    this.al = al; this._szp(al); this.flags = (this.flags & ~(CF | AF)) | (cf ? CF : 0) | (af ? AF : 0);
  }
  das() {
    const oldAL = this.reg[0] & 0xff, oldCF = this.flags & CF ? 1 : 0; let al = oldAL, cf = 0, af = 0;
    if ((al & 0x0f) > 9 || (this.flags & AF)) { al = (al - 6) & 0xff; af = 1; }  // low borrow does NOT set CF
    if (oldAL > ((this.flags & AF) ? 0x9f : 0x99) || oldCF) { al = (al - 0x60) & 0xff; cf = 1; }
    this.al = al; this._szp(al); this.flags = (this.flags & ~(CF | AF)) | (cf ? CF : 0) | (af ? AF : 0);
  }
  aaa() {
    let al = this.reg[0] & 0xff, ah = (this.reg[0] >> 8) & 0xff, cf = 0, af = 0;
    if ((al & 0x0f) > 9 || (this.flags & AF)) { al = (al + 6) & 0xff; ah = (ah + 1) & 0xff; af = 1; cf = 1; }
    al &= 0x0f; this.reg[0] = (this.reg[0] & ~0xffff) | (ah << 8) | al;
    this.flags = (this.flags & ~(CF | AF)) | (cf ? CF : 0) | (af ? AF : 0);
  }
  aas() {
    let al = this.reg[0] & 0xff, ah = (this.reg[0] >> 8) & 0xff, cf = 0, af = 0;
    if ((al & 0x0f) > 9 || (this.flags & AF)) { al = (al - 6) & 0xff; ah = (ah - 1) & 0xff; af = 1; cf = 1; }
    al &= 0x0f; this.reg[0] = (this.reg[0] & ~0xffff) | (ah << 8) | al;
    this.flags = (this.flags & ~(CF | AF)) | (cf ? CF : 0) | (af ? AF : 0);
  }

  // ---- double-precision shifts (SHLD/SHRD) --------------------------------
  shld(dst, src, c, bits) {
    const m = bits === 32 ? 0xffffffff : (1 << bits) - 1; dst &= m; src &= m; c &= 31; if (!c || c > bits) return dst;
    const res = ((dst << c) | (src >>> (bits - c))) & m;
    const cf = (dst >>> (bits - c)) & 1, of = c === 1 ? (((res >>> (bits - 1)) & 1) ^ ((dst >>> (bits - 1)) & 1)) : 0;
    this.setShiftResult(res, bits, !!cf, !!of); return res;
  }
  shrd(dst, src, c, bits) {
    const m = bits === 32 ? 0xffffffff : (1 << bits) - 1; dst &= m; src &= m; c &= 31; if (!c || c > bits) return dst;
    const res = ((dst >>> c) | (src << (bits - c))) & m;
    const cf = (dst >>> (c - 1)) & 1, of = c === 1 ? (((res >>> (bits - 1)) & 1) ^ ((dst >>> (bits - 1)) & 1)) : 0;
    this.setShiftResult(res, bits, !!cf, !!of); return res;
  }

  // ---- condition evaluation for Jcc/SETcc/CMOVcc (codes 0..15) -------------
  cond(code) {
    const f = this.flags;
    const o = !!(f & OF), c = !!(f & CF), z = !!(f & ZF), s = !!(f & SF), p = !!(f & PF);
    switch (code) {
      case 0x0: return o;             case 0x1: return !o;
      case 0x2: return c;             case 0x3: return !c;
      case 0x4: return z;             case 0x5: return !z;
      case 0x6: return c || z;        case 0x7: return !c && !z;
      case 0x8: return s;             case 0x9: return !s;
      case 0xa: return p;             case 0xb: return !p;
      case 0xc: return s !== o;       case 0xd: return s === o;
      case 0xe: return z || (s !== o); case 0xf: return !z && (s === o);
    }
    return false;
  }
}
