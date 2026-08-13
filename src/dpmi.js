// dpmi.js — a DPMI 0.9 host: the mode-switch entry point plus the INT 31h services a client needs.
//
// Why a host at all. A DOS extender asks INT 2Fh AX=1687h whether one is present. Answer "no" and
// it takes its HARDEST path — switching to protected mode itself through VCPI or raw hardware, with
// INT 15h extended-memory services and its own descriptor tables. Answer "yes" and it takes the
// documented client path: far-call our entry point to be put into protected mode, then ask for
// everything else through INT 31h. That path is specified, testable, and far smaller.
//
// Discovery and entry follow the same shape as xms.js: a marker byte at a fixed f000 address that
// the recompiler intercepts, so a FAR CALL to it runs JS instead of bytes.
//
// The host's own tables live at the TOP of RAM, and the XMS pool is capped below them so the two
// allocators cannot collide.

import { CS, DS, ES, SS } from './cpu.js';

export const DPMI_ENTRY_SEG = 0xf000, DPMI_ENTRY_OFF = 0x0200;   // far-callable mode-switch entry
const STATE_STUB_OFF = 0x0210;                                   // the do-nothing state save/restore

const LDT_ENTRIES = 512;                    // 4 KiB of descriptors — far more than a client uses
const HOST_SIZE = 0x10000;                  // 64 KiB reserved at the top of RAM for the tables

// Client descriptors live in the LDT, not the GDT. Every real host does this — CWSDPMI, DOS/4GW's
// own, Windows — and a client is entitled to assume it: DOS/4GW derived a selector with the TI bit
// set (0x0004 = LDT entry 0) from what we handed back, found an LDTR we had never loaded, and ran
// off through low memory in 0x180-byte strides. INT 31h AX=0000 (allocate descriptors) is specified
// to return LDT selectors too, so this is also the shape the services need.
const TI = 4;                                     // selector bit 2: 1 = LDT
const SEL_CODE32 = 0x08 | TI, SEL_DATA32 = 0x10 | TI;   // flat 4 GiB, the pair a 32-bit client wants
const SEL_HOST_CODE = 0x18;                       // host code, for far addresses we hand out
const SEL_CLIENT = 0x20;                          // first client segment (index, TI added on return)
const SEL_MAX = LDT_ENTRIES * 8;

