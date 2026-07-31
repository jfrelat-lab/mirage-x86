// bios.js — ROM-BIOS services: INT 10h (video), INT 16h (keyboard), INT 1Ah
// (timer), INT 11h/12h (equipment/memory). Maintains the BIOS Data Area at
// 0040:0000 and the 80x25 text screen at B800:0000. The text routines are
// exposed so the JS shell prints through the exact same path as guest code.

import { ZF } from './cpu.js';
import { installVGA } from './vga.js';

const VRAM = 0xb8000;          // text video memory
const BDA = 0x400;             // BIOS Data Area
const COLS = 80, ROWS = 25;

export function installBIOS(machine) {
  const mem = machine.mem, cpu = machine.cpu;

  const bios = {
    machine,
    attr: 0x07,
    dac: new Uint8Array(768),  // 256 * (r,g,b) 6-bit — VGA palette for mode 13h
    onModeChange: null,        // (mode) => void, wired up by the video layer
    mode: 0x03,
    cga: { color: 0x30, mode: 0 },  // CGA color-select (0x3D9) / mode-control (0x3D8) registers
  };

  // default VGA DAC palette (text + standard 16, then a usable 256 ramp)
  defaultPalette(bios.dac);

  // ---- BIOS Data Area defaults ----
  mem.w16(BDA + 0x10, 0x0021);   // equipment: 80x25 colour, has FPU
  mem.w16(BDA + 0x13, 640);      // conventional memory KB
  mem.w16(BDA + 0x49, 0x0003);   // current video mode = 3 (low byte) — see helpers below
  mem.w8(BDA + 0x49, 0x03);
  mem.w16(BDA + 0x4a, COLS);     // text columns
  mem.w8(BDA + 0x84, ROWS - 1);  // rows - 1
  mem.w16(BDA + 0x62, 0);        // active page
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

  function teletype(ch, attr = bios.attr) {
    const gfx = bios.mode === 4 || bios.mode === 5 || bios.mode === 6;
    const cols = gfx ? (bios.mode === 6 ? 80 : 40) : COLS;
    let col = getCol(), row = getRow();
    if (ch === 0x0d) col = 0;
    else if (ch === 0x0a) row++;
    else if (ch === 0x08) { if (col > 0) col--; }
    else if (ch === 0x07) { /* bell */ }
    else if (ch === 0x09) { col = (col + 8) & ~7; }
    else {
      if (gfx) drawGlyphCGA(ch, col, row, attr);
      else mem.w16(VRAM + (row * COLS + col) * 2, (ch & 0xff) | (attr << 8));
      col++;
    }
    if (col >= cols) { col = 0; row++; }
    if (row >= ROWS) { if (gfx) scrollGfxCGA(); else scroll(attr); row = ROWS - 1; }
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
        bios.mode = cpu.al & 0x7f;
        mem.w8(BDA + 0x49, bios.mode);
        mem.w16(BDA + 0x63, bios.mode === 7 ? 0x03b4 : 0x03d4);  // CRTC base (mono mode 7 vs colour)
        defaultPalette(bios.dac);               // a mode set reloads the default DAC
        // EGA/VGA 16-colour graphics modes are planar (A000 via the Sequencer/Graphics
        // Controller); the flag routes A000 writes through the plane logic (see vga.js).
        const planar = bios.mode === 0x0d || bios.mode === 0x0e || bios.mode === 0x0f ||
                       bios.mode === 0x10 || bios.mode === 0x11 || bios.mode === 0x12;
        mem.planar = planar; bios.planar = planar;
        if (machine.vga) machine.vga.setMode(bios.mode, planar);
        if (!(cpu.al & 0x80)) {                 // high bit set = keep screen
          if (bios.mode === 0x13) for (let i = 0; i < 320 * 200; i++) mem.w8(0xa0000 + i, 0);
          else if (planar) { if (machine.vga) machine.vga.clear(); }
          else clearScreen(0x07);
        }
        if (bios.onModeChange) bios.onModeChange(bios.mode);
        break;
      }
      case 0x01: break;                          // set cursor shape (ignored)
      case 0x02: setCur(cpu.dx & 0xff, (cpu.dx >> 8) & 0xff); break; // set cursor pos
      case 0x03: cpu.dx = (getRow() << 8) | getCol(); cpu.cx = 0x0607; break; // get cursor
      case 0x05: mem.w16(BDA + 0x62, cpu.al); break; // set active page
      case 0x06: case 0x07: {                    // AH=06 scroll up / AH=07 scroll down, in a window
        const lines = cpu.al, bh = (cpu.bx >> 8) & 0xff;
        const top = (cpu.cx >> 8) & 0xff, left = cpu.cx & 0xff;
        const bottom = (cpu.dx >> 8) & 0xff, right = cpu.dx & 0xff;
        scrollWindow(ah === 0x06, lines, bh, top, left, bottom, right);
        break;
      }
      case 0x08: cpu.ax = mem.r16(VRAM + (getRow() * COLS + getCol()) * 2); break; // read char/attr
      case 0x09: {                               // write char+attr (no advance)
        const c = cpu.al, at = cpu.bx & 0xff, n = cpu.cx & 0xffff;
        let off = (getRow() * COLS + getCol());
        for (let i = 0; i < n; i++) mem.w16(VRAM + (off + i) * 2, c | (at << 8));
        bios.attr = at;
        break;
      }
      case 0x0a: {                               // write char only
        const c = cpu.al, n = cpu.cx & 0xffff;
        let off = (getRow() * COLS + getCol());
        for (let i = 0; i < n; i++) mem.w8(VRAM + (off + i) * 2, c);
        break;
      }
      case 0x0b: {                               // set CGA palette (BH=1) / background+border (BH=0)
        const bh = (cpu.bx >> 8) & 0xff, bl = cpu.bx & 0xff;
        if (bh === 0) bios.cga.color = (bios.cga.color & 0x20) | (bl & 0x1f);       // background/border
        else bios.cga.color = (bios.cga.color & ~0x20) | ((bl & 1) << 5);          // palette select
        break;
      }
      case 0x0e:                                 // teletype (BL = foreground colour in graphics modes)
        teletype(cpu.al, (bios.mode >= 4 && bios.mode <= 6) ? (cpu.bx & 0xff) : bios.attr);
        break;
      case 0x0f: cpu.ax = (COLS << 8) | bios.mode; cpu.bx = (mem.r16(BDA + 0x62) << 8) & 0xff00; break; // get mode
      case 0x10:                                 // palette / DAC
        if (cpu.al === 0x10) {                   // set one DAC register
          const reg = cpu.bx & 0xff;
          bios.dac[reg * 3] = (cpu.dx >> 8) & 0x3f;     // DH = red
          bios.dac[reg * 3 + 1] = (cpu.cx >> 8) & 0x3f; // CH = green
          bios.dac[reg * 3 + 2] = cpu.cx & 0x3f;        // CL = blue
        } else if (cpu.al === 0x12) {            // set block of DAC registers
          const start = cpu.bx & 0xffff, count = cpu.cx & 0xffff;
          let p = (cpu.seg[0] << 4) + (cpu.dx & 0xffff); // ES:DX
          for (let i = 0; i < count; i++) {
            bios.dac[(start + i) * 3] = mem.r8(p++) & 0x3f;
            bios.dac[(start + i) * 3 + 1] = mem.r8(p++) & 0x3f;
            bios.dac[(start + i) * 3 + 2] = mem.r8(p++) & 0x3f;
          }
        }
        break;
      case 0x12:                                 // alternate select / EGA info
        if ((cpu.bx & 0xff) === 0x10) { cpu.bx = 0x0003; cpu.cx = 0x0000; }  // return EGA info: BH=0 colour, BL=3 (256K), CX=switches → EGA/VGA present
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
      case 0x1a: cpu.ax = (cpu.ax & 0xff00) | 0x1a; cpu.bx = 0x0008; break; // get DCC: AL=1Ah = supported, BL=08h = VGA colour
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
  // Input Status #1 (0x3DA): a real time-based VGA beam instead of a per-read toggle, so a vsync
  // loop that measures the retrace (not just waits for an edge) sees a realistic period. The beam
  // position is cpu.cycles within one ~70 Hz mode-13h frame. bit3 = vertical retrace (short pulse
  // at frame end); bit0 = display disabled during the surrounding vblank. Reads also reset the ATC
  // index/data flip-flop.
  // Period in cycles: when a virtual CPU clock is set (browser, machine.vcpuHz cycles/second of
  // wall-clock), one 70 Hz frame is vcpuHz/70 cycles, so a throttled guest sees a real 70 Hz beam.
  // Headless (no vcpuHz, deterministic timerAuto) keeps the pitBase-derived period so golden
  // fingerprints are unchanged (period = pitBase / (70/18.2), the VGA:PIT frequency ratio).
  const vgaPeriod = machine.vcpuHz
    ? Math.max(1, Math.round(machine.vcpuHz / 70))
    : Math.max(1, Math.round((machine.pitBase || machine.pitReload) / 3.845));
  const vblankStart = Math.round(vgaPeriod * 0.88), vretraceStart = Math.round(vgaPeriod * 0.92);
  machine.onPortRead(0x3da, () => {
    if (machine.vga) machine.vga.atcFlip = 0;
    const pos = machine.cpu.cycles % vgaPeriod;
    return (pos >= vblankStart ? 0x01 : 0) | (pos >= vretraceStart ? 0x08 : 0);
  });

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
  for (const base of [0x388, 0x228]) {
    machine.onPortWrite(base, (_p, _s, v) => { oplReg = v & 0xff; });     // register select
    machine.onPortWrite(base + 1, (_p, _s, v) => oplData(v & 0xff));      // register data
    machine.onPortRead(base, () => oplStatus);                            // OPL status
  }

  // Game/joystick port 0x201: no joystick attached. Buttons (bits 4-7) read 1 = not pressed;
  // axis one-shots (bits 0-3) read 0 = timed out. Returning the default 0xFF instead left the
  // axis bits stuck high, so a game timing how long they stay high (Keen 4's joystick probe)
  // spun forever. Writes (the axis trigger) are a no-op with no joystick.
  machine.onPortRead(0x201, () => 0xf0);
  machine.onPortWrite(0x201, () => {});

  // ---- 8042 keyboard controller (ports 0x60/0x64) + IRQ1 ------------------
  // Programs that install their own INT 9h handler — QBasic's IDE, and most games — take input
  // as hardware scancodes read from port 0x60 on each keyboard IRQ, NOT via the BIOS INT 16h
  // buffer. Deliver queued keys as make/break scancodes and fire IRQ1 so those handlers see them.
  const kb = { data: 0, obf: false, scans: [] };   // scans: FIFO of pending make/break scancodes
  machine.kb = kb;
  machine.onPortRead(0x60, () => { const d = kb.data; kb.obf = false; return d; });   // read scancode, clear OBF
  machine.onPortRead(0x64, () => (kb.obf ? 0x1d : 0x1c));     // status byte; bit0 = output-buffer-full
  machine.onPortWrite(0x60, () => { kb.data = 0xfa; kb.obf = true; });   // keyboard command -> ACK
  machine.onPortWrite(0x64, () => {});                        // controller command (ignored)
  machine.onPortWrite(0x20, () => {});                        // master PIC end-of-interrupt
  machine.onPortWrite(0xa0, () => {});                        // slave PIC end-of-interrupt
  machine.pushScancodes = (arr) => { for (const s of arr) kb.scans.push(s); };
  // Deliver the next pending scancode to the guest's INT 9h handler (if one is installed) via
  // port 0x60 + IRQ1. No guest ISR -> drop them; the BIOS INT 16h / keyQueue path serves those.
  machine.pumpKeyboard = () => {
    if (kb.obf || kb.scans.length === 0) return;
    if (machine.getVector(9).seg === 0xf000) { kb.scans.length = 0; return; }   // no guest INT 9h ISR
    kb.data = kb.scans.shift(); kb.obf = true;                 // stage the scancode into port 0x60
    machine.hwIrqPending = true;                               // fire IRQ1 as soon as the guest sets IF
  };

  installVGA(machine);   // EGA/VGA planar device (Sequencer/Graphics-Controller ports + planes)

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
