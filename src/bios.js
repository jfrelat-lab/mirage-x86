// bios.js — ROM-BIOS services: INT 10h (video), INT 16h (keyboard), INT 1Ah
// (timer), INT 11h/12h (equipment/memory). Maintains the BIOS Data Area at
// 0040:0000 and the 80x25 text screen at B800:0000. The text routines are
// exposed so the JS shell prints through the exact same path as guest code.

import { ZF, CF } from './cpu.js';
import { installVGA } from './vga.js';
import { installXMS } from './xms.js';
import { installDPMI } from './dpmi.js';
import { installEMS } from './ems.js';
import { installDisk } from './disk.js';
import { installPIC } from './pic.js';

const VRAM = 0xb8000;          // text video memory
const BDA = 0x400;             // BIOS Data Area
const COLS = 80, ROWS = 25;

/**
 * @param opts.ems  false to boot without expanded memory, as not loading EMM386.
 * @param opts.xms  false to boot WITHOUT an XMS driver. Not a debugging switch: some titles refuse
 *   to start when one is present — Zone 66's extender wants raw extended memory and says so
 *   ("This program can not run with an XMS driver!!!"), which on real hardware meant not loading
 *   HIMEM.SYS. DPMI still installs, since it manages its own memory.
 */
export function installBIOS(machine, opts = {}) {
  const mem = machine.mem, cpu = machine.cpu;

  // Storage inside the BIOS segment for the two things a VbeInfoBlock points at. Well clear of the
  // per-vector stub table and of the DPMI/EMS entries above.
  const VBE_SEG = 0xf000, VBE_OEM_OFF = 0x0700, VBE_MODES_OFF = 0x0740;
  // The VBE framebuffer is real RAM at the top of the machine's memory, reserved the same way the
  // DPMI host reserves its descriptor tables — a client is told this address as PhysBasePtr, maps it
  // with INT 31h 0800h and writes straight into it, so it has to be memory that exists and that no
  // allocator will hand out. 2 MiB covers the largest advertised mode (640x480x32 = 1.2 MiB).
  const VBE_FB_BYTES = 2 * 1024 * 1024;
  const VBE_FB_LIN = (mem.size - VBE_FB_BYTES) >>> 0;
  machine.vbeFbBase = VBE_FB_LIN;
  for (let i = 0; i < 0x60; i++) mem.w8(((VBE_SEG << 4) + VBE_OEM_OFF + i) >>> 0, 0);
  const oem = 'MIRAGE VGA';
  for (let i = 0; i < oem.length; i++) mem.w8(((VBE_SEG << 4) + VBE_OEM_OFF + i) >>> 0, oem.charCodeAt(i));
  // The advertised VBE mode list. 0x101-0x112 are the standard VBE numbers; 0x140+ are OEM numbers,
  // which VBE explicitly allows and which is the only way to offer 320x240 — the standard set has no
  // such mode, yet it is exactly what Void 3 scans for (320x240 at 32 bpp, from its SRC/SHIVA.RM).
  // A client matches on the geometry in the ModeInfoBlock, not on the number, so the number is free.
  const VBE_MODES = [
    [0x101, 640, 480, 8], [0x103, 800, 600, 8], [0x10e, 320, 200, 16], [0x111, 640, 480, 16],
    [0x112, 640, 480, 32], [0x140, 320, 200, 32], [0x141, 320, 240, 32], [0x142, 320, 240, 8],
  ];
  VBE_MODES.forEach(([n], i) => mem.w16(((VBE_SEG << 4) + VBE_MODES_OFF + i * 2) >>> 0, n));
  mem.w16(((VBE_SEG << 4) + VBE_MODES_OFF + VBE_MODES.length * 2) >>> 0, 0xffff);   // terminator

  // The ROM identity a real machine carries at the very top of F000. Ours held zeros there, and a
  // program that SCANS this region for it finds nothing and keeps going: Turbo Pascal's runtime runs
  // its scan to f000:ffff, wraps past the 1 MB boundary and ends up executing the interrupt vector
  // table. Values read out of the reference rather than invented (tools/biosid.asm):
  //   FFF0 far JMP to the power-on entry, FFF5 the 8-byte release date, FFFE the model byte
  //   (FCh = AT class), FFFF the submodel.
  for (const [off, b] of [[0xffff0, 0xea], [0xffff1, 0x5b], [0xffff2, 0xe0], [0xffff3, 0x00], [0xffff4, 0xf0],
                          [0xffffd, 0x00], [0xffffe, 0xfc], [0xfffff, 0x55]]) mem.w8(off, b);
  const romDate = '01/01/92';
  for (let i = 0; i < romDate.length; i++) mem.w8(0xffff5 + i, romDate.charCodeAt(i));

  const bios = {
    machine,
    attr: 0x07,
    dac: new Uint8Array(768),  // 256 * (r,g,b) 6-bit — VGA palette for mode 13h
    onModeChange: null,        // (mode) => void, wired up by the video layer
    mode: 0x03,
    cga: { color: 0x30, mode: 0 },  // CGA color-select (0x3D9) / mode-control (0x3D8) registers
    blink: true,                    // attribute bit 7 = blink (default) vs bright background
    cursor: { start: 14, end: 15, hidden: false },   // scan lines, per INT 10h AH=01 / CRTC 0A-0B
  };

  // default VGA DAC palette (text + standard 16, then a usable 256 ramp)
  defaultPalette(bios.dac);

  // ---- BIOS Data Area defaults ----
  // Equipment word. bit 0 floppy fitted, bit 1 math coprocessor, bit 2 pointing device, bits 4-5 the
  // initial video mode (10b = 80x25 colour), bits 6-7 floppies minus one, bits 9-11 serial ports,
  // bits 14-15 parallel ports. The old comment claimed "has FPU" while bit 1 was CLEAR — we ship an
  // x87 and an INT 33h mouse, so both bits are now set to what is actually true of this machine.
  // ⚠️ Deliberately NOT dosbox-x's 0x4467, measured with tools/dcc.asm: it claims two floppies, two
  // serial ports and one parallel port, and this machine fits none of them — see the INT 14h/17h
  // note below, which depends on the port counts reading zero.
  mem.w16(BDA + 0x10, 0x0027);   // floppy + FPU + mouse, 80x25 colour, no ports
  mem.w16(BDA + 0x13, 640);      // conventional memory KB
  mem.w16(BDA + 0x49, 0x0003);   // current video mode = 3 (low byte) — see helpers below
  mem.w8(BDA + 0x49, 0x03);
  mem.w16(BDA + 0x4a, COLS);     // text columns
  mem.w8(BDA + 0x84, ROWS - 1);  // rows - 1
  mem.w16(BDA + 0x62, 0);        // active page
  // Video-BIOS ROM signature at C000:0 (0x55 0xAA + size/512). Games detect an EGA/VGA card by
  // scanning for this option-ROM signature; without it they print "requires an EGA or VGA Adapter".
  mem.w8(0xc0000, 0x55); mem.w8(0xc0001, 0xaa); mem.w8(0xc0002, 0x40);
  // EGA/VGA video Data Area — a real EGA/VGA BIOS sets these; games read them to detect the adapter.
  mem.w8(BDA + 0x87, 0x60);      // video-mode options: 256 KB, EGA/VGA active (bit3=0)
  mem.w8(BDA + 0x88, 0x09);      // EGA feature-connector / switch settings
  mem.w8(BDA + 0x89, 0x51);      // VGA flags: VGA active, 400-line default, etc.
  mem.w16(BDA + 0x63, 0x03d4);   // CRTC base I/O port (colour); +6 = 0x3DA status reg. Programs read
                                 // this to find the vertical-retrace port (Lemmings hung on port 6
                                 // because it read 0 here, added 6, and polled a dead port).

  // ---- cursor (page 0) at BDA 0x50 (col), 0x51 (row) ----
  const getCol = () => mem.r8(BDA + 0x50), getRow = () => mem.r8(BDA + 0x51);
  const setCur = (col, row) => { mem.w8(BDA + 0x50, col & 0xff); mem.w8(BDA + 0x51, row & 0xff); };
  bios.getCursor = () => ({ col: getCol(), row: getRow() });
  bios.setCursor = (row, col) => setCur(col, row);

  // Scroll a text window [top..bottom]×[left..right] by `lines` rows, up (INT 10h AH=06) or
  // down (AH=07), filling the vacated rows with `attr`. lines=0 (or ≥ window height) clears the
  // whole window. Honouring the window rectangle matters: menu programs (Apogee's CATALOG) scroll
  // an inner region and expect the header/footer rows to stay put.
  function scrollWindow(up, lines, attr, top, left, bottom, right) {
    top = Math.max(0, top); left = Math.max(0, left);
    bottom = Math.min(ROWS - 1, bottom); right = Math.min(COLS - 1, right);
    if (top > bottom || left > right) return;
    const blank = 0x20 | ((attr & 0xff) << 8);
    const height = bottom - top + 1;
    const blankRow = (r) => { for (let c = left; c <= right; c++) mem.w16(VRAM + (r * COLS + c) * 2, blank); };
    const copyRow = (dst, src) => { for (let c = left; c <= right; c++) mem.w16(VRAM + (dst * COLS + c) * 2, mem.r16(VRAM + (src * COLS + c) * 2)); };
    if (lines <= 0 || lines >= height) { for (let r = top; r <= bottom; r++) blankRow(r); return; }
    if (up) {
      for (let r = top; r <= bottom - lines; r++) copyRow(r, r + lines);
      for (let r = bottom - lines + 1; r <= bottom; r++) blankRow(r);
    } else {
      for (let r = bottom; r >= top + lines; r--) copyRow(r, r - lines);
      for (let r = top; r < top + lines; r++) blankRow(r);
    }
  }
  // teletype's line-wrap scroll: the whole screen up one row.
  function scroll(attr) { scrollWindow(true, 1, attr, 0, 0, ROWS - 1, COLS - 1); }

  function clearScreen(attr) {
    const blank = 0x20 | ((attr & 0xff) << 8);
    for (let i = 0; i < ROWS * COLS; i++) mem.w16(VRAM + i * 2, blank);
    setCur(0, 0);
  }
  bios.clearScreen = clearScreen;

  // ---- CGA graphics-mode character output (modes 4/5/6) --------------------
  // In a CGA graphics mode the BIOS draws each character as an 8×8 font glyph straight into the
  // B800 bitmap, not as a text char/attr cell. Games (Alley Cat's "joystick?" prompt) print over
  // graphics via INT 10h teletype and rely on this; without it the text bytes render as garbage.
  // The 8×8 glyph is derived from the 8×16 VGA font (`machine.font`, set by video.js) by taking
  // every other row. B800 banks interleave: even scanlines +0x0000, odd +0x2000, 80 bytes/row.
  // Prefer the real 8×8 CGA font (machine.font8x8, one byte per row, MSB=left); fall back to the
  // 8×16 VGA font downsampled by every other row when only that is loaded.
  function glyph8(ch, gy) {
    const f8 = machine.font8x8; if (f8) return f8[(ch & 0xff) * 8 + gy];
    const f = machine.font; return f ? f[(ch & 0xff) * 16 + (gy << 1)] : 0;
  }
  const gfxRowBase = (y) => VRAM + ((y & 1) ? 0x2000 : 0) + (y >> 1) * 80;
  function drawGlyphCGA(ch, col, row, color) {
    const mono = bios.mode === 6;                 // mode 6 = 640×200 1bpp; modes 4/5 = 320×200 2bpp
    const fg = mono ? 1 : ((color & 3) || 3);     // default to colour 3 so text is visible
    const x0 = col * 8, y0 = row * 8;
    for (let gy = 0; gy < 8; gy++) {
      const y = y0 + gy; if (y >= 200) break;
      const bits = glyph8(ch, gy), base = gfxRowBase(y);
      if (mono) { mem.u8[base + (x0 >> 3)] = bits; }
      else {
        const bo = base + (x0 >> 2);
        for (let half = 0; half < 2; half++) {
          let bval = 0;
          for (let p = 0; p < 4; p++) if (bits & (0x80 >> (half * 4 + p))) bval |= fg << ((3 - p) * 2);
          mem.u8[bo + half] = bval;
        }
      }
    }
  }
  function scrollGfxCGA() {                         // shift the CGA bitmap up one 8-pixel text row
    for (let y = 0; y < 200 - 8; y++) { const d = gfxRowBase(y), s = gfxRowBase(y + 8); for (let b = 0; b < 80; b++) mem.u8[d + b] = mem.u8[s + b]; }
    for (let y = 200 - 8; y < 200; y++) { const d = gfxRowBase(y); for (let b = 0; b < 80; b++) mem.u8[d + b] = 0; }
  }

  // Mode 13h is 320×200 linear at A000, so an 8×8 cell gives 40×25. BIOS character output used to
  // treat only CGA 4/5/6 as graphics: in 13h it wrote character+attribute words into the B800 *text*
  // buffer, which mode 13h does not display — the program printed happily into a screen nobody was
  // showing, with no error. (Planar EGA/VGA 0Dh–12h still take that wrong path; they need the plane
  // pipeline, and no program we run prints through the BIOS in those modes yet.)
  function drawGlyph13(ch, col, row, color) {
    // No font loaded → we cannot draw anything, and painting the cell background would *erase*
    // whatever the program had already put there. Leaving the framebuffer alone is the lesser wrong.
    if (!machine.font8x8 && !machine.font) return;
    const x0 = col * 8, y0 = row * 8, fg = color & 0xff;
    for (let gy = 0; gy < 8; gy++) {
      const y = y0 + gy; if (y >= 200) break;
      const bits = glyph8(ch, gy), base = 0xa0000 + y * 320 + x0;
      for (let gx = 0; gx < 8 && x0 + gx < 320; gx++) mem.w8(base + gx, (bits & (0x80 >> gx)) ? fg : 0);
    }
  }
  function scrollGfx13() {
    const A = 0xa0000;
    mem.u8.copyWithin(A, A + 8 * 320, A + 200 * 320);
    mem.u8.fill(0, A + (200 - 8) * 320, A + 200 * 320);
  }

  function teletype(ch, attr = bios.attr) {
    const cga = bios.mode === 4 || bios.mode === 5 || bios.mode === 6;
    const m13 = bios.mode === 0x13, gfx = cga || m13;
    const cols = m13 ? 40 : cga ? (bios.mode === 6 ? 80 : 40) : COLS;
    let col = getCol(), row = getRow();
    if (ch === 0x0d) col = 0;
    else if (ch === 0x0a) row++;
    else if (ch === 0x08) { if (col > 0) col--; }
    else if (ch === 0x07) { /* bell */ }
    else if (ch === 0x09) { col = (col + 8) & ~7; }
    else {
      if (m13) drawGlyph13(ch, col, row, attr);
      else if (cga) drawGlyphCGA(ch, col, row, attr);
      else mem.w16(VRAM + (row * COLS + col) * 2, (ch & 0xff) | (attr << 8));
      col++;
    }
    if (col >= cols) { col = 0; row++; }
    if (row >= ROWS) { if (m13) scrollGfx13(); else if (cga) scrollGfxCGA(); else scroll(attr); row = ROWS - 1; }
    setCur(col, row);
  }
  bios.teletype = teletype;
  bios.writeString = (s, attr) => { for (let i = 0; i < s.length; i++) teletype(typeof s === 'string' ? s.charCodeAt(i) : s[i], attr); };
  bios.resetPalette = () => defaultPalette(bios.dac);

  // ---- INT 10h: video ----
  machine.hookInterrupt(0x10, (cpu) => {
    const ah = cpu.ah;
    switch (ah) {
      case 0x00: {                              // set video mode
        machine.vbe = null;                     // a plain BIOS mode set leaves any VBE mode
        bios.mode = cpu.al & 0x7f;
        mem.w8(BDA + 0x49, bios.mode);
        mem.w16(BDA + 0x63, bios.mode === 7 ? 0x03b4 : 0x03d4);  // CRTC base (mono mode 7 vs colour)
        // EGA/VGA 16-colour graphics modes are planar (A000 via the Sequencer/Graphics
        // Controller); the flag routes A000 writes through the plane logic (see vga.js).
        const planar = bios.mode === 0x0d || bios.mode === 0x0e || bios.mode === 0x0f ||
                       bios.mode === 0x10 || bios.mode === 0x11 || bios.mode === 0x12;
        // A mode set reloads the DAC. In a planar EGA mode the DAC holds the 64 EGA colours and the
        // 16 attribute-controller palette registers get their EGA defaults; a pixel index then maps
        // index -> palette-register -> DAC. This reproduces the default 16 exactly, but lets a game
        // repaint the palette via INT 10h AH=10h AL=00/02 (Prehistorik does — without it the 16
        // registers stayed identity and its art rendered in garish default colours).
        const mi = MODE_INFO[bios.mode];
        if (mi) {
          loadModeDAC(bios.dac, mi.dac);
          mem.w16(BDA + 0x4a, mi.cols);          // text columns: mode 13h is 40, not 80
          cpu.al = mi.al;                        // AH=00 returns 0x20 for graphics, 0x30 for text
        } else if (planar && machine.vga) { egaPaletteDAC(bios.dac); machine.vga.palette.set(EGA_DEFAULT_PAL); }
        else defaultPalette(bios.dac);
        mem.setPlanar(planar); bios.planar = planar;
        if (machine.vga) machine.vga.setMode(bios.mode, planar);
        // AFTER setMode, which resets the sixteen registers to the identity: the BIOS's own defaults
        // are what a program inherits, and for every text and 16-colour mode register 6 is 0x14 —
        // brown rather than dark yellow — which is the one every EGA palette table is remembered for.
        if (mi && machine.vga) machine.vga.palette.set(mi.pal);
        if (!(cpu.al & 0x80)) {                 // high bit set = keep screen
          if (bios.mode === 0x13) for (let i = 0; i < 320 * 200; i++) mem.w8(0xa0000 + i, 0);
          else if (planar) { if (machine.vga) machine.vga.clear(); }
          else clearScreen(0x07);
        }
        if (bios.onModeChange) bios.onModeChange(bios.mode);
        break;
      }
      case 0x01: {                               // set cursor shape; CH bit 5 hides it
        const ch = (cpu.cx >> 8) & 0xff, cl = cpu.cx & 0xff;
        bios.cursor.hidden = (ch & 0x20) !== 0 || (ch & 0x1f) > (cl & 0x1f);
        bios.cursor.start = ch & 0x1f; bios.cursor.end = cl & 0x1f;
        if (machine.vga) { machine.vga.crtc[0x0a] = ch; machine.vga.crtc[0x0b] = cl; }
        break;
      }
      case 0x02: setCur(cpu.dx & 0xff, (cpu.dx >> 8) & 0xff); break; // set cursor pos
      case 0x03: cpu.dx = (getRow() << 8) | getCol();
        cpu.cx = (((bios.cursor.hidden ? 0x20 : 0) | (bios.cursor.start & 0x1f)) << 8) | (bios.cursor.end & 0x1f);
        break; // get cursor position + shape
      case 0x05: {                               // set active display page
        const page = cpu.al & 0xff;
        mem.w16(BDA + 0x62, page);
        // Recording the page number is only half of it: the BIOS also moves the CRTC display start,
        // and THAT is the page flip. Without it a game that draws to the hidden page and flips shows
        // page 0 for ever, so the screen is a blend of two frames — Baby Jo alternates 0 and 1
        // through this call 1375 times each, and its menu character came out with the head from one
        // frame above the body from another. Planar modes only: there the CRTC start counts bytes
        // per plane, which is what the page size is measured in. Text pages count characters and
        // have no reference here, so they are left alone.
        const md = mem.r8(0x449);
        const size = md === 0x0d ? 0x2000 : md === 0x0e ? 0x4000 : (md === 0x0f || md === 0x10) ? 0x8000 : 0;
        if (size && mem.planar && machine.vga) {
          const start = (page * size) & 0xffff;
          mem.w16(BDA + 0x4e, start);
          machine.vga.crtc[0x0c] = (start >> 8) & 0xff;
          machine.vga.crtc[0x0d] = start & 0xff;
        }
        break;
      }
      case 0x06: case 0x07: {                    // AH=06 scroll up / AH=07 scroll down, in a window
        const lines = cpu.al, bh = (cpu.bx >> 8) & 0xff;
        const top = (cpu.cx >> 8) & 0xff, left = cpu.cx & 0xff;
        const bottom = (cpu.dx >> 8) & 0xff, right = cpu.dx & 0xff;
        scrollWindow(ah === 0x06, lines, bh, top, left, bottom, right);
        break;
      }
      case 0x08: cpu.ax = mem.r16(VRAM + (getRow() * COLS + getCol()) * 2); break; // read char/attr
      // In a graphics mode these repeat the glyph across the row instead of writing text words into
      // a buffer the mode does not display — the same defect the teletype path had.
      case 0x09: case 0x0a: {                    // write char (+attr for 09), no cursor advance
        const c = cpu.al, at = cpu.bx & 0xff, n = cpu.cx & 0xffff, row = getRow(), col = getCol();
        if (bios.mode === 0x13) { for (let i = 0; i < n && col + i < 40; i++) drawGlyph13(c, col + i, row, at); }
        else if (bios.mode >= 4 && bios.mode <= 6) { for (let i = 0; i < n; i++) drawGlyphCGA(c, col + i, row, at); }
        else {
          const off = row * COLS + col;
          for (let i = 0; i < n; i++) {
            if (ah === 0x09) mem.w16(VRAM + (off + i) * 2, c | (at << 8));
            else mem.w8(VRAM + (off + i) * 2, c);
          }
        }
        if (ah === 0x09) bios.attr = at;
        break;
      }
      case 0x0b: {                               // set CGA palette (BH=1) / background+border (BH=0)
        const bh = (cpu.bx >> 8) & 0xff, bl = cpu.bx & 0xff;
        if (bh === 0) {
          bios.cga.color = (bios.cga.color & 0x20) | (bl & 0x1f);                   // background/border
          if (machine.vga) machine.vga.palette[0] = bl & 0x3f;   // a VGA puts it in attribute reg 0 too
        }
        else bios.cga.color = (bios.cga.color & ~0x20) | ((bl & 1) << 5);          // palette select
        break;
      }
      case 0x0e:                                 // teletype (BL = foreground colour in graphics modes)
        teletype(cpu.al, ((bios.mode >= 4 && bios.mode <= 6) || bios.mode === 0x13) ? (cpu.bx & 0xff) : bios.attr);
        break;
      case 0x0f: cpu.ax = ((mem.r16(BDA + 0x4a) & 0xff) << 8) | bios.mode;   // AH = columns, and mode 13h has 40
        cpu.bx = (mem.r16(BDA + 0x62) << 8) & 0xff00; break; // get mode
      case 0x10:                                 // palette / DAC
        if (cpu.al === 0x00) {                   // set one attribute-controller palette register
          if (machine.vga) machine.vga.palette[cpu.bx & 0x0f] = (cpu.bx >> 8) & 0x3f; // BL=reg, BH=value
        } else if (cpu.al === 0x02) {            // set all 16 palette registers + overscan (ES:DX -> 17 bytes)
          if (machine.vga) { let p = (cpu.seg[0] << 4) + (cpu.dx & 0xffff); for (let i = 0; i < 16; i++) machine.vga.palette[i] = mem.r8(p++) & 0x3f; }
        } else if (cpu.al === 0x10) {            // set one DAC register
          const reg = cpu.bx & 0xff;
          bios.dac[reg * 3] = (cpu.dx >> 8) & 0x3f;     // DH = red
          bios.dac[reg * 3 + 1] = (cpu.cx >> 8) & 0x3f; // CH = green
          bios.dac[reg * 3 + 2] = cpu.cx & 0x3f;        // CL = blue
        } else if (cpu.al === 0x03) {            // toggle blink vs bright-background (BL bit 0)
          bios.blink = (cpu.bx & 1) !== 0;
        } else if (cpu.al === 0x17) {            // GET block of DAC registers (mirror of AL=12h)
          const start = cpu.bx & 0xff, count = cpu.cx & 0xffff;   // BL, not BX — see AL=12h below
          let p = (cpu.seg[0] << 4) + (cpu.dx & 0xffff); // ES:DX
          for (let i = 0; i < count; i++) {
            mem.w8(p++, bios.dac[(start + i) * 3] & 0x3f);
            mem.w8(p++, bios.dac[(start + i) * 3 + 1] & 0x3f);
            mem.w8(p++, bios.dac[(start + i) * 3 + 2] & 0x3f);
          }
        } else if (cpu.al === 0x12) {            // set block of DAC registers
          // The starting register is **BL**, not BX. A real BIOS loads it into port 0x3C8, which is
          // eight bits wide, so anything above 255 truncates — and callers rely on that. mesha enters
          // this call with BX = 0x100 left over from its unpacker (`push si / pop bx`, si = 0x100 at
          // .COM entry) and never sets it, because BL is already 0. Reading BX put `start` at 256,
          // every write landed past the 768-byte DAC array and was silently dropped by the typed
          // array, so its whole palette upload did nothing: the demo then rendered against the
          // default VGA DAC. Right geometry, wrong colours everywhere (docs/COMPAT.md).
          const start = cpu.bx & 0xff, count = cpu.cx & 0xffff;
          let p = (cpu.seg[0] << 4) + (cpu.dx & 0xffff); // ES:DX
          for (let i = 0; i < count; i++) {
            bios.dac[(start + i) * 3] = mem.r8(p++) & 0x3f;
            bios.dac[(start + i) * 3 + 1] = mem.r8(p++) & 0x3f;
            bios.dac[(start + i) * 3 + 2] = mem.r8(p++) & 0x3f;
          }
        }
        break;
      case 0x11:                                 // character-generator / font routines (EGA/VGA only)
        if (cpu.al === 0x30) {                   // get font information — games probe this to detect EGA/VGA
          const bh = (cpu.bx >> 8) & 0xff;       // which font: 2/5=8×14, 6/7=8×16, else 8×8 (0/4 = 2nd half)
          let src, pts, half = 0;
          if (bh === 2 || bh === 5) { src = machine.font8x14; pts = 14; }
          else if (bh === 6 || bh === 7) { src = machine.font; pts = 16; }
          else { src = machine.font8x8; pts = 8; if (bh === 0 || bh === 4) half = 128 * 8; }
          const seg = 0xf000, off = 0x4000 + (pts === 14 ? 0x1000 : pts === 16 ? 0x2000 : 0);
          if (src) for (let i = 0; i < src.length; i++) mem.w8((seg << 4) + off + i, src[i]); // stage the font in the F000 ROM space
          cpu.setSeg(0, seg); cpu.bp = (off + half) & 0xffff;   // ES:BP → font table
          cpu.cx = pts;                                         // CX = bytes per character (points)
          cpu.dx = (cpu.dx & 0xff00) | (ROWS - 1);              // DL = character rows − 1
        }
        break;
      case 0x12:                                 // alternate select / EGA info
        if ((cpu.bx & 0xff) === 0x10) { cpu.bx = 0x0003; cpu.cx = 0x0009; }  // EGA info: BH=0 colour, BL=3 (256K), CX=0x0009 feature bits + switches (what the ROM answers)
        else cpu.ax = (cpu.ax & 0xff00) | 0x12;                              // ack other subfunctions (scan lines, palette, etc.)
        break;
      case 0x13: {                               // write string
        const len = cpu.cx & 0xffff, withAttr = cpu.al & 2;
        let p = (cpu.seg[0] << 4) + (cpu.bp & 0xffff); // ES:BP
        setCur(cpu.dx & 0xff, (cpu.dx >> 8) & 0xff);
        for (let i = 0; i < len; i++) {
          const c = mem.r8(p++); const at = withAttr ? mem.r8(p++) : bios.attr;
          teletype(c, at);
        }
        break;
      }
      // Get display combination code. Only AL carries the answer (1Ah = the call exists) and AH comes
      // back ZERO — measured against dosbox-x with tools/dcc.asm, which returns AX=001A. Preserving
      // the caller's AH gave AX=1A1A, since the caller necessarily set AH=1Ah to make the call; a
      // program comparing the whole of AX rather than AL saw an answer no BIOS gives.
      case 0x1a: cpu.ax = 0x001a; cpu.bx = 0x0008; break;   // BL=08h = VGA colour, BH=0 = no second display
      // ---- VESA VBE ----------------------------------------------------------------------------
      case 0x4f: {
        const es = (cpu.base[0] + (cpu.di & 0xffff)) >>> 0;    // base[0] = ES; ES:DI is the buffer
        const findMode = (n) => VBE_MODES.find((m) => m[0] === (n & 0x1ff));
        switch (cpu.al) {
          case 0x00: {                                          // VbeInfoBlock
            for (let i = 0; i < 256; i++) mem.w8(es + i, 0);
            for (let i = 0; i < 4; i++) mem.w8(es + i, 'VESA'.charCodeAt(i));
            mem.w16(es + 4, 0x0200);                             // VBE 2.0 — required for PhysBasePtr
            mem.w16(es + 6, VBE_OEM_OFF); mem.w16(es + 8, VBE_SEG);
            mem.w32(es + 10, 0x00000001);                        // capabilities: DAC is switchable
            mem.w16(es + 14, VBE_MODES_OFF); mem.w16(es + 16, VBE_SEG);
            mem.w16(es + 18, VBE_FB_BYTES >> 16);                // video memory, in 64 KB blocks
            cpu.ax = 0x004f; break;
          }
          case 0x01: {                                          // ModeInfoBlock for CX
            const m = findMode(cpu.cx);
            if (!m) { cpu.ax = 0x014f; break; }
            const [, w, h, bpp] = m, pitch = w * (bpp >> 3);
            for (let i = 0; i < 256; i++) mem.w8(es + i, 0);
            // bit0 supported, bit1 extra info, bit3 colour, bit4 graphics, bit7 linear framebuffer
            mem.w16(es + 0, 0x009b);
            mem.w8(es + 2, 0x07); mem.w8(es + 3, 0x00);          // window A readable/writable, no window B
            mem.w16(es + 4, 64); mem.w16(es + 6, 64);            // granularity / size, in KB
            mem.w16(es + 8, 0xa000);                             // window A at A000
            mem.w16(es + 16, pitch);
            mem.w16(es + 18, w); mem.w16(es + 20, h);
            mem.w8(es + 22, 8); mem.w8(es + 23, 16);
            mem.w8(es + 24, 1); mem.w8(es + 25, bpp);            // one plane, packed
            mem.w8(es + 26, 1); mem.w8(es + 27, bpp === 8 ? 4 : 6);   // 4 = packed pixel, 6 = direct colour
            mem.w8(es + 29, 0);
            if (bpp === 16) { mem.w8(es + 31, 5); mem.w8(es + 32, 11); mem.w8(es + 33, 6); mem.w8(es + 34, 5); mem.w8(es + 35, 5); mem.w8(es + 36, 0); }
            if (bpp === 32) {
              mem.w8(es + 31, 8); mem.w8(es + 32, 16); mem.w8(es + 33, 8); mem.w8(es + 34, 8);
              mem.w8(es + 35, 8); mem.w8(es + 36, 0); mem.w8(es + 37, 8); mem.w8(es + 38, 24);
            }
            mem.w32(es + 40, VBE_FB_LIN);                        // PhysBasePtr (VBE 2.0)
            cpu.ax = 0x004f; break;
          }
          case 0x02: {                                          // set mode (BX; bit 14 = linear)
            const m = findMode(cpu.bx);
            if (!m) { cpu.ax = 0x014f; break; }
            machine.setVbeMode(m, !!(cpu.bx & 0x4000));
            cpu.ax = 0x004f; break;
          }
          case 0x05: {                                          // window control (BH=0 set, 1 get)
            if (!machine.vbe) { cpu.ax = 0x014f; break; }
            if ((cpu.bx >> 8) & 0xff) cpu.dx = machine.vbe.bank;
            else machine.vbeWindow(cpu.dx & 0xffff);
            cpu.ax = 0x004f; break;
          }
          case 0x03:                                            // get mode
            cpu.bx = machine.vbe ? (machine.vbe.number | (machine.vbe.linear ? 0x4000 : 0)) : 0;
            cpu.ax = 0x004f; break;
          default: cpu.ax = 0x014f;                             // AH=01 failed, AL=4F supported
        }
        break;
      }
      case 0x1c: {                               // save/restore video state — VGA-only, so games use it to probe VGA
        // AL=00 return buffer size (BX = 64-byte blocks for the states requested in CX); AL=01 save, AL=02 restore.
        // We present as VGA: acknowledge with AL=1Ch. Secret Agent keys "is this VGA?" on CMP AL,1Ch — without it,
        // it falls through to the BL=32h probe, misdetects MCGA, and refuses to run ("requires an EGA or VGA Adapter").
        const sub = cpu.al;
        cpu.ax = (cpu.ax & 0xff00) | 0x1c;       // AL = 1Ch = function supported
        if (sub === 0x00) cpu.bx = 0x0003;       // report a few 64-byte blocks; save (01) / restore (02) are no-ops
        break;
      }
      // AH=0Ch/0Dh write/read pixel. Absent until now and swallowed by `default`, so a program that
      // plots through the BIOS drew *nothing*, with no error — a whole blank screen and no clue.
      // Mode 13h is the flat A000 byte array; planar EGA/VGA goes through the plane pipeline (the
      // Graphics Controller's bit mask selects the pixel); CGA 4/5/6 is the interleaved B800 bitmap.
      case 0x0c: case 0x0d: {
        const x = cpu.cx & 0xffff, y = cpu.dx & 0xffff, read = ah === 0x0d;
        const m = bios.mode;
        if (m === 0x13) {
          const a = 0xa0000 + y * 320 + x;
          if (x >= 320 || y >= 200) break;
          if (read) cpu.al = mem.r8(a); else mem.w8(a, cpu.al);
        } else if (m === 4 || m === 5 || m === 6) {
          const wide = m === 6, bpp = wide ? 1 : 2, perByte = wide ? 8 : 4;
          if (x >= (wide ? 640 : 320) || y >= 200) break;
          const off = VRAM + ((y & 1) ? 0x2000 : 0) + (y >> 1) * 80 + ((x / perByte) | 0);
          const sh = (perByte - 1 - (x % perByte)) * bpp, msk = ((1 << bpp) - 1) << sh;
          if (read) cpu.al = (mem.r8(off) & msk) >> sh;
          else mem.w8(off, (mem.r8(off) & ~msk) | ((cpu.al & ((1 << bpp) - 1)) << sh));
        } else if (machine.vga && mem.planar) {
          const vga = machine.vga, stride = vga.rowBytes(), off = (y * stride + (x >> 3)) & 0xffff;
          const bit = 0x80 >> (x & 7);
          if (read) {                            // assemble the 4 plane bits for this pixel
            vga.readByte(off);                   // loads the latches
            let v = 0; for (let p = 0; p < 4; p++) if (vga.planes[p * 0x10000 + off] & bit) v |= 1 << p;
            cpu.al = v;
          } else {
            const savedMask = vga.gc[8], savedMode = vga.gc[5], savedSR = vga.gc[0], savedESR = vga.gc[1];
            vga.gc[8] = bit; vga.gc[5] = (vga.gc[5] & ~3) | 0; vga.gc[0] = cpu.al & 0x0f; vga.gc[1] = 0x0f;
            vga.readByte(off);                   // latch, so untouched bits survive the read-modify-write
            vga.writeByte(off, 0);
            vga.gc[8] = savedMask; vga.gc[5] = savedMode; vga.gc[0] = savedSR; vga.gc[1] = savedESR;
          }
        }
        break;
      }
      default: break;
    }
  });

  // ---- INT 16h: keyboard ----
  machine.hookInterrupt(0x16, (cpu) => {
    const ah = cpu.ah;
    if (ah === 0x00 || ah === 0x10) {
      if (machine.keyQueue.length === 0) { machine.block(2); return; }
      const k = machine.keyQueue.shift();
      cpu.ax = ((k.scan & 0xff) << 8) | (k.ascii & 0xff);
    } else if (ah === 0x01 || ah === 0x11) {
      if (machine.keyQueue.length === 0) cpu.flags |= ZF;
      else { cpu.flags &= ~ZF; const k = machine.keyQueue[0]; cpu.ax = ((k.scan & 0xff) << 8) | (k.ascii & 0xff); }
    } else if (ah === 0x02 || ah === 0x12) {
      cpu.al = 0; // shift flags
    }
  });

  // ---- INT 1Ah: timer ----
  machine.hookInterrupt(0x1a, (cpu) => {
    if (cpu.ah === 0x00) {
      const t = mem.r32(BDA + 0x6c);
      cpu.cx = (t >>> 16) & 0xffff; cpu.dx = t & 0xffff; cpu.al = 0;
    }
  });

  // ---- INT 15h: system services ----
  // Only the subfunctions the corpus actually asks for (tools/survey-gaps.mjs): AH=86h — 16384 calls
  // from `revitro` alone — and AH=88h, which ZONE66 asks once. Until AH=86h had a handler at all the
  // wait returned instantly: a demo that paces itself with it ran as fast as the host could go,
  // which is a very plausible reason revitro's animation sits at a different phase from DOSBox's.
  // Everything else still increments machine.unhandledInts[0x15] so the survey keeps seeing it.
  machine.hookInterrupt(0x15, (cpu) => {
    if (cpu.ah === 0x86) {                     // wait CX:DX microseconds
      const us = (((cpu.cx & 0xffff) * 65536) + (cpu.dx & 0xffff));
      // cpu.cycles IS the PIT clock: pitBase cycles per 18.2 Hz tick, i.e. 1.193182 MHz at the
      // default reload. We cannot block a JS handler, so time passes by advancing the virtual
      // clock — the run loop then delivers whatever PIT ticks came due, which is what the guest
      // was waiting for anyway.
      cpu.cycles += us * (machine.pitBase * 1.193182 / 65536);
      cpu.flags &= ~CF;                        // CF clear = the wait completed
      return;
    }
    if (cpu.ah === 0x24) {                     // A20 gate services (PS/2 BIOS)
      // An XMS driver asks 2403 which methods exist and 2402 for the current state before it picks
      // one; answering neither is why HimemX refused to install. Both mechanisms it can then use —
      // the 8042 above and port 0x92 — are real here, so report both as supported.
      if (cpu.al === 0x00) { bios.setA20(false); cpu.ah = 0; cpu.flags &= ~CF; return; }   // disable
      if (cpu.al === 0x01) { bios.setA20(true);  cpu.ah = 0; cpu.flags &= ~CF; return; }   // enable
      if (cpu.al === 0x02) { cpu.ax = machine.mem.a20 ? 1 : 0; cpu.flags &= ~CF; return; } // AL = state
      if (cpu.al === 0x03) { cpu.ax = 0; cpu.bx = 0x0003; cpu.flags &= ~CF; return; }      // BX: bit0 8042, bit1 port 92h
      machine.unhandledInts[0x15]++;
      cpu.flags |= CF; cpu.ah = 0x86;
      return;
    }
    // AX=E801 and AH=8Ah are the two ways past AH=88h's 64 MiB ceiling, and an XMS driver asks for
    // them before it falls back. HimemX asks E801 first; leaving it unanswered made it size its pool
    // from AH=88h alone.
    if ((cpu.ax & 0xffff) === 0xe801) {
      const kb = Math.max(0, (mem.size - 0x100000) >> 10);
      const below16 = Math.min(kb, 0x3c00);                    // KB in 1..16 MiB, capped at 15 MiB
      const above16 = Math.max(0, (kb - 0x3c00)) >> 6;         // 64 KiB blocks above 16 MiB
      cpu.ax = below16; cpu.cx = below16;
      cpu.bx = above16; cpu.dx = above16;
      cpu.flags &= ~CF;
      return;
    }
    if (cpu.ah === 0x8a) {                     // extended memory size in KB, DX:AX
      const kb = Math.max(0, (mem.size - 0x100000) >> 10);
      cpu.ax = kb & 0xffff; cpu.dx = (kb >>> 16) & 0xffff;
      cpu.flags &= ~CF;
      return;
    }
    if (cpu.ah === 0x88) {                     // extended memory size, KB above 1 MiB
      // An XMS driver OWNS extended memory and hooks this vector to report none, so nobody else
      // claims it behind its back. Measured, not assumed: `tools/xms15.asm` under dosbox-x with XMS
      // installed answers KB=0000 CF=0 — so reporting our real 15 MiB here would be the wrong answer
      // for the configuration we actually boot.
      // Report none only while OUR XMS driver is the one actually serving the guest — that is, while
      // INT 2Fh still points at our stub. A booted kernel installs its own multiplex handler over the
      // vector, which orphans our driver (docs/COMPAT.md); answering 0 there told the guest's real XMS
      // driver there was no extended memory, and HimemX refused to install with "Extended memory is
      // too small or not available" even after it had A20 open.
      const oursLive = machine.xms && machine.getVector(0x2f).seg === 0xf000;
      cpu.ax = oursLive ? 0 : Math.min(0xffff, (mem.size - 0x100000) >> 10);
      cpu.flags &= ~CF;
      return;
    }
    machine.unhandledInts[0x15]++;
    cpu.flags |= CF; cpu.ah = 0x86;            // AH=86h + CF = "function not supported"
  });

  // ---- INT 08h: the BIOS timer handler ----
  // A game that hooks INT 8 very often does its work and then chains to the ORIGINAL vector,
  // expecting the BIOS handler to finish the job — which on real hardware ends with
  // `mov al,20h; out 20h,al`. Our f000:08 was a bare IRET, so with a real PIC in place ISR bit 0
  // stayed set after the first tick and the timer never fired again: COSMO, HOCUS, MI2 and
  // GODTHUND all went black.
  //
  // The BDA tick belongs HERE, not in machine.tickTimer. tickTimer fires at whatever rate the PIT is
  // programmed to, and a game that reprograms counter 0 chains to this handler only once every N of
  // its own ticks — which is precisely how 0040:006C stays at 18.2 Hz on real hardware while the
  // game's ISR runs at 473 Hz. Bumping it per PIT tick instead made the BDA clock run at the GAME's
  // rate: Monkey Island reprograms to 2521 (473 Hz, clamped to 291 Hz here), so every capture bounded
  // on the BIOS tick — tools/shot.mjs, and with it every DOSBox pixel comparison — stopped 16x too
  // early and photographed a screen the game had not drawn yet.
  machine.hookInterrupt(0x08, () => { machine.bumpBiosTick(); if (machine.pic) machine.pic.eoi(0); });

  // ---- INT 09h: the BIOS keyboard handler ----
  // Same shape: an ISR that chains to the original INT 9 expects the BIOS to acknowledge IRQ1.
  machine.hookInterrupt(0x09, () => { if (machine.pic) machine.pic.eoi(1); });

  // ---- INT 17h (printer) / INT 14h (serial) ----
  // No ports are fitted — the equipment word at BDA 0x410 says so — but MS-DOS's IO.SYS installs its
  // PRN and AUX drivers unconditionally and initialises them at boot, so it calls these regardless.
  // With no handler they returned CF and untouched registers, i.e. "success" to a caller that reads
  // AH as a status byte. That is the audit's T1.1 shape once more.
  machine.hookInterrupt(0x17, (cpu) => {
    // AH=00 print / 01 init / 02 status. Bit 0 = timeout: nothing answered, which is the truth.
    cpu.ah = 0x01;
    cpu.flags &= ~CF;
  });
  machine.hookInterrupt(0x14, (cpu) => {
    // AH=00 init / 01 send / 02 receive / 03 status. AH bit 7 = timeout, AL = modem status.
    cpu.ax = 0x8000;
    cpu.flags &= ~CF;
  });

  // ---- INT 2Ah: network / critical section ----
  // AH=00 is "is a network installed?" — AL=0 means no. Programs call it before deciding whether to
  // use file sharing; with no handler it returned CF, which some read as "installed but erroring".
  machine.hookInterrupt(0x2a, (cpu) => {
    if (cpu.ah === 0x00) { cpu.ax = 0; cpu.flags &= ~CF; return; }
    if (cpu.ah === 0x80 || cpu.ah === 0x81 || cpu.ah === 0x82) { cpu.flags &= ~CF; return; }  // begin/end critical section: no-ops
    machine.unhandledInts[0x2a]++;
    cpu.flags |= CF;
  });

  // ---- INT 11h / INT 12h ----
  machine.hookInterrupt(0x11, (cpu) => { cpu.ax = mem.r16(BDA + 0x10); });
  machine.hookInterrupt(0x12, (cpu) => { cpu.ax = mem.r16(BDA + 0x13); });

  // ---- VGA DAC palette ports (most demos set the palette this way, not INT 10h) ----
  let dacW = 0, dacR = 0, latch = 0;
  machine.onPortWrite(0x3c8, (_p, _s, v) => { dacW = v & 0xff; latch = 0; });   // write index
  machine.onPortWrite(0x3c7, (_p, _s, v) => { dacR = v & 0xff; latch = 0; });   // read index
  machine.onPortWrite(0x3c9, (_p, _s, v) => {                                   // write R,G,B (6-bit)
    bios.dac[dacW * 3 + latch] = v & 0x3f;
    if (++latch === 3) { latch = 0; dacW = (dacW + 1) & 0xff; }
  });
  machine.onPortRead(0x3c9, () => {
    const v = bios.dac[dacR * 3 + latch];
    if (++latch === 3) { latch = 0; dacR = (dacR + 1) & 0xff; }
    return v;
  });
  machine.onPortRead(0x3c8, () => dacW);
  machine.onPortRead(0x3c6, () => 0xff); machine.onPortWrite(0x3c6, () => {});  // pixel mask
  // CGA control (modes 4/5/6): 0x3D8 mode-control, 0x3D9 colour-select (bits0-3 background,
  // bit4 intensity, bit5 palette green-red-brown vs cyan-magenta-white). The renderer reads these.
  machine.onPortWrite(0x3d8, (_p, _s, v) => { bios.cga.mode = v & 0xff; });
  machine.onPortWrite(0x3d9, (_p, _s, v) => { bios.cga.color = v & 0xff; });
  machine.onPortRead(0x3d9, () => bios.cga.color);
  // A20 gate — System Control Port A (0x92), the PS/2 "fast A20": bit 1 opens/closes the 1 MiB
  // address wrap. (Games that want HMA/extended addressing set it; most rely on the reset default
  // of A20 disabled, which memory.js already provides.)
  // Every A20 path goes through here. The recompiler bakes the address mask as a literal into
  // compiled blocks, so re-bake it and drop the cache — otherwise inlined accesses keep the old wrap.
  const setA20 = (want) => {
    if (!!want === machine.mem.a20) return;
    machine.mem.setA20(!!want);
    if (machine.rec) machine.rec.setMask(machine.mem.mask);
  };
  bios.setA20 = setA20;
  machine.onPortWrite(0x92, (_p, _s, v) => setA20(v & 2));
  machine.onPortRead(0x92, () => (machine.mem.a20 ? 0x02 : 0x00));
  // Input Status #1 (0x3DA): a real time-based VGA beam instead of a per-read toggle, so a vsync
  // loop that measures the retrace (not just waits for an edge) sees a realistic period. The beam
  // position is cpu.cycles within one ~70 Hz mode-13h frame. bit3 = vertical retrace (short pulse
  // at frame end); bit0 = display disabled during the surrounding vblank. Reads also reset the ATC
  // index/data flip-flop.
  // Where the period comes from, in order of preference:
  //
  //   1. machine.wallClockMs (the browser) — the beam is derived from REAL time, so the retrace is
  //      a true 70 Hz however fast the engine runs. This is what makes running the CPU unthrottled
  //      safe: cycles are no longer proportional to wall time, so a cycle-derived beam would make
  //      vsync-paced code run at whatever rate the host happens to manage (~27x too fast here).
  //   2. machine.vcpuHz — a virtual CPU clock, if one is set: one 70 Hz frame is vcpuHz/70 cycles.
  //   3. neither (headless, deterministic timerAuto) — the pitBase-derived period, so golden
  //      fingerprints are unchanged (period = pitBase / (70/18.2), the VGA:PIT frequency ratio).
  const vgaPeriod = machine.vcpuHz
    ? Math.max(1, Math.round(machine.vcpuHz / 70))
    : Math.max(1, Math.round((machine.pitBase || machine.pitReload) / 3.845));
  const FRAME_MS = 1000 / 70;
  // The three fractions come from the CRTC now (vga.js `recomputeBeam`) rather than from constants
  // here: the retrace pulse ENDS, and where it starts follows the mode. `beamStamp` changes only on
  // a mode set or a CRTC write, so the common case is one integer compare — this reader runs 24 M
  // times in a single starport run and cannot recompute per read.
  let bStamp = -1, fBlank = 400 / 449, fRS = 412 / 449, fRE = 414 / 449;
  let cBlank = Math.round(vgaPeriod * fBlank), cRS = Math.round(vgaPeriod * fRS), cRE = Math.round(vgaPeriod * fRE);
  const status1 = () => {
    const v = machine.vga;
    if (v) {
      v.atcFlip = 0;
      if (v.beamStamp !== bStamp) {
        bStamp = v.beamStamp; fBlank = v.beam.blank; fRS = v.beam.rStart; fRE = v.beam.rEnd;
        cBlank = Math.round(vgaPeriod * fBlank); cRS = Math.round(vgaPeriod * fRS); cRE = Math.round(vgaPeriod * fRE);
      }
    }
    if (machine.wallClockMs) {
      const t = machine.wallClockMs() / FRAME_MS, f = t - Math.floor(t);
      return (f >= fBlank ? 0x01 : 0) | (f >= fRS && f < fRE ? 0x08 : 0);
    }
    const pos = machine.cpu.cycles % vgaPeriod;
    return (pos >= cBlank ? 0x01 : 0) | (pos >= cRS && pos < cRE ? 0x08 : 0);
  };
  machine.onPortRead(0x3da, status1);
  // 0x3BA is the same register on the mono/MDA address (BDA 0x463 selects which a program uses).
  // Unregistered it read back 0xFF via the open-bus default — bit 3 permanently set — so a
  // "wait for retrace to END" loop never exited. A hang, not a glitch.
  machine.onPortRead(0x3ba, status1);
  // Small registers that were unregistered and therefore read 0xFF. A program that saves and
  // restores VGA state read 0xFF into every one of them and wrote the garbage back.
  machine.onPortRead(0x3c1, () => {              // Attribute Controller data read
    const v = machine.vga; if (!v) return 0;
    return v.atcIndex < 16 ? v.palette[v.atcIndex] : (v.atc ? v.atc[v.atcIndex & 0x1f] : 0);
  });
  machine.onPortRead(0x3cc, () => machine.miscOutput === undefined ? 0x67 : machine.miscOutput);
  machine.onPortWrite(0x3c2, (_p, _s, v) => { machine.miscOutput = v & 0xff; });
  machine.onPortRead(0x3c7, () => 0);            // DAC state: 0 = last access was a write
  let pelMask = 0xff;                            // 0x3C6 is a real register, not a constant 0xFF:
  machine.onPortRead(0x3c6, () => pelMask);      // the standard VGA probe writes it and reads back
  machine.onPortWrite(0x3c6, (_p, _s, v) => { pelMask = v & 0xff; });

  // Minimal Sound Blaster DSP detection at base 0x220 (matches BLASTER=A220). We emulate
  // only the reset handshake and the version query so games that probe for a card start up;
  // there is no actual audio — DSP commands are accepted and dropped.
  let sbReset = 0; const sbOut = [];
  machine.onPortWrite(0x226, (_p, _s, v) => {                            // DSP reset: 1 then 0 → 0xAA ready
    if ((v & 1) === 1) sbReset = 1;
    else if (sbReset) { sbReset = 0; sbOut.length = 0; sbOut.push(0xaa); }
  });
  machine.onPortWrite(0x22c, (_p, _s, v) => { if (v === 0xe1) sbOut.push(4, 5); }); // command: get-version → 4.05
  machine.onPortRead(0x22c, () => 0x00);                                 // write-buffer status: bit7=0 = ready
  machine.onPortRead(0x22e, () => (sbOut.length ? 0x80 : 0x00));         // read-buffer status: bit7 = data ready
  machine.onPortRead(0x22a, () => (sbOut.length ? sbOut.shift() : 0xff)); // DSP read-data

  // Minimal AdLib/OPL FM-synth detection. The classic probe resets the two timers, then
  // starts timer 1 and expects the status port's timer-expired bits (0xC0) to appear.
  // We fake exactly that handshake (no synthesis): a write of the timer-start bit to
  // register 4 arms the expired status; a reset clears it. Mirrored at the SB Pro OPL base.
  let oplReg = 0, oplStatus = 0;
  const oplData = (v) => { if (oplReg === 0x04) oplStatus = (v & 0x80) ? 0 : (v & 0x01) ? 0xc0 : 0; };
  // Bases: 0x388 (Adlib), 0x228 (SB-compatible FM) and — because BLASTER advertises T6, an SB16 —
  // the OPL3 stereo pair at 0x220/0x221 and 0x222/0x223. Those two were unregistered, so a game
  // driving the FM there wrote into nothing and read 0xFF from the status port. tools/survey-ports
  // caught it as HOCUS reading 0x220 and 0x222 about 165000 times each: not a stalled poll, but the
  // standard "delay by reading the FM status port" between the register write and the data write.
  // The reads were harmless; the inconsistency was not — we claimed a card at a base we ignored.
  for (const base of [0x388, 0x228, 0x220, 0x222]) {
    machine.onPortWrite(base, (_p, _s, v) => { oplReg = v & 0xff; });     // register select
    machine.onPortWrite(base + 1, (_p, _s, v) => oplData(v & 0xff));      // register data
    machine.onPortRead(base, () => oplStatus);                            // OPL status
  }

  // Game/joystick port 0x201: no joystick attached, so every line floats high — 0xFF, the same
  // value DOSBox returns with joysticktype=none. Axis bits reading 0 (the old 0xF0) says "the
  // one-shots fired and already timed out", which is a joystick that IS there: Quake's
  // IN_ReadJoystick accepted it and parked in WaitJoyButton before Host_Init ever finished, so
  // its command buffer never ran and no game frame was drawn. Writes (the axis trigger) are a
  // no-op with no joystick.
  machine.onPortRead(0x201, () => 0xff);
  machine.onPortWrite(0x201, () => {});

  // ---- 8042 keyboard controller (ports 0x60/0x64) + IRQ1 ------------------
  // Programs that install their own INT 9h handler — QBasic's IDE, and most games — take input
  // as hardware scancodes read from port 0x60 on each keyboard IRQ, NOT via the BIOS INT 16h
  // buffer. Deliver queued keys as make/break scancodes and fire IRQ1 so those handlers see them.
  // The 8042 data port RETAINS the last scancode; it does not read back as zero. A program is
  // launched from a prompt by pressing Enter and letting it go, so what a freshly started guest finds
  // at port 0x60 is Enter's BREAK code, 0x9C — and DOS-era code reads the port directly and depends
  // on that. Chrome Revenge ends each frame with `IN AL,60H / DAS / JC nextframe`: DAS sets CF only
  // for a value above 0x99, i.e. exactly "the last thing that happened was a key being RELEASED".
  // Reading back 0 made it exit after drawing one single frame.
  const kb = { data: 0x9c, obf: false, scans: [], cmd: 0 };   // scans: FIFO of pending make/break scancodes
  machine.kb = kb;
  machine.onPortRead(0x60, () => { const d = kb.data; kb.obf = false; return d; });   // read scancode, clear OBF
  machine.onPortRead(0x64, () => (kb.obf ? 0x1d : 0x1c));     // status byte; bit0 = output-buffer-full
  machine.onPortWrite(0x60, (_p, _s, v) => {                   // keyboard command -> ACK, or the
    if (kb.cmd === 0xd1) { kb.cmd = 0; setA20(v & 2); return; } // output-port byte after a 0xD1
    kb.data = 0xfa; kb.obf = true;
  });
  // 8042 controller commands. A20 through the keyboard controller is the OLDEST of the three ways to
  // open the 1 MiB wrap and the first one an XMS driver tries: HimemX writes 0xD1 to 0x64 then the
  // output-port byte to 0x60, whose bit 1 is A20. Ignoring 0x64 made that method silently inert, so
  // HimemX gave up with "No Supported A20 method detected / Driver won't be installed" and no XMS
  // existed at all under a booted kernel (docs/COMPAT.md). 0xDD/0xDF are the shorthand forms.
  machine.onPortWrite(0x64, (_p, _s, v) => {
    const c = v & 0xff;
    if (c === 0xd1) { kb.cmd = 0xd1; return; }               // next byte on 0x60 is the output port
    if (c === 0xd0) { kb.data = 0x02 | (machine.mem.a20 ? 0x02 : 0); kb.obf = true; return; }  // read it back
    if (c === 0xdd) { setA20(false); return; }
    if (c === 0xdf) { setA20(true); return; }
    kb.cmd = 0;
  });

  // ---- 8255 PPI port B (0x61) + PIT channel 2 (0x42) ----------------------
  // 0x61 was unhandled and is the most-touched port in the corpus after the video status register:
  // 37205 reads and 102563 writes, from nearly every game. Two things live there.
  //   bit 4 — the RAM-refresh toggle. It flips continuously on real hardware, and a program that
  //           times a short delay by counting flips (a very common trick before the PIT is safe to
  //           reprogram) spins forever against the stuck 1 an unhandled read returns.
  //   bits 0-1 — the speaker gate. Read back, so a program that ORs a bit in and writes it back
  //           does not accidentally clear the other.
  //   bit 5 — timer-2 output, i.e. the speaker's square wave.
  // Channel 2 of the PIT (0x42) is the tone generator behind it. We honour its reload so the square
  // wave has the right period; nothing here makes sound, it makes the *timing* readable.
  const ppi = machine.ppi = { portB: 0x00, ch2Reload: 0x10000, _lo: 0, _hiNext: false };
  machine.onPortWrite(0x61, (_p, _s, v) => { ppi.portB = v & 0xff; });
  machine.onPortRead(0x61, () => {
    const cyc = machine.cpu.cycles;
    // The refresh bit toggles every ~15.085 us = 18 PIT clocks, and cpu.cycles IS the PIT clock.
    const refresh = ((cyc / 18) | 0) & 1;
    // Timer 2 output: a square wave at the programmed reload, high for the first half of a period.
    const half = ppi.ch2Reload >> 1;
    const out = half > 0 && (cyc % ppi.ch2Reload) < half ? 1 : 0;
    return (ppi.portB & 0x0f) | (refresh << 4) | (out << 5);
  });
  machine.onPortWrite(0x42, (_p, _s, v) => {                  // channel 2 reload, LSB then MSB
    v &= 0xff;
    if (!ppi._hiNext) { ppi._lo = v; ppi._hiNext = true; return; }
    ppi._hiNext = false;
    const r = (v << 8) | ppi._lo;
    ppi.ch2Reload = r === 0 ? 0x10000 : r;
  });
  machine.onPortRead(0x42, () => {                            // live countdown, same shape as ch0
    const count = (ppi.ch2Reload - (machine.cpu.cycles % ppi.ch2Reload)) & 0xffff;
    const b = ppi._hiNext ? (count >> 8) & 0xff : count & 0xff;
    ppi._hiNext = !ppi._hiNext;
    return b;
  });
  machine.pushScancodes = (arr) => { for (const s of arr) kb.scans.push(s); };
  // Deliver the next pending scancode to the guest's INT 9h handler (if one is installed) via
  // port 0x60 + IRQ1. No guest ISR -> drop them; the BIOS INT 16h / keyQueue path serves those.
  machine.pumpKeyboard = () => {
    if (kb.obf || kb.scans.length === 0) return;
    // "No guest ISR" has to mean BOTH tables. A DPMI client installs its keyboard handler with
    // INT 31h AX=0205, in the PROTECTED-mode vector — the real-mode IVT keeps the BIOS stub — so
    // testing only the IVT threw away every scancode meant for it. Quake sat on "Press a key" with
    // a correct handler at pmVec[9] that was never given one.
    const pmVec9 = machine.dpmi && machine.dpmi.active && machine.dpmi.pmVec && machine.dpmi.pmVec[9];
    if (!pmVec9 && machine.getVector(9).seg === 0xf000) { kb.scans.length = 0; return; }   // no guest INT 9h ISR
    kb.data = kb.scans.shift(); kb.obf = true;                 // stage the scancode into port 0x60
    machine.hwIrqPending = true;                               // fire IRQ1 as soon as the guest sets IF
  };

  installVGA(machine);   // EGA/VGA planar device (Sequencer/Graphics-Controller ports + planes)
  installDisk(machine);  // INT 13h over attachable sector images (no drives attached by default)
  installPIC(machine);   // 8259A pair: IRR/ISR/IMR, fixed priority, EOI, ICW init (ports 0x20/0x21, 0xA0/0xA1)
  if (opts.xms !== false) installXMS(machine);   // XMS driver (extended memory above 1 MiB via INT 2Fh + f000:0100 entry)
  if (machine.xms) machine.xms.max = Math.min(machine.xms.max, VBE_FB_LIN);   // keep XMS out of the framebuffer
  if (opts.ems !== false) installEMS(machine);   // EMS — after XMS: shares its pool via xms.top
  // DPMI is optional in the same shape as XMS and EMS. `dpmi: false` (or MIRAGE_NODPMI=1, for the
  // tools that take no options) leaves the guest with no host, which is what DOSBox-X does — it ships
  // none, measured with a .COM that reports AX after INT 2Fh AX=1687: it comes back 1687 unchanged.
  // A program that can use either then takes its OTHER branch, so comparing the two emulators without
  // matching this compares two different programs. intros/mesha.com is the case: with a host it
  // becomes a client and installs a protected-mode INT 8 handler; without one its extender falls back
  // to XMS. See docs/TIMING.md §14d.
  // The env test compares against '0' and '' as well as undefined: `!!process.env.X` is TRUE for the
  // string "0", so the obvious spelling would make MIRAGE_NODPMI=0 mean "on".
  const noDpmiEnv = typeof process !== 'undefined' && !!process.env &&
    process.env.MIRAGE_NODPMI !== undefined && process.env.MIRAGE_NODPMI !== '0' && process.env.MIRAGE_NODPMI !== '';
  if (opts.dpmi !== false && !noDpmiEnv) {
    installDPMI(machine);  // DPMI host (INT 2Fh AX=1687h + f000:0200 mode-switch entry). AFTER XMS:
  }                        // it chains that INT 2Fh hook and caps the XMS pool below its own tables.

  machine.bios = bios;
  return bios;
}

