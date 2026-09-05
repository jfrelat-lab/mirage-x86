// machine.js — wires CPU + memory + recompiler together and owns the run loop,
// the modular I/O-port + interrupt bus, and hardware-interrupt injection.
//
// Interrupt routing is the interesting part: a software INT whose vector still
// points at our BIOS stub segment is serviced by a fast JS handler (trap and
// emulate). If the guest has *hooked* the vector with its own ISR, we perform a
// real INT (push FLAGS/CS/IP, jump through the IVT) so the guest code runs —
// which is what lets games install INT 9 / INT 1Ch handlers and have them fire.

import { Memory } from './memory.js';
import { describeRegion, recentBlocks } from './derail.js';
import { CPU, CS, CF, IF, TF, VM} from './cpu.js';
import { Recompiler } from './recompiler.js';
import { installFPU } from './fpu.js';
import { installSSE } from './sse.js';
import { resolveProfile } from './cpu-profile.js';
import { resolveMemStrategy } from './mem-strategy.js';
import { EMS_SEG } from './ems.js';

export const BIOS_SEG = 0xf000;
// Where every UNSERVICED interrupt vector points. 0xFF53 is the address a real IBM BIOS uses for its
// dummy IRET, so the table looks like a real one: a handful of distinct installed handlers and a
// large block of identical entries.
const DUMMY_INT_OFF = 0xff53;

// Result mask by I/O access size in bytes, so the hot path indexes instead of re-deriving the
// mask with a ternary chain on every IN/OUT. Index 0 and 3 are never used.
const IO_MASK = [0, 0xff, 0xffff, 0, 0xffffffff];

