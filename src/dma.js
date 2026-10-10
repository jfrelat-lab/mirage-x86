// dma.js — the two 8237 DMA controllers, as registers only.
//
// Nothing in MIRAGE moves data by DMA: there is no floppy controller and the Sound Blaster is a stub.
// But software reads the controller back. A Sound Blaster player asks how far the card has played
// by reading the channel's current count, and with no 8237 every port answered FFh — Void 3 fills
// its sound buffer up to `0FFFh - count`, never reached 1000h with a 12-bit index, and spun inside
// its timer handler for good. A real PC with no card draining the channel reads back what was
// programmed, so that is what this does: the current address and count are the base ones.
//
// tools/dmaprobe.asm under QEMU and DOSBox-X: channel 1 and 3's address, count and page read back as
// written. The two disagree on the mask register (port 0Fh: 00h against 0Fh) and the status register
// (08h: 04h against 00h), so neither is answered here — those reads stay FFh, as before.
//
// Controller 1 (channels 0-3, byte ports 00h-0Fh) and controller 2 (channels 4-7, word-spaced ports
// C0h-DEh). Each has a flip-flop that selects the low or high byte of a 16-bit register.

const PAGE_PORTS = [0x87, 0x83, 0x81, 0x82, 0x8f, 0x8b, 0x89, 0x8a];   // channel -> page register

export function installDMA(machine) {
  const ctl = [0, 1].map(() => ({ ff: 0, addr: new Uint16Array(4), count: new Uint16Array(4), mode: new Uint8Array(4) }));
  const page = new Uint8Array(8);
  // Register index r (0..15) of controller k lives at port base + r * stride.
  const port = (k, r) => (k === 0 ? r : 0xc0 + r * 2);
  for (const k of [0, 1]) {
    const c = ctl[k];
    for (let ch = 0; ch < 4; ch++) {
      for (const [r, reg] of [[ch * 2, c.addr], [ch * 2 + 1, c.count]]) {
        machine.onPortWrite(port(k, r), (p, s, v) => {
          reg[ch] = c.ff ? (reg[ch] & 0x00ff) | ((v & 0xff) << 8) : (reg[ch] & 0xff00) | (v & 0xff);
          c.ff ^= 1;
        });
        machine.onPortRead(port(k, r), () => { const v = c.ff ? reg[ch] >>> 8 : reg[ch] & 0xff; c.ff ^= 1; return v; });
      }
    }
    machine.onPortWrite(port(k, 0x0b), (p, s, v) => { c.mode[v & 3] = v & 0xfc; });   // mode
    machine.onPortWrite(port(k, 0x0c), () => { c.ff = 0; });                         // clear flip-flop
    machine.onPortWrite(port(k, 0x0d), () => { c.ff = 0; });                         // master clear
  }
  PAGE_PORTS.forEach((p, ch) => {
    machine.onPortWrite(p, (pp, s, v) => { page[ch] = v & 0xff; });
    machine.onPortRead(p, () => page[ch]);
  });
  machine.dma = { ctl, page };
  return machine.dma;
}