// The authentic IBM VGA BIOS default 256-colour DAC for mode 13h, captured byte-for-byte
// from real hardware (via DOSBox-X). Layout: 0-15 EGA, 16-31 greyscale ramp, 32-247 the
// HSV colour cube (3 intensity x 3 saturation x 24 hues), 248-255 black. 6-bit (0-63).
// Intros that never program the DAC (e.g. rv256, which only uses indices 16-31) rely on
// this exact table — a made-up ramp renders them in the wrong colours.
const VGA_DEFAULT_DAC = (
  '00000000002a002a00002a2a2a00002a002a2a15002a2a2a15151515153f153f15153f3f3f15153f153f3f3f153f3f3f' +  //   0- 15
  '0000000505050808080b0b0b0e0e0e1111111414141818181c1c1c2020202424242828282d2d2d3232323838383f3f3f' +  //  16- 31
  '00003f10003f1f003f2f003f3f003f3f002f3f001f3f00103f00003f10003f1f003f2f003f3f002f3f001f3f00103f00' +  //  32- 47
  '003f00003f10003f1f003f2f003f3f002f3f001f3f00103f1f1f3f271f3f2f1f3f371f3f3f1f3f3f1f373f1f2f3f1f27' +  //  48- 63
  '3f1f1f3f271f3f2f1f3f371f3f3f1f373f1f2f3f1f273f1f1f3f1f1f3f271f3f2f1f3f371f3f3f1f373f1f2f3f1f273f' +  //  64- 79
  '2d2d3f312d3f362d3f3a2d3f3f2d3f3f2d3a3f2d363f2d313f2d2d3f312d3f362d3f3a2d3f3f2d3a3f2d363f2d313f2d' +  //  80- 95
  '2d3f2d2d3f312d3f362d3f3a2d3f3f2d3a3f2d363f2d313f00001c07001c0e001c15001c1c001c1c00151c000e1c0007' +  //  96-111
  '1c00001c07001c0e001c15001c1c00151c000e1c00071c00001c00001c07001c0e001c15001c1c00151c000e1c00071c' +  // 112-127
  '0e0e1c110e1c150e1c180e1c1c0e1c1c0e181c0e151c0e111c0e0e1c110e1c150e1c180e1c1c0e181c0e151c0e111c0e' +  // 128-143
  '0e1c0e0e1c110e1c150e1c180e1c1c0e181c0e151c0e111c14141c16141c18141c1a141c1c141c1c141a1c14181c1416' +  // 144-159
  '1c14141c16141c18141c1a141c1c141a1c14181c14161c14141c14141c16141c18141c1a141c1c141a1c14181c14161c' +  // 160-175
  '0000100400100800100c001010001010000c100008100004100000100400100800100c001010000c1000081000041000' +  // 176-191
  '00100000100400100800100c001010000c100008100004100808100a08100c08100e081010081010080e10080c10080a' +  // 192-207
  '100808100a08100c08100e081010080e10080c10080a100808100808100a08100c08100e081010080e10080c10080a10' +  // 208-223
  '0b0b100c0b100d0b100f0b10100b10100b0f100b0d100b0c100b0b100c0b100d0b100f0b10100b0f100b0d100b0c100b' +  // 224-239
  '0b100b0b100c0b100d0b100f0b10100b0f100b0d100b0c10000000000000000000000000000000000000000000000000'    // 240-255
).match(/../g).map((h) => parseInt(h, 16));