export class Machine {
  constructor(opts = {}) {
    this.mem = new Memory(opts.memSize || 16 * 1024 * 1024);
    this.mem.pfRaise = true;         // there is a run loop here to catch it — see Memory.xlat
    this.cpu = new CPU(this.mem);
    // Which x86 generation this machine is. Read by the recompiler at TRANSLATION time, so every
    // difference becomes a constant in the emitted code — see src/cpu-profile.js.
    // The VGA keeps its linear shadow up to date only when emitted reads rely on it.
    this.mem.shadowReads = resolveMemStrategy().read === 'shadow';
    this.cpu.profile = resolveProfile(opts.cpu);
    this.cpu.shiftMask = this.cpu.profile.shiftCountMask;   // read by the shift/rotate helpers
    installFPU(this.cpu);                           // x87 coprocessor
    installSSE(this.cpu);                           // XMM register file + the SSE subset (src/sse.js)
    // FLDCW changing PRECISION CONTROL invalidates every translated FPU block: the rounding is folded
    // into the emitted code, exactly as the CPU profile's constants are.
    this.cpu.onFcwPrecChange = () => { this.rec.reset(); this.cpu.tbudget = 0; };
    this.rec = new Recompiler(this.cpu);
    // Paging plumbing. Memory needs the CPU to walk CR3, and any change to the mapping invalidates
    // both the software TLB and every translated block (their emitted addresses assumed the old
    // one). Enabling paging also forces the `paged` memory strategy: it is the only emission that
    // consults the table, so `inline` code would silently bypass translation. That is the trigger
    // the memory-dispatch benchmarks named — a page table earns its keep once there is address
    // TRANSLATION to do, and there now is.
    this.mem.cpu = this.cpu;
    // Faults that carry an error code (protected mode only) — #GP is the first we raise.
    this.cpu.raise = (n, err) => { if (this.cpu.cr0 & 1) this.protInt(n, err); else this.swInt(n); };
    this.cpu.onPagingChange = () => {
      if (this.cpu.pagingOn) this.rec.memStrategy = { read: 'paged', write: 'paged' };
      this.mem.rebuildPageTables();
      this.rec.reset();
      // End the slice. The run loop hoists `pagedMode` into a local at entry — it is read once per
      // slice, not once per block, because it sits on the dispatch path. Turning paging on mid-slice
      // therefore left the REST of that slice masking linear addresses, and those blocks were cached
      // under the masked key: the first blocks of a protected-mode kernel, compiled from the wrong
      // address and never re-looked-up. Windows 3.0 enables paging and far-jumps to linear
      // 0x80201b5e in the same slice.
      this.cpu.tbudget = 0;
    };

    this.intHandlers = new Array(256).fill(null); // n -> (cpu, machine) => void
    // The I/O bus is a flat 64K-entry table, not a Map. x86 port space is exactly 16 bits (an
    // immediate port is a byte, a DX port is masked to 0xffff by the emitter), so the port number
    // IS the index — no hashing, and a miss is a null slot rather than a Map probe. This is on the
    // hottest device path there is: a vsync-locked demo polls 0x3DA hundreds of thousands of times
    // per frame. Two arrays of 65536 pointers cost ~1 MB and are shared by nothing else.
    this.portRead = new Array(0x10000).fill(null);  // port -> (port,size) => value
    this.portWrite = new Array(0x10000).fill(null); // port -> (port,size,value) => void
    this.devices = [];
    this.onError = null;                           // (err) => void
    this.blocked = false;                          // set by a handler waiting on input
    this.vbe = null;                               // active VESA VBE mode, if any (see setVbeMode)
    this.keyQueue = [];                            // {ascii, scan} pushed by the UI
    this.hwIrqPending = false;                      // a hardware IRQ (keyboard) waits for IF to be set
    this.unhandledInts = new Uint32Array(256);      // per-vector count of INTs we don't implement
    this._inBiosCallback = -1;                     // vector currently running via the inline far-call path

    // PIT channel-0 timer, clocked off cpu.cycles (which counts retired instructions ~= the
    // 1.19 MHz PIT tick for our purposes). The run loop fires INT 8 whenever cpu.cycles crosses
    // the next reload boundary WITH IF set — so a guest that busy-waits on a timer-updated
    // counter INSIDE one runSlice (Wolf3D's VBL loop spins on its TimeCount) actually sees the
    // tick, instead of the old model where the timer only fired between slices.
    // Reload in cpu.cycles — and this number IS the emulated machine's speed, because a cycle here is
    // one retired instruction. It used to be 0x10000, the real PIT channel-0 default, which made one
    // instruction one ~1.19 MHz PIT clock: about a fast 286.
    //
    // 182584 instead, because that is what the reference does. tools/beamperiod.asm counts poll
    // iterations across one 0x3DA frame from INSIDE the guest, and the same binary runs on both
    // sides: DOSBox-X at `cycles=fixed 20000` gives 0x2E60 = 11872 per frame, we gave 0x10A5 = 4261,
    // so a guest got 2.79x less work per frame here than in the configuration every dosdiff and
    // dbx-oracle comparison is made against. 182584 reproduces DOSBox's count exactly, digit for
    // digit — one comparable unit, at last. See docs/TIMING.md §6.
    this.pitReload = (typeof process !== 'undefined' && process.env && +process.env.MIRAGE_PITRELOAD) || 182584;
    this.nextTimerCycle = this.pitReload;           // cpu.cycles threshold for the next INT 8
    // pitBase is the default cycles-per-18.2Hz-tick. The 0x3DA VGA beam (70 Hz) scales off THIS,
    // not the dynamic pitReload — a game reprogramming the system timer (below) must not move the
    // video refresh, which is an independent clock.
    this.pitBase = this.pitReload;
    // PIT counter-0 reprogramming: games set a custom INT 8 rate via ports 0x43 (mode)/0x40 (data)
    // — e.g. Cryo's Dune sets reload 0x1745 → ~200 Hz for smooth, correctly-paced animation. We
    // honour counter 0's reload as the new pitReload; counters 1 (refresh)/2 (speaker) don't drive
    // INT 8 so their programming is accepted but ignored here.
    this._pitAccess = 3; this._pitHiNext = false; this._pitLo = 0; this._pitReadHi = false;
    this.onPortWrite(0x43, (_p, _s, v) => {
      v &= 0xff;
      if (((v >> 6) & 3) !== 0) return;              // not counter 0
      const access = (v >> 4) & 3;
      this._pitReadHi = false;                        // any counter-0 command re-aligns reads to LSB first
      if (access === 0) return;                       // counter-latch command (read), no reload change
      this._pitAccess = access; this._pitHiNext = false;
    });
    this.onPortWrite(0x40, (_p, _s, v) => {
      v &= 0xff;
      let reload;
      if (this._pitAccess === 1) reload = v;                    // LSB only
      else if (this._pitAccess === 2) reload = v << 8;          // MSB only
      else {                                                    // LSB then MSB
        if (!this._pitHiNext) { this._pitLo = v; this._pitHiNext = true; return; }
        reload = (v << 8) | this._pitLo; this._pitHiNext = false;
      }
      this.setPitReload(reload === 0 ? 0x10000 : reload);       // 0 == 65536
    });
    // Reading counter 0 (0x40) returns the LIVE countdown value. Games poll it for fine timing /
    // delays / entropy — Alley Cat's gameplay loop spins on it — so a constant reply freezes them.
    // The counter counts down from the reload once per PIT period; derive it from cpu.cycles and
    // return LSB then MSB per the current access mode (BIOS default is LSB-then-MSB).
    this.onPortRead(0x40, () => {
      const count = (this.pitReload - (this.cpu.cycles % this.pitReload)) & 0xffff;
      if (this._pitAccess === 1) return count & 0xff;
      if (this._pitAccess === 2) return (count >> 8) & 0xff;
      const b = this._pitReadHi ? (count >> 8) & 0xff : count & 0xff;
      this._pitReadHi = !this._pitReadHi;
      return b;
    });
    // Auto-fire the timer off cpu.cycles from the run loop. On (headless): deterministic and
    // representative — INT 8 fires proportionally to CPU work, so a busy-wait inside one runSlice
    // still sees ticks. The browser (ui.js) sets this false and paces tickTimer to wall-clock at
    // 18.2 Hz instead, keeping real-time game speed.
    this.timerAuto = true;

    this.cpu.swInt = (n) => this.swInt(n);
    this.cpu.softInt = (n, nextIp, faultIp) => this.softInt(n, nextIp, faultIp);
    this.cpu.biosCallback = (n) => this.biosCallback(n);
    // Bind the tables directly rather than trampolining through this.ioRead/ioWrite: recompiled code
    // calls these per IN/OUT, and the extra frame was pure overhead on a 0x3DA poll loop. Capturing
    // the arrays (not the handlers) keeps late onPortRead/onPortWrite registration working.
    const pr = this.portRead, pw = this.portWrite;
    this.cpu.ioRead = (p, s) => { const h = pr[p]; return h ? h(p, s) & IO_MASK[s] : IO_MASK[s]; };
    this.cpu.ioWrite = (p, s, v) => { const h = pw[p]; if (h) h(p, s, v); };

    // Point every vector at the BIOS stub so unhandled INTs no-op (act as IRET)
    // rather than jumping through an uninitialised 0000:0000 vector. A real IRET (0xCF)
    // byte is placed at each stub entry so that a guest which hooks an interrupt, saves the
    // ORIGINAL vector, and later *chains* to it (a far JMP/CALL to f000:n — the ubiquitous
    // TSR/game pattern, e.g. Keen's INT 8 handler) executes a clean IRET instead of running
    // off into uninitialised BIOS memory. (The INT-n → JS-handler fast path is unaffected:
    // swInt dispatches by number and never executes these bytes.)
    // Unserviced vectors share ONE dummy, as a real BIOS does: a table of 256 distinct handlers is
    // something no real machine shows, and programs scan for adjacent identical entries to find free
    // vector space. hookInterrupt re-points a vector to its own F000:00nn stub when a service claims
    // it, keeping the per-vector identity the inline BIOS-call path decodes from the address.
    for (let n = 0; n < 256; n++) { this.setVector(n, BIOS_SEG, DUMMY_INT_OFF); this.mem.u8[(BIOS_SEG << 4) + n] = 0xcf; }
    this.mem.u8[(BIOS_SEG << 4) + DUMMY_INT_OFF] = 0xcf;
  }

