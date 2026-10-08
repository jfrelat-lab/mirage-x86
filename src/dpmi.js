// dpmi.js — a DPMI 0.9 host: the mode-switch entry point plus the INT 31h services clients use.
//
// Answering INT 2Fh AX=1687h with "host present" puts an extender on the documented client path
// instead of making it switch to protected mode itself. Entry follows xms.js: a marker byte at a
// fixed f000 address that the recompiler intercepts, so a FAR CALL runs JS. The host's tables sit at
// the top of RAM with the XMS pool capped below them.

import { CS, DS, ES, SS, FS, GS, TF } from './cpu.js';

const TF_MASK = TF;   // a real-mode call must not inherit the client's single-step flag
const IOPL_MASK = 3 << 12;
const IF_FLAG = 1 << 9;

export const DPMI_ENTRY_SEG = 0xf000, DPMI_ENTRY_OFF = 0x0200;   // far-callable mode-switch entry
const STATE_STUB_OFF = 0x0210;                                   // the do-nothing state save/restore
const RAW_R2P_OFF = 0x0220, RAW_P2R_OFF = 0x0230;                // raw mode-switch routines (0306)
const RM_RET_OFF = 0x0240;                                       // where a 0302 real-mode call returns
const EXC_RET_OFF = 0x0250;                                      // where a client's exception handler RETFs back
const RM_STACK_TOP = 0x0500;                                     // host-provided real-mode stack (256 B below)
const RMCS_SCRATCH = 0x0300;                                     // 50-byte call structure the host builds
                                                                 // when it reflects a client's INT n
const CB_BASE_OFF = 0x0600, CB_MAX = 16;                         // real-mode callback entries (0303)

const LDT_ENTRIES = 8192;                   // the architectural maximum: 64 KiB of descriptors,
                                            // which is exactly the host area reserved below
                                            // (a client asks for thousands at a time and works down)
const HOST_SIZE = 0x10000;                  // 64 KiB reserved at the top of RAM for the tables

// Client descriptors live in the LDT, not the GDT: every real host does this, AX=0000 is specified
// to return LDT selectors, and a client is entitled to assume both.
const TI = 4;                                     // selector bit 2: 1 = LDT
const SEL_CODE32 = 0x08 | TI | 3, SEL_DATA32 = 0x10 | TI | 3;   // flat 4 GiB, the pair a 32-bit client wants
// RPL 3 like everything else the client sees: it far-calls and IRETs through these, and a return
// into a ring-0 selector from ring 3 is a #GP.
const SEL_HOST_CODE = 0x18 | 3;                   // host code, for far addresses we hand out
const SEL_CLIENT = 0x20;                          // first client segment (index, TI added on return)
const SEL_MAX = LDT_ENTRIES * 8;