function defaultPalette(dac) {
  dac.set(VGA_DEFAULT_DAC);
}

// What a real VGA BIOS establishes on a mode set, captured from SeaVGABIOS with
// tools/int10-oracle.mjs: the AL it returns, the columns it publishes at BDA 0x44A, which DAC table
// it loads, and the attribute-controller palette. None of this was modelled — every mode kept
// whatever DAC was already loaded and an identity attribute palette, which the oracle showed as 636
// of 768 DAC bytes and 9 palette entries differing from the ROM after a mode 03h or 12h.
//
// Three of the four DAC tables cover 0..63 and leave 64..255 at zero; the fourth is the 256-colour
// ramp for mode 13h, which VGA_DEFAULT_DAC already reproduces byte for byte (verified against the
// ROM). `ega64` is exactly what egaPaletteDAC() computes, so only these two are captured data.
const CGA_DAC64 = Uint8Array.from([
  0x00,0x00,0x00, 0x00,0x00,0x2a, 0x00,0x2a,0x00, 0x00,0x2a,0x2a, 0x2a,0x00,0x00, 0x2a,0x00,0x2a, 0x2a,0x15,0x00, 0x2a,0x2a,0x2a,
  0x00,0x00,0x00, 0x00,0x00,0x2a, 0x00,0x2a,0x00, 0x00,0x2a,0x2a, 0x2a,0x00,0x00, 0x2a,0x00,0x2a, 0x2a,0x15,0x00, 0x2a,0x2a,0x2a,
  0x15,0x15,0x15, 0x15,0x15,0x3f, 0x15,0x3f,0x15, 0x15,0x3f,0x3f, 0x3f,0x15,0x15, 0x3f,0x15,0x3f, 0x3f,0x3f,0x15, 0x3f,0x3f,0x3f,
  0x15,0x15,0x15, 0x15,0x15,0x3f, 0x15,0x3f,0x15, 0x15,0x3f,0x3f, 0x3f,0x15,0x15, 0x3f,0x15,0x3f, 0x3f,0x3f,0x15, 0x3f,0x3f,0x3f,
  0x00,0x00,0x00, 0x00,0x00,0x2a, 0x00,0x2a,0x00, 0x00,0x2a,0x2a, 0x2a,0x00,0x00, 0x2a,0x00,0x2a, 0x2a,0x15,0x00, 0x2a,0x2a,0x2a,
  0x00,0x00,0x00, 0x00,0x00,0x2a, 0x00,0x2a,0x00, 0x00,0x2a,0x2a, 0x2a,0x00,0x00, 0x2a,0x00,0x2a, 0x2a,0x15,0x00, 0x2a,0x2a,0x2a,
  0x15,0x15,0x15, 0x15,0x15,0x3f, 0x15,0x3f,0x15, 0x15,0x3f,0x3f, 0x3f,0x15,0x15, 0x3f,0x15,0x3f, 0x3f,0x3f,0x15, 0x3f,0x3f,0x3f,
  0x15,0x15,0x15, 0x15,0x15,0x3f, 0x15,0x3f,0x15, 0x15,0x3f,0x3f, 0x3f,0x15,0x15, 0x3f,0x15,0x3f, 0x3f,0x3f,0x15, 0x3f,0x3f,0x3f]);
