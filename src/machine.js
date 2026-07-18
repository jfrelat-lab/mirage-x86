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

    this.cpu.swInt = (n) => this.swInt(n);
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
    const v8 = this.getVector(8);
    if (v8.seg !== BIOS_SEG) { this.realInt(8, v8.seg, v8.off); return; }
    const v1c = this.getVector(0x1c);
    if (v1c.seg !== BIOS_SEG) this.realInt(0x1c, v1c.seg, v1c.off);
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
    return this.rec.run(this, maxBlocks);
  }

  /** A handler calls this to wait on input: rewind past the INT and yield. */
  block(instrLen = 2) { this.blocked = true; this.cpu.eip = (this.cpu.eip - instrLen) & 0xffff; }

  reset() {
    this.cpu.reg.fill(0); this.cpu.seg.fill(0); this.cpu.base.fill(0);
    this.cpu.eip = 0; this.cpu.flags = 0x0002 | IF; this.cpu.halted = false;
    this.rec.reset();
  }
}
