// cirrus.js — a Cirrus Logic CL-GD5446, the PCI SVGA chip of 1996 that QEMU's -vga cirrus emulates
// and that the drivers of the period know: XFree86 3.3's SVGA server ("clgd5446"), Windows 95's
// CIRRUSMM.DRV, NT's cirrus.sys. On a machine that asks for it (`vga: 'cirrus'`, MIRAGE_VGA=cirrus),
// it sits on top of the VGA (src/vga.js) as the chip does: the standard registers stay the VGA's,
// and the extensions are more indexes behind the same ports.
//
//   SR6       unlock: 12h written opens the extensions and reads back 12h; anything else reads 0Fh
//   SR7       extended sequencer mode: bit 0 the extended (packed-pixel) modes, bits 1-3 the depth
//   SR0F/SR15 the memory size (QEMU's 5446 values: 4 MB); SR17 the bus (PCI); SR1F the memory clock
//   GR9, GRA  the bank offsets of the A000 window — one, or two of 32 KiB each when GRB bit 0 is set,
//             in 4 KiB units, or 16 KiB when GRB bit 5 is set
//   CR1A/1B/1D  the high bits of the display start and of the offset, interlace
//   CR27      the part ID: B8h for the 5446
//   3C6h      the hidden DAC register, reached after four reads of 3C6h: the 15/16-bit pixel formats
//
// The video memory is the VBE framebuffer's (machine.vbeFbBase), so the renderer draws an extended
// mode as it draws a VBE one: this file keeps machine.vbe in step with the registers. The register
// semantics follow QEMU's hw/display/cirrus_vga.c, the chip's behaviour measured with the real
// CL-GD5436/46 BIOS 1.25 (boot/roms/5446bv.vbi) under QEMU: tools/cirprobe.asm.

export const CIRRUS_5446 = 0xb8;

