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

import { CS, DS, ES, SS, FS, GS, TF } from './cpu.js';

const TF_MASK = TF;   // a real-mode call must not inherit the client's single-step flag

export const DPMI_ENTRY_SEG = 0xf000, DPMI_ENTRY_OFF = 0x0200;   // far-callable mode-switch entry
const STATE_STUB_OFF = 0x0210;                                   // the do-nothing state save/restore
const RAW_R2P_OFF = 0x0220, RAW_P2R_OFF = 0x0230;                // raw mode-switch routines (0306)
const RM_RET_OFF = 0x0240;                                       // where a 0302 real-mode call returns
const RM_STACK_TOP = 0x0500;                                     // host-provided real-mode stack (256 B below)
const CB_BASE_OFF = 0x0600, CB_MAX = 16;                         // real-mode callback entries (0303)

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

  // The DPMI heap grows DOWN from the host tables while XMS grows UP from 1 MiB, and the XMS ceiling
  // is lowered to whatever the heap has reached. One pool with two ends beats two pools with a
  // guessed split: a client that wants 8 MiB gets it if XMS has not taken it.
  const heapFloor = () => (machine.xms ? machine.xms.top : 0x100000);

  const dpmi = {
    active: false,                 // has a client switched to protected mode?
    is32: false,
    nextSel: SEL_CLIENT,           // bump allocator over the LDT
    unimplemented: new Map(),      // INT 31h AX values a client asked for and we refused
    // Protected-mode interrupt vectors the client installed with 0205. A null entry means "still
    // ours", and softInt reflects those to the JS service as before.
    pmVec: new Array(256).fill(null),
    // Processor EXCEPTION handlers (0202/0203), a separate table from the interrupt vectors above:
    // vector 0Dh as an exception is #GP, not INT 0Dh.
    excVec: new Array(32).fill(null),
    rmCalls: [],                   // 0302 calls in flight (nested calls are legal)
    callbacks: [],                 // 0303: real-mode addresses that re-enter protected-mode code
    memTop: 0,                     // DPMI heap: grows DOWN from the host tables (set below)
    blocks: new Map(),             // handle -> { base, size }
    log: null,                     // set by a probe to record real-mode call targets
    reset() { this.active = false; this.is32 = false; this.nextSel = SEL_CLIENT; this.unimplemented = new Map(); this.pmVec = new Array(256).fill(null); this.excVec = new Array(32).fill(null); this.rmCalls = []; this.callbacks = []; },
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
    // A20 FIRST. Protected mode requires it, and until it is on every address is masked to 1 MiB —
    // so our tables at 0xFF0000 aliased onto 0xF0000 and wrote descriptors straight over the BIOS
    // stubs. They still worked (reads aliased the same way), but f000:0021 stopped being the INT 21h
    // stub, so a client calling that vector through 0302 ran whatever the descriptor bytes decoded
    // to. Nothing pointed at the cause: the tables were self-consistent and the damage was elsewhere.
    machine.mem.setA20(true);
    machine.rec.MM = machine.mem.mask;
    machine.rec.reset();
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

  const ERR_UNSUPPORTED = 0x8001, ERR_INVALID_SELECTOR = 0x8022, ERR_INVALID_VALUE = 0x8021;

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

      // 0306 — Get Raw Mode Switch Addresses. Refusing this is worse than useless: the client does
      // not check CF, so it stored 0305's leftover BX:CX/SI:DI as the switch routines and later
      // transferred through them (#GP at 24:893e with selector 0x210). Blanking the registers on
      // refusal would only move the crash to 0000:0000.
      //   BX:CX = real -> protected routine, SI:DI = protected -> real routine
      case 0x0306: {
        c.reg[3] = (c.reg[3] & ~0xffff) | DPMI_ENTRY_SEG;            // BX
        c.reg[1] = (c.reg[1] & ~0xffff) | RAW_R2P_OFF;               // CX
        c.reg[6] = (c.reg[6] & ~0xffff) | (SEL_HOST_CODE | TI);      // SI
        c.reg[7] = (c.reg[7] & ~0xffff) | RAW_P2R_OFF;               // DI
        return ok();
      }

      // 0000 — Allocate LDT Descriptors. CX consecutive entries, zeroed and marked not-present; the
      // client fills them in with 000C. This is the call that makes a client self-sufficient, and it
      // is why the descriptors had to live in the LDT in the first place.
      //   in: CX = count;  out: AX = base selector
      case 0x0000: {
        const count = c.reg[1] & 0xffff;
        if (count === 0) return fail(ERR_INVALID_VALUE);
        if (dpmi.nextSel + count * 8 > SEL_MAX) return fail(0x8011);   // descriptor unavailable
        const base = dpmi.nextSel;
        for (let i = 0; i < count; i++) {
          const off = base + i * 8;
          for (let b = 0; b < 8; b++) mem.w8((LDT_BASE + off + b) >>> 0, 0);
        }
        dpmi.nextSel += count * 8;
        c.ax = base | TI;
        return ok();
      }

      // 0003 — Get Selector Increment Value: how far apart consecutive selectors are. Always 8 on a
      // 386; the client uses it to walk a block returned by 0000.
      case 0x0003:
        c.reg[0] = (c.reg[0] & ~0xffff) | 8;      // AX
        return ok();

      // 0008 — Set Segment Limit. The client grows a descriptor it allocated with 0000, typically to
      // cover a memory block it just obtained. Above 1 MiB the limit must be expressed in 4 KiB
      // pages with G=1, and the low 12 bits must then be all ones — a limit that is not page-aligned
      // is an error, not something to round.
      //   in: BX = selector, CX:DX = 32-bit limit
      case 0x0008: {
        const off = descOffset(c.reg[3] & 0xffff);
        if (off < 0) return fail(ERR_INVALID_SELECTOR);
        let limit = (((c.reg[1] & 0xffff) << 16) | (c.reg[2] & 0xffff)) >>> 0;
        const a = (LDT_BASE + off) >>> 0;
        let gran = mem.r8(a + 6) & 0xf0;
        if (limit > 0xfffff) {
          if ((limit & 0xfff) !== 0xfff) return fail(ERR_INVALID_VALUE);
          limit = limit >>> 12; gran |= 0x80;
        } else {
          gran &= ~0x80;
        }
        mem.w16(a, limit & 0xffff);
        mem.w8(a + 6, gran | ((limit >>> 16) & 0x0f));
        return ok();
      }

      // 0304 — Free Real Mode Callback Address. We hand out no callbacks yet (0303), so there is
      // nothing to release; reporting success keeps the client's teardown path clean.
      case 0x0304:
        return ok();

      // 0302 — Call Real Mode Procedure with IRET Frame. Completes in realCallReturn, not here, so
      // there is no ok(): CF is set on the way back out.
      //   in: CX = words to copy from the protected-mode stack, ES:(E)DI = real mode call structure
      case 0x0302:
        realCall(bufAddr(), c.reg[1] & 0xffff);
        return;

      // 0001 — Free LDT Descriptor. The bump allocator never reuses a slot, so freeing is just
      // marking the descriptor not-present: a selector the client later loads by mistake then faults
      // instead of silently addressing whatever was there.
      case 0x0001: {
        const off = descOffset(c.reg[3] & 0xffff);
        if (off < 0) return fail(ERR_INVALID_SELECTOR);
        mem.w8((LDT_BASE + off + 5) >>> 0, 0);      // P=0
        return ok();
      }

      // 000A — Create Alias Descriptor: a DATA descriptor over the same memory as an existing one.
      // This is how a client writes to its own code segment — the point of an alias is that the two
      // descriptors must keep describing the same bytes, so base and limit are copied, not recomputed.
      //   in: BX = selector;  out: AX = alias
      case 0x000a: {
        const off = descOffset(c.reg[3] & 0xffff);
        if (off < 0) return fail(ERR_INVALID_SELECTOR);
        if (dpmi.nextSel >= SEL_MAX) return fail(0x8011);
        const src = (LDT_BASE + off) >>> 0, sel = dpmi.nextSel; dpmi.nextSel += 8;
        const dst = (LDT_BASE + sel) >>> 0;
        for (let i = 0; i < 8; i++) mem.w8((dst + i) >>> 0, mem.r8((src + i) >>> 0));
        mem.w8(dst + 5, (mem.r8(src + 5) & ~0x08) | 0x02);   // code -> data, writable
        c.ax = sel | TI;
        return ok();
      }

      // 0600-0603 — Lock / unlock a linear region, and 0702/0703 — page-management hints. MIRAGE has
      // no demand paging and never swaps, so every page is permanently resident: locking is already
      // true and the hints have nothing to act on. Reporting success is accurate here, not a stub.
      case 0x0600: case 0x0601: case 0x0602: case 0x0603:
      case 0x0702: case 0x0703:
        return ok();

      // 0006 — Get Segment Base Address. The client reads back where a descriptor points, typically
      // right after setting it, to convert between its own pointers and linear addresses.
      //   in: BX = selector;  out: CX:DX = base
      case 0x0006: {
        const off = descOffset(c.reg[3] & 0xffff);
        if (off < 0) return fail(ERR_INVALID_SELECTOR);
        const a = (LDT_BASE + off) >>> 0;
        const base = (mem.r16(a + 2) | (mem.r8(a + 4) << 16) | (mem.r8(a + 7) << 24)) >>> 0;
        c.reg[1] = (c.reg[1] & ~0xffff) | ((base >>> 16) & 0xffff);   // CX
        c.reg[2] = (c.reg[2] & ~0xffff) | (base & 0xffff);            // DX
        return ok();
      }

      // 0501 — Allocate Memory Block. This is the one that matters: it is how a DOS-extended program
      // gets its heap, and Doom asked twenty-one times before this existed.
      //   in: BX:CX = size;  out: BX:CX = linear address, SI:DI = handle
      case 0x0501: {
        const size = ((((c.reg[3] & 0xffff) << 16) | (c.reg[1] & 0xffff)) >>> 0) || 1;
        const base = (dpmi.memTop - ((size + 0xfff) & ~0xfff)) >>> 0;   // page-aligned, growing down
        if (base < heapFloor()) return fail(0x8013);                    // physical memory unavailable
        dpmi.memTop = base;
        if (machine.xms) machine.xms.max = Math.min(machine.xms.max, base);
        dpmi.blocks.set(base, { base, size });
        c.reg[3] = (c.reg[3] & ~0xffff) | ((base >>> 16) & 0xffff);     // BX:CX = linear address
        c.reg[1] = (c.reg[1] & ~0xffff) | (base & 0xffff);
        c.reg[6] = (c.reg[6] & ~0xffff) | ((base >>> 16) & 0xffff);     // SI:DI = handle (the address)
        c.reg[7] = (c.reg[7] & ~0xffff) | (base & 0xffff);
        return ok();
      }

      // 0502 — Free Memory Block. We do not reclaim: the heap is a bump allocator, and a client that
      // frees on the way out gains nothing from us doing better. Reporting success keeps its teardown
      // clean, which is the only thing that matters here.
      case 0x0502:
        return ok();

      // 0500 — Get Free Memory Information. A 0x30-byte block; a client reads the first field (the
      // largest available block) and usually ignores the rest, but the page counts must be
      // self-consistent or a careful one will conclude there is no memory.
      case 0x0500: {
        const a = bufAddr();
        const free = Math.max(0, dpmi.memTop - heapFloor()) >>> 0;
        const pages = free >>> 12;
        for (let i = 0; i < 0x30; i += 4) mem.w32((a + i) >>> 0, 0xffffffff);   // "unknown" per spec
        mem.w32(a + 0x00, free);        // largest available block, bytes
        mem.w32(a + 0x04, pages);       // max unlocked page allocation
        mem.w32(a + 0x08, pages);       // max locked page allocation
        mem.w32(a + 0x0c, (mem.size >>> 12));   // linear address space, pages
        mem.w32(a + 0x10, pages);       // total unlocked pages
        mem.w32(a + 0x14, pages);       // free pages
        mem.w32(a + 0x18, (mem.size >>> 12));   // total physical pages
        mem.w32(a + 0x1c, pages);       // free linear address space, pages
        mem.w32(a + 0x20, 0);           // no paging file
        return ok();
      }

      // 0200 / 0201 — Get / Set REAL mode interrupt vector. Straight through to the IVT: in real mode
      // that table is the truth, and a client hooking a real-mode vector expects exactly that.
      //   in: BL = vector;  out/in: CX:DX = segment:offset
      case 0x0200: {
        const v = machine.getVector(c.reg[3] & 0xff);
        c.reg[1] = (c.reg[1] & ~0xffff) | v.seg;
        c.reg[2] = (c.reg[2] & ~0xffff) | v.off;
        return ok();
      }
      case 0x0201:
        machine.setVector(c.reg[3] & 0xff, c.reg[1] & 0xffff, c.reg[2] & 0xffff);
        return ok();

      // 0009 — Set Descriptor Access Rights. CL is the access byte (P/DPL/S/type), CH the extended
      // byte whose HIGH nibble carries G and D/B. The low nibble of that byte is the top of the
      // limit and must be preserved, which is the whole reason this is not a plain store.
      //   in: BX = selector, CX = rights
      case 0x0009: {
        const off = descOffset(c.reg[3] & 0xffff);
        if (off < 0) return fail(ERR_INVALID_SELECTOR);
        const a = (LDT_BASE + off) >>> 0;
        mem.w8(a + 5, c.reg[1] & 0xff);
        mem.w8(a + 6, ((c.reg[1] >> 8) & 0xf0) | (mem.r8(a + 6) & 0x0f));
        return ok();
      }

      // 0303 — Allocate Real Mode Callback Address. Hands back a real-mode far address that, called
      // from real mode, re-enters the client's protected-mode procedure. The mirror of 0302.
      //   in: DS:(E)SI = protected-mode procedure, ES:(E)DI = call structure to use
      //   out: CX:DX = real-mode address
      case 0x0303: {
        if (dpmi.callbacks.length >= CB_MAX) return fail(0x8015);     // callbacks exhausted
        const idx = dpmi.callbacks.length;
        const off32 = (r) => (dpmi.is32 ? (r >>> 0) : (r & 0xffff));
        dpmi.callbacks.push({
          sel: c.seg[DS], off: off32(c.reg[6]),
          rmcsSel: c.seg[ES], rmcsOff: off32(c.reg[7]),
          rmcs: (c.base[ES] + off32(c.reg[7])) >>> 0,
        });
        c.reg[1] = (c.reg[1] & ~0xffff) | DPMI_ENTRY_SEG;             // CX
        c.reg[2] = (c.reg[2] & ~0xffff) | (CB_BASE_OFF + idx);        // DX
        return ok();
      }

      // 0202 / 0203 — Get / Set Processor Exception Handler Vector. Same read-then-install dance as
      // 0204/0205, and the same reason it cannot be refused: the client stores whatever CX:EDX held
      // and transfers through it later (refusing 0202 left CS=0xffff). A separate table from the
      // interrupt vectors — exception 0Dh is #GP, which is not INT 0Dh.
      //   in: BL = exception 00-1Fh;  out/in: CX:EDX = selector:offset
      case 0x0202: {
        const n = c.reg[3] & 0xff;
        if (n > 0x1f) return fail(ERR_INVALID_VALUE);
        const v = dpmi.excVec[n] || { sel: SEL_HOST_CODE | TI, off: STATE_STUB_OFF };
        c.reg[1] = (c.reg[1] & ~0xffff) | (v.sel & 0xffff);
        c.reg[2] = v.off >>> 0;
        return ok();
      }
      case 0x0203: {
        const n = c.reg[3] & 0xff;
        if (n > 0x1f) return fail(ERR_INVALID_VALUE);
        dpmi.excVec[n] = { sel: c.reg[1] & 0xffff, off: c.reg[2] >>> 0 };
        return ok();
      }

      // 0204 / 0205 — Get / Set Protected Mode Interrupt Vector. This is how a client installs its
      // own handlers: it reads the current vector, keeps it to chain to, and writes its own.
      //
      // A vector we still own is reported as <host code>:n — the per-vector BIOS stub at f000:00nn
      // that already exists for real mode. Executing it runs the JS service and IRETs, and the
      // recompiler's guard is on the LINEAR address, so it works identically through a selector.
      // That means a client which chains to the old vector reaches the real service, instead of the
      // 0000:0000 it would get if we reported an empty vector.
      //   in:  BL = vector;  out: CX:EDX = selector:offset
      case 0x0204: {
        const n = c.reg[3] & 0xff;
        const v = dpmi.pmVec[n] || { sel: SEL_HOST_CODE | TI, off: n };
        c.reg[1] = (c.reg[1] & ~0xffff) | (v.sel & 0xffff);          // CX
        c.reg[2] = v.off >>> 0;                                       // EDX
        return ok();
      }
      case 0x0205: {
        const n = c.reg[3] & 0xff;
        dpmi.pmVec[n] = { sel: c.reg[1] & 0xffff, off: c.reg[2] >>> 0 };
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

  /**
   * Raw mode switch (the routines 0306 hands out). The client sets up the state it wants on the
   * OTHER side and far-calls one of these; they do not return, they transfer:
   *
   *   AX = new DS   CX = new ES   DX = new SS   BX = new SP   SI:DI = new CS:IP
   *
   * Values are selectors when switching TO protected mode and real-mode segments when switching to
   * real mode, which is exactly the difference cpu.setSeg already makes from CR0.PE — so the switch
   * is: set PE, then load the segments, and every address the recompiler emits follows.
   *
   * The caller's return address is left on the old stack on purpose: the client supplies a new
   * SS:SP, so the old stack is not ours to tidy.
   */
  const rawSwitch = (toProtected) => {
    const ax = cpu.reg[0] & 0xffff, cx = cpu.reg[1] & 0xffff, dx = cpu.reg[2] & 0xffff;
    const bx = cpu.reg[3] & 0xffff, si = cpu.reg[6] & 0xffff, di = cpu.reg[7] & 0xffff;
    // No cache flush: blocks are keyed by (linear address, CS.D), so 16-bit and 32-bit code at the
    // same address are already distinct entries, and emitted code reads segment bases at run time.
    // Flushing on every switch made a client that bounces between modes re-translate constantly.
    cpu.setCR0(toProtected ? ((cpu.cr0 | 1) >>> 0) : ((cpu.cr0 & ~1) >>> 0));
    cpu.setSeg(DS, ax); cpu.setSeg(ES, cx); cpu.setSeg(SS, dx);
    cpu.reg[4] = (cpu.reg[4] & ~0xffff) | bx;   // SP only: the convention passes 16 bits
    cpu.setSeg(CS, si); cpu.eip = di;
  };
  cpu.dpmiRawSwitch = rawSwitch;

  /**
   * A real-mode callback firing (0303). Real-mode code far-calls an address we handed out; we fill
   * the client's call structure with the real-mode register state and enter its protected-mode
   * procedure.
   *
   * LIMITATION, stated rather than hidden: the protected-mode context to return into is taken from
   * the innermost 0302 call in flight. That covers what this exists for — a real-mode service
   * calling back while the client waits inside 0302 — but a callback fired from real-mode code the
   * client did not call has no context to use, and is refused by leaving the machine alone. Doing
   * better needs the client's locked protected-mode stack, which is 0600/0601 territory.
   */
  const callbackFired = (idx) => {
    const cb = dpmi.callbacks[idx];
    const ctx = dpmi.rmCalls[dpmi.rmCalls.length - 1];
    if (!cb || !ctx) return;                     // nothing sensible to do; leave the machine as it is

    // The real-mode state the callback was invoked with, for the client to inspect and edit.
    const w32 = (o, v) => mem.w32((cb.rmcs + o) >>> 0, v >>> 0);
    const w16 = (o, v) => mem.w16((cb.rmcs + o) >>> 0, v & 0xffff);
    w32(RMCS.EDI, cpu.reg[7]); w32(RMCS.ESI, cpu.reg[6]); w32(RMCS.EBP, cpu.reg[5]);
    w32(RMCS.EBX, cpu.reg[3]); w32(RMCS.EDX, cpu.reg[2]); w32(RMCS.ECX, cpu.reg[1]);
    w32(RMCS.EAX, cpu.reg[0]);
    w16(RMCS.FLAGS, cpu.flags); w16(RMCS.ES, cpu.seg[ES]); w16(RMCS.DS, cpu.seg[DS]);
    w16(RMCS.FS, cpu.seg[FS]); w16(RMCS.GS, cpu.seg[GS]);
    w16(RMCS.SS, cpu.seg[SS]); w16(RMCS.SP, cpu.reg[4]);

    cpu.setCR0(ctx.cr0);                          // back to protected mode, on the client's context
    cpu.seg.set(ctx.seg); cpu.base.set(ctx.base); cpu.limit.set(ctx.limit);
    cpu.csD = ctx.csD; cpu.ssB = ctx.ssB;
    cpu.reg[4] = ctx.reg[4];                      // the client's protected-mode stack
    cpu.setSeg(ES, cb.rmcsSel); cpu.reg[7] = cb.rmcsOff >>> 0;   // ES:(E)DI = the call structure
    cpu.setSeg(CS, cb.sel); cpu.eip = cb.off >>> 0;
  };
  cpu.dpmiCallback = callbackFired;

  // ---- 0302: call a real-mode procedure from protected mode ------------------
  //
  // This one cannot finish inside its own handler: it has to RUN GUEST CODE and come back. So it is
  // split in two. The service sets the machine up in real mode, entered as if by an interrupt, with
  // the return address pointing at a SENTINEL of ours; when the procedure's IRET reaches that
  // sentinel, the second half copies the resulting registers out and restores protected mode.
  //
  // The client passes a 50-byte "real mode call structure" holding the registers to enter with, and
  // reads the same structure afterwards to see what came back.

  const RMCS = { EDI: 0x00, ESI: 0x04, EBP: 0x08, EBX: 0x10, EDX: 0x14, ECX: 0x18, EAX: 0x1c,
                 FLAGS: 0x20, ES: 0x22, DS: 0x24, FS: 0x26, GS: 0x28,
                 IP: 0x2a, CS: 0x2c, SP: 0x2e, SS: 0x30 };

  const realCall = (rmcs, words) => {
    const r32 = (o) => mem.r32((rmcs + o) >>> 0) >>> 0, r16 = (o) => mem.r16((rmcs + o) >>> 0);

    // Everything needed to come back. base/limit/csD/ssB are saved and restored verbatim rather than
    // re-resolved from the selectors: the descriptors are still there, and re-reading them would
    // only add a way to get it wrong.
    dpmi.rmCalls.push({
      rmcs, reg: Array.from(cpu.reg), seg: Array.from(cpu.seg), base: Array.from(cpu.base),
      limit: Array.from(cpu.limit), eip: cpu.eip >>> 0, flags: cpu.flags, cr0: cpu.cr0,
      csD: cpu.csD, ssB: cpu.ssB,
    });

    // Read the parameter words off the PROTECTED-mode stack before switching: they are addressed
    // through the protected-mode SS, which is about to stop meaning what it means now.
    const args = [];
    for (let i = 0; i < words; i++) {
      args.push(mem.r16((cpu.base[SS] + ((cpu.reg[4] >>> 0) + i * 2)) >>> 0));
    }

    cpu.setCR0((cpu.cr0 & ~1) >>> 0);            // real mode: a selector is a segment again

    cpu.reg[7] = r32(RMCS.EDI); cpu.reg[6] = r32(RMCS.ESI); cpu.reg[5] = r32(RMCS.EBP);
    cpu.reg[3] = r32(RMCS.EBX); cpu.reg[2] = r32(RMCS.EDX); cpu.reg[1] = r32(RMCS.ECX);
    cpu.reg[0] = r32(RMCS.EAX);
    cpu.flags = (r16(RMCS.FLAGS) | 2) & ~TF_MASK;
    cpu.setSeg(ES, r16(RMCS.ES)); cpu.setSeg(DS, r16(RMCS.DS));
    cpu.setSeg(FS, r16(RMCS.FS)); cpu.setSeg(GS, r16(RMCS.GS));

    // SS:SP of zero means "host, provide a stack" — a client that has no real-mode stack of its own
    // says so this way, and it is the common case.
    const ss = r16(RMCS.SS), sp = r16(RMCS.SP);
    if ((ss | sp) === 0) { cpu.setSeg(SS, DPMI_ENTRY_SEG); cpu.reg[4] = RM_STACK_TOP; }
    else { cpu.setSeg(SS, ss); cpu.reg[4] = (cpu.reg[4] & ~0xffff) | sp; }

    // The procedure's own parameters go on first, so they sit ABOVE the frame it returns through.
    for (let i = args.length - 1; i >= 0; i--) cpu.push16(args[i]);
    cpu.push16(cpu.flags & 0xffff);              // the IRET frame: FLAGS, CS, IP
    cpu.push16(DPMI_ENTRY_SEG);
    cpu.push16(RM_RET_OFF);

    cpu.setSeg(CS, r16(RMCS.CS)); cpu.eip = r16(RMCS.IP);
    if (dpmi.log) {
      const lin = ((r16(RMCS.CS) << 4) + r16(RMCS.IP)) >>> 0;
      const bytes = [0, 1, 2, 3].map((i) => mem.r8((lin + i) >>> 0).toString(16).padStart(2, '0')).join(' ');
      dpmi.log.push(`0302 -> reel ${r16(RMCS.CS).toString(16)}:${r16(RMCS.IP).toString(16)} ` +
        `ax=${(r32(RMCS.EAX) & 0xffff).toString(16)} ss:sp=${cpu.seg[SS].toString(16)}:${(cpu.reg[4] & 0xffff).toString(16)} ` +
        `mots=${words}  lineaire=${lin.toString(16)} octets=[${bytes}] PE=${cpu.cr0 & 1}`);
    }
  };

  /** The sentinel the procedure's IRET lands on: harvest registers, go back to protected mode. */
  const realCallReturn = () => {
    const st = dpmi.rmCalls.pop();
    if (!st) return;                             // not ours — nothing to unwind
    const w32 = (o, v) => mem.w32((st.rmcs + o) >>> 0, v >>> 0);
    const w16 = (o, v) => mem.w16((st.rmcs + o) >>> 0, v & 0xffff);

    // Harvest BEFORE restoring, or the client reads back its own inputs and every DOS call it makes
    // through this path silently returns nothing.
    w32(RMCS.EDI, cpu.reg[7]); w32(RMCS.ESI, cpu.reg[6]); w32(RMCS.EBP, cpu.reg[5]);
    w32(RMCS.EBX, cpu.reg[3]); w32(RMCS.EDX, cpu.reg[2]); w32(RMCS.ECX, cpu.reg[1]);
    w32(RMCS.EAX, cpu.reg[0]);
    w16(RMCS.FLAGS, cpu.flags); w16(RMCS.ES, cpu.seg[ES]); w16(RMCS.DS, cpu.seg[DS]);
    w16(RMCS.FS, cpu.seg[FS]); w16(RMCS.GS, cpu.seg[GS]);

    cpu.setCR0(st.cr0);
    cpu.reg.set(st.reg); cpu.seg.set(st.seg); cpu.base.set(st.base); cpu.limit.set(st.limit);
    cpu.csD = st.csD; cpu.ssB = st.ssB;
    cpu.eip = st.eip; cpu.flags = st.flags & ~1;         // CF=0: the call succeeded
  };
  cpu.dpmiRealCallReturn = realCallReturn;

  dpmi.memTop = HOST_BASE;
  cpu.dpmiSwitch = modeSwitch;
  machine.dpmi = dpmi;
  mem.u8[(DPMI_ENTRY_SEG << 4) + DPMI_ENTRY_OFF] = 0xcb;  // marker byte (RETF) the recompiler guards on
  // The state save/restore routine 0305 advertises. We keep no extra host state per client, so the
  // routine has nothing to do and a bare RETF is the whole of it — which is also why 0305 reports a
  // buffer size of zero. It is a normal RETF byte, not a guarded entry: it really does just return.
  mem.u8[(DPMI_ENTRY_SEG << 4) + STATE_STUB_OFF] = 0xcb;
  mem.u8[(DPMI_ENTRY_SEG << 4) + RAW_R2P_OFF] = 0xcb;     // guarded: cpu.dpmiRawSwitch(1)
  mem.u8[(DPMI_ENTRY_SEG << 4) + RAW_P2R_OFF] = 0xcb;     // guarded: cpu.dpmiRawSwitch(0)
  mem.u8[(DPMI_ENTRY_SEG << 4) + RM_RET_OFF] = 0xcb;      // guarded: cpu.dpmiRealCallReturn()
  for (let i = 0; i < CB_MAX; i++) mem.u8[(DPMI_ENTRY_SEG << 4) + CB_BASE_OFF + i] = 0xcb;

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
