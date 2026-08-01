// machine.js — wires CPU + memory + recompiler together and owns the run loop,
// the modular I/O-port + interrupt bus, and hardware-interrupt injection.
//
// Interrupt routing is the interesting part: a software INT whose vector still
// points at our BIOS stub segment is serviced by a fast JS handler (trap and
// emulate). If the guest has *hooked* the vector with its own ISR, we perform a
// real INT (push FLAGS/CS/IP, jump through the IVT) so the guest code runs —
// which is what lets games install INT 9 / INT 1Ch handlers and have them fire.

import { Memory } from './memory.js';
import { CPU, CS, IF, TF } from './cpu.js';
import { Recompiler } from './recompiler.js';
import { installFPU } from './fpu.js';

export const BIOS_SEG = 0xf000;

export class Machine {
  constructor(opts = {}) {
    this.mem = new Memory(opts.memSize || 16 * 1024 * 1024);
    this.cpu = new CPU(this.mem);
    installFPU(this.cpu);                           // x87 coprocessor
    this.rec = new Recompiler(this.cpu);

    this.intHandlers = new Array(256).fill(null); // n -> (cpu, machine) => void
    this.portRead = new Map();                     // port -> (port,size) => value
    this.portWrite = new Map();                    // port -> (port,size,value) => void
    this.devices = [];
    this.onError = null;                           // (err) => void
    this.blocked = false;                          // set by a handler waiting on input
    this.keyQueue = [];                            // {ascii, scan} pushed by the UI
    this.hwIrqPending = false;                      // a hardware IRQ (keyboard) waits for IF to be set

    // PIT channel-0 timer, clocked off cpu.cycles (which counts retired instructions ~= the
    // 1.19 MHz PIT tick for our purposes). The run loop fires INT 8 whenever cpu.cycles crosses
    // the next reload boundary WITH IF set — so a guest that busy-waits on a timer-updated
    // counter INSIDE one runSlice (Wolf3D's VBL loop spins on its TimeCount) actually sees the
    // tick, instead of the old model where the timer only fired between slices.
    // Reload in cpu.cycles. 65536 = the real PIT channel-0 default, i.e. we treat one retired
    // instruction as one ~1.19 MHz PIT clock (an emulated ~1.2 MIPS 386). Env override for tuning.
    this.pitReload = (typeof process !== 'undefined' && process.env && +process.env.MIRAGE_PITRELOAD) || 0x10000;
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
    this.cpu.biosCallback = (n) => this.biosCallback(n);
    this.cpu.ioRead = (p, s) => this.ioRead(p, s);
    this.cpu.ioWrite = (p, s, v) => this.ioWrite(p, s, v);

    // Point every vector at the BIOS stub so unhandled INTs no-op (act as IRET)
    // rather than jumping through an uninitialised 0000:0000 vector. A real IRET (0xCF)
    // byte is placed at each stub entry so that a guest which hooks an interrupt, saves the
    // ORIGINAL vector, and later *chains* to it (a far JMP/CALL to f000:n — the ubiquitous
    // TSR/game pattern, e.g. Keen's INT 8 handler) executes a clean IRET instead of running
    // off into uninitialised BIOS memory. (The INT-n → JS-handler fast path is unaffected:
    // swInt dispatches by number and never executes these bytes.)
    for (let n = 0; n < 256; n++) { this.setVector(n, BIOS_SEG, n); this.mem.u8[(BIOS_SEG << 4) + n] = 0xcf; }
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
    if (h) h(cpu, this);
    cpu.eip = cpu.pop16();
    cpu.setSeg(CS, cpu.pop16());
    cpu.flags = (cpu.pop16() & 0x7fd5) | 2;
    cpu.halted = false;
  }

  swInt(n) {
    const v = this.getVector(n);
    if (v.seg === BIOS_SEG) {
      const h = this.intHandlers[n];
      if (h) h(this.cpu, this);          // JS handler; eip already points past the INT
      // else: unhandled BIOS vector -> behave as IRET (no-op)
    } else {
      this.realInt(n, v.seg, v.off);     // guest-installed ISR
    }
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
  onPortRead(port, fn) { this.portRead.set(port, fn); }
  onPortWrite(port, fn) { this.portWrite.set(port, fn); }
  ioRead(p, s) { const h = this.portRead.get(p); return h ? h(p, s) & (s === 1 ? 0xff : s === 2 ? 0xffff : 0xffffffff) : (s === 1 ? 0xff : s === 2 ? 0xffff : 0xffffffff); }
  ioWrite(p, s, v) { const h = this.portWrite.get(p); if (h) h(p, s, v); }

  /** A device is any object with an optional attach(machine) and a name. */
  addDevice(dev) { this.devices.push(dev); if (dev.attach) dev.attach(this); return dev; }

  // ---- hardware interrupt injection ---------------------------------------
  /** Fire the 18.2 Hz timer: bump the BIOS tick and run the user timer ISR. */
  tickTimer() {
    const a = 0x46c;                          // BDA 0040:006C — ticks since midnight
    this.mem.w32(a, (this.mem.r32(a) + 1) >>> 0);
    if (!(this.cpu.flags & IF)) return;
    this.cpu.halted = false;                  // the timer IRQ wakes a HLT even with the BIOS-default
                                              // ISR (a `STI;HLT` before the guest installs its own
                                              // INT 8 — e.g. Moktar's GAME.TDT init — must resume)
    const v8 = this.getVector(8);
    if (v8.seg !== BIOS_SEG) { this.realInt(8, v8.seg, v8.off); return; }
    const v1c = this.getVector(0x1c);
    if (v1c.seg !== BIOS_SEG) this.realInt(0x1c, v1c.seg, v1c.off);
  }

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
    this.pitReload = Math.max(this.pitBase >> 4, r);
    this.nextTimerCycle = this.cpu.cycles + this.pitReload;
    this.cpu.deadline = this.nextTimerCycle;
  }

  /** Raise IRQ1 (keyboard) into a guest-installed INT 9 handler, if any. */
  raiseKeyboardIRQ() {
    if (!(this.cpu.flags & IF)) return false;
    const v = this.getVector(9);
    if (v.seg === BIOS_SEG) return false;     // no guest handler; use BIOS buffer instead
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

  /** A handler calls this to wait on input: rewind past the INT and yield. */
  block(instrLen = 2) { this.blocked = true; this.cpu.eip = (this.cpu.eip - instrLen) & 0xffff; }

  reset() {
    this.cpu.reg.fill(0); this.cpu.seg.fill(0); this.cpu.base.fill(0);
    this.cpu.eip = 0; this.cpu.flags = 0x0002 | IF; this.cpu.halted = false;
    this.nextTimerCycle = this.cpu.cycles + this.pitReload;
    this.rec.reset();
  }
}
