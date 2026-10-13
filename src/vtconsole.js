// vtconsole.js — the Linux console's text screen, drawn into the PC's VGA text memory.
//
// What a program writes to /dev/tty1 (after the tty's output processing, src/linux.js) appears on the
// 80x25 text screen at B8000h, with the cursor where the BIOS data area says (0450h/0451h), which is
// where src/video.js draws it — and in the CRTC's cursor location registers (0Eh/0Fh), which is where
// the VGA (and so the picture) takes it from, as the Linux console's vgacon sets them. Control characters and the escape sequences the Linux console answers
// that readline, ls --color and the like use: CR LF BS TAB BEL; CSI A B C D H f J K m, and the
// private ones they send at start-up (cursor visibility, modes), which are accepted and ignored.
const COLS = 80, ROWS = 25, TEXT = 0xb8000;
const ANSI_TO_VGA = [0, 4, 2, 6, 1, 5, 3, 7];             // ANSI black red green yellow blue magenta cyan white

export class VtConsole {
  constructor(u8, vga = null) {
    this.u8 = u8; this.vga = vga; this.fg = 7; this.bg = 0; this.bold = false; this.rev = false;
    this.state = 0; this.params = ''; this.saved = [0, 0];
  }
  get attr() {
    let fg = this.fg | (this.bold ? 8 : 0), bg = this.bg;
    if (this.rev) [fg, bg] = [bg, fg & 7];
    return (bg << 4) | fg;
  }
  get col() { return this.u8[0x450]; } set col(v) { this.u8[0x450] = Math.max(0, Math.min(COLS - 1, v)); }
  get row() { return this.u8[0x451]; } set row(v) { this.u8[0x451] = Math.max(0, Math.min(ROWS - 1, v)); }
  cell(r, c, ch, a = this.attr) { const at = TEXT + (r * COLS + c) * 2; this.u8[at] = ch; this.u8[at + 1] = a; }
  clear(from = 0, to = COLS * ROWS) { for (let i = from; i < to; i++) { this.u8[TEXT + i * 2] = 32; this.u8[TEXT + i * 2 + 1] = this.attr; } }
  scroll() {
    this.u8.copyWithin(TEXT, TEXT + COLS * 2, TEXT + COLS * ROWS * 2);
    this.clear(COLS * (ROWS - 1), COLS * ROWS);
  }
  lf() { if (this.row === ROWS - 1) this.scroll(); else this.row = this.row + 1; }
  write(bytes) { for (const b of bytes) this.put(b); this.syncCursor(); }
  /** Where the cursor is drawn: the CRTC's location registers, relative to the display start. */
  syncCursor() {
    const v = this.vga; if (!v || !v.crtc) return;
    const loc = (v.startAddr ? v.startAddr() : 0) + this.row * COLS + Math.min(this.col, COLS - 1);
    v.crtc[0x0e] = (loc >> 8) & 0xff; v.crtc[0x0f] = loc & 0xff;
  }
  put(b) {
    if (this.state === 1) {                                              // after ESC
      if (b === 0x5b) { this.state = 2; this.params = ''; return; }      // CSI
      this.state = 0;
      if (b === 0x37) this.saved = [this.row, this.col];                 // ESC 7 / ESC 8: save, restore
      else if (b === 0x38) [this.row, this.col] = this.saved;
      else if (b === 0x63) { this.fg = 7; this.bg = 0; this.bold = this.rev = false; this.clear(); this.row = 0; this.col = 0; }   // ESC c
      return;
    }
    if (this.state === 2) {                                              // in a CSI sequence
      if ((b >= 0x30 && b <= 0x3f)) { this.params += String.fromCharCode(b); return; }
      this.state = 0; this.csi(String.fromCharCode(b), this.params); return;
    }
    switch (b) {
      case 0x1b: this.state = 1; return;
      case 13: this.col = 0; return;
      case 10: case 11: case 12: this.lf(); return;
      case 8: if (this.col > 0) this.col = this.col - 1; return;
      case 9: this.col = Math.min(COLS - 1, (this.col & ~7) + 8); return;
      case 7: return;
      default:
        if (b < 32) return;
        if (this.col >= COLS) { this.col = 0; this.lf(); }
        this.cell(this.row, this.col, b);
        if (this.col === COLS - 1) { this.u8[0x450] = COLS; return; }    // pending wrap, as a VT does
        this.col = this.col + 1;
    }
  }
  csi(f, p) {
    if (p.startsWith('?')) return;                                       // private modes: cursor, wrap...
    const n = p.split(';').map((x) => parseInt(x, 10));
    const a = Number.isNaN(n[0]) ? 0 : n[0], a1 = a || 1;
    const here = this.row * COLS + Math.min(this.col, COLS - 1);
    switch (f) {
      case 'A': this.row = this.row - a1; break;
      case 'B': this.row = this.row + a1; break;
      case 'C': this.col = Math.min(this.col, COLS - 1) + a1; break;
      case 'D': this.col = Math.min(this.col, COLS - 1) - a1; break;
      case 'G': this.col = a1 - 1; break;
      case 'd': this.row = a1 - 1; break;
      case 'H': case 'f': this.row = (a || 1) - 1; this.col = (n[1] || 1) - 1; break;
      case 'J': if (a === 2 || a === 3) this.clear(); else if (a === 1) this.clear(0, here + 1); else this.clear(here); break;
      case 'K': { const s = this.row * COLS; if (a === 2) this.clear(s, s + COLS); else if (a === 1) this.clear(s, here + 1); else this.clear(here, s + COLS); break; }
      case 'P': { const s = this.row * COLS, c = Math.min(this.col, COLS - 1);   // delete characters
        this.u8.copyWithin(TEXT + (s + c) * 2, TEXT + (s + c + a1) * 2, TEXT + (s + COLS) * 2); this.clear(s + COLS - a1, s + COLS); break; }
      case '@': { const s = this.row * COLS, c = Math.min(this.col, COLS - 1);   // insert blanks
        this.u8.copyWithin(TEXT + (s + c + a1) * 2, TEXT + (s + c) * 2, TEXT + (s + COLS - a1) * 2); this.clear(s + c, s + c + a1); break; }
      case 'm':
        for (const v of (p ? n : [0]).map((x) => (Number.isNaN(x) ? 0 : x))) {
          if (v === 0) { this.fg = 7; this.bg = 0; this.bold = this.rev = false; }
          else if (v === 1) this.bold = true; else if (v === 22) this.bold = false;
          else if (v === 7) this.rev = true; else if (v === 27) this.rev = false;
          else if (v >= 30 && v <= 37) this.fg = ANSI_TO_VGA[v - 30]; else if (v === 39) this.fg = 7;
          else if (v >= 40 && v <= 47) this.bg = ANSI_TO_VGA[v - 40]; else if (v === 49) this.bg = 0;
          else if (v >= 90 && v <= 97) { this.fg = ANSI_TO_VGA[v - 90]; this.bold = true; }
        }
        break;
      default: break;
    }
  }
}
