// video.js — renders the active VGA mode to a canvas each frame.
//   mode 0x03  → 80×25 text (B800:0), CP437 glyphs, 16-colour attributes
//   mode 0x13  → 320×200×256 linear framebuffer (A000:0) with the DAC palette
// Everything is drawn through a native-resolution ImageData and putImageData;
// the 4:3 CRT presentation is handled in CSS so the pixels stay crisp.

const VRAM_TEXT = 0xb8000, VRAM_GFX = 0xa0000;
const COLS = 80, ROWS = 25, CW = 8, CH = 16;

export class Video {
  constructor(machine, canvas) {
    this.machine = machine;
    this.mem = machine.mem;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.font = null;                 // Uint8Array, 256 glyphs × 16 rows
    this.image = null;
    this.imgW = 0; this.imgH = 0;
    this.frame = 0;
    this.pal = new Uint32Array(256);  // ABGR
    this.scale6 = new Uint8Array(64);
    for (let i = 0; i < 64; i++) this.scale6[i] = Math.round(i * 255 / 63);
  }

  async loadFont(url) {
    const buf = await (await fetch(url)).arrayBuffer();
    this.font = new Uint8Array(buf);
  }

  _ensure(w, h) {
    if (this.imgW === w && this.imgH === h) return;
    this.canvas.width = w; this.canvas.height = h;
    this.image = this.ctx.createImageData(w, h);
    this.imgW = w; this.imgH = h;
    this.u32 = new Uint32Array(this.image.data.buffer);
  }

  _palette() {
    const dac = this.machine.bios.dac, s = this.scale6, p = this.pal;
    for (let i = 0; i < 256; i++) {
      const r = s[dac[i * 3] & 63], g = s[dac[i * 3 + 1] & 63], b = s[dac[i * 3 + 2] & 63];
      p[i] = (0xff << 24) | (b << 16) | (g << 8) | r;   // little-endian RGBA
    }
  }

  render() {
    this.frame++;
    this._palette();
    const mode = this.mem.r8(0x449);
    if (mode === 0x13) this._renderGfx13();
    else this._renderText();
    this.ctx.putImageData(this.image, 0, 0);
  }

  _renderText() {
    this._ensure(COLS * CW, ROWS * CH);
    const mem = this.mem, font = this.font, u32 = this.u32, pal = this.pal, W = this.imgW;
    if (!font) return;
    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        const cell = mem.r16(VRAM_TEXT + (row * COLS + col) * 2);
        const ch = cell & 0xff, attr = cell >> 8;
        const fg = pal[attr & 0x0f], bg = pal[(attr >> 4) & 0x07];
        const gbase = ch * CH;
        for (let y = 0; y < CH; y++) {
          const bits = font[gbase + y];
          let o = (row * CH + y) * W + col * CW;
          for (let x = 0; x < CW; x++) u32[o++] = (bits & (0x80 >> x)) ? fg : bg;
        }
      }
    }
    // blinking cursor (underline) at the BIOS cursor position
    if ((this.frame >> 4) & 1) {
      const ccol = mem.r8(0x450), crow = mem.r8(0x451);
      if (crow < ROWS && ccol < COLS) {
        const fg = pal[mem.r16(VRAM_TEXT + (crow * COLS + ccol) * 2) >> 8 & 0x0f] || pal[7];
        for (let y = CH - 3; y < CH; y++) {
          let o = (crow * CH + y) * W + ccol * CW;
          for (let x = 0; x < CW; x++) u32[o++] = fg;
        }
      }
    }
  }

  _renderGfx13() {
    this._ensure(320, 200);
    const mem = this.mem, u32 = this.u32, pal = this.pal;
    const u8 = mem.u8, base = VRAM_GFX;
    for (let i = 0; i < 320 * 200; i++) u32[i] = pal[u8[base + i]];
  }
}