  // ---- interrupt vector table --------------------------------------------
  setVector(n, seg, off) { this.mem.w16(n * 4, off & 0xffff); this.mem.w16(n * 4 + 2, seg & 0xffff); }
  getVector(n) { return { off: this.mem.r16(n * 4), seg: this.mem.r16(n * 4 + 2) }; }

  /** Register a JS service routine for INT n and point its vector at our stub. */
  hookInterrupt(n, fn) { this.intHandlers[n] = fn; this.setVector(n, BIOS_SEG, n); }

  /** BIOS service reached by executing its entry (f000:n) — a guest that calls the ISR inline
   *  rather than via `INT n` (reads the vector, then far-JMP/CALLs it, having pushed an IRET
   *  frame). Run the JS handler (if any), then IRET back to the frame the guest set up. A vector
   *  with no JS handler just IRETs — identical to the bare 0xCF stub, so chaining is unaffected. */
  biosCallback(n) {
    const cpu = this.cpu, h = this.intHandlers[n];
    const prev = this._inBiosCallback;
    const depth0 = this.dpmi ? this.dpmi.rmCalls.length : 0;   // grew? the handler transferred control
    this._inBiosCallback = n;                    // tells block() which path it is on
    try { if (h) h(cpu, this); } finally { this._inBiosCallback = prev; }
    if (this.blocked) {
      // The handler is waiting on input. Consuming the IRET frame here is what broke this path:
      // it overwrote the rewind block() had just done, so the guest never re-asked, `blocked`
      // stayed set and AX was never loaded. Leave the caller's frame alone and re-enter this same
      // entry when the slice resumes, so the service is retried instead of silently completing.
      cpu.setSeg(CS, BIOS_SEG); cpu.eip = n;
      return;
    }
    // A service may TRANSFER control rather than return: 0300/0302 switch to real mode and set CS:IP
    // themselves, finishing later at their sentinel. Having pushed a real-mode call is the signal
    // that the handler owns CS:IP now, and consuming the frame here would overwrite it.
    if (this.dpmi && this.dpmi.rmCalls.length > depth0) return;

    // Pop the frame at the width it was pushed at: 16-bit in real mode, but a client chaining into
    // these stubs left the 32-bit frame softInt pushed for it.
    //
    // The RESULT flags must survive the pop. A real ISR returns its answer by writing the flags
    // IMAGE on the stack — DOS sets carry there, then IRETs — so restoring the caller's copy
    // verbatim threw away every error the service had just reported. Only this path was affected:
    // an `INT 21h` runs the JS handler with no frame at all, so its CF stood. But a program that
    // HOOKS INT 21h and chains to the saved vector comes through here, and that is the ubiquitous
    // TSR idiom — Windows 3.0's WIN386 does it, then read AX=2 from a failed open as if it were a
    // file handle, because carry had been wiped on the way back.
    // ...but only a SERVICE reports through that image. A HARDWARE interrupt handler returns
    // nothing, and its IRET owes the interrupted instruction its flags byte for byte — carrying the
    // handler's arithmetic flags back instead silently rewrites the flag the guest was mid-way
    // through using. Dune decompresses with `shr bp,1` / `jnz` / `rcl cx,1`, so a timer tick landing
    // on that boundary shifted a 0 into the match length where the carry said 1: one short copy,
    // then a resource whose sprite records read as zero-height, then a blitter looping 65536 rows.
    const isIRQ = (n >= 0x08 && n <= 0x0f) || (n >= 0x70 && n <= 0x77) || n === 0x1c;
    const ARITH = CF | 0x04 | 0x10 | 0x40 | 0x80 | 0x800;   // CF PF AF ZF SF OF
    const result = cpu.flags;
    const is32 = (cpu.cr0 & 1) && this.dpmi && this.dpmi.active && this.dpmi.is32;
    if (is32) {
      cpu.eip = cpu.pop32() >>> 0;
      cpu.setSeg(CS, cpu.pop32() & 0xffff);
      cpu.flags = (cpu.pop32() & 0x27fd5) | 2;
    } else {
      cpu.eip = cpu.pop16();
      cpu.setSeg(CS, cpu.pop16());
      cpu.flags = (cpu.pop16() & 0x7fd5) | 2;
    }
    if (!isIRQ) cpu.flags = (cpu.flags & ~ARITH) | (result & ARITH);
    cpu.halted = false;
  }