export function installDPMI(machine) {
  const mem = machine.mem, cpu = machine.cpu;

  const HOST_BASE = (machine.vbeFbBase || mem.size) - HOST_SIZE;   // below the VBE framebuffer, if one is reserved
  const LDT_BASE = HOST_BASE, LDT_LIMIT = LDT_ENTRIES * 8 - 1;

  // Keep XMS out of the host's block, or a game's allocation overwrites the descriptor tables.
  if (machine.xms) machine.xms.max = Math.min(machine.xms.max, HOST_BASE);

  // One pool with two ends: XMS grows up from 1 MiB, this heap grows down from the tables.
  const heapFloor = () => (machine.xms ? machine.xms.top : 0x100000);

  const dpmi = {
    active: false,                 // has a client switched to protected mode?
    is32: false,
    nextSel: SEL_CLIENT,           // bump allocator over the LDT
    freeSels: [],                  // offsets returned by 0001, reused before the bump advances
    virtualIF: true,               // the client's virtual interrupt flag (0900/0901/0902)
    unimplemented: new Map(),      // INT 31h AX values a client asked for and we refused
    segSels: new Map(),
    dosBlocks: new Map(),          // 0100 selector -> real-mode segment, for 0101/0102            // 0002: real-mode segment -> selector, never freed
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
    reset() { this.active = false; this.is32 = false; this.nextSel = SEL_CLIENT; this.freeSels = []; this.virtualIF = true; this.unimplemented = new Map(); this.segSels = new Map(); this.dosBlocks = new Map(); this.pmVec = new Array(256).fill(null); this.excVec = new Array(32).fill(null); this.rmCalls = []; this.callbacks = []; },
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

  /**
   * Reserve `count` CONSECUTIVE descriptor slots, reusing a freed one when a single slot will do.
   * Without reuse this was a pure bump allocator, and a client that allocates and frees descriptors
   * in a loop — which DOS/4GW does, one per section as it walks the executable — simply ran the
   * table out. 0000 then returned 8011 "descriptor unavailable", and DOS/4GW carried that error
   * code forward as the function number of its next call.
   * @returns the byte offset in the LDT, or -1 if the table is full.
   */
  const takeSel = (count) => {
    if (count === 1 && dpmi.freeSels.length) return dpmi.freeSels.pop();
    if (dpmi.nextSel + count * 8 > SEL_MAX) return -1;
    const off = dpmi.nextSel; dpmi.nextSel += count * 8;
    return off;
  };

  /** A descriptor for one of the client's real-mode segments: same bytes, seen through a selector. */
  const allocClientSel = (seg, code) => {
    const sel = takeSel(1);
    if (sel < 0) return 0;
    // Ring 3, DPL 3, RPL 3 — what every real host hands a client, and what a client tests for.
    // DOS/4GW reads a selector's RPL to decide whether the descriptor is its own to edit: at RPL 0
    // it wrote through a GDT alias selector we do not have and #GP'd forever, drawing nothing.
    // D/B = 0: these describe REAL-MODE segments, so 16-bit code and stack. A client that wants
    // 32-bit selectors allocates them itself.
    setDesc(sel, (seg & 0xffff) << 4, 0xffff, code ? 0xfa : 0xf2, 0x00);
    return sel | TI | 3;
  };

  /** Build the tables once, on the first mode switch. */
  const buildTables = () => {
    for (let i = 0; i < LDT_ENTRIES * 8; i++) mem.w8(LDT_BASE + i, 0);
    // DPL 3 throughout: the client runs at ring 3, as it does under every real host, so every
    // selector it can load must be reachable from there.
    setDesc(SEL_CODE32, 0, 0xffffffff, 0xfa, 0xc0);      // flat code, 32-bit
    setDesc(SEL_DATA32, 0, 0xffffffff, 0xf2, 0xc0);      // flat data, 32-bit
    // Deliberately no IDT: softInt reflects software interrupts, so an IDT would only serve
    // exceptions — and an exception in a client is a defect to surface, not to dispatch.
    // A 16-bit code selector over the BIOS segment, for services that hand back a protected-mode
    // far address (0305): a real-mode segment value will not do.
    setDesc(SEL_HOST_CODE, DPMI_ENTRY_SEG << 4, 0xffff, 0xfa, 0x00);
    // Load LDTR directly rather than through LLDT: that would need a GDT entry describing the LDT,
    // and nothing here reads one. The GDT stays empty — a client never sees a GDT selector from us.
    cpu.ldtr.sel = 0; cpu.ldtr.base = LDT_BASE; cpu.ldtr.limit = LDT_LIMIT;
  };

  /**
   * The mode-switch entry, reached by a FAR CALL from real mode.
   *
   * AX bit 0 says whether the client is 32-bit. On exit it must be in protected mode with CS/DS/ES/SS
   * describing the same memory its real-mode segments did, continuing after the call — so the return
   * address is popped in real mode and re-entered through a selector, which a RETF cannot express.
   */
  const modeSwitch = () => {
    const is32 = (cpu.reg[0] & 1) !== 0;
    // A20 first: protected mode requires it, and until it is on every address masks to 1 MiB, so the
    // tables at 0xFF0000 alias onto 0xF0000 and overwrite the BIOS stubs.
    machine.mem.setA20(true);
    machine.rec.setMask(machine.mem.mask);
    buildTables();

    const retOff = cpu.pop16(), retSeg = cpu.pop16();     // still a real-mode stack at this point
    const oldDS = cpu.seg[DS], oldES = cpu.seg[ES], oldSS = cpu.seg[SS];
    const csSel = allocClientSel(retSeg, true);
    const dsSel = allocClientSel(oldDS, false);
    // ES comes back describing the client's PSP, not whatever it held before.
    const psp = machine.dos ? machine.dos.psp : oldES;
    const esSel = allocClientSel(psp, false);
    const ssSel = oldSS === oldDS ? dsSel : allocClientSel(oldSS, false);

    cpu.setCR0((cpu.cr0 | 1) >>> 0);                     // PE — from here selectors are indices
    machine.rec.reset();                                  // every cached block assumed real mode
    // Enter ring 3 the way an IRET to a less-privileged level does: CPL first, then the selectors.
    // Loading SS (RPL 3, DPL 3) while CPL still read 0 is a #GP on real silicon too — no sequence of
    // plain MOVs can express this switch, which is why a host uses IRET or a gate.
    cpu._cpl = 3;
    cpu.setSeg(DS, dsSel); cpu.setSeg(ES, esSel); cpu.setSeg(SS, ssSel);
    cpu.setSeg(CS, csSel); cpu.eip = retOff;
    // The PSP's environment field (offset 2Ch) holds a real-mode PARAGRAPH, and a client in
    // protected mode cannot load one. DOS/4GW reads it and puts it straight into ES with no
    // conversion — `mov es,[psp]; mov bx,[es:2Ch]; mov es,bx` — so a host has to leave a SELECTOR
    // there. Ours did not, and DOS/4GW reported "General Protection Fault at 00BF:36D2, code=00C0",
    // 00C0 being our environment paragraph.
    if (machine.dos && machine.dos.psp) {
      const at = ((machine.dos.psp << 4) + 0x2c) >>> 0;
      const envSeg = mem.r16(at);
      if (envSeg && !dpmi.envPatched) { dpmi.envPatched = true; mem.w16(at, allocClientSel(envSeg, false)); }
    }
    cpu.flags &= ~1;                                      // CF=0: the switch succeeded
    cpu.flags |= 0x3000;                                  // IOPL=3: a ring-3 client still owns the
                                                          // hardware, which is what DPMI promises it

    dpmi.active = true; dpmi.is32 = is32;
  };

  // ---- INT 31h services ------------------------------------------------------
  // The set clients actually call, measured with tools/dpmi-probe.mjs rather than taken from the
  // spec's ~60 functions. CF clear on success; CF set with AX = error code on failure.

  const ok = () => { cpu.flags &= ~1; };
  const fail = (code) => { cpu.flags |= 1; cpu.ax = code; };

  const ERR_UNSUPPORTED = 0x8001, ERR_INVALID_SELECTOR = 0x8022, ERR_INVALID_VALUE = 0x8021;

  /**
   * Run the HLE DOS INT 21h handler with ES holding a REAL-MODE paragraph. It reads cpu.seg[ES] as
   * a segment number, but we are in protected mode, where setSeg resolves a descriptor: handing it
   * the paragraph made it a selector, and freeing a DOS block raised #GP(paragraph). Quake stopped
   * there, on its own memory teardown. So write the raw register and put the cached descriptor back
   * afterwards, without going through a load in either direction.
   */
  const withRealModeES = (seg, fn) => {
    const sv = cpu.seg[ES], sb = cpu.base[ES], sl = cpu.limit[ES], sll = cpu.limLo[ES];
    cpu.seg[ES] = seg & 0xffff;
    try { return fn(); } finally { cpu.seg[ES] = sv; cpu.base[ES] = sb; cpu.limit[ES] = sl; cpu.limLo[ES] = sll; }
  };

  /** Byte offset of a selector's descriptor in the LDT, or -1 if it is not one of ours. */
  const descOffset = (sel) => {
    sel &= 0xffff;
    if (!(sel & TI)) return -1;                       // GDT selector: our GDT is empty by design
    const off = sel & 0xfff8;
    return off + 7 <= LDT_LIMIT ? off : -1;
  };

  // A descriptor a client writes must carry the CLIENT's privilege level, and this host runs clients
  // at ring 0. DPMI requires the DPL a client sets to equal its own, and a client written against a
  // ring-3 host hard-codes DPL 3: Void 3 builds a 32-bit code alias with access byte 0xFB and far
  // RETFs into it, which is #GP(sel) here because a non-conforming code segment must have DPL == CPL.
  // Normalising the field is what makes the descriptor mean the same thing on either kind of host.
  // A client cannot mint a descriptor more privileged than itself: the host forces DPL 3, which is
  // also the client's own ring, so a selector it builds is one it can load.
  const clientDPL = (access) => ((access & ~0x60) | 0x60) & 0xff;

  /** ES:(E)DI, the buffer both descriptor calls use. A 16-bit client passes DI, a 32-bit one EDI. */
  const bufAddr = () => (cpu.base[ES] + (dpmi.is32 ? (cpu.reg[7] >>> 0) : (cpu.reg[7] & 0xffff))) >>> 0;

  machine.hookInterrupt(0x31, (c) => {
    switch (c.ax) {
      // 000B / 000C — Get / Set Descriptor: the 8 raw bytes, used as a pair.
      case 0x000b: {
        const off = descOffset(c.reg[3] & 0xffff);
        if (off < 0) return fail(ERR_INVALID_SELECTOR);
        const src = (LDT_BASE + off) >>> 0, dst = bufAddr();
        for (let i = 0; i < 8; i++) mem.w8((dst + i) >>> 0, mem.r8((src + i) >>> 0));
        return ok();
      }

      // Nothing reloads a segment register already holding the selector: hardware keeps the cached
      // descriptor until the selector is loaded again.
      case 0x000c: {
        const off = descOffset(c.reg[3] & 0xffff);
        if (off < 0) return fail(ERR_INVALID_SELECTOR);
        const dst = (LDT_BASE + off) >>> 0, src = bufAddr();
        for (let i = 0; i < 8; i++) mem.w8((dst + i) >>> 0, mem.r8((src + i) >>> 0));
        mem.w8((dst + 5) >>> 0, clientDPL(mem.r8((dst + 5) >>> 0)));
        return ok();
      }

      // 0305 — Get State Save/Restore Addresses. No per-client state to keep, so size 0 and both
      // routines are a bare RETF. It cannot be refused: clients store the addresses without checking
      // CF and call them later.
      //   AX = buffer size in words, BX:CX = real-mode routine, SI:DI = protected-mode routine
      case 0x0305: {
        c.ax = 0;
        c.reg[3] = (c.reg[3] & ~0xffff) | DPMI_ENTRY_SEG;            // BX
        c.reg[1] = (c.reg[1] & ~0xffff) | STATE_STUB_OFF;            // CX
        c.reg[6] = (c.reg[6] & ~0xffff) | (SEL_HOST_CODE | TI);      // SI
        c.reg[7] = (c.reg[7] & ~0xffff) | STATE_STUB_OFF;            // DI
        return ok();
      }

      // 0306 — Get Raw Mode Switch Addresses. Same as 0305: refusing leaves the previous call's
      // values in the registers it answers in, and the client stores those.
      //   BX:CX = real -> protected routine, SI:DI = protected -> real routine
      case 0x0306: {
        c.reg[3] = (c.reg[3] & ~0xffff) | DPMI_ENTRY_SEG;            // BX
        c.reg[1] = (c.reg[1] & ~0xffff) | RAW_R2P_OFF;               // CX
        c.reg[6] = (c.reg[6] & ~0xffff) | (SEL_HOST_CODE | TI);      // SI
        c.reg[7] = (c.reg[7] & ~0xffff) | RAW_P2R_OFF;               // DI
        return ok();
      }

      // 0000 — Allocate LDT Descriptors. CX consecutive entries.
      //
      // They come back as PRESENT expand-up read/write data segments with base and limit zero, at
      // the client's privilege — not zeroed, which is what this did. A zeroed descriptor has P=0,
      // so a client that fills in only base and limit (0007 + 0008, which the spec allows on its
      // own) got a #GP the moment it loaded the selector. That is DOS/4GW: DOOM faulted on
      // `mov ds,bx` forever, inside DOS/4GW's own exception handler, drawing nothing.
      //   in: CX = count;  out: AX = base selector
      case 0x0000: {
        const count = c.reg[1] & 0xffff;
        if (count === 0) return fail(ERR_INVALID_VALUE);
        const base = takeSel(count);
        if (base < 0) return fail(0x8011);                             // descriptor unavailable
        for (let i = 0; i < count; i++) {
          const off = base + i * 8;
          for (let b = 0; b < 8; b++) mem.w8((LDT_BASE + off + b) >>> 0, 0);
          mem.w8((LDT_BASE + off + 5) >>> 0, clientDPL(0x92));         // P=1, S=1, data, writable
          mem.w8((LDT_BASE + off + 6) >>> 0, dpmi.is32 ? 0x40 : 0);    // D/B follows the client
        }
        c.ax = base | TI | 3;
        return ok();
      }

      // 0002 — Segment to Descriptor. A data selector over a real-mode segment: this is how a
      // protected-mode client reaches the VGA window at A000, and it is the call Void 3 makes right
      // after setting its VBE mode. The spec says these descriptors are never freed, so one per
      // segment is cached and handed back again. Refusing it returned 0x8001 in AX, which the client
      // loaded straight into ES as if it were a selector.
      case 0x0002: {
        const seg = c.reg[3] & 0xffff;                                  // BX
        let sel = dpmi.segSels.get(seg);
        if (sel === undefined) {
          sel = allocClientSel(seg, false);
          if (!sel) return fail(0x8011);                                // descriptor unavailable
          dpmi.segSels.set(seg, sel);
        }
        c.ax = sel;
        return ok();
      }

      // 0100/0101/0102 — Allocate / Free / Resize DOS Memory Block. A host owns these because a
      // protected-mode client cannot call INT 21h AH=48 itself and get a usable answer: it needs the
      // real-mode SEGMENT to hand to DOS and a SELECTOR to address the block with, and only the host
      // can mint the second. Refusing 0100 is what printed Quake's "Load error: no DOS memory" — its
      // DJGPP stub allocates its transfer buffer this way before anything else happens.
      //   0100 in: BX = paragraphs;  out: AX = real-mode segment, DX = selector
      case 0x0100: {
        const para = c.reg[3] & 0xffff;
        const h = machine.intHandlers[0x21];
        if (!h) return fail(0x8012);                       // no DOS below us to ask
        const savedAx = c.reg[0], savedBx = c.reg[3], savedFlags = c.flags;
        c.reg[0] = 0x4800; c.reg[3] = (savedBx & ~0xffff) | para;   // AH=48h, BX = paragraphs
        h(c, machine);
        const failed = (c.flags & 1) !== 0;
        const seg = c.reg[0] & 0xffff, largest = c.reg[3] & 0xffff;
        c.reg[0] = savedAx; c.reg[3] = savedBx; c.flags = savedFlags;
        // On failure DOS reports the largest block available, and the DPMI spec passes it through in
        // BX — a client that asked for too much retries with that number rather than giving up.
        if (failed) { c.reg[3] = (savedBx & ~0xffff) | largest; return fail(0x8012); }
        const sel = allocClientSel(seg, false);
        if (!sel) return fail(0x8011);
        c.ax = seg;
        c.reg[2] = (c.reg[2] & ~0xffff) | sel;             // DX
        dpmi.dosBlocks.set(sel, seg);
        return ok();
      }
      case 0x0101: {                                       // in: DX = selector
        const sel = c.reg[2] & 0xffff, seg = dpmi.dosBlocks.get(sel);
        if (seg === undefined) return fail(ERR_INVALID_VALUE);
        const h = machine.intHandlers[0x21];
        if (h) {
          const savedAx = c.reg[0], savedFlags = c.flags;
          c.reg[0] = 0x4900;                               // AH=49h, ES = the block
          withRealModeES(seg, () => h(c, machine));
          c.reg[0] = savedAx; c.flags = savedFlags;
        }
        dpmi.dosBlocks.delete(sel);
        return ok();
      }
      case 0x0102: {                                       // in: BX = new paragraphs, DX = selector
        const sel = c.reg[2] & 0xffff, seg = dpmi.dosBlocks.get(sel);
        if (seg === undefined) return fail(ERR_INVALID_VALUE);
        const h = machine.intHandlers[0x21];
        if (!h) return fail(0x8012);
        const savedAx = c.reg[0], savedBx = c.reg[3], savedFlags = c.flags;
        c.reg[0] = 0x4a00;                                 // AH=4Ah, ES = block, BX = paragraphs
        withRealModeES(seg, () => h(c, machine));
        const failed = (c.flags & 1) !== 0, largest = c.reg[3] & 0xffff;
        c.reg[0] = savedAx; c.reg[3] = savedBx; c.flags = savedFlags;
        if (failed) { c.reg[3] = (savedBx & ~0xffff) | largest; return fail(0x8012); }
        return ok();
      }

      // 0003 — Get Selector Increment Value. Always 8 on a 386.
      case 0x0003:
        c.reg[0] = (c.reg[0] & ~0xffff) | 8;      // AX
        return ok();

      // 0008 — Set Segment Limit. Above 1 MiB the limit counts 4 KiB pages with G=1, and its low 12
      // bits must be all ones: a limit that is not page-aligned is an error, not something to round.
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

      // 0304 — Free Real Mode Callback Address. Nothing to release; success keeps teardown clean.
      case 0x0304:
        return ok();

      // 0300 — Simulate Real Mode Interrupt: 0302 with the target taken from the real-mode vector.
      //   in: BL = interrupt, CX = words to copy, ES:(E)DI = real mode call structure
      case 0x0300:
        realCall(bufAddr(), c.reg[1] & 0xffff, c.reg[3] & 0xff);
        return;

      // 0302 — Call Real Mode Procedure. Completes in realCallReturn, so no ok() here.
      //   in: CX = words to copy from the protected-mode stack, ES:(E)DI = real mode call structure
      case 0x0302:
        realCall(bufAddr(), c.reg[1] & 0xffff);
        return;

      // 0001 — Free LDT Descriptor. Marked not-present so a stale selector faults rather than
      // addressing whatever was there, and the slot goes back on the free list.
      case 0x0001: {
        const off = descOffset(c.reg[3] & 0xffff);
        if (off < 0) return fail(ERR_INVALID_SELECTOR);
        mem.w8((LDT_BASE + off + 5) >>> 0, 0);      // P=0
        if (off >= SEL_CLIENT && !dpmi.freeSels.includes(off)) dpmi.freeSels.push(off);
        return ok();
      }

      // 000A — Create Alias Descriptor: a DATA view of the same memory, so base and limit are copied
      // rather than recomputed.
      //   in: BX = selector;  out: AX = alias
      case 0x000a: {
        const off = descOffset(c.reg[3] & 0xffff);
        if (off < 0) return fail(ERR_INVALID_SELECTOR);
        const sel = takeSel(1);
        if (sel < 0) return fail(0x8011);
        const src = (LDT_BASE + off) >>> 0;
        const dst = (LDT_BASE + sel) >>> 0;
        for (let i = 0; i < 8; i++) mem.w8((dst + i) >>> 0, mem.r8((src + i) >>> 0));
        mem.w8(dst + 5, clientDPL((mem.r8(src + 5) & ~0x08) | 0x02));   // code -> data, writable
        c.ax = sel | TI | 3;
        return ok();
      }

      // 0600-0603 lock/unlock, 0702/0703 paging hints. MIRAGE never swaps, so every page really is
      // resident: success is accurate here, not a stub.
      case 0x0600: case 0x0601: case 0x0602: case 0x0603:
      case 0x0702: case 0x0703:
        return ok();

      // 0006 — Get Segment Base Address.
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

      // 0007 — Set Segment Base Address, the write half of 0006.
      //   in: BX = selector, CX:DX = base
      case 0x0007: {
        const off = descOffset(c.reg[3] & 0xffff);
        if (off < 0) return fail(ERR_INVALID_SELECTOR);
        const a = (LDT_BASE + off) >>> 0;
        const base = ((((c.reg[1] & 0xffff) << 16) | (c.reg[2] & 0xffff)) >>> 0);
        mem.w16(a + 2, base & 0xffff);
        mem.w8(a + 4, (base >>> 16) & 0xff);
        mem.w8(a + 7, (base >>> 24) & 0xff);
        return ok();
      }

      // 0501 — Allocate Memory Block: how an extended program gets its heap.
      //   in: BX:CX = size;  out: BX:CX = linear address, SI:DI = handle
      case 0x0501: {
        const size = ((((c.reg[3] & 0xffff) << 16) | (c.reg[1] & 0xffff)) >>> 0) || 1;
        // Round in FLOATING POINT and bound on BOTH sides. `(size + 0xfff) & ~0xfff` is a signed
        // int32: a request near 4 GiB rounds NEGATIVE, so the base came out ABOVE memTop and the
        // "physical memory unavailable" test — which only looked at the floor — let it through.
        // Quake was handed a base at 30 MiB on a 16 MiB machine, jumped into it, and executed
        // whatever `mem.u8` returns past the end of RAM until the block cache exhausted the host.
        const base = dpmi.memTop - Math.ceil(size / 4096) * 4096;       // page-aligned, growing down
        if (!(base >= heapFloor() && base <= dpmi.memTop)) return fail(0x8013);
        dpmi.memTop = base;
        if (machine.xms) machine.xms.max = Math.min(machine.xms.max, base);
        dpmi.blocks.set(base, { base, size });
        c.reg[3] = (c.reg[3] & ~0xffff) | ((base >>> 16) & 0xffff);     // BX:CX = linear address
        c.reg[1] = (c.reg[1] & ~0xffff) | (base & 0xffff);
        c.reg[6] = (c.reg[6] & ~0xffff) | ((base >>> 16) & 0xffff);     // SI:DI = handle (the address)
        c.reg[7] = (c.reg[7] & ~0xffff) | (base & 0xffff);
        return ok();
      }

      // 0502 — Free Memory Block. A bump allocator does not reclaim; report success anyway.
      case 0x0502:
        return ok();

      // 0503 — Resize Memory Block. Shrinking, or growing inside the rounding slack, keeps the block
      // where it is; anything else allocates a fresh one lower down and copies. The old block is not
      // reclaimed, for the same reason 0502 does nothing.
      //   in: BX:CX = new size, SI:DI = handle;  out: BX:CX = address, SI:DI = handle
      case 0x0503: {
        const size = ((((c.reg[3] & 0xffff) << 16) | (c.reg[1] & 0xffff)) >>> 0) || 1;
        const handle = ((((c.reg[6] & 0xffff) << 16) | (c.reg[7] & 0xffff)) >>> 0);
        const blk = dpmi.blocks.get(handle);
        if (!blk) return fail(0x8023);                                  // invalid handle
        let base = blk.base;
        if (size > Math.ceil(blk.size / 4096) * 4096) {
          base = dpmi.memTop - Math.ceil(size / 4096) * 4096;
          if (!(base >= heapFloor() && base <= dpmi.memTop)) return fail(0x8013);
          dpmi.memTop = base;
          if (machine.xms) machine.xms.max = Math.min(machine.xms.max, base);
          for (let i = 0; i < blk.size; i++) mem.w8((base + i) >>> 0, mem.r8((blk.base + i) >>> 0));
          dpmi.blocks.delete(handle);
        }
        dpmi.blocks.set(base, { base, size });
        c.reg[3] = (c.reg[3] & ~0xffff) | ((base >>> 16) & 0xffff);
        c.reg[1] = (c.reg[1] & ~0xffff) | (base & 0xffff);
        c.reg[6] = (c.reg[6] & ~0xffff) | ((base >>> 16) & 0xffff);
        c.reg[7] = (c.reg[7] & ~0xffff) | (base & 0xffff);
        return ok();
      }

      // 0900/0901/0902 — the client's VIRTUAL interrupt flag. Virtual is the whole point: a host
      // keeps this state per client and does NOT disable the machine's interrupts for it, so the
      // hardware keeps being serviced while the client believes it is in a critical section.
      //
      // Mapping it onto the real IF, as this first did, latched the machine: Quake calls 0900
      // thirty-four times and 0901 never — it re-enables by other means — so IF went to 0 on the
      // 29th call and stayed there. Its own protected-mode INT 9 handler was installed and correct
      // (pmVec[9] = 0047:009a0000) and never saw a scancode, because raiseKeyboardIRQ will not
      // raise with IF clear. It sat on "Press a key" for ever.
      //
      // The client runs at IOPL 3, so its own CLI/STI reach the real IF and control delivery
      // faithfully; this flag is tracked and reported, not enforced. A host that virtualises would
      // also QUEUE interrupts taken while the client had them off and deliver them on the way back
      // — we do not, and that is the part of the contract still missing here.
      //   out: AL = the PREVIOUS state, 0 = disabled, 1 = enabled
      case 0x0900: case 0x0901: case 0x0902: {
        const fn = c.ax;                       // read it before AX becomes the answer
        const was = dpmi.virtualIF ? 1 : 0;
        if (fn === 0x0900) dpmi.virtualIF = false;
        else if (fn === 0x0901) dpmi.virtualIF = true;
        c.ax = was;
        return ok();
      }

      // 0500 — Get Free Memory Information. The page counts must be self-consistent or a careful
      // client concludes there is no memory.
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

      // 0200 / 0201 — Get / Set real mode interrupt vector, straight through to the IVT.
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

      // 0009 — Set Descriptor Access Rights. CH's LOW nibble is the top of the limit and must be
      // preserved, which is why this is not a plain store.
      //   in: BX = selector, CX = rights
      case 0x0009: {
        const off = descOffset(c.reg[3] & 0xffff);
        if (off < 0) return fail(ERR_INVALID_SELECTOR);
        const a = (LDT_BASE + off) >>> 0;
        mem.w8(a + 5, clientDPL(c.reg[1] & 0xff));
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

      // 0202 / 0203 — Get / Set Processor Exception Handler Vector. A separate table from the
      // interrupt vectors: exception 0Dh is #GP, not INT 0Dh.
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

      // 0204 / 0205 — Get / Set Protected Mode Interrupt Vector. A vector we still own is reported
      // as <host code>:n, the per-vector BIOS stub: the recompiler's guard is on the LINEAR address,
      // so it works through a selector too and a client chaining to the old vector reaches the
      // real service.
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

      // 0A00 — Get Vendor-Specific API Entry Point. A host need not provide one.
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
   * LIMITATION: the protected-mode context comes from the innermost 0302 in flight. A callback fired
   * from real-mode code the client did not call has no context and is refused.
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
  // Cannot finish inside its handler: it must run guest code and come back. The service enters real
  // mode with the return address pointing at a sentinel; the sentinel harvests the registers into the
  // client's 50-byte call structure and restores protected mode.

  const RMCS = { EDI: 0x00, ESI: 0x04, EBP: 0x08, EBX: 0x10, EDX: 0x14, ECX: 0x18, EAX: 0x1c,
                 FLAGS: 0x20, ES: 0x22, DS: 0x24, FS: 0x26, GS: 0x28,
                 IP: 0x2a, CS: 0x2c, SP: 0x2e, SS: 0x30 };

  /** Reflect a protected-mode software interrupt the host does not serve down to the real-mode
   *  handler. Required by the DPMI spec and, until now, missing: `machine.softInt` reflected a
   *  client's INT to our JS services and, finding none, simply returned. Under our own DOS every
   *  vector has a JS handler so nothing showed; under a BOOTED kernel none do, so every DOS call a
   *  client made did nothing at all — intros/mesha.com rendered its whole show and then never
   *  terminated, because its `INT 21h AH=4Ch` exit was swallowed (ROADMAP F9).
   *
   *  The mode switch is the one 0300 already performs; the difference is that a reflected interrupt
   *  takes its inputs from the CLIENT's registers rather than a structure it passed, and hands the
   *  results back the same way — hence `reflect`, which realCallReturn honours. */
  const reflectInt = (n) => {
    const rmcs = ((DPMI_ENTRY_SEG << 4) + RMCS_SCRATCH) >>> 0;
    const w32 = (o, v) => mem.w32((rmcs + o) >>> 0, v >>> 0);
    const w16 = (o, v) => mem.w16((rmcs + o) >>> 0, v & 0xffff);
    w32(RMCS.EDI, cpu.reg[7]); w32(RMCS.ESI, cpu.reg[6]); w32(RMCS.EBP, cpu.reg[5]);
    w32(RMCS.EBX, cpu.reg[3]); w32(RMCS.EDX, cpu.reg[2]); w32(RMCS.ECX, cpu.reg[1]);
    w32(RMCS.EAX, cpu.reg[0]);
    w16(RMCS.FLAGS, cpu.flags);
    // Segment REGISTERS, not the client's selectors: in real mode these are paragraph numbers, and a
    // selector put here would address nonsense. A client that wants a buffer seen by DOS passes a
    // real-mode segment in the structure itself; we have none, so hand DOS the host's own.
    w16(RMCS.ES, DPMI_ENTRY_SEG); w16(RMCS.DS, DPMI_ENTRY_SEG);
    w16(RMCS.FS, 0); w16(RMCS.GS, 0);
    w16(RMCS.SS, 0); w16(RMCS.SP, 0);            // 0:0 = host, provide a stack
    realCall(rmcs, 0, n, true);
  };
  dpmi.reflectInt = reflectInt;

  const realCall = (rmcs, words, vec, reflect) => {
    const r32 = (o) => mem.r32((rmcs + o) >>> 0) >>> 0, r16 = (o) => mem.r16((rmcs + o) >>> 0);

    // A client may reach a DPMI service by FAR-CALLING the protected-mode vector 0204 gave it, with
    // FLAGS pushed first — the ordinary way to chain an interrupt handler — instead of executing
    // INT 31h. The stub is an IRET byte, so biosCallback normally consumes that frame on the way
    // back out; but 0300 and 0302 TRANSFER control and never return through it, and the context
    // saved just below would then resume ON the stub. DOS/4GW re-ran the same call for ever,
    // reading back into its own structure the result the previous one had written there: two DOS
    // allocations succeeded, the third arrived carrying the second's return value as its function
    // number, and the fourth carried the error code — AH=00, which is "terminate program".
    // So consume the frame here, and save the caller's resume point instead.
    if (machine._inBiosCallback === 0x31) {
      const w32 = (cpu.cr0 & 1) && dpmi.is32;
      const ip = w32 ? (cpu.pop32() >>> 0) : cpu.pop16();
      const cs = (w32 ? cpu.pop32() : cpu.pop16()) & 0xffff;
      const fl = w32 ? (cpu.pop32() >>> 0) : cpu.pop16();
      cpu.setSeg(CS, cs); cpu.eip = ip >>> 0;
      cpu.flags = w32 ? ((fl & 0x27fd5) | 2) : ((cpu.flags & ~0xffff) | ((fl & 0x7fd5) | 2));
    }

    // base/limit/csD/ssB are saved verbatim rather than re-resolved: the descriptors have not moved.
    dpmi.rmCalls.push({
      rmcs, reg: Array.from(cpu.reg), seg: Array.from(cpu.seg), base: Array.from(cpu.base),
      limit: Array.from(cpu.limit), eip: cpu.eip >>> 0, flags: cpu.flags, cr0: cpu.cr0,
      csD: cpu.csD, ssB: cpu.ssB, cpl: cpu.cpl, reflect: !!reflect,
    });

    // Read the parameter words before switching: they are addressed through the protected-mode SS.
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

    // SS:SP of zero means "host, provide a stack".
    const ss = r16(RMCS.SS), sp = r16(RMCS.SP);
    if ((ss | sp) === 0) { cpu.setSeg(SS, DPMI_ENTRY_SEG); cpu.reg[4] = RM_STACK_TOP; }
    else { cpu.setSeg(SS, ss); cpu.reg[4] = (cpu.reg[4] & ~0xffff) | sp; }

    // The procedure's own parameters go on first, so they sit ABOVE the frame it returns through.
    for (let i = args.length - 1; i >= 0; i--) cpu.push16(args[i]);
    cpu.push16(cpu.flags & 0xffff);              // the IRET frame: FLAGS, CS, IP
    cpu.push16(DPMI_ENTRY_SEG);
    cpu.push16(RM_RET_OFF);

    // 0300 enters through the real-mode vector instead of the structure's CS:IP.
    const tgt = vec === undefined ? { seg: r16(RMCS.CS), off: r16(RMCS.IP) } : machine.getVector(vec);
    cpu.setSeg(CS, tgt.seg); cpu.eip = tgt.off;
    if (dpmi.log) {
      const lin = ((tgt.seg << 4) + tgt.off) >>> 0;
      const bytes = [0, 1, 2, 3].map((i) => mem.r8((lin + i) >>> 0).toString(16).padStart(2, '0')).join(' ');
      dpmi.log.push(`${vec === undefined ? '0302' : '0300 int ' + vec.toString(16)} rmcs=${rmcs.toString(16)} es:di=${cpu.seg[ES].toString(16)}:${(cpu.reg[7] & 0xffff).toString(16)} ` +
        `-> reel ${tgt.seg.toString(16)}:${tgt.off.toString(16)} ` +
        `ax=${(r32(RMCS.EAX) & 0xffff).toString(16)} ss:sp=${cpu.seg[SS].toString(16)}:${(cpu.reg[4] & 0xffff).toString(16)} ` +
        `words=${words}  linear=${lin.toString(16)} bytes=[${bytes}] PE=${cpu.cr0 & 1}`);
    }
  };

  /** The sentinel the procedure's IRET lands on: harvest registers, go back to protected mode. */
  const realCallReturn = () => {
    const st = dpmi.rmCalls.pop();
    if (!st) return;                             // not ours — nothing to unwind
    const w32 = (o, v) => mem.w32((st.rmcs + o) >>> 0, v >>> 0);
    const w16 = (o, v) => mem.w16((st.rmcs + o) >>> 0, v & 0xffff);

    // Harvest before restoring, or the client reads back its own inputs.
    w32(RMCS.EDI, cpu.reg[7]); w32(RMCS.ESI, cpu.reg[6]); w32(RMCS.EBP, cpu.reg[5]);
    w32(RMCS.EBX, cpu.reg[3]); w32(RMCS.EDX, cpu.reg[2]); w32(RMCS.ECX, cpu.reg[1]);
    w32(RMCS.EAX, cpu.reg[0]);
    w16(RMCS.FLAGS, cpu.flags); w16(RMCS.ES, cpu.seg[ES]); w16(RMCS.DS, cpu.seg[DS]);
    w16(RMCS.FS, cpu.seg[FS]); w16(RMCS.GS, cpu.seg[GS]);

    if (dpmi.log) {
      const r16r = (o) => mem.r16((st.rmcs + o) >>> 0);
      dpmi.log.push(`   <- retour ax=${r16r(RMCS.EAX).toString(16)} bx=${r16r(RMCS.EBX).toString(16)} ` +
        `cx=${r16r(RMCS.ECX).toString(16)} dx=${r16r(RMCS.EDX).toString(16)} ` +
        `flags=${r16r(RMCS.FLAGS).toString(16)} CF=${r16r(RMCS.FLAGS) & 1}`);
    }
    cpu.setCR0(st.cr0);
    cpu.reg.set(st.reg); cpu.seg.set(st.seg); cpu.base.set(st.base); cpu.limit.set(st.limit);
    // CPL travels with the rest of the cached segment state. Writing cpu.seg directly bypasses
    // setSeg, which is what maintains it, and the excursion ran in real mode where CS's load left it
    // at 0 — so the client came back to ring 3 with the CPU still believing it was at ring 0. The
    // next far RET then read `(cs & 3) > cpl` as an OUTWARD return, popped two words that were not
    // there, and loaded a garbage CS. That is where DOOM stopped.
    cpu._cpl = st.cpl;
    cpu.csD = st.csD; cpu.ssB = st.ssB;
    cpu.eip = st.eip; cpu.flags = st.flags & ~1;         // CF=0: the call succeeded
    if (st.reflect) {
      // A reflected interrupt returns its answer in the CLIENT's registers, not in a structure the
      // client will read — so carry the results back out, CF included, which is where DOS puts
      // success or failure.
      const r32 = (o) => mem.r32((st.rmcs + o) >>> 0) >>> 0, r16 = (o) => mem.r16((st.rmcs + o) >>> 0);
      cpu.reg[7] = r32(RMCS.EDI); cpu.reg[6] = r32(RMCS.ESI); cpu.reg[5] = r32(RMCS.EBP);
      cpu.reg[3] = r32(RMCS.EBX); cpu.reg[2] = r32(RMCS.EDX); cpu.reg[1] = r32(RMCS.ECX);
      cpu.reg[0] = r32(RMCS.EAX);
      cpu.flags = (cpu.flags & ~1) | (r16(RMCS.FLAGS) & 1);
    }
  };
  /**
   * Deliver an exception to the handler the client installed with 0203, building the frame the DPMI
   * specification defines. This used to push a bare flags/CS/IP/error and jump: a shape no client
   * can read. DOS/4GW installs handlers for all 17 exceptions before it loads the program, faults
   * on purpose (it loads the PSP's environment field, a real-mode paragraph, as a selector), and
   * then walked off into its own data because the stack under it was not the frame it expected.
   *
   * 16-bit client, from SP upwards: return CS:IP, error code, faulting CS:IP, flags, faulting SS:SP.
   * 32-bit client: the same fields as dwords. The handler either RETFs to the return address — our
   * EXC_RET stub, which restores whatever it left in the frame — or edits the frame first to resume
   * somewhere else. That is the whole point of the frame: a client fixes the fault by rewriting it.
   */
  const deliverException = (n, err) => {
    const ev = n < 32 ? dpmi.excVec[n] : null;
    if (!ev) return false;
    const is32 = dpmi.is32;
    const oldSS = cpu.seg[SS], oldESP = cpu.reg[4] >>> 0, oldFlags = cpu.flags;
    const oldCS = cpu.seg[CS], oldEIP = cpu.eip >>> 0;
    const push = (v) => cpu.pushW(v, is32);
    push(oldSS); push(is32 ? oldESP : (oldESP & 0xffff));
    push(is32 ? (oldFlags >>> 0) : (oldFlags & 0xffff));
    push(oldCS); push(is32 ? oldEIP : (oldEIP & 0xffff));
    push(err === undefined ? 0 : err >>> 0);
    push(SEL_HOST_CODE | TI); push(EXC_RET_OFF);
    cpu.flags &= ~(IF_FLAG | TF);
    cpu.setSeg(CS, ev.sel); cpu.eip = ev.off >>> 0;
    return true;
  };
  machine.dpmiDeliverException = deliverException;

  /** The far RETF target the frame above carries. Restores the context the handler left in it. */
  const excReturn = () => {
    const is32 = dpmi.is32;
    const pop = () => (is32 ? cpu.pop32() >>> 0 : cpu.pop16());
    pop();                                        // error code — the handler cannot change it
    const eip = pop(), cs = pop() & 0xffff, fl = pop(), esp = pop(), ss = pop() & 0xffff;
    cpu.setSeg(SS, ss);
    cpu.reg[4] = is32 ? (esp >>> 0) : ((cpu.reg[4] & ~0xffff) | (esp & 0xffff));
    cpu.setSeg(CS, cs); cpu.eip = eip >>> 0;
    // IOPL is not the client's to write, here any more than through IRET.
    const keep = cpu.flags & IOPL_MASK;
    cpu.flags = (is32 ? (fl >>> 0) : ((cpu.flags & ~0xffff) | (fl & 0xffff)));
    if (cpu.cpl !== 0) cpu.flags = (cpu.flags & ~IOPL_MASK) | keep;
  };
  cpu.dpmiExcReturn = excReturn;

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
  mem.u8[(DPMI_ENTRY_SEG << 4) + EXC_RET_OFF] = 0xcb;     // guarded: cpu.dpmiExcReturn()
  for (let i = 0; i < CB_MAX; i++) mem.u8[(DPMI_ENTRY_SEG << 4) + CB_BASE_OFF + i] = 0xcb;

  // INT 2Fh AX=1687h — "is a DPMI host present, and where do I switch?" Chain to whatever already
  // owns the vector (XMS answers 43xx there) rather than replacing it.
  const prev = machine.intHandlers[0x2f];
  machine.reclaimMultiplex = typeof process !== 'undefined' && !!process.env && !!process.env.MIRAGE_DPMI_ALWAYS &&
    process.env.MIRAGE_DPMI_ALWAYS !== '0';
  machine.hookInterrupt(0x2f, (c, m) => {
    // Stand aside once a guest handler sits below us, for the same reason xms.js does: a real BIOS
    // offers no DPMI host either — one is a TSR the guest loads, and DOSBox ships none at all. This
    // is not merely cosmetic. Offering DPMI on the boot path pushed intros/mesha.com onto its DPMI
    // branch under FreeDOS, where it faults with #GP at 3c:9fc, instead of the XMS branch that
    // renders (docs/notes/2026-09-05-mesha.md). On the HLE path nothing takes the vector, so we answer as before.
    // MIRAGE_DPMI_ALWAYS=1 keeps answering even under a booted kernel. Not for normal use — it puts a
    // client on our host where a real machine would have none — but it is the only way to reproduce
    // ROADMAP F8, the #GP our DPMI path takes on the boot path and not under the HLE DOS.
    const ALWAYS = typeof process !== 'undefined' && !!process.env &&
      process.env.MIRAGE_DPMI_ALWAYS !== undefined && process.env.MIRAGE_DPMI_ALWAYS !== '0' && process.env.MIRAGE_DPMI_ALWAYS !== '';
    if (!ALWAYS && machine.guestOwns(0x2f)) return false;
    if (c.ax === 0x1687) {
      c.ax = 0;                                  // 0 = host present
      c.reg[3] = (c.reg[3] & ~0xffff) | 1;       // BX bit 0: 32-bit programs supported
      c.reg[1] = (c.reg[1] & ~0xff) | 3;         // CL = processor type (3 = 386)
      c.reg[2] = (c.reg[2] & ~0xffff) | 0x005a;  // DX = DPMI version 0.90
      c.reg[6] = c.reg[6] & ~0xffff;             // SI = paragraphs of host data needed: none
      c.setSeg(ES, DPMI_ENTRY_SEG); c.reg[7] = (c.reg[7] & ~0xffff) | DPMI_ENTRY_OFF;
      return true;
    }
    return prev ? prev(c, m) : false;
  });

  return dpmi;
}
