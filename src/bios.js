// bios.js — ROM-BIOS services: INT 10h (video), INT 16h (keyboard), INT 1Ah
// (timer), INT 11h/12h (equipment/memory). Maintains the BIOS Data Area at
// 0040:0000 and the 80x25 text screen at B800:0000. The text routines are
// exposed so the JS shell prints through the exact same path as guest code.

import { ZF } from './cpu.js';

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

  // ---- cursor (page 0) at BDA 0x50 (col), 0x51 (row) ----
  const getCol = () => mem.r8(BDA + 0x50), getRow = () => mem.r8(BDA + 0x51);
  const setCur = (col, row) => { mem.w8(BDA + 0x50, col & 0xff); mem.w8(BDA + 0x51, row & 0xff); };
  bios.getCursor = () => ({ col: getCol(), row: getRow() });
  bios.setCursor = (row, col) => setCur(col, row);

  function scroll(attr) {
    for (let i = 0; i < (ROWS - 1) * COLS; i++) {
      mem.w16(VRAM + i * 2, mem.r16(VRAM + (i + COLS) * 2));
    }
    const blank = 0x20 | (attr << 8);
    for (let i = (ROWS - 1) * COLS; i < ROWS * COLS; i++) mem.w16(VRAM + i * 2, blank);
  }

  function clearScreen(attr) {
    const blank = 0x20 | ((attr & 0xff) << 8);
    for (let i = 0; i < ROWS * COLS; i++) mem.w16(VRAM + i * 2, blank);
    setCur(0, 0);
  }
  bios.clearScreen = clearScreen;

  function teletype(ch, attr = bios.attr) {
    let col = getCol(), row = getRow();
    if (ch === 0x0d) col = 0;
    else if (ch === 0x0a) row++;
    else if (ch === 0x08) { if (col > 0) col--; }
    else if (ch === 0x07) { /* bell */ }
    else if (ch === 0x09) { col = (col + 8) & ~7; }
    else {
      mem.w16(VRAM + (row * COLS + col) * 2, (ch & 0xff) | (attr << 8));
      col++;
    }
    if (col >= COLS) { col = 0; row++; }
    if (row >= ROWS) { scroll(attr); row = ROWS - 1; }
    setCur(col, row);
  }
  bios.teletype = teletype;
  bios.writeString = (s, attr) => { for (let i = 0; i < s.length; i++) teletype(typeof s === 'string' ? s.charCodeAt(i) : s[i], attr); };

  // ---- INT 10h: video ----
  machine.hookInterrupt(0x10, (cpu) => {
    const ah = cpu.ah;
    switch (ah) {
      case 0x00: {                              // set video mode
        bios.mode = cpu.al & 0x7f;
        mem.w8(BDA + 0x49, bios.mode);
        if (!(cpu.al & 0x80)) {                 // high bit set = keep screen
          if (bios.mode === 0x13) for (let i = 0; i < 320 * 200; i++) mem.w8(0xa0000 + i, 0);
          else clearScreen(0x07);
        }
        if (bios.onModeChange) bios.onModeChange(bios.mode);
        break;
      }
      case 0x01: break;                          // set cursor shape (ignored)
      case 0x02: setCur(cpu.dx & 0xff, (cpu.dx >> 8) & 0xff); break; // set cursor pos
      case 0x03: cpu.dx = (getRow() << 8) | getCol(); cpu.cx = 0x0607; break; // get cursor
      case 0x05: mem.w16(BDA + 0x62, cpu.al); break; // set active page
      case 0x06: case 0x07: {                    // scroll window (simplified: whole screen)
        const lines = cpu.al, bh = (cpu.bx >> 8) & 0xff;
        if (lines === 0) clearScreen(bh);
        else for (let i = 0; i < lines; i++) scroll(bh);
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
      case 0x0e: teletype(cpu.al); break;        // teletype
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
      case 0x12: break;                          // alternate select
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
      case 0x1a: cpu.ax = 0x1a00; cpu.bx = 0x0008; break; // display combination = VGA
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

  machine.bios = bios;
  return bios;
}

function defaultPalette(dac) {
  // 16 CGA/EGA colours expanded to 6-bit DAC, then a 6-6-4-ish ramp for the rest.
  const base = [
    [0, 0, 0], [0, 0, 42], [0, 42, 0], [0, 42, 42], [42, 0, 0], [42, 0, 42], [42, 21, 0], [42, 42, 42],
    [21, 21, 21], [21, 21, 63], [21, 63, 21], [21, 63, 63], [63, 21, 21], [63, 21, 63], [63, 63, 21], [63, 63, 63],
  ];
  for (let i = 0; i < 16; i++) { dac[i * 3] = base[i][0]; dac[i * 3 + 1] = base[i][1]; dac[i * 3 + 2] = base[i][2]; }
  for (let i = 16; i < 256; i++) {
    const j = i - 16;
    dac[i * 3] = ((j >> 5) & 7) * 9;
    dac[i * 3 + 1] = ((j >> 2) & 7) * 9;
    dac[i * 3 + 2] = (j & 3) * 21;
  }
}