const MONO_DAC64 = Uint8Array.from([
  0x00,0x00,0x00, 0x00,0x00,0x00, 0x00,0x00,0x00, 0x00,0x00,0x00, 0x00,0x00,0x00, 0x00,0x00,0x00, 0x00,0x00,0x00, 0x00,0x00,0x00,
  0x2a,0x2a,0x2a, 0x2a,0x2a,0x2a, 0x2a,0x2a,0x2a, 0x2a,0x2a,0x2a, 0x2a,0x2a,0x2a, 0x2a,0x2a,0x2a, 0x2a,0x2a,0x2a, 0x2a,0x2a,0x2a,
  0x2a,0x2a,0x2a, 0x2a,0x2a,0x2a, 0x2a,0x2a,0x2a, 0x2a,0x2a,0x2a, 0x2a,0x2a,0x2a, 0x2a,0x2a,0x2a, 0x2a,0x2a,0x2a, 0x2a,0x2a,0x2a,
  0x3f,0x3f,0x3f, 0x3f,0x3f,0x3f, 0x3f,0x3f,0x3f, 0x3f,0x3f,0x3f, 0x3f,0x3f,0x3f, 0x3f,0x3f,0x3f, 0x3f,0x3f,0x3f, 0x3f,0x3f,0x3f,
  0x00,0x00,0x00, 0x00,0x00,0x00, 0x00,0x00,0x00, 0x00,0x00,0x00, 0x00,0x00,0x00, 0x00,0x00,0x00, 0x00,0x00,0x00, 0x00,0x00,0x00,
  0x2a,0x2a,0x2a, 0x2a,0x2a,0x2a, 0x2a,0x2a,0x2a, 0x2a,0x2a,0x2a, 0x2a,0x2a,0x2a, 0x2a,0x2a,0x2a, 0x2a,0x2a,0x2a, 0x2a,0x2a,0x2a,
  0x2a,0x2a,0x2a, 0x2a,0x2a,0x2a, 0x2a,0x2a,0x2a, 0x2a,0x2a,0x2a, 0x2a,0x2a,0x2a, 0x2a,0x2a,0x2a, 0x2a,0x2a,0x2a, 0x2a,0x2a,0x2a,
  0x3f,0x3f,0x3f, 0x3f,0x3f,0x3f, 0x3f,0x3f,0x3f, 0x3f,0x3f,0x3f, 0x3f,0x3f,0x3f, 0x3f,0x3f,0x3f, 0x3f,0x3f,0x3f, 0x3f,0x3f,0x3f]);