  /**
   * Protected-mode interrupt/exception dispatch: through an IDT GATE, not the real-mode IVT.
   * Gate types 0x06/0x07 are the 286 (16-bit) interrupt/trap gates, 0x0E/0x0F their 386 (32-bit)
   * counterparts; the odd ones are TRAP gates and leave IF alone, the even ones are INTERRUPT gates
   * and clear it. The frame is pushed at the GATE's width, not the current code segment's.
   *
   * Same-privilege only for now: a gate whose selector has a lower DPL needs a stack switch through
   * the TSS, which is the next step. Nothing here checks privilege, so a fault that should be #GP
   * still gets delivered — wrong, but it surfaces as a later POST rather than as silence.
   */
  /**
   * Exception delivery can itself fault — loading the handler's CS, switching to the TSS stack —
   * and that recursion has to stop somewhere. Real hardware escalates: a fault during delivery is
   * #DF, and a fault while delivering #DF shuts the processor down. We do not model #DF, so this
   * reports instead, which is more useful than a JS stack overflow (the first thing Windows 3.0's
   * enhanced mode produced here: #PF -> load SS from an un-LTR'd TSS -> #GP -> repeat).
   */
  protInt(n, err, faultIp) {
    if ((this._excDepth = (this._excDepth || 0) + 1) > 3) {
      this._excDepth = 0;
      throw new Error(`mirage: exception ${n} raised while already delivering one, three deep — ` +
        `the delivery path itself is faulting. TR=0x${this.cpu.tr.sel.toString(16)} ` +
        `GDT=0x${(this.cpu.gdtr.base >>> 0).toString(16)}/0x${this.cpu.gdtr.limit.toString(16)} ` +
        `CR2=0x${(this.cpu.cr2 >>> 0).toString(16)}`);
    }
    // While DELIVERING, a null CS/SS in a gate or an un-LTR'd TSS is not the guest's #GP to take:
    // raising there recurses instead of reporting, and the depth guard above is the diagnosis.
    const wasDelivering = this.cpu._delivering; this.cpu._delivering = true;
    try { return this._protInt(n, err, faultIp); }
    finally { this._excDepth--; this.cpu._delivering = wasDelivering; }
  }

  _protInt(n, err, faultIp) {
    const cpu = this.cpu, m = this.mem;
    // No IDT for a client (see dpmi.js): software interrupts are reflected, so reaching here means a
    // genuine exception. Name it rather than dispatching through an empty table.
    if (this.dpmi && this.dpmi.active) {
      // A handler installed with 0203 gets the fault; only an unclaimed one is worth naming.
      const ev = n < 32 ? this.dpmi.excVec[n] : null;
      if (ev) {
        const is32 = this.dpmi.is32;
        cpu.pushW(cpu.flags, is32); cpu.pushW(cpu.seg[1], is32); cpu.pushW(cpu.eip >>> 0, is32);
        if (err !== undefined) cpu.pushW(err, is32);
        cpu.flags &= ~(IF | TF);
        cpu.setSeg(1, ev.sel); cpu.eip = ev.off >>> 0;
        return;
      }
      const NAMES = { 0: '#DE', 1: '#DB', 3: '#BP', 4: '#OF', 5: '#BR', 6: '#UD', 7: '#NM', 8: '#DF',
        10: '#TS', 11: '#NP', 12: '#SS', 13: '#GP', 14: '#PF' };
      throw new Error(`mirage: ${NAMES[n] || 'exception ' + n} in DPMI client at ` +
        `${cpu.seg[1].toString(16)}:${(cpu.eip >>> 0).toString(16)}` +
        (err !== undefined ? ` err=0x${(err >>> 0).toString(16)}` : ''));
    }
    const a = (cpu.idtr.base + n * 8) >>> 0;
    const offLo = m.r16(a), sel = m.r16(a + 2), access = m.r8(a + 5), offHi = m.r16(a + 6);
    const type = access & 0x1f, is32 = (type & 0x08) !== 0;
    const off = is32 ? ((offLo | (offHi << 16)) >>> 0) : offLo;

    // The new CPL is the TARGET code segment's DPL, not the gate's and not zero. Loading the gate's
    // selector verbatim silently promoted every handler to ring 0 — test386 installs a DPL-3
    // handler for #GP, checks which ring it is running in, and asks for a different saved CS in
    // each case, which is how that showed up.
    const target = cpu.readDesc(sel);
    const cpl = cpu.cpl;
    const conforming = target && !target.sys && (target.type & 0x0c) === 0x0c;
    const newCpl = (target && !conforming) ? target.dpl : cpl;

    // An interrupt goes inward or stays put. A target code segment LESS privileged than CPL is
    // illegal — #GP with its selector. Conforming targets follow the same DPL <= CPL rule.
    // From a virtual-8086 task the gate must land in ring 0, in a NON-CONFORMING segment: the monitor
    // is the only thing allowed to see the guest's interrupts, and a conforming target would keep CPL
    // at 3. Anything else is #GP with that segment's selector —
    // test386 checks exactly this ("interrupt with IOPL 3 to non-V86 privilege level 0 faults with
    // #GP(usermodesegment)"). Without it we entered the DPL-3 handler from the previous section.
    if ((cpu.flags & VM) && target && !target.sys && (target.dpl !== 0 || conforming)) {
      if (faultIp !== undefined) cpu.eip = faultIp >>> 0;
      return this.protInt(13, sel & 0xfffc);
    }
    if (target && !target.sys && target.dpl > cpl) {
      // On this fault the saved EIP must point AT the INT, not past it; softInt supplies that.
      if (faultIp !== undefined) cpu.eip = faultIp >>> 0;
      return this.protInt(13, sel & 0xfffc);
    }
    // Leaving a virtual-8086 task. The frame is the widest the architecture has: the four data
    // segments ride on it because a V86 task's segment registers are 8086 values, and the monitor
    // has to be able to put them back. VM must be cleared BEFORE the ring-0 SS is loaded, or setSeg
    // would treat that selector as an 8086 value and the handler would run on a nonsense stack.
    const savedFlags = cpu.flags;                    // VM lives in here; the pushed copy must keep it
    if (cpu.flags & VM) {
      const oldSS = cpu.seg[2], oldESP = cpu.reg[4] >>> 0;
      const gs = cpu.seg[5], fs = cpu.seg[4], ds = cpu.seg[3], es = cpu.seg[0];
      const inner = cpu.tssStack(newCpl);
      cpu.flags &= ~VM;
      cpu._cpl = newCpl;                             // the inner stack is checked at the NEW ring
      cpu.setSeg(2, inner.ss); cpu.reg[4] = inner.esp;
      cpu.push32(gs); cpu.push32(fs); cpu.push32(ds); cpu.push32(es);
      cpu.push32(oldSS); cpu.push32(oldESP);
      // The 8086 data segments must not stay loaded in the monitor: their cached bases are
      // sel << 4 and would survive into ring 0 as if they were descriptors.
      cpu.setSeg(0, 0); cpu.setSeg(3, 0); cpu.setSeg(4, 0); cpu.setSeg(5, 0);
    } else if (newCpl < cpl) {                       // inward: the inner stack comes from the TSS
      const oldSS = cpu.seg[2], oldESP = cpu.reg[4] >>> 0;
      const inner = cpu.tssStack(newCpl);
      cpu._cpl = newCpl;                             // the inner stack is checked at the NEW ring
      cpu.setSeg(2, inner.ss); cpu.reg[4] = inner.esp;
      cpu.pushW(oldSS, is32); cpu.pushW(oldESP, is32);
    }
    cpu.pushW(savedFlags, is32);
    cpu.pushW(cpu.seg[1], is32);
    cpu.pushW(cpu.eip >>> 0, is32);
    if (err !== undefined) cpu.pushW(err, is32);
    if ((type & 1) === 0) cpu.flags &= ~IF;          // interrupt gate masks; trap gate does not
    cpu.flags &= ~TF;
    cpu.setSeg(1, (sel & 0xfffc) | newCpl);          // CS's RPL carries the new CPL
    cpu.eip = off;
    cpu.halted = false;
  }

