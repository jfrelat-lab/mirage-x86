// uart.js — a 16550A serial port (COM1: 3F8h-3FFh, IRQ 4), from the National Semiconductor PC16550D
// datasheet's register model:
//   +0 RBR (read) / THR (write), or DLL when LCR.DLAB     +1 IER, or DLM when LCR.DLAB
//   +2 IIR (read) / FCR (write)                           +3 LCR    +4 MCR    +5 LSR    +6 MSR    +7 SCR
//
// Optional, like the PCI bus: `installBIOS(machine, { serial: true })` or MIRAGE_SERIAL=1 in the tools.
// The machine used to have no UART at all — the equipment word says "no serial ports", and DOS
// programs that probe COM ports depend on that — so the ISA machine every existing image boots on
// stays as it was. With it, the BDA lists COM1 at 3F8h and the equipment word counts one port.
//
// What a guest sees:
//   * Transmission is instant: THR is empty again when the write returns, so LSR always reads THRE
//     and TEMT, and a THRE interrupt (IER bit 1) is pending after every write — and as soon as IER
//     bit 1 is set, which is what the chip does when the holding register is already empty.
//     Bytes go to `serial.out` and to `serial.onTx(byte)` when a host wants them.
//   * Reception: `serial.receive(bytes)` queues bytes; LSR.DR says one is there, and IER bit 0 makes
//     it an interrupt (IIR 04h). The FIFO is 16 bytes deep, as on the 16550A; more is an overrun.
//   * FCR bit 0 turns the FIFOs on and IIR's top bits read 11 — which is how software tells a 16550A
//     from an 8250/16450.
//   * The modem lines: with nothing attached, CTS, DSR and DCD are asserted, as QEMU leaves them for
//     a port with no back end. In loopback (MCR bit 4) they follow RTS/DTR/OUT1/OUT2 and transmitted
//     bytes come back as received ones — the self-test drivers run before they trust a port.
//   * The IRQ line is gated by MCR OUT2 (bit 3), as on every PC serial card.

const RX_FIFO = 16;

function makeUart(machine, base, irq) {
  const u = {
    base, irq, rx: [], out: [], onTx: null,
    ier: 0, lcr: 0, mcr: 0, scr: 0, dll: 0x0c, dlm: 0, fifo: false,
    threPending: false, msrDelta: 0, lsrErr: 0, line: false,
  };
  const msrLines = () => {
    if (u.mcr & 0x10) {                                       // loopback
      return ((u.mcr & 0x02) ? 0x10 : 0) | ((u.mcr & 0x01) ? 0x20 : 0) | ((u.mcr & 0x04) ? 0x40 : 0) | ((u.mcr & 0x08) ? 0x80 : 0);
    }
    return 0xb0;                                              // DCD, DSR, CTS
  };
  let lastLines = msrLines();
  const iir = () => {
    let id = 0x01;                                            // nothing pending
    if ((u.ier & 0x04) && u.lsrErr) id = 0x06;
    else if ((u.ier & 0x01) && u.rx.length) id = 0x04;
    else if ((u.ier & 0x02) && u.threPending) id = 0x02;
    else if ((u.ier & 0x08) && u.msrDelta) id = 0x00;
    return id | (u.fifo ? 0xc0 : 0);
  };
  const update = () => {
    const asserted = (iir() & 0x01) === 0 && (u.mcr & 0x08) !== 0;
    if (asserted && !u.line) machine.raiseIRQ(irq);
    else if (!asserted && u.line) machine.lowerIRQ(irq);
    u.line = asserted;
  };
  const linesChanged = () => {
    const now = msrLines(), x = now ^ lastLines;
    if (x & 0x10) u.msrDelta |= 0x01;                         // DCTS
    if (x & 0x20) u.msrDelta |= 0x02;                         // DDSR
    // TERI (RI going inactive) is NOT raised on a loopback exit: the datasheet would, QEMU's 16550A
    // does not (tools/uartprobe.asm: MSR B0h after MCR 1Fh -> 03h, where TERI would read B4h).
    if (x & 0x80) u.msrDelta |= 0x08;                         // DDCD
    lastLines = now;
  };
  const rxPush = (b) => { if (u.rx.length >= (u.fifo ? RX_FIFO : 1)) { u.lsrErr |= 0x02; return; } u.rx.push(b & 0xff); };

  machine.onPortRead(base + 0, () => {
    if (u.lcr & 0x80) return u.dll;
    const b = u.rx.length ? u.rx.shift() : 0;
    update();
    return b;
  });
  machine.onPortWrite(base + 0, (_p, _s, v) => {
    if (u.lcr & 0x80) { u.dll = v & 0xff; return; }
    const b = v & 0xff;
    if (u.mcr & 0x10) rxPush(b);                              // loopback: back to our own receiver
    else { u.out.push(b); if (u.onTx) u.onTx(b); }
    u.threPending = true;
    update();
  });
  machine.onPortRead(base + 1, () => ((u.lcr & 0x80) ? u.dlm : u.ier));
  machine.onPortWrite(base + 1, (_p, _s, v) => {
    if (u.lcr & 0x80) { u.dlm = v & 0xff; return; }
    const was = u.ier;
    u.ier = v & 0x0f;
    if ((u.ier & 0x02) && !(was & 0x02)) u.threPending = true;   // THR is empty: THRE fires at once
    update();
  });
  machine.onPortRead(base + 2, () => {
    const v = iir();
    if ((v & 0x0f) === 0x02) u.threPending = false;           // reading IIR acknowledges THRE
    update();
    return v;
  });
  machine.onPortWrite(base + 2, (_p, _s, v) => {              // FCR
    u.fifo = (v & 0x01) !== 0;
    if (v & 0x02) u.rx.length = 0;
    update();
  });
  machine.onPortRead(base + 3, () => u.lcr);
  machine.onPortWrite(base + 3, (_p, _s, v) => { u.lcr = v & 0xff; });
  machine.onPortRead(base + 4, () => u.mcr);
  machine.onPortWrite(base + 4, (_p, _s, v) => { u.mcr = v & 0x1f; linesChanged(); update(); });
  machine.onPortRead(base + 5, () => {
    const v = (u.rx.length ? 0x01 : 0) | u.lsrErr | 0x60;     // DR, OE, THRE + TEMT
    u.lsrErr = 0;
    update();
    return v;
  });
  machine.onPortWrite(base + 5, () => {});
  machine.onPortRead(base + 6, () => { const v = msrLines() | u.msrDelta; u.msrDelta = 0; update(); return v; });
  machine.onPortWrite(base + 6, () => {});
  machine.onPortRead(base + 7, () => u.scr);
  machine.onPortWrite(base + 7, (_p, _s, v) => { u.scr = v & 0xff; });

  /** Host -> guest: queue bytes (a string or numbers) on the receive side. */
  u.receive = (bytes) => {
    for (const b of (typeof bytes === 'string' ? [...bytes].map((c) => c.charCodeAt(0)) : bytes)) rxPush(b);
    update();
  };
  /** Guest -> host: everything transmitted so far, as a string. */
  u.text = () => String.fromCharCode(...u.out);
  return u;
}

export function installUART(machine) {
  const com1 = makeUart(machine, 0x3f8, 4);
  // The BIOS Data Area names the port (0400h) and the equipment word counts it (bits 9-11).
  const mem = machine.mem;
  mem.w16(0x400, 0x3f8);
  mem.w16(0x410, (mem.r16(0x410) & ~0x0e00) | (1 << 9));
  machine.serial = com1;
  return com1;
}