const PAL_TEXT   = [0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x14, 0x07, 0x38, 0x39, 0x3a, 0x3b, 0x3c, 0x3d, 0x3e, 0x3f];
const PAL_CGA4   = [0x00, 0x13, 0x15, 0x17, 0x02, 0x04, 0x06, 0x07, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17];
const PAL_CGA6   = [0x00, 0x17, 0x17, 0x17, 0x17, 0x17, 0x17, 0x17, 0x17, 0x17, 0x17, 0x17, 0x17, 0x17, 0x17, 0x17];
const PAL_EGALO  = [0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17];
const PAL_MONO7  = [0x00, 0x08, 0x08, 0x08, 0x08, 0x08, 0x08, 0x08, 0x10, 0x18, 0x18, 0x18, 0x18, 0x18, 0x18, 0x18];
const PAL_MONO0F = [0x00, 0x08, 0x00, 0x00, 0x18, 0x18, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00, 0x18, 0x00, 0x00];
const PAL_MODE11 = [0x00, 0x3f, 0x00, 0x3f, 0x00, 0x3f, 0x00, 0x3f, 0x00, 0x3f, 0x00, 0x3f, 0x00, 0x3f, 0x00, 0x3f];
const PAL_VGA256 = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

// al: what AH=00 returns. Mode 6 really does answer 0x3f — a CGA-compatibility quirk, not a typo.
const MODE_INFO = {
  0x00: { al: 0x30, cols: 40, dac: 'ega64',  pal: PAL_TEXT },
  0x01: { al: 0x30, cols: 40, dac: 'ega64',  pal: PAL_TEXT },
  0x02: { al: 0x30, cols: 80, dac: 'ega64',  pal: PAL_TEXT },
  0x03: { al: 0x30, cols: 80, dac: 'ega64',  pal: PAL_TEXT },
  0x04: { al: 0x30, cols: 40, dac: 'cga',    pal: PAL_CGA4 },
  0x05: { al: 0x30, cols: 40, dac: 'cga',    pal: PAL_CGA4 },
  0x06: { al: 0x3f, cols: 80, dac: 'cga',    pal: PAL_CGA6 },
  0x07: { al: 0x30, cols: 80, dac: 'mono',   pal: PAL_MONO7 },
  0x0d: { al: 0x20, cols: 40, dac: 'cga',    pal: PAL_EGALO },
  0x0e: { al: 0x20, cols: 80, dac: 'cga',    pal: PAL_EGALO },
  0x0f: { al: 0x20, cols: 80, dac: 'mono',   pal: PAL_MONO0F },
  0x10: { al: 0x20, cols: 80, dac: 'ega64',  pal: PAL_TEXT },
  0x11: { al: 0x20, cols: 80, dac: 'ega64',  pal: PAL_MODE11 },
  0x12: { al: 0x20, cols: 80, dac: 'ega64',  pal: PAL_TEXT },
  0x13: { al: 0x20, cols: 40, dac: 'vga256', pal: PAL_VGA256 },
};

