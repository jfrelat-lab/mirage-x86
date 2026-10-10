// dma.js — the two 8237 DMA controllers.
//
// Software reads the controller back: a Sound Blaster player asks how far the card has played by
// reading the channel's current count. With no 8237 every port answered FFh — Void 3 fills its sound
// buffer up to `0FFFh - count`, never reached 1000h with a 12-bit index, and spun inside its timer
// handler for good.
//
// tools/dmaprobe.asm under QEMU and DOSBox-X: channel 1 and 3's address, count and page read back as
// written. The two disagree on the mask register (port 0Fh: 00h against 0Fh) and the status register
// (08h: 04h against 00h), so neither is answered here — those reads stay FFh.
//
// Each channel has a BASE address and count (what was written) and a CURRENT pair (what a transfer
// has reached); writing a register sets both, as on the chip. A device moves data with transfer():
// it advances the current pair one unit at a time — a byte on controller 1, a word on controller 2 —
// and at terminal count (the count going past zero) reloads the base pair if the channel is in
// auto-initialise mode, or masks the channel if not. Only the Sound Blaster (src/sb.js) calls it.
//
// Controller 1 (channels 0-3, byte ports 00h-0Fh) and controller 2 (channels 4-7, word-spaced ports
// C0h-DEh). Each has a flip-flop that selects the low or high byte of a 16-bit register.

const PAGE_PORTS = [0x87, 0x83, 0x81, 0x82, 0x8f, 0x8b, 0x89, 0x8a];   // channel -> page register

export function installDMA(machine) {
  const ch = Array.from({ length: 8 }, () => ({ baseAddr: 0, baseCount: 0, addr: 0, count: 0, mode: 0, masked: true }));
  const ff = [0, 0];
  const page = new Uint8Array(8);
  const dma = {
    ch, page,
    // A device that is moving data catches up before the guest reads where it has got to.
    beforeRead: null,
    /**
     * Move up to `n` units on channel `c` (0-7). `fn(linear)` is called for each unit's address.
     * Returns { done, tc }: units moved, and whether terminal count was reached (after which an
     * auto-initialised channel has reloaded and a single-cycle one is masked).
     */
    transfer(c, n, fn) {
      const s = ch[c];
      if (s.masked) return { done: 0, tc: false };
      const wide = c >= 4;
      let done = 0, tc = false;
      while (done < n) {
        // The 16-bit controller counts words: its address register holds the word address, the page
        // supplies A17-A23 and bit 0 of the page is not used.
        const lin = wide ? (((page[c] & 0xfe) << 16) | (s.addr << 1)) : ((page[c] << 16) | s.addr);
        fn(lin >>> 0);
        done++;
        s.addr = (s.addr + ((s.mode & 0x20) ? -1 : 1)) & 0xffff;
        if (s.count === 0) {
          tc = true;
          if (s.mode & 0x10) { s.addr = s.baseAddr; s.count = s.baseCount; }
          else { s.count = 0xffff; s.masked = true; break; }
          break;
        }
        s.count = (s.count - 1) & 0xffff;
      }
      return { done, tc };
    },
  };
  // Register index r (0..15) of controller k lives at port base + r * stride.
  const port = (k, r) => (k === 0 ? r : 0xc0 + r * 2);
  for (const k of [0, 1]) {
    for (let i = 0; i < 4; i++) {
      const s = ch[k * 4 + i];
      for (const [r, field] of [[i * 2, 'addr'], [i * 2 + 1, 'count']]) {
        const base = field === 'addr' ? 'baseAddr' : 'baseCount';
        machine.onPortWrite(port(k, r), (p, sz, v) => {
          const x = ff[k] ? (s[base] & 0x00ff) | ((v & 0xff) << 8) : (s[base] & 0xff00) | (v & 0xff);
          s[base] = x; s[field] = x;
          ff[k] ^= 1;
        });
        machine.onPortRead(port(k, r), () => {
          if (dma.beforeRead) dma.beforeRead();
          const v = ff[k] ? s[field] >>> 8 : s[field] & 0xff;
          ff[k] ^= 1;
          return v;
        });
      }
    }
    const of = (n) => ch[k * 4 + (n & 3)];
    machine.onPortWrite(port(k, 0x0a), (p, sz, v) => { of(v).masked = !!(v & 4); });              // single mask
    machine.onPortWrite(port(k, 0x0b), (p, sz, v) => { of(v).mode = v & 0xfc; });                 // mode
    machine.onPortWrite(port(k, 0x0c), () => { ff[k] = 0; });                                      // clear flip-flop
    machine.onPortWrite(port(k, 0x0d), () => { ff[k] = 0; for (let i = 0; i < 4; i++) ch[k * 4 + i].masked = true; });  // master clear
    machine.onPortWrite(port(k, 0x0e), () => { for (let i = 0; i < 4; i++) ch[k * 4 + i].masked = false; });            // clear all masks
    machine.onPortWrite(port(k, 0x0f), (p, sz, v) => { for (let i = 0; i < 4; i++) ch[k * 4 + i].masked = !!(v & (1 << i)); });  // write all masks
  }
  PAGE_PORTS.forEach((p, c) => {
    machine.onPortWrite(p, (pp, sz, v) => { page[c] = v & 0xff; });
    machine.onPortRead(p, () => page[c]);
  });
  machine.dma = dma;
  return dma;
}
