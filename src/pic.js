// pic.js — a real 8259A pair: IRR, ISR, IMR, fixed priority, EOI and the ICW init sequence.
//
// What was here before: `onPortWrite(0x20, () => {})`. The EOI was a no-op, there was no IRR or ISR,
// and interrupts were delivered by calling realInt() straight from the device. That is not a small
// simplification — it means a guest that masks an IRQ still receives it, and an ISR that has not
// finished cannot hold off the next one. (The mask register at least reads back since a71ead1;
// before that, "save the IMR, mask my IRQ, restore it" restored 0xFF and masked everything.)
//
// Deliberately NOT changed here: *when* an interrupt is delivered. A device still raises and the
// existing path delivers in the same place it always did, so this commit changes semantics without
// moving timing. Delivering at run-loop safepoints instead is the D7 chantier, and it is what will
// move the goldens — keeping the two apart is the only way to tell which change did what.
//
// Fixed priority only (IRQ0 highest). Rotating priority, special mask mode and the poll command are
// not implemented; nothing in the corpus uses them, and survey-ports.mjs will say if that changes.

const MASTER_BASE = 0x08, SLAVE_BASE = 0x70;   // the vectors a PC BIOS programs the pair to
const CASCADE_IRQ = 2;                         // master IRQ2 carries the slave

function chip(base) {
  return {
    irr: 0, isr: 0, imr: 0,      // request / in-service / mask
    base,                        // vector base, set by ICW2 (we start at the BIOS defaults)
    init: 0,                     // 0 = running, 1 = expecting ICW2, 2 = ICW3, 3 = ICW4
    expectICW4: false,
    single: false,
    autoEOI: false,
    readISR: false,              // OCW3 selected ISR (0x0B) rather than IRR (0x0A) for reads
  };
}

export function installPIC(machine) {
  const master = chip(MASTER_BASE), slave = chip(SLAVE_BASE);

  /** Highest-priority unmasked request on `c`, or -1. A set ISR bit blocks everything at or below
   *  its own priority — that is the whole point of in-service state. */
  const pendingOn = (c) => {
    const ready = c.irr & ~c.imr;
    for (let i = 0; i < 8; i++) {
      const b = 1 << i;
      if (c.isr & b) return -1;
      if (ready & b) return i;
    }
    return -1;
  };

  const pic = {
    master, slave,

    /** Assert an IRQ line. 0-7 = master, 8-15 = slave (which raises the master's cascade line). */
    raise(irq) {
      if (irq >= 8) { slave.irr |= 1 << (irq - 8); master.irr |= 1 << CASCADE_IRQ; }
      else master.irr |= 1 << irq;
    },
    /** Drop a request that has not been acknowledged (edge-triggered lines that go away). */
    lower(irq) {
      if (irq >= 8) { slave.irr &= ~(1 << (irq - 8)); if (!slave.irr) master.irr &= ~(1 << CASCADE_IRQ); }
      else master.irr &= ~(1 << irq);
    },

    /** The IRQ the CPU would take right now, or -1. Does not change state. */
    pending() {
      const m = pendingOn(master);
      if (m < 0) return -1;
      if (m !== CASCADE_IRQ) return m;
      const s = pendingOn(slave);
      return s < 0 ? -1 : 8 + s;
    },

    /** Take the pending interrupt: clear its request, mark it in service, return its vector. */
    acknowledge() {
      const irq = pic.pending();
      if (irq < 0) return -1;
      if (irq >= 8) {
        const b = 1 << (irq - 8);
        slave.irr &= ~b;
        if (slave.autoEOI) { /* nothing stays in service */ } else slave.isr |= b;
        master.irr &= ~(1 << CASCADE_IRQ);
        if (!master.autoEOI) master.isr |= 1 << CASCADE_IRQ;
        return slave.base + (irq - 8);
      }
      const b = 1 << irq;
      master.irr &= ~b;
      if (!master.autoEOI) master.isr |= b;
      return master.base + irq;
    },

    /** End of interrupt on `c`: clear the highest-priority in-service bit (non-specific EOI). */
    eoiOn(c) {
      for (let i = 0; i < 8; i++) if (c.isr & (1 << i)) { c.isr &= ~(1 << i); return; }
    },
    /** Convenience for the code that services an IRQ itself instead of handing it to a guest ISR:
     *  a real BIOS handler ends with `mov al,20h; out 20h,al`, and ours must too. */
    eoi(irq = 0) {
      if (irq >= 8) { pic.eoiOn(slave); master.isr &= ~(1 << CASCADE_IRQ); }
      else master.isr &= ~(1 << irq);
    },
    /** True if `irq` is masked off. Devices use it to skip work nobody will see. */
    masked(irq) {
      return irq >= 8 ? !!(slave.imr & (1 << (irq - 8))) || !!(master.imr & (1 << CASCADE_IRQ))
                      : !!(master.imr & (1 << irq));
    },
    reset() {
      Object.assign(master, chip(MASTER_BASE));
      Object.assign(slave, chip(SLAVE_BASE));
    },
  };

  /** Command port (0x20 / 0xA0): ICW1, OCW2 (EOI) or OCW3 (read select). */
  const writeCommand = (c, v) => {
    v &= 0xff;
    if (v & 0x10) {                          // ICW1 — begin initialisation
      c.irr = 0; c.isr = 0; c.imr = 0;
      c.init = 1; c.expectICW4 = !!(v & 1); c.single = !!(v & 2); c.autoEOI = false;
      return;
    }
    if (v & 0x08) {                          // OCW3
      if (v & 0x02) c.readISR = !!(v & 0x01);   // 0x0A = read IRR, 0x0B = read ISR
      return;
    }
    // OCW2
    const kind = (v >> 5) & 7;
    if (kind === 1) pic.eoiOn(c);                                   // 0x20 non-specific EOI
    else if (kind === 3) c.isr &= ~(1 << (v & 7));                  // 0x60+n specific EOI
    // rotating-priority forms (kind 4/5/7) are accepted and ignored: fixed priority only
  };

  /** Data port (0x21 / 0xA1): the rest of the ICW sequence, or the mask. */
  const writeData = (c, v) => {
    v &= 0xff;
    if (c.init === 1) { c.base = v & 0xf8; c.init = c.single ? (c.expectICW4 ? 3 : 0) : 2; return; }
    if (c.init === 2) { c.init = c.expectICW4 ? 3 : 0; return; }    // ICW3: cascade wiring, fixed here
    if (c.init === 3) { c.autoEOI = !!(v & 0x02); c.init = 0; return; }
    c.imr = v;
  };

  machine.onPortWrite(0x20, (_p, _s, v) => writeCommand(master, v));
  machine.onPortWrite(0x21, (_p, _s, v) => writeData(master, v));
  machine.onPortRead(0x20, () => (master.readISR ? master.isr : master.irr));
  machine.onPortRead(0x21, () => master.imr);

  machine.onPortWrite(0xa0, (_p, _s, v) => writeCommand(slave, v));
  machine.onPortWrite(0xa1, (_p, _s, v) => writeData(slave, v));
  machine.onPortRead(0xa0, () => (slave.readISR ? slave.isr : slave.irr));
  machine.onPortRead(0xa1, () => slave.imr);

  machine.pic = pic;
  return pic;
}