/** Load the DAC table a mode set installs. Everything above entry 63 is zero except in mode 13h. */
function loadModeDAC(dac, kind) {
  if (kind === 'vga256') { dac.set(VGA_DEFAULT_DAC); return; }
  dac.fill(0);
  if (kind === 'ega64') egaPaletteDAC(dac);
  else dac.set(kind === 'cga' ? CGA_DAC64 : MONO_DAC64);
}

// The standard EGA default attribute-controller palette registers (index -> 6-bit EGA colour code).
// Index 6 -> 0x14 (brown) and 8..15 -> 0x38..0x3f (the high-intensity set) is what makes the plain
// 16 render correctly once the DAC below holds the 64 EGA colours.
const EGA_DEFAULT_PAL = Uint8Array.from(
  [0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x14, 0x07, 0x38, 0x39, 0x3a, 0x3b, 0x3c, 0x3d, 0x3e, 0x3f]);

// Fill DAC entries 0..63 with the 64 EGA colours. An EGA 6-bit colour code is r g b R G B (secondary
// then primary bits per channel); each channel = primary*0x2a + secondary*0x15 (6-bit, 0..63).
function egaPaletteDAC(dac) {
  for (let v = 0; v < 64; v++) {
    dac[v * 3]     = ((v >> 2) & 1) * 0x2a + ((v >> 5) & 1) * 0x15; // red
    dac[v * 3 + 1] = ((v >> 1) & 1) * 0x2a + ((v >> 4) & 1) * 0x15; // green
    dac[v * 3 + 2] = ((v >> 0) & 1) * 0x2a + ((v >> 3) & 1) * 0x15; // blue
  }
}