  /**
   * INT n / INT3 / INTO. Unlike a fault, a software interrupt is privilege-checked against the gate:
   * at CPL > gate.DPL it raises #GP with the IDT-style error code (n<<3)|2. BOUND and #UD also route
   * through swInt but are FAULTS and must NOT be checked, so only the three opcodes call this.
   * #GP here is a fault, hence faultIp: the saved EIP points AT the instruction, not past it.
   */
  softInt(n, nextIp, faultIp) {
    const cpu = this.cpu;
    // In virtual-8086 mode INT n is IOPL-sensitive like CLI/STI/PUSHF/POPF/IRET: below IOPL 3 it
    // traps to the monitor instead of taking the gate, which is how a V86 monitor gets to see the
    // guest's software interrupts at all. test386 enters V86 with IOPL 0 (switchToRing3V86_0) and
    // then does `int 0x22` expecting exactly this; without the check we took the gate and landed in
    // the ring-3 handler from the previous section, which asserts a 0x14-byte frame.
    if (cpu.flags & VM) {
      if (cpu.iopl < 3) {
        if (faultIp !== undefined) cpu.eip = faultIp >>> 0;
        return this.protInt(13, 0);
      }
    }
    if (cpu.cr0 & 1) {
      // A host reflects a protected-mode software interrupt to the real-mode handler. Ours are JS
      // services, so reflection is calling them: no gate, no frame, no mode change.
      if (this.dpmi && this.dpmi.active) {
        // A handler installed with 0205 wins: push a protected-mode frame so its IRET returns here.
        const v = this.dpmi.pmVec[n];
        if (v) {
          cpu.eip = nextIp;
          const is32 = this.dpmi.is32;
          cpu.pushW(cpu.flags, is32); cpu.pushW(cpu.seg[1], is32); cpu.pushW(cpu.eip >>> 0, is32);
          cpu.flags &= ~(IF | TF);
          cpu.setSeg(1, v.sel); cpu.eip = v.off >>> 0;
          return;
        }
        if (this.intHandlers[n]) {
          cpu.eip = nextIp;
          this.intHandlers[n](cpu, this);
          return;
        }
        // Unclaimed: return, as the real-mode dummy IRET would. EIP is already past the INT.
        cpu.eip = nextIp;
        this.unhandledInts[n]++;
        return;
      }
      const dpl = (this.mem.r8((cpu.idtr.base + n * 8 + 5) >>> 0) >> 5) & 3;
      if (dpl < (cpu.seg[1] & 3)) { cpu.eip = faultIp; return this.protInt(13, (n << 3) | 2); }
    }
    cpu.eip = nextIp;
    if (cpu.cr0 & 1) return this.protInt(n, undefined, faultIp);
    return this.swInt(n);
  }

