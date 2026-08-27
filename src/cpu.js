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
             SF = 1 << 7, TF = 1 << 8, IF = 1 << 9, DF = 1 << 10, OF = 1 << 11,
             NT = 1 << 14, RF = 1 << 16, VM = 1 << 17, IOPL = 3 << 12;

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
    // Code-segment default size (CS descriptor D bit): 0 = 16-bit operands/addresses, 1 = 32-bit.
    // Always 0 in real mode. It selects the DEFAULT that 0x66/0x67 invert, so translated code is
    // only valid for one value of it — the block cache is keyed by it (recompiler.js).
    this.csD = 0;
    this._cpl = 0;                   // stored CPL — see the `cpl` getter
    // Stack-segment B bit: 0 = the stack pointer is SP (16-bit, wraps in 64 KiB), 1 = ESP (32-bit).
    // Independent of the operand size, which decides how MUCH is pushed, not WHERE. Always 0 in
    // real mode. test386 POST 9 exists to catch exactly this confusion.
    this.ssB = 0;
    this.limit = new Uint32Array(6).fill(0xffff);   // cached segment limits (0xFFFF in real mode)
    this.segAccess = new Uint8Array(6);             // cached access byte (P/DPL/S/type) — checks come later
    // Descriptor table registers. Real mode never consults them; LGDT/LIDT load them and protected
    // mode resolves every selector through them.
    this.gdtr = { base: 0, limit: 0 };
    this.idtr = { base: 0, limit: 0x3ff };          // the real-mode IVT, expressed as an IDTR
    this.ldtr = { sel: 0, base: 0, limit: 0 };
    this.tr = { sel: 0, base: 0, limit: 0 };        // task register — the TSS holds the inner-ring stacks
    this.cr3 = 0;                    // page-directory physical base (bits 31:12)
    this.cr2 = 0;                    // faulting linear address, set on #PF
    this.cr0 = 0x00000010;           // machine status word: PE=0 (real mode), ET=1 (387 present).
    // Set when a write lands inside the block that is CURRENTLY EXECUTING. A block is compiled from
    // the bytes it saw at translation time, so an in-place decryptor that rewrites its own tail runs
    // the stale form: Mystic Towers executed INT 2Fh as INT 00h that way. Declared here rather than
    // assigned on first use so the shape stays monomorphic on the dispatch path.
    this.smcSelf = 0;
                                     // SMSW reads it; LMSW and MOV CR0 write it, and bit 0 (PE) now
                                     // really switches how setSeg resolves a selector.

    // Interrupt plumbing. swInt() is filled in by the Machine: it routes a
    // software interrupt either to a JS handler or to a guest-hooked ISR.
    this.swInt = (n) => { throw new Error('Unhandled INT ' + n.toString(16)); };
    // Overwritten by Machine from the CPU profile; 0x1f (286+) is the default so a bare CPU works.
    this.shiftMask = 0x1f;
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

  // ---- segment loading -----------------------------------------------------
  // In real mode a selector IS the base, shifted. In protected mode it is an INDEX into a descriptor
  // table, and base/limit/size come from the 8-byte descriptor found there. Every address the
  // recompiler emits is already `base[seg] + offset` and never `sel << 4`, so making this one method
  // descriptor-aware is what carries the entire emitted corpus into protected mode unchanged.
  //
  // Deliberately NOT here yet, each being its own step gated by test386's POST sequence: privilege
  // and type checks with #GP, call gates, task switching. A selector that would fault on real
  // hardware is loaded here instead of raising — wrong, but wrong in a way that surfaces as a later
  // POST failing rather than as silence.
  /** Virtual-8086 mode: EFLAGS.VM. A V86 task runs 8086 code with protection still on underneath. */
  get v86() { return (this.flags & VM) !== 0; }

  /**
   * Current privilege level. It is STORED, not derived from CS's RPL, because between `mov cr0` (PE
   * on) and the far jump that reloads CS, the selector register still holds the REAL-MODE value —
   * and its low two bits mean nothing. Windows 3.0 runs there with CS = 0x13b, so a derived CPL read
   * 3 and the very next instruction, a far jump to a DPL-0 selector, was rejected with #GP(8).
   * On real hardware CPL lives in the CS descriptor cache, which that transition leaves at 0.
   */
  get cpl() { return this._cpl; }

  /** I/O privilege level. In V86 it gates the whole sensitive-instruction set. */
  get iopl() { return (this.flags >>> 12) & 3; }

  setSeg(i, sel) {
    sel &= 0xffff;
    // Real mode, and virtual-8086 mode: the selector IS the base, shifted. In V86 protection is
    // still on underneath, but a segment register holds an 8086 value and never indexes a table.
    if (!(this.cr0 & 1) || (this.flags & VM)) {
      this.seg[i] = sel;
      this.base[i] = sel << 4;
      this.limit[i] = 0xffff;
      if (i === CS) { this.csD = 0; this._cpl = (this.flags & VM) ? 3 : 0; }
      else if (i === SS) this.ssB = 0;
      return;
    }
    // A load that FAULTS leaves the segment register ALONE — the descriptor is validated first and
    // the selector is committed only on success. Writing it up front left DS holding the selector we
    // had just refused, so the handler's own `mov ax,ds / push ax` saved 0xFFF8 and restored it into
    // DS on the way out, faulting again: test386's POST-B fails its SECOND fault test that way, not
    // its first. It also must not move CPL, for the same reason.
    if (this.loadDescriptor(i, sel) === false) return false;
    this.seg[i] = sel;
    if (i === CS) this._cpl = sel & 3;
  }

  /** Cache base/limit (and, for CS, the D bit) from the descriptor `sel` selects. */
  loadDescriptor(i, sel) {
    if ((sel & 0xfffc) === 0) {
      // A null selector is legal to LOAD into a data segment — it faults later, on use. Into CS or
      // SS it is #GP(0) at once. The difference is diagnostic as much as architectural: Heretic's
      // DOS4GW leaves through an IRET whose saved CS:IP reads back 0:0, and accepting that gave CS
      // base 0, so the guest ran from linear 0 for 20000 blocks instead of stopping where it broke.
      if ((i === CS || i === SS) && !this._delivering) { this.raise(13, 0); return false; }
      this.base[i] = 0; this.limit[i] = 0;
      if (i === CS) this.csD = 0; else if (i === SS) this.ssB = 0;
      return;
    }
    const tbl = (sel & 4) ? this.ldtr : this.gdtr;          // TI bit picks GDT or LDT
    // A selector past the table's limit is #GP(selector), not a read past the table. Without this
    // we followed a garbage selector into unmapped memory: delivering Windows' first #PF loads SS
    // from a TSS that has never been LTR'd, and the resulting nonsense selector read 0xff50 bytes
    // beyond a 0x10f-byte GDT.
    if ((sel & 0xfff8) + 7 > tbl.limit) { this.raise(13, sel & 0xfffc); return false; }
    const a = (tbl.base + (sel & 0xfff8)) >>> 0;            // the index is already scaled by 8
    const m = this.mem;
    const lo = m.r16(a), b0 = m.r16(a + 2);
    const b1 = m.r8(a + 4), access = m.r8(a + 5), gran = m.r8(a + 6), b2 = m.r8(a + 7);
    // TYPE first, then presence — the order the manual checks them in.
    //   S=0 is a SYSTEM descriptor (LDT, TSS, gate): never loadable into a segment register.
    //   Into a data register, a code segment is only loadable if it is READABLE (bit 1).
    //   Into SS, only a WRITABLE DATA segment will do.
    // Without these, an LDT or TSS descriptor loaded as if it were a segment and addressed whatever
    // its base and limit fields happened to encode — test386's POST-B expects #GP(selector).
    const isSys = !(access & 0x10), isCode = (access & 0x08) !== 0, rw = (access & 0x02) !== 0;
    if (isSys || (i === SS ? (isCode || !rw) : (isCode && !rw))) { this.raise(13, sel & 0xfffc); return false; }
    // PRIVILEGE. A data load needs max(CPL, RPL) <= DPL; a CONFORMING code segment is exempt, since
    // its whole point is to be reachable from less privileged code. SS is stricter still: RPL and DPL
    // must both equal CPL. test386 runs the whole fault series a second time from ring 3, and this is
    // what it catches there — a DPL-1 segment loaded happily at CPL 3.
    // ...DATA registers only. SS and CS are loaded by the very transfers that CHANGE CPL — exception
    // delivery through a gate, IRET back to ring 3 — where `_cpl` is still the old value at the moment
    // of the load, so the same rule applied there rejects legitimate transitions and cost test386 its
    // whole V86 section (POST 0x0B back to 0x20). Those need the transfer's own privilege logic, not
    // this one.
    const dpl = (access >> 5) & 3, conforming = isCode && (access & 0x04) !== 0;
    // DATA registers only — and the exclusion of SS is a KNOWN GAP, not caution. The SS rule (RPL and
    // DPL must both equal CPL) is what test386's POST-B needs next, but turning it on rejects
    // test386's OWN ring-switch helper: at `cs=0xab, eip=0x2d46` it loads SS=0x118 (DPL 0) while our
    // `_cpl` says 3. That load is legitimate on real silicon, so the rule is not wrong — our CPL
    // tracking through the ring-switch path is. Fix that first; the rule then costs nothing.
    // CS is excluded for a different reason: it is loaded by the transfers that CHANGE CPL.
    if (i !== SS && i !== CS && !conforming && dpl < Math.max(this._cpl, sel & 3)) {
      this.raise(13, sel & 0xfffc); return false;
    }
    // P=0 is a fault, not a usable descriptor: #NP(selector), or #SS(selector) when the load is into
    // the stack segment. Without it a not-present segment loaded silently and addressed whatever base
    // the table happened to hold — test386's POST-B expects EX_NP here and got a normal retirement.
    if (!(access & 0x80)) { this.raise(i === SS ? 12 : 11, sel & 0xfffc); return false; }
    let limit = (lo | ((gran & 0x0f) << 16)) >>> 0;
    if (gran & 0x80) limit = (((limit << 12) >>> 0) | 0xfff) >>> 0;   // G: the limit counts 4 KiB pages
    this.base[i] = (b0 | (b1 << 16) | (b2 << 24)) >>> 0;
    this.limit[i] = limit;
    this.segAccess[i] = access;
    // The same bit is called D on a code segment and B on a stack segment: 32-bit default operand
    // size for CS, 32-bit stack pointer for SS.
    if (i === CS) this.csD = (gran & 0x40) ? 1 : 0;
    else if (i === SS) this.ssB = (gran & 0x40) ? 1 : 0;
  }

  /** Raw descriptor fields for a selector, or null for the null selector. */
  readDesc(sel) {
    sel &= 0xffff;
    if ((sel & 0xfffc) === 0) return null;
    const tbl = (sel & 4) ? this.ldtr : this.gdtr;
    if ((sel & 0xfff8) + 7 > tbl.limit) return null;        // past the table: no descriptor to read
    const a = (tbl.base + (sel & 0xfff8)) >>> 0, m = this.mem;
    const access = m.r8(a + 5);
    return {
      w0: m.r16(a), w1: m.r16(a + 2), b4: m.r8(a + 4), access, b6: m.r8(a + 6), b7: m.r8(a + 7),
      sys: (access & 0x10) === 0, type: access & 0x0f, dpl: (access >> 5) & 3, present: (access & 0x80) !== 0,
    };
  }

  /**
   * LAR / LSL — a descriptor's access rights or limit WITHOUT loading it. Both set ZF on success and
   * leave the destination untouched otherwise, so these return -1 for "not accessible".
   *
   * Accessible: non-null, inside its table, present, and — except for CONFORMING code, readable from
   * anywhere — DPL >= max(CPL, RPL). Only the 386 system types below are valid operands.
   */
  _descVisible(sel) {
    sel &= 0xffff;
    if ((sel & 0xfffc) === 0) return null;                     // null selector is never accessible
    const tbl = (sel & 4) ? this.ldtr : this.gdtr;
    if ((sel & 0xfff8) + 7 > tbl.limit) return null;           // beyond the table
    const d = this.readDesc(sel);
    if (!d || !d.present) return null;
    if (d.sys) {
      // Valid system/gate types for LAR/LSL on a 386: LDT, TSS (avail/busy, 16 and 32 bit), and the
      // three gate kinds. Everything else (0, 8, 0xA, 0xD) is reserved and reads as inaccessible.
      const ok = [1, 2, 3, 4, 5, 9, 0xb, 0xc].includes(d.type);
      if (!ok) return null;
    }
    const conforming = !d.sys && (d.type & 0x0c) === 0x0c;
    if (!conforming) {
      const cpl = this.cpl, rpl = sel & 3;
      if (d.dpl < cpl || d.dpl < rpl) return null;
    }
    return d;
  }

  /** Access-rights dword for LAR: the descriptor's second dword with the base/limit bits masked
   *  out. A 16-bit operand keeps only the low half of that. -1 when inaccessible. */
  larRights(sel, is32) {
    const d = this._descVisible(sel);
    if (!d) return -1;
    const e2 = ((d.access << 8) | (d.b6 << 16) | (d.b7 << 24)) >>> 0;
    return (is32 ? (e2 & 0x00ffff00) : (e2 & 0x0000ff00)) >>> 0;
  }

  /** Segment limit for LSL, granularity applied. -1 when inaccessible. A gate has no limit. */
  lslLimit(sel) {
    const d = this._descVisible(sel);
    if (!d) return -1;
    if (d.sys && (d.type === 4 || d.type === 5 || d.type === 0xc)) return -1;   // gates carry no limit
    let lim = (d.w0 | ((d.b6 & 0x0f) << 16)) >>> 0;
    if (d.b6 & 0x80) lim = (((lim << 12) >>> 0) | 0xfff) >>> 0;                 // G: the limit counts 4 KiB pages
    return lim >>> 0;
  }

  /** LTR — the TSS descriptor lives in the GDT, like the LDT's. */
  loadTR(sel) {
    sel &= 0xffff; this.tr.sel = sel;
    const d = this.readDesc(sel);
    if (!d) { this.tr.base = 0; this.tr.limit = 0; return; }
    let limit = (d.w0 | ((d.b6 & 0x0f) << 16)) >>> 0;
    if (d.b6 & 0x80) limit = (((limit << 12) >>> 0) | 0xfff) >>> 0;
    this.tr.base = (d.w1 | (d.b4 << 16) | (d.b7 << 24)) >>> 0;
    this.tr.limit = limit;
  }

  /** The stack the TSS reserves for privilege level `pl` (32-bit TSS: ESP0 at +4, SS0 at +8, …). */
  tssStack(pl) {
    const m = this.mem, b = this.tr.base >>> 0;
    return { esp: m.r32(b + 4 + pl * 8) >>> 0, ss: m.r16(b + 8 + pl * 8) & 0xffff };
  }

  /**
   * Is this port access denied? Protected mode only. At CPL <= IOPL it is always allowed; above
   * that — and ALWAYS in virtual-8086 mode, where CPL is 3 — the TSS's I/O permission bitmap
   * decides, one bit per port, and a set bit denies.
   *
   * The bitmap's base is a word at TSS offset 0x66, and it runs to the TSS limit. A byte that would
   * lie past the limit denies: that is how a task with no bitmap (limit 0x67, the minimum 386 TSS)
   * gets no I/O at all. Before this, IN/OUT raised #GP for every CPL > IOPL, so a task the bitmap
   * PERMITS was refused as well; test386 tests both halves.
   *
   * @param {number} port  first port
   * @param {number} size  1, 2 or 4 — a word access needs both its bytes permitted
   */
  ioDenied(port, size) {
    if (!(this.cr0 & 1)) return false;
    if (!(this.flags & VM) && this.cpl <= this.iopl) return false;
    const b = this.tr.base >>> 0, lim = this.tr.limit >>> 0;
    if (lim < 0x67) return true;                          // not even a full 386 TSS
    const mapBase = this.mem.r16(b + 0x66);
    for (let i = 0; i < size; i++) {
      const p = (port + i) & 0xffff, off = mapBase + (p >>> 3);
      if (off > lim) return true;
      if (this.mem.r8((b + off) >>> 0) & (1 << (p & 7))) return true;
    }
    return false;
  }

  pushW(v, is32) { if (is32) this.push32(v); else this.push16(v); }

  /**
   * After an OUTWARD transfer (a far return or IRET to a less privileged ring), any of DS/ES/FS/GS
   * still holding a segment more privileged than the new CPL is loaded with the NULL selector — the
   * inner ring's data must not stay reachable from the outer one. Conforming code segments are
   * exempt, being readable from anywhere.
   *
   * test386 checks it directly: after returning from a ring-0 call gate it asserts
   * `mov ax,ds / cmp ax,0`. Leaving DS intact is a privilege leak, not just a stale register.
   */
  nullInvalidDataSegs(cpl) {
    for (const i of [ES, DS, FS, GS]) {
      const sel = this.seg[i];
      if ((sel & 0xfffc) === 0) continue;                    // already null
      const d = this.readDesc(sel);
      if (!d) continue;
      const conformingCode = !d.sys && (d.type & 0x0c) === 0x0c;
      if (!conformingCode && d.dpl < cpl) { this.seg[i] = 0; this.base[i] = 0; this.limit[i] = 0; }
    }
  }

  /**
   * Far CALL. In protected mode the destination descriptor decides everything, and it must be
   * examined BEFORE being used as a segment: S=0 marks a SYSTEM descriptor, and type 4 / 0xC are
   * 286 / 386 CALL GATES, whose "base/limit" fields are really selector:offset. Treating a gate as
   * a code segment is what made test386 POST 20 jump to linear 0xd0 and execute the real-mode IVT.
   *
   * A gate to a lower DPL also switches stacks: the inner stack comes from the TSS, the caller's
   * SS:ESP are pushed on it, and the gate's parameter count says how many words to copy across.
   */
  farCall(sel, off, is32, faultIp) {
    const plain = () => {
      this.pushW(this.seg[CS], is32); this.pushW(this.eip >>> 0, is32);
      this.setSeg(CS, sel); this.eip = off >>> 0;
    };
    if (!(this.cr0 & 1)) return plain();
    const d = this.readDesc(sel);
    // An ordinary code segment: same rule as farJmp. Only a CALL GATE (below) changes rings.
    if (d && !d.sys) {
      const cpl = this.cpl;
      const conforming = (d.type & 0x0c) === 0x0c;
      if (conforming ? d.dpl > cpl : ((sel & 3) > cpl || d.dpl !== cpl)) {
        // EIP holds the return address a successful call would push; a fault must save the CALL's.
        if (faultIp !== undefined) this.eip = faultIp >>> 0;
        return this.raise(13, sel & 0xfffc);
      }
    }
    if (!d || !d.sys) return plain();
    if (d.type !== 0x04 && d.type !== 0x0c) return plain();  // not a call gate (task gate etc.): later
    const g32 = d.type === 0x0c;
    const gSel = d.w1 & 0xffff;
    const gOff = g32 ? ((d.w0 | ((d.b6 | (d.b7 << 8)) << 16)) >>> 0) : d.w0;
    const params = d.b4 & 0x1f;
    const target = this.readDesc(gSel);
    const cpl = this.cpl;
    const tdpl = target ? target.dpl : cpl;
    if (tdpl < cpl) {                                        // inward: switch to the TSS's stack
      const oldSS = this.seg[SS], oldESP = this.reg[4] >>> 0;
      const inner = this.tssStack(tdpl);
      const args = [];
      for (let i = 0; i < params; i++) {
        const a = (this.base[SS] + ((oldESP + i * (g32 ? 4 : 2)) >>> 0)) >>> 0;
        args.push(g32 ? this.mem.r32(a) : this.mem.r16(a));
      }
      this.setSeg(SS, inner.ss); this.reg[4] = inner.esp;
      this.pushW(oldSS, g32); this.pushW(oldESP, g32);
      for (let i = params - 1; i >= 0; i--) this.pushW(args[i], g32);
    }
    this.pushW(this.seg[CS], g32); this.pushW(this.eip >>> 0, g32);
    this.setSeg(CS, (gSel & 0xfffc) | tdpl);                 // CS's RPL becomes the new CPL
    this.eip = gOff >>> 0;
  }

  /** Far JMP. A gate is followed the same way, but nothing is pushed and no stack switch happens. */
  farJmp(sel, off) {
    if (this.cr0 & 1) {
      const d = this.readDesc(sel);
      if (d && d.sys && (d.type === 0x04 || d.type === 0x0c)) {
        const g32 = d.type === 0x0c;
        this.setSeg(CS, d.w1 & 0xffff);
        this.eip = (g32 ? ((d.w0 | ((d.b6 | (d.b7 << 8)) << 16)) >>> 0) : d.w0) >>> 0;
        return;
      }
      // A far JMP cannot change privilege, only stay at it: a non-conforming target demands
      // CPL == DPL exactly plus RPL <= CPL, a conforming one only DPL <= CPL.
      if (d && !d.sys) {
        const cpl = this.cpl;
        const conforming = (d.type & 0x0c) === 0x0c;
        if (conforming ? d.dpl > cpl : ((sel & 3) > cpl || d.dpl !== cpl)) {
          this.raise(13, sel & 0xfffc);
          return;
        }
      }
    }
    this.setSeg(CS, sel); this.eip = off >>> 0;
  }

  /** Far RET. Like IRET, an outward return also restores the caller's SS:ESP. */
  farRet(is32, popBytes, faultIp) {
    const pop = is32 ? () => this.pop32() : () => this.pop16();
    const cpl = this.cpl;
    const esp0 = this.reg[4];                       // to restore if the return is not permitted
    const eip = is32 ? (pop() >>> 0) : pop();
    const cs = pop() & 0xffff;
    // A far RET goes outward or stays put, never inward: the target's RPL must be >= CPL, and a
    // non-conforming segment's DPL must equal that RPL. The stack is rewound — a fault consumes
    // nothing.
    if (this.cr0 & 1) {
      const rpl = cs & 3;
      const d = this.readDesc(cs);
      const conforming = d && !d.sys && (d.type & 0x0c) === 0x0c;
      if (rpl < cpl || (d && !d.sys && (conforming ? d.dpl > rpl : d.dpl !== rpl))) {
        this.reg[4] = esp0;
        if (faultIp !== undefined) this.eip = faultIp >>> 0;
        return this.raise(13, cs & 0xfffc);
      }
    }
    if (popBytes) this.spAdd(popBytes);
    if ((this.cr0 & 1) && (cs & 3) > cpl) {
      const esp = is32 ? (pop() >>> 0) : pop();
      const ss = pop() & 0xffff;
      this.setSeg(CS, cs); this.eip = eip;
      this.setSeg(SS, ss); this.reg[4] = esp;
      if (popBytes) this.spAdd(popBytes);
      this.nullInvalidDataSegs(cs & 3);
    } else {
      this.setSeg(CS, cs); this.eip = eip;
    }
  }

  /**
   * IRET. In real mode it pops EIP/CS/EFLAGS and nothing else. In protected mode, returning to a
   * LESS privileged ring pops two more items — the caller's ESP and SS — because entering the inner
   * ring had switched stacks. test386's switchToRing3 is exactly this: it builds a five-element
   * frame (EIP, CS, EFLAGS, ESP, SS) and IRETs into ring 3. Getting the frame length wrong is how a
   * bogus CS ends up loaded, which is what made it spin at 9bf0:0004.
   *
   * The width comes from the operand size, so iretd pops dwords.
   */
  iret(is32) {
    const pop = is32 ? () => this.pop32() : () => this.pop16();
    if (!(this.cr0 & 1)) {                       // real mode — unchanged
      this.eip = is32 ? (pop() >>> 0) : pop();
      this.setSeg(CS, pop() & 0xffff);
      this.flags = (pop() & 0x7fd5) | 2;
      return;
    }
    // Inside a V86 task, IRET is one of the IOPL-sensitive instructions: at IOPL < 3 it must trap to
    // the monitor instead of returning. At IOPL 3 it behaves as the 8086's, and cannot touch VM/IOPL.
    if (this.flags & VM) {
      if (this.iopl < 3) return this.raise(13, 0);
      const keep = this.flags & (VM | IOPL);
      this.eip = is32 ? (pop() >>> 0) : pop();
      this.setSeg(CS, pop() & 0xffff);
      this.flags = ((pop() & 0x7fd5) | 2 | keep) >>> 0;
      return;
    }
    const cpl = this.cpl;
    const eip = is32 ? (pop() >>> 0) : pop();
    const cs = pop() & 0xffff;
    const fl = pop();
    // IRETD from ring 0 with VM set in the popped EFLAGS is the ONLY way into virtual-8086 mode
    // short of a task switch. The frame is nine dwords, not three: the four data segments ride in it
    // because a V86 task's segment registers are 8086 values that no descriptor can describe.
    if (is32 && cpl === 0 && (fl & VM)) return this.enterV86(eip, cs, fl);
    if ((cs & 3) > cpl) {                        // outward transition: the frame carries the stack
      const esp = is32 ? (pop() >>> 0) : pop();
      const ss = pop() & 0xffff;
      this.setSeg(CS, cs); this.eip = eip;
      this.setSeg(SS, ss); this.reg[4] = esp;    // SS first: it decides whether ESP is 16 or 32 bits
      this.nullInvalidDataSegs(cs & 3);
    } else {
      this.setSeg(CS, cs); this.eip = eip;
    }
    this.flags = (fl & 0x27fd5) | 2;
  }

  /**
   * Enter virtual-8086 mode from an IRETD frame whose EFLAGS has VM set. EIP, CS and EFLAGS are
   * already popped; what remains is ESP, SS, ES, DS, FS and GS — six more dwords, always dwords
   * whatever the segment they hold. VM must be set BEFORE the segments are loaded, since it is what
   * makes setSeg treat them as 8086 values rather than selectors.
   */
  enterV86(eip, cs, fl) {
    const esp = this.pop32() >>> 0, ss = this.pop32() & 0xffff;
    const es = this.pop32() & 0xffff, ds = this.pop32() & 0xffff;
    const fs = this.pop32() & 0xffff, gs = this.pop32() & 0xffff;
    this.flags = ((fl & 0x27fd5) | 2) >>> 0;              // VM is inside the mask
    this.setSeg(CS, cs); this.eip = eip >>> 0;
    this.setSeg(SS, ss); this.reg[4] = esp;
    this.setSeg(ES, es); this.setSeg(DS, ds); this.setSeg(FS, fs); this.setSeg(GS, gs);
    this.ssB = 0;                                          // an 8086 stack is 16-bit
  }

  /**
   * LLDT: the operand selects a GDT descriptor OF TYPE LDT, whose base and limit become the LDTR.
   * Until this existed, every LDT selector resolved against ldtr.base = 0 and read whatever sat at
   * linear address 0 — which is how test386's 32-bit stack section (its segments live in the LDT)
   * silently got a garbage descriptor rather than a fault.
   */
  loadLDT(sel) {
    sel &= 0xffff;
    this.ldtr.sel = sel;
    if ((sel & 0xfffc) === 0) { this.ldtr.base = 0; this.ldtr.limit = 0; return; }
    const a = (this.gdtr.base + (sel & 0xfff8)) >>> 0;      // an LDT selector always indexes the GDT
    const m = this.mem;
    const lo = m.r16(a), b0 = m.r16(a + 2);
    const b1 = m.r8(a + 4), gran = m.r8(a + 6), b2 = m.r8(a + 7);
    let limit = (lo | ((gran & 0x0f) << 16)) >>> 0;
    if (gran & 0x80) limit = (((limit << 12) >>> 0) | 0xfff) >>> 0;
    this.ldtr.base = (b0 | (b1 << 16) | (b2 << 24)) >>> 0;
    this.ldtr.limit = limit;
  }

  /**
   * Write CR0. Switching PE does NOT re-resolve the segment registers: on real hardware the cached
   * descriptors survive the switch untouched and are only replaced when a segment register is
   * explicitly reloaded. That is not a detail — it is what the standard entry sequence depends on
   * (`mov cr0,eax` with PE set, THEN a far jump to load CS), because at that instant DS/ES/SS still
   * hold real-mode paragraph values that are not valid selectors. Re-resolving them here would read
   * whatever the GDT happens to contain at those indices. It is also what makes "unreal mode" work.
   */
  setCR0(v) {
    // Notify on any change to PAGING-IN-EFFECT, which is PG *and* PE: clearing PE with PG still set
    // turns translation off just as clearing PG does, and memory caches that answer.
    const was = this.pagingOn;
    this.cr0 = v >>> 0;
    if (this.pagingOn !== was) this.onPagingChange && this.onPagingChange();
  }

  /** CR3 reload: the whole software TLB is stale. */
  setCR3(v) { this.cr3 = v >>> 0; this.onPagingChange && this.onPagingChange(); }

  /** Paging enabled? Only meaningful with PE set — PG without PE is illegal. */
  get pagingOn() { return ((this.cr0 >>> 31) & 1) !== 0 && (this.cr0 & 1) !== 0; }

  /** Linear address of CS:IP — where the recompiler fetches the next block. */
  csip() { const a = this.base[CS] + (this.csD ? (this.eip >>> 0) : (this.eip & 0xffff));
    return this.mem.paged ? (a >>> 0) : (a & this.mem.mask); }

  // ---- real-mode stack -----------------------------------------------------
  /** The stack pointer in use: SP or ESP, per the SS descriptor's B bit. */
  get stackPtr() { return this.ssB ? (this.reg[4] >>> 0) : (this.reg[4] & 0xffff); }
  /** Adjust it by n, wrapping in 16 bits and preserving the high half when B=0. */
  spAdd(n) {
    if (this.ssB) this.reg[4] = (this.reg[4] + n) >>> 0;
    else this.reg[4] = (this.reg[4] & ~0xffff) | ((this.reg[4] + n) & 0xffff);
  }

  /**
   * Linear address of the stack top. The RAM/A20 mask belongs to PHYSICAL addresses, so it must not
   * be applied once paging is on — Windows 3.0's kernel stack lives at linear 0x800131e8, and with
   * A20 closed that was masked to 0x131e8: every push landed in low memory and every pop read zeros,
   * so its exception dispatcher read a return address of 0 and called through a wild pointer.
   */
  get stackLin() {
    const a = this.base[SS] + this.stackPtr;
    return this.mem.paged ? (a >>> 0) : (a & this.mem.mask);
  }

  push16(v) {
    this.spAdd(-2);
    this.mem.w16(this.stackLin, v & 0xffff);
  }
  pop16() {
    const v = this.mem.r16(this.stackLin);
    this.spAdd(2);
    return v;
  }
  push32(v) {
    this.spAdd(-4);
    this.mem.w32(this.stackLin, v >>> 0);
  }
  pop32() {
    const v = this.mem.r32(this.stackLin);
    this.spAdd(4);
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
  // The count mask comes from the CPU profile (src/cpu-profile.js): a 286+ masks it to 5 bits, an
  // 8086/88 uses CL in full. That is why the shifts below handle counts >= the operand width
  // explicitly instead of leaning on JS's `<<`, which silently masks to 5 bits and would turn a
  // shift of 32 into a shift of 0.
  shl(v, c, bits) {
    const m = bits === 32 ? 0xffffffff : (1 << bits) - 1, msb = bits - 1;
    v &= m; c &= this.shiftMask; if (!c) return v;
    // Everything is shifted out: the result is 0, and CF is the last bit to leave (the LSB when the
    // count equals the width, nothing at all beyond it).
    if (c >= bits) { const cf = c === bits ? (v & 1) : 0; this.setShiftResult(0, bits, !!cf, false); return 0; }
    const cf = c <= bits ? (v >>> (bits - c)) & 1 : 0;
    const res = (v << c) & m;
    const of = c === 1 ? (((res >>> msb) & 1) ^ cf) : 0;
    this.setShiftResult(res, bits, !!cf, !!of); return res;
  }
  shr(v, c, bits) {
    const m = bits === 32 ? 0xffffffff : (1 << bits) - 1, msb = bits - 1;
    v &= m; c &= this.shiftMask; if (!c) return v;
    if (c >= bits) { const cf = c === bits ? ((v >>> msb) & 1) : 0; this.setShiftResult(0, bits, !!cf, false); return 0; }
    const cf = (v >>> (c - 1)) & 1, res = (v >>> c) & m;
    const of = c === 1 ? (v >>> msb) & 1 : 0;
    this.setShiftResult(res, bits, !!cf, !!of); return res;
  }
  sar(v, c, bits) {
    const m = bits === 32 ? 0xffffffff : (1 << bits) - 1, msb = 1 << (bits - 1);
    v &= m; c &= this.shiftMask; if (!c) return v;
    // An arithmetic shift saturates to the sign: every bit becomes the sign bit, which is also CF.
    if (c >= bits) { const neg = (v & msb) !== 0, res = neg ? m : 0; this.setShiftResult(res, bits, neg, false); return res; }
    const sv = ((v & msb) ? (v | ~m) : v) | 0;
    const cf = (sv >> (c - 1)) & 1, res = (sv >> c) & m;
    this.setShiftResult(res, bits, !!cf, false); return res;
  }
  // ROL/ROR: count masked to 5 bits (286+); period = bits. When the masked count is a nonzero
  // multiple of the period the value is unchanged but CF is STILL written (= LSB for ROL, MSB for
  // ROR) — a genuine bug in the old `if(!effective) return` path, independent of the count mask.
  rol(v, c, bits) {
    const m = bits === 32 ? 0xffffffff : (1 << bits) - 1;
    v &= m; c &= this.shiftMask; if (!c) return v;
    const e = c % bits;
    const res = e ? (((v << e) | (v >>> (bits - e))) & m) : v, cf = res & 1;
    const of = c === 1 ? (((res >>> (bits - 1)) & 1) ^ cf) : 0;
    this.setShiftResult(res, bits, !!cf, !!of, false); return res;
  }
  ror(v, c, bits) {
    const m = bits === 32 ? 0xffffffff : (1 << bits) - 1, msb = bits - 1;
    v &= m; c &= this.shiftMask; if (!c) return v;
    const e = c % bits;
    const res = e ? (((v >>> e) | (v << (bits - e))) & m) : v, cf = (res >>> msb) & 1;
    const of = c === 1 ? (((res >>> msb) & 1) ^ ((res >>> (msb - 1)) & 1)) : 0;
    this.setShiftResult(res, bits, !!cf, !!of, false); return res;
  }
  // RCL/RCR: through-carry, period = bits+1; count masked to 5 bits (286+). A full period restores
  // both value and CF, so an effective count of 0 returns unchanged with no flag write.
  rcl(v, c, bits) {
    const m = bits === 32 ? 0xffffffff : (1 << bits) - 1;
    v &= m; c &= this.shiftMask; c %= (bits + 1); if (!c) return v;
    let cf = (this.flags & CF) ? 1 : 0;
    for (let i = 0; i < c; i++) { const nb = (v >>> (bits - 1)) & 1; v = ((v << 1) | cf) & m; cf = nb; }
    const of = (((v >>> (bits - 1)) & 1) ^ cf);
    this.setShiftResult(v, bits, !!cf, !!of, false); return v;
  }
  rcr(v, c, bits) {
    const m = bits === 32 ? 0xffffffff : (1 << bits) - 1, msb = 1 << (bits - 1);
    v &= m; c &= this.shiftMask; c %= (bits + 1); if (!c) return v;
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
  div8(s)  { s &= 0xff;  if (!s) { this.swInt(0); return true; } const n = this.ax, q = (n / s) | 0; if (q > 0xff) { this.swInt(0); return true; } this.al = q; this.ah = n % s; }
  div16(s) { s &= 0xffff; if (!s) { this.swInt(0); return true; } const n = (this.dx & 0xffff) * 65536 + (this.ax & 0xffff), q = Math.floor(n / s); if (q > 0xffff) { this.swInt(0); return true; } this.ax = q; this.dx = n % s; }
  idiv8(s) { s = (s << 24 >> 24); if (!s) { this.swInt(0); return true; } const n = (this.ax << 16 >> 16), q = (n / s) | 0; if (q < -128 || q > 127) { this.swInt(0); return true; } this.al = q & 0xff; this.ah = (n % s) & 0xff; }
  idiv16(s){ s = (s << 16 >> 16); if (!s) { this.swInt(0); return true; } const n = (((this.dx & 0xffff) << 16) | (this.ax & 0xffff)) | 0, q = (n / s) | 0; if (q < -32768 || q > 32767) { this.swInt(0); return true; } this.ax = q & 0xffff; this.dx = (n % s) & 0xffff; }
  // 32-bit MUL/IMUL/DIV/IDIV: EDX:EAX is a 64-bit value, beyond float64's exact range, so
  // compute with BigInt. reg[0]=EAX, reg[2]=EDX.
  mul32(s)  { const p = BigInt(this.reg[0] >>> 0) * BigInt(s >>> 0); this.reg[0] = Number(BigInt.asUintN(32, p)); this.reg[2] = Number(BigInt.asUintN(32, p >> 32n)); const c = this.reg[2] !== 0; this.setShiftResult(0, 32, c, c, false); }
  imul32(s) { const p = BigInt(this.reg[0] | 0) * BigInt(s | 0); this.reg[0] = Number(BigInt.asUintN(32, p)); this.reg[2] = Number(BigInt.asUintN(32, p >> 32n)); const c = p < -2147483648n || p > 2147483647n; this.setShiftResult(0, 32, c, c, false); }
  div32(s)  { s >>>= 0; if (!s) { this.swInt(0); return true; } const n = (BigInt(this.reg[2] >>> 0) << 32n) | BigInt(this.reg[0] >>> 0), bs = BigInt(s), q = n / bs; if (q > 0xffffffffn) { this.swInt(0); return true; } this.reg[0] = Number(q); this.reg[2] = Number(n % bs); }
  idiv32(s) { s |= 0; if (!s) { this.swInt(0); return true; } const n = BigInt.asIntN(64, (BigInt(this.reg[2] >>> 0) << 32n) | BigInt(this.reg[0] >>> 0)), bs = BigInt(s), q = n / bs; if (q > 2147483647n || q < -2147483648n) { this.swInt(0); return true; } this.reg[0] = Number(BigInt.asUintN(32, q)); this.reg[2] = Number(BigInt.asUintN(32, n % bs)); }

  // three-operand / 0F IMUL: signed multiply, result in this._mr, sets CF/OF
  imul16x(a, b, bits) {
    if (bits === 16) { a = a << 16 >> 16; b = b << 16 >> 16; const p = a * b; this._mr = p & 0xffff; const c = (p < -32768 || p > 32767); this.setShiftResult(0, 16, c, c, false); }
    else { a |= 0; b |= 0; this._mr = Math.imul(a, b) >>> 0; const p = a * b; const c = (this._mr | 0) !== p; this.setShiftResult(0, 32, c, c, false); }
  }
  aam(base) { if (base === 0) { this.swInt(0); return true; } const al = this.reg[0] & 0xff; this.ah = (al / base) | 0; this.al = al % base; this.setLogic(this.reg[0] & 0xff, 8); }
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