export function installDPMI(machine) {
  const mem = machine.mem, cpu = machine.cpu;

  const HOST_BASE = mem.size - HOST_SIZE;
  const LDT_BASE = HOST_BASE, LDT_LIMIT = LDT_ENTRIES * 8 - 1;

  // Keep XMS out of the host's reserved block. Without this the two bump allocators overlap and the
  // symptom is a descriptor table quietly overwritten by a game's extended-memory allocation.
  if (machine.xms) machine.xms.max = Math.min(machine.xms.max, HOST_BASE);

  const dpmi = {
    active: false,                 // has a client switched to protected mode?
    is32: false,
    nextSel: SEL_CLIENT,           // bump allocator over the LDT
    unimplemented: new Map(),      // INT 31h AX values a client asked for and we refused
    reset() { this.active = false; this.is32 = false; this.nextSel = SEL_CLIENT; this.unimplemented = new Map(); },
  };

  /** Write one 8-byte descriptor. `access` is the P/DPL/S/type byte, `gran` the G/D/limit-high byte. */
  const setDesc = (sel, base, limit, access, gran) => {
    const a = (LDT_BASE + (sel & 0xfff8)) >>> 0;
    let g = gran & 0xf0;
    if (limit > 0xfffff) { limit = limit >>> 12; g |= 0x80; }     // G=1: the limit counts 4 KiB pages
    mem.w16(a, limit & 0xffff);
    mem.w16(a + 2, base & 0xffff);
    mem.w8(a + 4, (base >>> 16) & 0xff);
    mem.w8(a + 5, access & 0xff);
    mem.w8(a + 6, g | ((limit >>> 16) & 0x0f));
    mem.w8(a + 7, (base >>> 24) & 0xff);
  };

  /** A descriptor for one of the client's real-mode segments: same bytes, seen through a selector. */
  const allocClientSel = (seg, code) => {
    if (dpmi.nextSel >= SEL_MAX) return 0;
    const sel = dpmi.nextSel; dpmi.nextSel += 8;
    // Ring 0, deliberately. A real host runs its client at ring 3, but MIRAGE has no reason to
    // enforce that boundary yet and DOS/4GW executes CLI/STI and port I/O constantly: at CPL 3 with
    // IOPL 0 the very first one raises #GP(0), which is exactly where Doom died (1b:6e9d). Tightening
    // this later means changing the DPL here and the RPL below, and supplying a TSS — nothing else.
    // D/B = 0: these describe the client's REAL-MODE segments, which hold 16-bit code and a 16-bit
    // stack. Marking them 32-bit made the recompiler decode 16-bit instructions at the wrong width,
    // and DOS/4GW's third instruction after the switch loaded raw opcode bytes into EIP
    // (001c:6e9d -> 001c:e89713d). A client that wants 32-bit selectors allocates them itself.
    setDesc(sel, (seg & 0xffff) << 4, 0xffff, code ? 0x9a : 0x92, 0x00);
    return sel | TI;
  };

  /** Build the tables once, on the first mode switch. */
  const buildTables = () => {
    for (let i = 0; i < LDT_ENTRIES * 8; i++) mem.w8(LDT_BASE + i, 0);
    setDesc(SEL_CODE32, 0, 0xffffffff, 0x9a, 0xc0);      // flat code, 32-bit
    setDesc(SEL_DATA32, 0, 0xffffffff, 0x92, 0xc0);      // flat data, 32-bit
    // Deliberately NO IDT. Software interrupts are reflected to the JS services in Machine.softInt,
    // so the only thing an IDT would serve here is EXCEPTIONS — and an exception inside a DPMI
    // client is a defect we want to SEE. An earlier version installed 256 gates pointing at a
    // reflector stub that was described in a comment and never written: every fault then jumped to
    // linear 0x21x, executed the interrupt vector table as code, and Doom "exited cleanly" with no
    // message. Silent garbage is the worst possible outcome; protInt now names the vector instead.
    // A 16-bit code selector over the BIOS segment. Services that must hand the client a
    // PROTECTED-MODE far address (0305 below) need one; a real-mode segment value will not do.
    setDesc(SEL_HOST_CODE, DPMI_ENTRY_SEG << 4, 0xffff, 0x9a, 0x00);
    // Load LDTR directly rather than through LLDT: that would need a GDT entry describing the LDT,
    // and nothing here reads one. The GDT stays empty — a client never sees a GDT selector from us.
    cpu.ldtr.sel = 0; cpu.ldtr.base = LDT_BASE; cpu.ldtr.limit = LDT_LIMIT;
  };

  /**
   * The mode-switch entry, reached by a FAR CALL from real mode.
   *
   * On entry AX bit 0 says whether the client is 32-bit, and ES points at the host data block it
   * allocated for us (we need none). On exit the client must be IN protected mode, with CS/DS/ES/SS
   * describing the very same memory its real-mode segments did, and execution continuing at the
   * instruction after the call. So the return address is popped in real mode and re-entered through
   * a selector — the one transition a RETF cannot express by itself.
   */
  const modeSwitch = () => {
    const is32 = (cpu.reg[0] & 1) !== 0;
    buildTables();

    const retOff = cpu.pop16(), retSeg = cpu.pop16();     // still a real-mode stack at this point
    const oldDS = cpu.seg[DS], oldES = cpu.seg[ES], oldSS = cpu.seg[SS];
    const csSel = allocClientSel(retSeg, true);
    const dsSel = allocClientSel(oldDS, false);
    // The spec is specific here: ES comes back describing the client's PSP, not whatever it held
    // before. DOS/4GW reads its command line and environment through it immediately after the
    // switch, so handing back the old ES gives it garbage at the very first thing it does.
    const psp = machine.dos ? machine.dos.psp : oldES;
    const esSel = allocClientSel(psp, false);
    const ssSel = oldSS === oldDS ? dsSel : allocClientSel(oldSS, false);

    cpu.setCR0((cpu.cr0 | 1) >>> 0);                     // PE — from here selectors are indices
    machine.rec.reset();                                  // every cached block assumed real mode
    cpu.setSeg(DS, dsSel); cpu.setSeg(ES, esSel); cpu.setSeg(SS, ssSel);
    cpu.setSeg(CS, csSel); cpu.eip = retOff;
    cpu.flags &= ~1;                                      // CF=0: the switch succeeded
    dpmi.active = true; dpmi.is32 = is32;
  };

  // ---- INT 31h services -----------------------------------------------------
  //
  // The set here is the one Doom actually asks for, in the order it asks (captured with
  // tools/dpmi-probe.mjs). Implementing what a client calls beats implementing what the spec lists:
  // DPMI 0.9 has ~60 functions and this client opens with three.
  //
  // Convention: CF clear on success; CF set with AX = error code on failure.

  const ok = () => { cpu.flags &= ~1; };
  const fail = (code) => { cpu.flags |= 1; cpu.ax = code; };

  const ERR_UNSUPPORTED = 0x8001, ERR_INVALID_SELECTOR = 0x8022;

  /** Byte offset of a selector's descriptor in the LDT, or -1 if it is not one of ours. */
  const descOffset = (sel) => {
    sel &= 0xffff;
    if (!(sel & TI)) return -1;                       // GDT selector: our GDT is empty by design
    const off = sel & 0xfff8;
    return off + 7 <= LDT_LIMIT ? off : -1;
  };

  /** ES:(E)DI, the buffer both descriptor calls use. A 16-bit client passes DI, a 32-bit one EDI. */
  const bufAddr = () => (cpu.base[ES] + (dpmi.is32 ? (cpu.reg[7] >>> 0) : (cpu.reg[7] & 0xffff))) >>> 0;

  machine.hookInterrupt(0x31, (c) => {
    switch (c.ax) {
      // 000B — Get Descriptor. Copy the 8 raw bytes to the client's buffer. A client reads a
      // descriptor before editing it, so this and 000C are always used as a pair.
      case 0x000b: {
        const off = descOffset(c.reg[3] & 0xffff);
        if (off < 0) return fail(ERR_INVALID_SELECTOR);
        const src = (LDT_BASE + off) >>> 0, dst = bufAddr();
        for (let i = 0; i < 8; i++) mem.w8((dst + i) >>> 0, mem.r8((src + i) >>> 0));
        return ok();
      }

      // 000C — Set Descriptor. The client writes base, limit and access rights this way rather than
      // through individual calls. Nothing reloads a segment register that already holds the
      // selector: real hardware keeps the cached descriptor until the selector is loaded again, and
      // matching that is both correct and what the client expects.
      case 0x000c: {
        const off = descOffset(c.reg[3] & 0xffff);
        if (off < 0) return fail(ERR_INVALID_SELECTOR);
        const dst = (LDT_BASE + off) >>> 0, src = bufAddr();
        for (let i = 0; i < 8; i++) mem.w8((dst + i) >>> 0, mem.r8((src + i) >>> 0));
        return ok();
      }

      // 0305 — Get State Save/Restore Addresses. The client calls the routine we name here around a
      // mode switch so the host can preserve anything the CPU state does not carry. We keep no such
      // state per client, so the buffer size is zero and both routines are a bare RETF. Refusing
      // this outright is not an option: the client stores the addresses unconditionally and calls
      // them later, so a refusal leaves it holding whatever was in the registers.
      //   AX = buffer size in words, BX:CX = real-mode routine, SI:DI = protected-mode routine
      case 0x0305: {
        c.ax = 0;
        c.reg[3] = (c.reg[3] & ~0xffff) | DPMI_ENTRY_SEG;            // BX
        c.reg[1] = (c.reg[1] & ~0xffff) | STATE_STUB_OFF;            // CX
        c.reg[6] = (c.reg[6] & ~0xffff) | (SEL_HOST_CODE | TI);      // SI
        c.reg[7] = (c.reg[7] & ~0xffff) | STATE_STUB_OFF;            // DI
        return ok();
      }

      // 0A00 — Get Vendor-Specific API Entry Point. Extenders probe for host extensions (DOS/4GW
      // asks for "RATIONAL DOS/4G"). We have none, and saying so is the correct answer — a host is
      // not required to provide any.
      case 0x0a00:
        return fail(ERR_UNSUPPORTED);

      default:
        dpmi.unimplemented.set(c.ax, (dpmi.unimplemented.get(c.ax) || 0) + 1);
        return fail(ERR_UNSUPPORTED);
    }
  });

  cpu.dpmiSwitch = modeSwitch;
  machine.dpmi = dpmi;
  mem.u8[(DPMI_ENTRY_SEG << 4) + DPMI_ENTRY_OFF] = 0xcb;  // marker byte (RETF) the recompiler guards on
  // The state save/restore routine 0305 advertises. We keep no extra host state per client, so the
  // routine has nothing to do and a bare RETF is the whole of it — which is also why 0305 reports a
  // buffer size of zero. It is a normal RETF byte, not a guarded entry: it really does just return.
  mem.u8[(DPMI_ENTRY_SEG << 4) + STATE_STUB_OFF] = 0xcb;

  // INT 2Fh AX=1687h — "is a DPMI host present, and where do I switch?" Chain to whatever already
  // owns the vector (XMS answers 43xx there) rather than replacing it.
  const prev = machine.intHandlers[0x2f];
  machine.hookInterrupt(0x2f, (c, m) => {
    if (c.ax === 0x1687) {
      c.ax = 0;                                  // 0 = host present
      c.reg[3] = (c.reg[3] & ~0xffff) | 1;       // BX bit 0: 32-bit programs supported
      c.reg[1] = (c.reg[1] & ~0xff) | 3;         // CL = processor type (3 = 386)
      c.reg[2] = (c.reg[2] & ~0xffff) | 0x005a;  // DX = DPMI version 0.90
      c.reg[6] = c.reg[6] & ~0xffff;             // SI = paragraphs of host data needed: none
      c.setSeg(ES, DPMI_ENTRY_SEG); c.reg[7] = (c.reg[7] & ~0xffff) | DPMI_ENTRY_OFF;
      return;
    }
    if (prev) prev(c, m);
  });

  return dpmi;
}