  swInt(n) {
    // In protected mode every vector goes through the IDT — including the ones a BIOS would own in
    // real mode. test386 replaces the BIOS wholesale, so routing its exceptions to our JS handlers
    // would swallow them.
    if (this.cpu.cr0 & 1) return this.protInt(n);
    const v = this.getVector(n);
    // EMS has its own segment (the name must sit at <vector segment>:000A) but is still ours.
    if (v.seg === BIOS_SEG || (v.seg === EMS_SEG && this.ems)) {
      const h = this.intHandlers[n];
      if (h) h(this.cpu, this);          // JS handler; eip already points past the INT
      else if (this.mem.u8[((BIOS_SEG << 4) + v.off) & this.mem.mask] !== 0xcf) {
        // The vector points into F000 but the byte there is NOT our IRET stub, so the guest has
        // replaced the ROM and owns this vector — test386.asm does exactly that, being a BIOS
        // replacement whose exception handlers live in F000. Assuming we own the segment made us
        // swallow its #UD handler and spin on the faulting instruction forever.
        this.realInt(n, v.seg, v.off);
      } else {
        // Unhandled BIOS vector. Returning with CF untouched reads to the guest as SUCCESS — so a
        // program that e.g. asks INT 13h for a sector believes it got one and then parses whatever
        // was in the buffer. Report failure instead (CF=1 is the DOS/BIOS error convention) and
        // count it, so "the game misbehaves" becomes one line in `unhandledInts`.
        // INT 03h (breakpoint) and INT 01h (single step) are the exception: on real hardware their
        // default vectors are a bare IRET, which restores the flags rather than modifying them. A
        // debugger-detection routine — LOOM's bundled !RAWCOPY.EXE fires INT 3 over 1500 times —
        // reads a clobbered CF as a debugger being present. Count them, change nothing.
        // INT 03h (breakpoint) and INT 01h (single step) are not gaps: their real default vectors ARE
        // a bare IRET, which restores the flags rather than modifying them. Doing nothing is the
        // correct implementation, so they are neither counted nor failed — a debugger-detection
        // routine (LOOM's bundled !RAWCOPY.EXE fires INT 3 over 1500 times) reads a clobbered CF as
        // a debugger being present.
        if (n === 0x03 || n === 0x01) return;
        this.unhandledInts[n]++;
        this.cpu.flags |= CF;
        // A processor EXCEPTION returns to the FAULTING instruction, not past it, so an unhandled
        // one re-runs it and re-raises for ever. MS-DOS 6.22 spent 3 million blocks that way: it had
        // wandered into the IVT, where the bytes 62 07 decode as BOUND, and every retry raised #BR
        // again in silence. Report the loop instead — the vector alone said nothing, the ADDRESS is
        // the whole diagnosis.
        if (n <= 0x07) {
          const at = ((this.cpu.seg[1] << 16) | (this.cpu.eip & 0xffff)) >>> 0;
          if (at === this._excAt) {
            if (++this._excN === 100000) {
              const h = (x, w) => (x >>> 0).toString(16).padStart(w, '0');
              // base[CS], not seg[CS] << 4: in protected mode CS is a selector and the shift is
              // fiction — it reported oktaeder's fault at 0xc54, an address it never executed.
              // The EIP width follows CS.D for the same reason the dispatch sites do.
              const at = (this.cpu.base[1] + (this.cpu.csD ? this.cpu.eip >>> 0 : this.cpu.eip & 0xffff)) & this.mem.mask;
              const where = describeRegion(this.mem, at, this.cpu);
              const path = recentBlocks(this.rec);
              throw new Error(`mirage: unhandled exception INT ${h(n, 2)}h re-raised 100000x at the same ` +
                `address ${h(this.cpu.seg[1], 4)}:${h(this.cpu.csD ? this.cpu.eip >>> 0 : this.cpu.eip & 0xffff, 4)} ` +
                `(linear 0x${at.toString(16)}) — ` +
                'the guest is stuck on one instruction; an exception resumes at the faulting one, so nothing ' +
                `will change${where ? '. ' + where : ''}${path ? '. Recent block starts (oldest first, the last is this one): ' + path : ''}`);
            }
          } else { this._excAt = at; this._excN = 1; }
        }
      }
    } else {
      this.realInt(n, v.seg, v.off);     // guest-installed ISR
    }
  }

  /** Vectors the guest asked for that we don't implement, as "INT xx ×N" — the first thing to look
   *  at when a program misbehaves for no visible reason. */
  unhandledIntReport() {
    const out = [];
    for (let n = 0; n < 256; n++) if (this.unhandledInts[n]) out.push(`INT ${n.toString(16).padStart(2, '0')}h ×${this.unhandledInts[n]}`);
    return out.join(', ');
  }

  /** Push state and transfer control to a real ISR (used for hooked + hardware ints). */
  realInt(n, seg, off) {
    const cpu = this.cpu;
    cpu.push16(cpu.flags & 0xffff);
    cpu.push16(cpu.seg[CS]);
    cpu.push16(cpu.eip & 0xffff);
    cpu.flags &= ~(IF | TF);
    cpu.setSeg(CS, seg);
    cpu.eip = off;
    cpu.halted = false;
  }

  // ---- modular I/O bus ----------------------------------------------------
  onPortRead(port, fn) { this.portRead[port & 0xffff] = fn; }
  onPortWrite(port, fn) { this.portWrite[port & 0xffff] = fn; }
  ioRead(p, s) { const h = this.portRead[p]; return h ? h(p, s) & IO_MASK[s] : IO_MASK[s]; }
  ioWrite(p, s, v) { const h = this.portWrite[p]; if (h) h(p, s, v); }

  /** A device is any object with an optional attach(machine) and a name. */
  addDevice(dev) { this.devices.push(dev); if (dev.attach) dev.attach(this); return dev; }

