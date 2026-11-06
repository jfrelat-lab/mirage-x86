// vga.js — EGA/VGA 16-colour PLANAR video. In modes 0Dh/0Eh/0Fh/10h/11h/12h the A000
// window is four bit-planes reached through the Sequencer (map mask) and Graphics
// Controller (set/reset, ALU function, bit mask, latches, write modes 0-3) — a single
// CPU byte write fans out to several planes, so it cannot be stored as one flat byte.
// This device holds the planes and implements the write/read pipeline plus a plane→pixel
// renderer. Mode 13h stays linear (handled directly in memory/video); text is unchanged.

const PLANE = 0x10000;                              // 64 KiB per plane
const DIMS = { 0x0d: [320, 200], 0x0e: [640, 200], 0x0f: [640, 350], 0x10: [640, 350], 0x11: [640, 480], 0x12: [640, 480], 0x6a: [800, 600] };

export function installVGA(machine) {
  const mem = machine.mem;
  const planes = new Uint8Array(4 * PLANE);
  const latches = new Uint8Array(4);

  const vga = {
    planes, latches, mode: 0x03, planar: false, modeX: false, width: 320, height: 200,
    seqIndex: 0, mapMask: 0x0f, memMode: 0x0e,       // Sequencer: reg 2 = plane write-enable, reg 4 = memory mode (bit3 = chain-4)
    gcIndex: 0, gc: new Uint8Array(9),               // Graphics Controller regs 0..8
    atcIndex: 0, atcFlip: 0, palette: new Uint8Array(16),  // Attribute Controller palette
    atc: Uint8Array.from([0x0c, 0, 0x0f, 0x08, 0]),  // AC 10h-14h: mode control (bit 3 = blink), overscan, plane enable, panning, colour select
    crtcIndex: 0, crtc: new Uint8Array(0x19),        // CRTC: r13 offset (logical width), r0C/r0D start address
  };
  for (let i = 0; i < 16; i++) vga.palette[i] = i;   // identity → DAC 0-15 (the EGA colours)
  vga.gc[8] = 0xff;                                  // bit mask defaults to all bits

  // Route A000 through the plane pipeline (memory.js checks mem.planar) whenever EITHER an EGA
  // 16-colour planar mode OR Mode-X (mode 13h with chain-4 off) is active.
  const syncRouting = () => { mem.setPlanar(vga.planar || vga.modeX); };

  // HARDWARE-DERIVED ROUTING, for a machine whose INT 10h is a real VGA BIOS ROM (src/vgarom.js).
  // Our own INT 10h tells this device which mode it set (setMode); a ROM only writes registers, so
  // the routing must come from them, as it does on the card: the A000 window is the four planes when
  // the Graphics Controller is in graphics mode (GC6 bit 0), the Sequencer is not chaining four
  // planes into one (SEQ4 bit 3), the CGA shift/interleave is off (GC5 bit 5) and memory is mapped
  // at A000 (GC6 bits 2-3 = 0 or 1). Mode 13h (chained) and the CGA modes stay plain RAM.
  vga.hw = false;
  const hwRoute = () => {
    if (!vga.hw) return;
    const gfx = (vga.gc[6] & 1) !== 0, map = (vga.gc[6] >> 2) & 3;
    const route = gfx && !(vga.memMode & 0x08) && !(vga.gc[5] & 0x20) && map <= 1;
    vga.modeX = false;
    if (route !== vga.planar) { vga.planar = route; syncRouting(); }
  };
  vga.hwRoute = hwRoute;

  // The register state a real VGA BIOS leaves behind after a mode set, captured by running an actual
  // SeaVGABIOS ROM inside MIRAGE (tools/vga-rom.mjs) — observed, not derived, in the same spirit as
  // the Unicorn and DOS-kernel references. We used to zero the CRTC and set only the offset, which is
  // enough for OUR renderer but wrong for any program that READS the CRTC back to work out the
  // geometry — a Mode-X setup routine does exactly that, and saw zeros.
  const BIOS_CRTC = {
    0x03: [0x5f, 0x4f, 0x50, 0x82, 0x55, 0x81, 0xbf, 0x1f, 0x00, 0x4f, 0x0d, 0x0e, 0x00, 0x00, 0x00, 0x00, 0x9c, 0x8e, 0x8f, 0x28, 0x1f, 0x96, 0xb9, 0xa3, 0xff],
    0x0d: [0x2d, 0x27, 0x28, 0x90, 0x2b, 0x80, 0xbf, 0x1f, 0x00, 0xc0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x9c, 0x8e, 0x8f, 0x14, 0x00, 0x96, 0xb9, 0xe3, 0xff],
    0x0e: [0x5f, 0x4f, 0x50, 0x82, 0x54, 0x80, 0xbf, 0x1f, 0x00, 0xc0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x9c, 0x8e, 0x8f, 0x28, 0x00, 0x96, 0xb9, 0xe3, 0xff],
    0x10: [0x5f, 0x4f, 0x50, 0x82, 0x54, 0x80, 0xbf, 0x1f, 0x00, 0x40, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x83, 0x85, 0x5d, 0x28, 0x0f, 0x63, 0xba, 0xe3, 0xff],
    0x12: [0x5f, 0x4f, 0x50, 0x82, 0x54, 0x80, 0x0b, 0x3e, 0x00, 0x40, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xea, 0x8c, 0xdf, 0x28, 0x00, 0xe7, 0x04, 0xe3, 0xff],
    0x13: [0x5f, 0x4f, 0x50, 0x82, 0x54, 0x80, 0xbf, 0x1f, 0x00, 0x41, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x9c, 0x8e, 0x8f, 0x28, 0x40, 0x96, 0xb9, 0xa3, 0xff],
  };
  const BIOS_GC = {
    0x03: [0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x0e, 0x0f, 0xff],
    0x13: [0x00, 0x00, 0x00, 0x00, 0x00, 0x40, 0x05, 0x0f, 0xff],
    gfx:  [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x05, 0x0f, 0xff],   // every planar graphics mode
  };

  vga.setMode = (mode, planar) => {
    vga.mode = mode; vga.planar = planar; vga.modeX = false; vga.memMode = 0x0e;   // a fresh mode set starts chained
    if (planar) { const d = DIMS[mode] || [320, 200]; vga.width = d[0]; vga.height = d[1]; }
    else if (mode === 0x13) { vga.width = 320; vga.height = 200; }
    vga.crtc.fill(0);                                  // a mode set reloads the CRTC — otherwise the
    // Offset = words per scanline. Planar: width/8 bytes per plane, /2 for the word unit. Chained
    // 13h: the renderer derives stride = offset*8, so the standard value is width/8 (=40 for 320).
    vga.crtc[0x13] = planar ? ((vga.width >> 3) >> 1) : (vga.width >> 3);
    vga.mapMask = 0x0f; vga.gc.fill(0); vga.gc[8] = 0xff; vga.seqIndex = 0; vga.gcIndex = 0;
    // Overlay the BIOS tables where we have them. They agree with the offset and bit-mask values
    // computed just above — which is a useful check on both — and fill in everything else.
    const ct = BIOS_CRTC[mode];
    if (ct) for (let i = 0; i < ct.length && i < vga.crtc.length; i++) vga.crtc[i] = ct[i];
    const gt = BIOS_GC[mode] || (planar ? BIOS_GC.gfx : null);
    if (gt) for (let i = 0; i < gt.length && i < vga.gc.length; i++) vga.gc[i] = gt[i];
    vga.atcFlip = 0; for (let i = 0; i < 16; i++) vga.palette[i] = i;
    recomputeBeam();
    syncRouting();
  };
  // ---- vertical beam timing, DERIVED FROM THE CRTC ------------------------------------------
  // Port 0x3DA's blank and retrace bits used to come from two constants in bios.js (blank at 0.88 of
  // a frame, retrace from 0.92 to the END of the frame). Against these registers — which
  // tools/vga-rom.mjs verified against a real VGA BIOS ROM — that made the retrace pulse EIGHT
  // percent of a frame where the hardware's is 0.45%, roughly eighteen times too long, and it did
  // not track the mode at all: 640x350 blanks at 78% of a frame, not 88%. DOSBox derives the same
  // three numbers from the same registers (vga_misc.cpp), which is what makes a tweaked or Mode-X
  // CRTC behave.
  //   Vertical Total         CRTC 06 + overflow bit0 (<<8) + bit5 (<<9), plus the two-line convention
  //   Vertical Display End   CRTC 12 + overflow bit1 (<<8) + bit6 (<<9)
  //   Vertical Retrace Start CRTC 10 + overflow bit2 (<<8) + bit7 (<<9)
  //   Vertical Retrace End   the next line whose LOW FOUR BITS match CRTC 11 & 0x0F
  // `beamStamp` lets the 0x3DA reader cache its cycle thresholds: that path runs 24 M times in one
  // starport run, so it cannot afford to recompute this per read.
  // `lines` and `hDisp` give the HORIZONTAL blank too: within each of the frame's lines, the part past
  // Horizontal Display End (CRTC 01h + 1 of CRTC 00h + 5 character clocks) has bit 0 of 3DAh set.
  vga.beam = { blank: 400 / 449, rStart: 412 / 449, rEnd: 414 / 449, lines: 449, hDisp: 80 / 100 };
  vga.beamStamp = 0;
  // `MIRAGE_BEAM=legacy` restores the two constants this replaced (blank 0.88, retrace 0.92 to the
  // end of the frame), which made the retrace pulse 8% of a frame against the hardware's 0.45% and
  // did not track the mode at all. It was held back for a while because turning it on drove
  // intros/freality.com into its own divide by zero — and that turned out to be a SPEED artifact,
  // not a duty-cycle one: with the machine calibrated to the reference (docs/notes/timing.md §6) freality runs
  // its whole show under this beam and exits normally.
  const LEGACY_BEAM = typeof process !== 'undefined' && process.env && process.env.MIRAGE_BEAM === 'legacy';
  const recomputeBeam = () => {
    if (LEGACY_BEAM) { vga.beam.blank = 0.88; vga.beam.rStart = 0.92; vga.beam.rEnd = 1; vga.beamStamp++; return; }
    const c = vga.crtc, ov = c[0x07];
    const VT = (c[0x06] | ((ov & 1) << 8) | (((ov >> 5) & 1) << 9)) + 2;
    if (VT < 16) return;                       // CRTC not programmed yet — keep the last good values
    const VDE = (c[0x12] | (((ov >> 1) & 1) << 8) | (((ov >> 6) & 1) << 9)) + 1;
    const VRS = c[0x10] | (((ov >> 2) & 1) << 8) | (((ov >> 7) & 1) << 9);
    let VRE = VRS + 1; const want = c[0x11] & 0x0f;
    for (let k = 1; k <= 16; k++) if (((VRS + k) & 0x0f) === want) { VRE = VRS + k; break; }
    if (VRS >= VT || VDE > VT) return;          // half-programmed registers: do not publish nonsense
    vga.beam.blank = VDE / VT; vga.beam.rStart = VRS / VT; vga.beam.rEnd = Math.min(VRE / VT, 1);
    vga.beam.lines = VT;
    if (c[0x00] && c[0x01] < c[0x00]) vga.beam.hDisp = (c[0x01] + 1) / (c[0x00] + 5);
    vga.beamStamp++;
  };
  vga.recomputeBeam = recomputeBeam;
  // POWER-ON: the card holds the mode-3 CRTC a VGA BIOS's POST leaves (SeaVGABIOS sets mode 3), not
  // zeros. Our POST writes mode 3 into the BDA but never loaded the card, so a guest that takes the
  // console without a mode set (386BSD's pccons writes only the cursor) found a CRTC with no
  // geometry. The cursor registers (0Ah/0Bh, 0Eh/0Fh) stay the BIOS cursor code's.
  BIOS_CRTC[0x03].forEach((v, i) => { if (i < 0x0a || i > 0x0f) vga.crtc[i] = v; });
  recomputeBeam();

  vga.clear = () => planes.fill(0);

  const rotr = (v, c) => c ? (((v >>> c) | (v << (8 - c))) & 0xff) : (v & 0xff);
  const alu = (fn, v, l) => fn === 1 ? (v & l) : fn === 2 ? (v | l) : fn === 3 ? (v ^ l) : v;

  // The EGA/VGA write pipeline. `off` is the offset within the A000 window (0..0xFFFF).
  // A VESA VBE mode borrows the A000 window: it is a 64 KiB view of the linear framebuffer, moved by
  // VBE function 4F05. Routing it through this device (mem.setPlanar) is what makes the window a
  // window at all — otherwise A000 stays ordinary RAM and a real-mode program's pixels never reach
  // the framebuffer the renderer reads.
  // A Cirrus in dual-bank mode (src/cirrus.js) gives the window's upper 32 KiB a bank of its own.
  const vbeWin = (off) => { const v = machine.vbe; if (!v) return -1; return v.windowSrc2 !== undefined && (off & 0x8000) ? v.windowSrc2 - 0x8000 : v.windowSrc; };

  vga.writeByte = (off, val) => {
    { const w = vbeWin(off); if (w >= 0) { mem.u8[(w + (off & 0xffff)) >>> 0] = val & 0xff; return; } }
    off &= 0xffff;
    // Under MIRAGE_MEM_READ=shadow nothing loads the latches any more (reads bypass this file
    // entirely), so load them from the write address — exact for read-then-write-same-address,
    // which is the EGA blitting idiom. See the shadow notes below.
    if (mem.shadowReads) {
      latches[0] = planes[off]; latches[1] = planes[PLANE + off];
      latches[2] = planes[2 * PLANE + off]; latches[3] = planes[3 * PLANE + off];
    }
    const gc = vga.gc, wm = gc[5] & 3, mask = vga.mapMask, bm = gc[8];
    const rot = gc[3] & 7, fn = (gc[3] >> 3) & 3, esr = gc[1], sr = gc[0];
    for (let p = 0; p < 4; p++) {
      if (!(mask & (1 << p))) continue;
      const l = latches[p]; let v;
      if (wm === 0) {                                                 // write mode 0
        v = (esr & (1 << p)) ? ((sr & (1 << p)) ? 0xff : 0) : rotr(val, rot);
        v = alu(fn, v, l); v = (v & bm) | (l & ~bm);
      } else if (wm === 1) {                                          // write mode 1: latch copy
        v = l;
      } else if (wm === 2) {                                          // write mode 2: colour from val bits
        v = (val & (1 << p)) ? 0xff : 0;
        v = alu(fn, v, l); v = (v & bm) | (l & ~bm);
      } else {                                                        // write mode 3: val is the bit mask
        const m2 = rotr(val, rot) & bm;
        v = (sr & (1 << p)) ? 0xff : 0;
        v = (v & m2) | (l & ~m2);
      }
      planes[p * PLANE + off] = v & 0xff;
    }
    if (mem.shadowReads) vga.syncShadow(off);
  };

  // What a CPU read of `off` returns, WITHOUT the latch side effect. Split out of readByte so the
  // shadow below can be computed without disturbing latch state.
  const readValue = (off) => {
    if (!(vga.gc[5] & 0x08)) return planes[(vga.gc[4] & 3) * PLANE + off];  // read mode 0: selected plane
    const cmp = vga.gc[2] & 0x0f, care = vga.gc[7] & 0x0f;                  // read mode 1: colour compare
    let r = 0;
    for (let p = 0; p < 4; p++) {
      if (!(care & (1 << p))) continue;                          // "don't care" planes never disagree
      r |= (cmp & (1 << p)) ? ~planes[p * PLANE + off] : planes[p * PLANE + off];
    }
    return (~r) & 0xff;
  };

  // ---- linear read shadow (MIRAGE_MEM_READ=shadow) --------------------------------------------
  // The measured prize is emitting `u8[a]` with no test at all — 2.5-4x in synthetic tests, and 5
  // characters of source instead of 57. That only works if the flat array already holds what a
  // planar read would return, so vga.js maintains exactly that in the A000 window.
  //
  // Maintenance is incremental — one byte after each planar write — with a full rebuild only when
  // the read plane (GC 4) or read mode (GC 5) changes. Measurement says that is 0-1 times per run:
  // tools/vga-plane-switches.mjs found ZERO writes to GC index 4 across Keen 1, Cosmo, Duke Nukem 1
  // and Wolf3D. EGA games write video memory and essentially never read it back.
  //
  // ⚠️ The semantic hole, stated plainly rather than discovered later: a real read also LOADS THE
  // FOUR LATCHES, and an unconditional array read cannot. Latches are only ever consumed by writes,
  // so they are loaded at WRITE time from the address being written instead. That is exact for the
  // dominant EGA idiom (`mov al,[es:di]` then `mov [es:di],bl` — same address) and WRONG for
  // read-A-then-write-B. No emulator does this, so no prior art de-risks it; golden and the EGA
  // titles are the only evidence, which is why it is a flag and not the default.
  const VGA_WINDOW = 0xa0000;
  vga.syncShadow = (off) => { mem.u8[VGA_WINDOW + off] = readValue(off); };
  vga.rebuildShadow = () => {
    if (!mem.shadowReads || !mem.planar) return;
    for (let off = 0; off < 0x10000; off++) mem.u8[VGA_WINDOW + off] = readValue(off);
  };

  // A CPU read loads all four latches (that is what makes read-modify-write blitting work)
  // and returns the plane chosen by the read-map-select register (read mode 0).
  vga.readByte = (off) => {
    { const w = vbeWin(off); if (w >= 0) return mem.u8[(w + (off & 0xffff)) >>> 0]; }
    off &= 0xffff;
    latches[0] = planes[off]; latches[1] = planes[PLANE + off];
    latches[2] = planes[2 * PLANE + off]; latches[3] = planes[3 * PLANE + off];
    return readValue(off);
  };

  // ---- register ports (also accept the AL=index/AH=data 16-bit `out dx,ax` form) ----
  const seqData = (v) => {
    if (vga.seqIndex === 2) vga.mapMask = v & 0x0f;
    else if (vga.seqIndex === 4) {                    // memory mode: bit3 = chain-4. Clearing it in mode 13h = Mode-X (unchained)
      vga.memMode = v & 0xff;
      if (vga.hw) { hwRoute(); return; }
      const mx = vga.mode === 0x13 && !(v & 0x08);
      if (mx !== vga.modeX) { vga.modeX = mx; mem.setPlanar(vga.planar || vga.modeX); }
    }
  };
  machine.onPortWrite(0x3c4, (_p, s, v) => { vga.seqIndex = v & 0x1f; if (s === 2) seqData((v >> 8) & 0xff); });
  machine.onPortWrite(0x3c5, (_p, _s, v) => seqData(v & 0xff));
  machine.onPortRead(0x3c4, () => vga.seqIndex);   // the index registers read back on a VGA
  machine.onPortRead(0x3c5, () => (vga.seqIndex === 2 ? vga.mapMask : vga.seqIndex === 4 ? vga.memMode : 0));

  const gcData = (v) => {
    const i = vga.gcIndex & 0x0f, old = vga.gc[i];
    vga.gc[i] = v & 0xff;
    // GC 4 (read map select) and GC 5 (read mode) change what every byte of the window reads back:
    // the only event that forces a full shadow rebuild. Measured at 0-1 times per run.
    if ((i === 4 || i === 5 || i === 2 || i === 7) && vga.gc[i] !== old) vga.rebuildShadow();
    if ((i === 5 || i === 6) && vga.hw) hwRoute();
  };
  machine.onPortWrite(0x3ce, (_p, s, v) => { vga.gcIndex = v & 0x0f; if (s === 2) gcData((v >> 8) & 0xff); });
  machine.onPortWrite(0x3cf, (_p, _s, v) => gcData(v & 0xff));
  machine.onPortRead(0x3ce, () => vga.gcIndex);
  machine.onPortRead(0x3cf, () => vga.gc[vga.gcIndex & 0x0f]);

  // Attribute Controller: 0x3C0 alternates index then data; the flip-flop is reset to
  // "index" by a read of Input Status #1 (0x3DA) — bios.js does that reset.
  machine.onPortWrite(0x3c0, (_p, _s, v) => {
    if (vga.atcFlip === 0) { vga.atcIndex = v & 0x1f; vga.atcPas = v & 0x20; vga.atcFlip = 1; }
    else {
      if (vga.atcIndex < 16) vga.palette[vga.atcIndex] = v & 0x3f;
      else if (vga.atcIndex < 0x15) vga.atc[vga.atcIndex - 0x10] = v & 0xff;
      vga.atcFlip = 0;
    }
  });
  // The Attribute Controller READS BACK: 3C0h gives the address register — index and PAS (bit 5,
  // "palette address source") — and 3C1h the register it selects. Both read FFh here, an empty bus.
  // Windows 95's VDD saves the address register (`in al,3C0h`) and writes it back with PAS set before
  // it loads the palette; with FFh it took another path and never wrote the DAC, so every colour of
  // the desktop came from the VGA default palette (red title bars, an olive background).
  machine.onPortRead(0x3c0, () => (vga.atcIndex & 0x1f) | (vga.atcPas || 0));
  machine.onPortRead(0x3c1, () => (vga.atcIndex < 16 ? vga.palette[vga.atcIndex] : vga.atcIndex < 0x15 ? vga.atc[vga.atcIndex - 0x10] : 0));

  // CRTC (0x3D4 index / 0x3D5 data): the renderer needs r0C/r0D (display start address,
  // for page-flip / hardware scroll) and r13 (offset = logical scanline width in words).
  const crtcData = (v) => { vga.crtc[vga.crtcIndex & 0x1f] = v & 0xff; recomputeBeam(); };
  machine.onPortWrite(0x3d4, (_p, s, v) => { vga.crtcIndex = v & 0x1f; if (s === 2) crtcData((v >> 8) & 0xff); });
  machine.onPortWrite(0x3d5, (_p, _s, v) => crtcData(v & 0xff));
  machine.onPortRead(0x3d5, () => vga.crtc[vga.crtcIndex & 0x1f]);
  // Display geometry for the renderer (fall back to the mode's defaults before the game programs the CRTC).
  vga.startAddr = () => (vga.crtc[0x0c] << 8) | vga.crtc[0x0d];
  // The displayed size as the CRTC defines it — for a machine whose mode sets come from a real ROM
  // (vga.hw), which never calls setMode. Width: Horizontal Display End + 1 character clocks of 8
  // dots (the 320-wide modes halve the dot clock and program 40). Height: Vertical Display End + 1
  // scanlines with its two overflow bits, halved when CRTC 09h bit 7 doubles every line.
  vga.crtcDims = () => {
    const c = vga.crtc, ov = c[0x07];
    const w = (c[0x01] + 1) * 8;
    let h = (c[0x12] | (((ov >> 1) & 1) << 8) | (((ov >> 6) & 1) << 9)) + 1;
    if (c[0x09] & 0x80) h >>= 1;
    return { w, h };
  };
  vga.rowBytes = () => (vga.crtc[0x13] ? vga.crtc[0x13] * 2 : (vga.width >> 3));

  machine.vga = vga; mem.vga = vga;
  return vga;
}