export function installCirrus(machine) {
  const vga = machine.vga, mem = machine.mem;
  const sr = new Uint8Array(0x20), gr = new Uint8Array(0x40), cr = new Uint8Array(0x40);
  const fbBytes = machine.vbeFbBytes || (4 << 20);
  // As the card's BIOS leaves them (tools/cirprobe.asm, the real BIOS 1.25 under QEMU): the
  // extensions unlocked — the chip resets locked (0Fh), its BIOS opens them — and SR17 at 21h.
  sr[0x06] = 0x12;
  sr[0x0f] = 0x98;                                  // QEMU's cirrus_reset for the 5446
  sr[0x15] = fbBytes >= (4 << 20) ? 0x04 : 0x03;    // memory size: 3 = 2 MB, 4 = 4 MB
  sr[0x17] = 0x21;                                  // bus: PCI
  sr[0x1f] = 0x2d;                                  // memory clock
  cr[0x27] = CIRRUS_5446;
  let srIndex = 0, grIndex = 0, crIndex = 0, hidden = 0, dacReads = 0, cursorX = 0, cursorY = 0;

  // The ports the VGA already answers: the standard indexes still go to it.
  const pr = machine.portRead, pw = machine.portWrite;
  const vgaR = (p) => pr[p], vgaW = (p) => pw[p];
  const seqR = vgaR(0x3c5), seqW = vgaW(0x3c5), gcR = vgaR(0x3cf), gcW = vgaW(0x3cf), crR = vgaR(0x3d5), crW = vgaW(0x3d5);
  const seqIW = vgaW(0x3c4), gcIW = vgaW(0x3ce), crIW = vgaW(0x3d4), dacR = vgaR(0x3c6), dacW = vgaW(0x3c6);

  const extended = () => (sr[0x07] & 1) !== 0;
  const bppOf = () => {
    switch (sr[0x07] & 0x0e) {
      case 0x00: return 8;
      case 0x02: case 0x06: return (hidden & 0x0f) === 1 ? 16 : 15;   // the hidden DAC: 0 Sierra 5:5:5, 1 XGA 5:6:5
      case 0x04: return 24;
      case 0x08: return 32;
      default: return 8;
    }
  };

  // The banks: where the A000 window's two halves (or its one 64 KiB) read and write in video memory.
  const bankOffset = (i) => {
    const o = gr[0x09 + i];
    return (gr[0x0b] & 0x20) ? o << 14 : o << 12;            // 16 KiB units reach all 4 MB (QEMU: no mask)
  };
  const updateBanks = () => {
    const v = machine.vbe;
    if (!v || !v.cirrus) return;
    const base = v.fbBase;
    v.windowSrc = (base + bankOffset(0)) >>> 0;
    v.windowSrc2 = (gr[0x0b] & 1) ? ((base + bankOffset(1)) >>> 0) : undefined;
  };

  // machine.vbe from the registers: geometry from the CRTC, as the chip scans it out.
  const update = () => {
    const was = machine.vbe;
    if (!extended()) {
      if (was && was.cirrus) { machine.vbe = null; mem.setPlanar(vga.planar || vga.modeX); }
      return;
    }
    const c = vga.crtc, ov = c[0x07];
    const width = (c[0x01] + 1) * 8;
    let height = (c[0x12] | ((ov & 0x02) << 7) | ((ov & 0x40) << 3)) + 1;
    if (cr[0x1a] & 0x01) height *= 2;                // interlaced
    const offset = c[0x13] | ((cr[0x1b] & 0x10) << 4);
    const start = (((c[0x0c] << 8) | c[0x0d]) | ((cr[0x1b] & 0x01) << 16) | ((cr[0x1b] & 0x0c) << 15) | ((cr[0x1d] & 0x80) << 12)) * 4;
    const bpp = bppOf(), pitch = Math.max(offset * 8, 8), fb = machine.vbeFbBase >>> 0;
    // The A000 window is banked as soon as SR7 bit 0 is set, whatever the CRTC holds (a standard
    // mode's timings, or registers half-way through a mode set): the picture is cut to what fits.
    const w = Math.max(8, Math.min(width, Math.floor(pitch / ((bpp + 7) >> 3)))), h = Math.max(1, Math.min(height, Math.floor(fbBytes / pitch)));
    machine.vbe = { number: 0, width: w, height: h, bpp, pitch, linear: true, base: (fb + (start % fbBytes)) >>> 0, fbBase: fb, bank: 0, cirrus: true };
    updateBanks();
    mem.setPlanar(true);                            // the A000 window through vga.js, banked
  };

  // A 16-bit `out dx,ax` to an index port carries the data too: an extended index's data must not
  // reach the VGA, which keeps only the index's low bits (GR10h would land on GR0, CR27h on CR7).
  machine.onPortWrite(0x3c4, (p, s, v) => { srIndex = v & 0xff; seqIW(p, srIndex < 0x05 ? s : 1, s === 2 && srIndex < 0x05 ? v : v & 0xff); if (s === 2) seqData((v >> 8) & 0xff); });
  machine.onPortRead(0x3c4, () => srIndex);
  const seqData = (v) => {
    const i = srIndex & 0x1f;
    if (srIndex < 0x05) return;                     // the VGA's, already written through seqIW / below
    if (i === 0x06) { sr[6] = (v & 0x17) === 0x12 ? 0x12 : 0x0f; return; }
    // The cursor's position: SR10 (x) and SR11 (y) in units of 8 pixels, the low three bits in the
    // index's top three — 10h, 30h ... F0h all reach SR10.
    if (i === 0x10) { sr[i] = v; cursorX = (v << 3) | (srIndex >> 5); return; }
    if (i === 0x11) { sr[i] = v; cursorY = (v << 3) | (srIndex >> 5); return; }
    sr[i] = v;
    if (i === 0x07) update();
  };
  machine.onPortWrite(0x3c5, (p, s, v) => { if (srIndex < 0x05) seqW(p, s, v); seqData(v & 0xff); });
  machine.onPortRead(0x3c5, (p, s) => (srIndex < 0x05 ? seqR(p, s) : sr[srIndex & 0x1f]));

  machine.onPortWrite(0x3ce, (p, s, v) => { grIndex = v & 0xff; gcIW(p, grIndex < 0x09 ? s : 1, grIndex < 0x09 ? v : v & 0xff); if (s === 2) grData((v >> 8) & 0xff); });
  machine.onPortRead(0x3ce, () => grIndex);
  const grData = (v) => {
    if (grIndex < 0x09) return;
    if (grIndex >= 0x40) return;
    gr[grIndex] = v;
    if (grIndex >= 0x09 && grIndex <= 0x0b) updateBanks();
  };
  machine.onPortWrite(0x3cf, (p, s, v) => { if (grIndex < 0x09) gcW(p, s, v); else grData(v & 0xff); });
  machine.onPortRead(0x3cf, (p, s) => (grIndex < 0x09 ? gcR(p, s) : grIndex < 0x40 ? gr[grIndex] : 0xff));

  const DISPLAY = new Set([0x01, 0x07, 0x0c, 0x0d, 0x12, 0x13]);
  machine.onPortWrite(0x3d4, (p, s, v) => { crIndex = v & 0xff; crIW(p, crIndex < 0x19 ? s : 1, crIndex < 0x19 ? v : v & 0xff); if (s === 2) crData((v >> 8) & 0xff); });
  machine.onPortRead(0x3d4, () => crIndex);
  const crData = (v) => {
    if (crIndex < 0x19) { if (DISPLAY.has(crIndex) && extended()) update(); return; }
    if (crIndex >= 0x40 || crIndex === 0x27 || crIndex === 0x24) return;   // read-only
    cr[crIndex] = v;
    if ((crIndex === 0x1a || crIndex === 0x1b || crIndex === 0x1d) && extended()) update();
  };
  machine.onPortWrite(0x3d5, (p, s, v) => { if (crIndex < 0x19) crW(p, s, v); crData(v & 0xff); });
  machine.onPortRead(0x3d5, (p, s) => {
    if (crIndex < 0x19) return crR(p, s);
    if (crIndex === 0x24) return vga.atcFlip << 7;  // the attribute controller's flip-flop
    return crIndex < 0x40 ? cr[crIndex] : 0xff;
  });

  // The hidden DAC register: four reads of the pixel mask, then 3C6h is it (QEMU, and the databook).
  machine.onPortRead(0x3c6, (p, s) => {
    if (dacReads === 4) { dacReads = 0; return hidden; }
    dacReads++;
    return dacR ? dacR(p, s) : 0xff;
  });
  machine.onPortWrite(0x3c6, (p, s, v) => {
    if (dacReads === 4) { hidden = v & 0xff; dacReads = 0; if (extended()) update(); return; }
    dacReads = 0;
    if (dacW) dacW(p, s, v);
  });
  // SR12 bit 1 turns the DAC's ports to a hidden palette of 16 entries, of which the hardware cursor
  // uses 0 (its colour 0) and 0Fh (colour 1): XFree86 loads them that way, and they must not land on
  // palette entries 0 and 15.
  const cursorPal = new Uint8Array(48);
  let curW = 0, curR = 0;
  const curSlot = (i) => (i & 0x0f) * 3;
  for (const port of [0x3c7, 0x3c8, 0x3c9]) {
    const r = pr[port], w = pw[port];
    machine.onPortRead(port, (p, s) => {
      dacReads = 0;
      if (port === 0x3c9 && (sr[0x12] & 2)) { const v = cursorPal[curSlot(curR >> 2) + (curR & 3)]; curR = (curR & ~3) | (((curR & 3) + 1) % 3); return v; }
      return r ? r(p, s) : 0xff;
    });
    machine.onPortWrite(port, (p, s, v) => {
      dacReads = 0;
      if (sr[0x12] & 2) {
        if (port === 0x3c8) { curW = (v & 0xff) << 2; return; }
        if (port === 0x3c7) { curR = (v & 0xff) << 2; return; }
        if (port === 0x3c9) { cursorPal[curSlot(curW >> 2) + (curW & 3)] = v & 0x3f; curW = (curW & ~3) | (((curW & 3) + 1) % 3); return; }
      }
      if (w) w(p, s, v);
    });
  }

  // The hardware cursor, drawn over the picture as the chip overlays it on the way to the DAC: SR12
  // bit 0 shows it, bit 2 makes it 64x64 (else 32x32). Its two bit planes are in the last 16 KiB of
  // video memory at SR13's slot — 32x32: plane 0 then plane 1, 128 bytes each; 64x64: each row's 8
  // bytes of plane 0 then 8 of plane 1. Per pixel, planes (1,0): 00 transparent, 01 inverted, 10
  // colour 0, 11 colour 1 (QEMU's cirrus_cursor_draw_line).
  const drawCursor = (u32, W, H) => {
    if (!(sr[0x12] & 1)) return;
    const large = (sr[0x12] & 4) !== 0, size = large ? 64 : 32, u8 = mem.u8;
    const src = ((machine.vbeFbBase >>> 0) + fbBytes - 0x4000 + (large ? (sr[0x13] & 0x3c) : (sr[0x13] & 0x3f)) * 256) >>> 0;
    const rgb = (i) => { const c = (k) => ((cursorPal[i * 3 + k] & 0x3f) * 255 / 63) | 0; return (0xff << 24) | (c(2) << 16) | (c(1) << 8) | c(0); };
    const c0 = rgb(0), c1 = rgb(15);
    for (let y = 0; y < size; y++) {
      const sy = cursorY + y; if (sy >= H) break;
      const row = large ? src + y * 16 : src + y * 4, poff = large ? 8 : 128;
      for (let x = 0; x < size; x++) {
        const sx = cursorX + x; if (sx >= W) break;
        const sh = 7 - (x & 7), b0 = (u8[row + (x >> 3)] >> sh) & 1, b1 = (u8[row + poff + (x >> 3)] >> sh) & 1;
        const k = b0 | (b1 << 1), o = sy * W + sx;
        if (k === 1) u32[o] ^= 0x00ffffff; else if (k === 2) u32[o] = c0; else if (k === 3) u32[o] = c1;
      }
    }
  };

  machine.cirrus = { sr, gr, cr, update, drawCursor, get hidden() { return hidden; }, get cursor() { return { x: cursorX, y: cursorY }; } };
  return machine.cirrus;
}