  // ---- hardware interrupt injection ---------------------------------------
  /** Fire the 18.2 Hz timer: bump the BIOS tick and run the user timer ISR. */
  tickTimer() {
    if (!(this.cpu.flags & IF)) return;
    // Raise IRQ0 on the PIC and let it decide. This is where masking and in-service state start
    // mattering: a guest that has masked IRQ0 in the IMR no longer receives the tick (it used to,
    // regardless), and a tick cannot be delivered while the previous INT 8 is still in service.
    // The delivery *point* is unchanged — still right here — so this is a semantic change, not a
    // timing one. Moving delivery to run-loop safepoints is D7.
    const pic = this.pic;
    if (pic) {
      pic.raise(0);
      if (pic.pending() !== 0) return;        // masked, or an ISR of equal/higher priority is open
      pic.acknowledge();                      // clears IRR bit 0, sets ISR bit 0
    }
    this.cpu.halted = false;                  // the timer IRQ wakes a HLT even with the BIOS-default
                                              // ISR (a `STI;HLT` before the guest installs its own
                                              // INT 8 — e.g. Moktar's GAME.TDT init — must resume)
    if (this.dpmiIrq(8)) return;              // a DPMI client's own PM handler comes first
    // In protected mode a hardware interrupt is dispatched through the IDT, not the real-mode vector
    // table. Without this a self-hosted protected-mode guest — one that switches by itself instead of
    // going through a DPMI host — never receives the timer at all, and we ran our own BIOS handler
    // instead. intros/mesha.com is the case: its extender (PMODE4K, source on scene.org) keeps the
    // RESET IDTR and writes its gate straight to linear 0x40, which is idtr.base 0 + vector 8 * 8, so
    // there is no LIDT to notice. Measured there: `92 00 08 00 00 8e 00 00` — offset 0x92, selector 8,
    // access 0x8E, a present 32-bit interrupt gate, and offset 0x92 is the same handler the DPMI
    // branch installs with INT 31h AX=0205. All of mesha's rendering lives in that handler, so
    // without this it drew nothing at all (docs/TIMING.md §14j).
    // Guarded on the gate's PRESENT bit: a guest that is in protected mode with no IDT of its own
    // must keep the previous behaviour rather than jump through an empty descriptor.
    const c = this.cpu;
    if ((c.cr0 & 1) && !(c.flags & VM)) {
      const g = (c.idtr.base + 8 * 8) >>> 0;
      if (8 * 8 + 7 <= c.idtr.limit && (this.mem.r8(g + 5) & 0x80)) { this.protInt(8); return; }
    }
    const v8 = this.getVector(8);
    if (v8.seg !== BIOS_SEG) { this.realInt(8, v8.seg, v8.off); return; }
    // No guest ISR: we are the BIOS timer handler. A real one ends with `mov al,20h; out 20h,al`,
    // and so must we — otherwise ISR bit 0 stays set and the timer never ticks again.
    // We ARE the BIOS INT 8 handler on this path, so do what it does — including the BDA tick, which
    // the guest-ISR path gets instead when it chains to f000:08 (see bios.js).
    this.bumpBiosTick();
    const v1c = this.getVector(0x1c);
    if (v1c.seg !== BIOS_SEG) this.realInt(0x1c, v1c.seg, v1c.off);
    if (pic) pic.eoi(0);
  }

  /** Advance 0040:006C, the BDA's ticks-since-midnight. Only the BIOS INT 8 handler does this. */
  bumpBiosTick() { const a = 0x46c; this.mem.w32(a, (this.mem.r32(a) + 1) >>> 0); }

  /** Deliver PIT ticks that have come due (cpu.cycles crossed a reload boundary). Called from
   *  the run loop only when IF is set. A long IF-off gap is coalesced into a single tick so a
   *  guest that runs with interrupts disabled for a while doesn't get a burst on the next STI. */
  serviceTimer() {
    if (this.cpu.cycles - this.nextTimerCycle > 8 * this.pitReload) this.nextTimerCycle = this.cpu.cycles;
    this.nextTimerCycle += this.pitReload;
    this.cpu.deadline = this.nextTimerCycle;   // a running tier-2 region bails here to let the next tick fire
    this.tickTimer();
  }

  /** Set the PIT channel-0 reload (INT 8 period, in cpu.cycles) and reschedule the next tick.
   *  Called when a guest reprograms the timer via port 0x40/0x43; `ui.js` reads pitReload to pace
   *  its wall-clock tick rate so the browser delivers INT 8 at the game's chosen frequency. */
  setPitReload(r) {
    // Cap the emulated INT 8 rate (floor the reload at pitBase/16 ≈ 291 Hz). Some games drive
    // counter 0 far faster — Wolf3D sets ~700 Hz for its sound service — which real hardware
    // handles with a tiny ISR, but MIRAGE's per-interrupt dispatch is much heavier, so an
    // uncapped rate becomes an INT-8 storm (headless especially, where serviceTimer fires off
    // cpu.cycles). The cap keeps timer-paced games fast enough (200 Hz Dune / 140 Hz GoT are
    // unaffected) and matches ui.js's wall-clock clamp.
    // The floor is a SPEED accommodation, not a timing one — measured in docs/TIMING.md §2: interrupt
    // dispatch costs ~0.2 µs and 256x the deliveries cost +8% wall clock, so what an uncapped rate
    // actually buys is the guest's own ISR running that many more times. `MIRAGE_PITFLOOR` lowers it
    // for experiments (Chrome Revenge asks for 68 and runs ~33x slower when it gets it).
    const floor = (typeof process !== 'undefined' && process.env && +process.env.MIRAGE_PITFLOOR) || (this.pitBase >> 4);
    this.pitReload = Math.max(floor, r);
    this.nextTimerCycle = this.cpu.cycles + this.pitReload;
    this.cpu.deadline = this.nextTimerCycle;
  }

  /** Enter a VESA VBE mode. The framebuffer is plain RAM at `vbeFbBase` (reserved by installBIOS),
   *  so a client that maps PhysBasePtr and writes through it needs no device hook at all — and the
   *  A000 window is a 64 KiB view of the same bytes, moved by VBE function 4F05. `vbe` being non-null
   *  is what tells the renderer to ignore the BDA mode byte, which has no VBE encoding. */
  setVbeMode(m, linear) {
    const [number, width, height, bpp] = m;
    const pitch = width * (bpp >> 3);
    this.vbe = { number, width, height, bpp, pitch, linear, base: this.vbeFbBase >>> 0, bank: 0 };
    this.mem.u8.fill(0, this.vbe.base, this.vbe.base + height * pitch);
    this.vbeWindow(0);
    this.mem.setPlanar(true);      // route the A000 window through the VGA device (see vga.js vbeWin)
  }

  /** Point the A000 window at 64 KiB of the framebuffer (VBE 4F05, granularity 64 KiB). */
  vbeWindow(bank) {
    if (!this.vbe) return;
    this.vbe.bank = bank >>> 0;
    const src = (this.vbe.base + this.vbe.bank * 0x10000) >>> 0;
    this.vbe.windowSrc = src;
  }

  /** Deliver a hardware IRQ to a DPMI client's own protected-mode handler, at the client's frame
   *  width. Without this the IRQ goes out through the real-mode IVT and realInt's 16-bit frame,
   *  which a 32-bit ISR then pops as three dwords — Mesha's PMODE4K timer ISR ends in POPAD/IRETD
   *  and took a garbage CS from it. Returns true when it delivered. */
  dpmiIrq(n, pic) {
    if (!(this.cpu.cr0 & 1) || !this.dpmi || !this.dpmi.active) return false;
    const v = this.dpmi.pmVec[n];
    if (!v) return false;
    if (pic) pic.acknowledge();
    const cpu = this.cpu, is32 = this.dpmi.is32;
    cpu.pushW(cpu.flags, is32); cpu.pushW(cpu.seg[CS], is32); cpu.pushW(cpu.eip >>> 0, is32);
    cpu.flags &= ~(IF | TF);
    cpu.setSeg(CS, v.sel); cpu.eip = v.off >>> 0;
    cpu.halted = false;
    return true;
  }

  /** Raise IRQ1 (keyboard) into a guest-installed INT 9 handler, if any. */
  raiseKeyboardIRQ() {
    if (!(this.cpu.flags & IF)) return false;
    const pic = this.pic;
    if (pic) {
      pic.raise(1);
      if (pic.pending() !== 1) return false;  // masked, or a higher-priority ISR is still open
    }
    if (this.dpmiIrq(9, pic)) return true;
    const v = this.getVector(9);
    if (v.seg === BIOS_SEG) {
      // No guest handler; the BIOS buffer path handles the scancode itself, so acknowledge and end
      // the interrupt here rather than leaving IRQ1 asserted forever.
      if (pic) { pic.acknowledge(); pic.eoi(1); }
      return false;
    }
    if (pic) pic.acknowledge();
    this.realInt(9, v.seg, v.off);
    return true;
  }

  /** Deliver a pending hardware IRQ once interrupts are unmasked. Called from the run loop at
   *  block boundaries (guarded by the cheap `hwIrqPending` flag) so a guest that busy-waits for
   *  the keyboard IRQ with IF briefly set (QBasic's IDE, most games) actually receives it. */
  serviceHwInts() {
    if (this.hwIrqPending && (this.cpu.flags & IF)) {
      this.hwIrqPending = false;
      this.raiseKeyboardIRQ();
    }
  }

  // ---- run loop -----------------------------------------------------------
  /** Execute up to `maxBlocks` basic blocks (or until HLT). Returns blocks run. */
  runSlice(maxBlocks = 100000) {
    this.blocked = false;
    // A halted CPU (STI;HLT, waiting for the next interrupt) freezes cpu.cycles — but the PIT
    // keeps ticking on real hardware. Headless (timerAuto) drives INT 8 off cpu.cycles, so a HLT
    // would deadlock: advance to the next timer deadline and deliver the tick to wake it. (The
    // browser path uses wall-clock tickTimer instead.) Moktar's GAME.TDT does STI;HLT between
    // its decryption passes; without this it never resumes headless.
    if (this.cpu.halted && this.timerAuto && (this.cpu.flags & IF)) {
      if (this.cpu.cycles < this.nextTimerCycle) this.cpu.cycles = this.nextTimerCycle;
      this.serviceTimer();                       // fires INT 8; tickTimer clears cpu.halted
    }
    return this.rec.run(this, maxBlocks);
  }

  /** A handler calls this to wait on input: yield, and arrange for the service to be re-entered.
   *  On the `INT n` path the handler runs with eip already past the CD nn, so rewind to re-execute
   *  it. On the inline far-call path there is nothing to rewind — the guest pushed an IRET frame and
   *  jumped to f000:n — and biosCallback handles the re-entry itself. */
  block(instrLen = 2) {
    this.blocked = true;
    if (this._inBiosCallback < 0) this.cpu.eip = (this.cpu.eip - instrLen) & 0xffff;
  }

  reset() {
    this.cpu.reg.fill(0); this.cpu.seg.fill(0); this.cpu.base.fill(0);
    this.cpu.eip = 0; this.cpu.flags = 0x0002 | IF; this.cpu.halted = false;
    this.nextTimerCycle = this.cpu.cycles + this.pitReload;
    this.rec.reset();
  }
}
