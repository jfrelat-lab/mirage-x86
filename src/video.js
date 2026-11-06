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
    this.machine.font = this.font;   // 8×16 — text mode 3 + VGA-graphics INT 10h text
    // the 8×8 (CGA / 200-line graphics text) and 8×14 (EGA text) ROM fonts, extracted graphically
    // from DOSBox (tools/build-fonts.mjs). Optional — drawGlyphCGA falls back to the 8×16 downsample.
    try { this.machine.font8x8 = new Uint8Array(await (await fetch(url.replace('8x16', '8x8'))).arrayBuffer()); } catch { /* fallback */ }
    try { this.machine.font8x14 = new Uint8Array(await (await fetch(url.replace('8x16', '8x14'))).arrayBuffer()); } catch { /* optional */ }
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
    // The card reads memory PHYSICALLY, and so must we: under a paging OS the guest's linear page 0
    // may be unmapped (Linux), and the BDA and B8000 read through it threw a #PF out of render().
    const mode = this.mem.u8[0x449];
    if (this.machine.vbe) this._renderVBE();
    // 256 colours is a state of the CARD (GC 05h bit 6 + GC 06h bit 0), whatever the BDA says: Windows
    // 9x's IO.SYS draws its logo in 320x400 unchained and then writes 03h into 0040:0049, so the byte
    // this used to dispatch on sent the logo through the text renderer's neighbours as stripes.
    else if (mode === 0x13 || this._card256()) {
      const v = this.machine.vga;
      if (v && (v.modeX || (this._card256() && !(v.memMode & 0x08)))) this._renderModeX(); else this._renderGfx13();
    }
    else if (this.mem.planar && this.machine.vga) this._renderPlanar();
    else if (mode === 4 || mode === 5 || mode === 6) this._renderCGA(mode);
    else this._renderText();
    this.ctx.putImageData(this.image, 0, 0);
  }

  // VESA VBE: the framebuffer is plain RAM at vbe.base, one packed pixel per 1/2/4 bytes. 8 bpp goes
  // through the DAC like mode 13h; 16 bpp is 5:6:5 and 32 bpp is 8:8:8:8, matching what 4F01 reports
  // in the ModeInfoBlock — a client picks its mode from those masks, so they have to agree.
  _renderVBE() {
    const v = this.machine.vbe, W = v.width, H = v.height;
    this._ensure(W, H);
    const u32 = this.u32, pal = this.pal, u8 = this.mem.u8, base = v.base, pitch = v.pitch;
    for (let y = 0; y < H; y++) {
      let src = base + y * pitch, dst = y * W;
      if (v.bpp === 8) { for (let x = 0; x < W; x++) u32[dst++] = pal[u8[src++]]; }
      else if (v.bpp === 16) {
        for (let x = 0; x < W; x++, src += 2) {
          const p = u8[src] | (u8[src + 1] << 8);
          const r = ((p >> 11) & 31) * 255 / 31, g = ((p >> 5) & 63) * 255 / 63, b = (p & 31) * 255 / 31;
          u32[dst++] = (0xff << 24) | ((b | 0) << 16) | ((g | 0) << 8) | (r | 0);
        }
      } else if (v.bpp === 15) {                                   // 1:5:5:5, a Cirrus's hidden DAC can choose it
        for (let x = 0; x < W; x++, src += 2) {
          const p = u8[src] | (u8[src + 1] << 8);
          const r = ((p >> 10) & 31) * 255 / 31, g = ((p >> 5) & 31) * 255 / 31, b = (p & 31) * 255 / 31;
          u32[dst++] = (0xff << 24) | ((b | 0) << 16) | ((g | 0) << 8) | (r | 0);
        }
      } else if (v.bpp === 24) {
        for (let x = 0; x < W; x++, src += 3) u32[dst++] = (0xff << 24) | (u8[src] << 16) | (u8[src + 1] << 8) | u8[src + 2];
      } else {
        for (let x = 0; x < W; x++, src += 4) u32[dst++] = (0xff << 24) | (u8[src] << 16) | (u8[src + 1] << 8) | u8[src + 2];
      }
    }
    if (v.cirrus && this.machine.cirrus) this.machine.cirrus.drawCursor(u32, W, H);   // the chip's hardware cursor (src/cirrus.js)
  }

  // EGA/VGA 16-colour planar: assemble each pixel's 4-bit index from the four bit-planes,
  // map it through the attribute palette to a DAC entry, then to RGB.
  _renderPlanar() {
    const vga = this.machine.vga;
    // With a real VGA ROM the size is the CRTC's (no setMode ran); otherwise the mode's table.
    // Its height is the CRTC's too, double scan included (09h bit 7): Pinball Fantasies sets mode 12h,
    // then doubles every line for a 640x240 menu; drawn at the mode's 480 lines, its lower half was the
    // memory below the screen.
    const hwd = vga.hw ? vga.crtcDims() : null;
    const W = hwd && hwd.w >= 64 ? hwd.w : vga.width, H = hwd && hwd.h >= 64 ? hwd.h : (vga.crtc ? this._modeXHeight(vga) : vga.height);
    this._ensure(W, H);
    const u32 = this.u32, pal = this.pal, planes = vga.planes, palr = vga.palette;
    // Honour the CRTC display-start (page-flip / hardware scroll) and the offset register
    // (logical scanline width, often wider than the visible area for smooth scrolling) —
    // without these a scrolling game like Keen reads the wrong bytes and shears into stripes.
    const stride = vga.rowBytes(), start = vga.startAddr(), visBytes = W >> 3;
    for (let y = 0; y < H; y++) {
      const rowOff = (start + y * stride) & 0xffff;
      for (let xb = 0; xb < visBytes; xb++) {
        const off = (rowOff + xb) & 0xffff;
        const b0 = planes[off], b1 = planes[0x10000 + off], b2 = planes[0x20000 + off], b3 = planes[0x30000 + off];
        let o = y * W + xb * 8;
        for (let m = 0x80; m; m >>= 1) {
          const idx = ((b0 & m) ? 1 : 0) | ((b1 & m) ? 2 : 0) | ((b2 & m) ? 4 : 0) | ((b3 & m) ? 8 : 0);
          u32[o++] = pal[palr[idx] & 0x3f];
        }
      }
    }
  }

  _renderText() {
    // A colour nibble goes through the attribute-controller palette, then the DAC, as on a VGA. It
    // indexed the DAC directly, which is right only while the DAC's first 16 entries ARE the 16
    // colours: after an INT 10h AX=0003h the DAC holds the 64-colour EGA table, and colour 6 came
    // out dark yellow (DAC 6) instead of brown (AC 6 = 14h -> DAC 14h), 8-15 in the wrong hues.
    const vga = this.machine.vga, hw = !!(vga && vga.hw), ac = vga ? vga.palette : null;
    const ci = ac ? (n) => ac[n] & 0x3f : (n) => n;
    // The card and the BDA are the truth, whoever programs them (our INT 10h keeps them, a real ROM
    // does, Linux's vgacon writes the CRTC itself): columns 044Ah, rows 0484h, blink AC 10h bit 3,
    // display start CRTC 0Ch/0Dh (hardware scrolling), cursor CRTC 0Ah/0Bh/0Eh/0Fh.
    // The size is the CRTC's when it is programmed, as the card draws it: Horizontal Display End + 1
    // columns, Vertical Display End + 1 scanlines over the character height (09h bits 0-4 + 1). The
    // BDA is ordinary RAM: 386BSD zeroes physical page 0, and 0040:0084 = 0 drew ONE row of its
    // console (QEMU, whose BDA reads mode 0 there too, draws the CRTC's 80x25). The BDA stays the
    // fallback for a CRTC nobody loaded (our POST, our modes 0, 1 and 7) -- and a zeroed BDA, which
    // no BIOS leaves (rows - 1 = 0 is a one-row screen), falls back to 80x25.
    const u8 = this.mem.u8, p16 = (a) => u8[a] | (u8[a + 1] << 8);
    const td = vga ? this._textDims(vga) : null;
    const cols = td ? td.cols : vga ? (p16(0x44a) || COLS) : COLS;
    const rows = td ? td.rows : vga && u8[0x484] ? u8[0x484] + 1 : ROWS;
    this._ensure(cols * CW, rows * CH);
    const mem = this.mem, font = this.font, u32 = this.u32, pal = this.pal, W = this.imgW;
    if (!font) return;
    const blinkMode = vga ? !!(vga.atc[0] & 0x08) : (this.machine.bios ? this.machine.bios.blink : true);
    const base = VRAM_TEXT + (vga ? (vga.startAddr() * 2) & 0x7fff : 0);
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const cell = p16(base + (row * cols + col) * 2);
        const ch = cell & 0xff, attr = cell >> 8;
        const bg = pal[ci((attr >> 4) & (blinkMode ? 0x07 : 0x0f))];
        // while blinking and in the "off" phase the glyph is drawn in the background colour
        const hidden = blinkMode && (attr & 0x80) && !((this.frame >> 4) & 1);
        const fg = hidden ? bg : pal[ci(attr & 0x0f)];
        const gbase = ch * CH;
        for (let y = 0; y < CH; y++) {
          const bits = font[gbase + y];
          let o = (row * CH + y) * W + col * CW;
          for (let x = 0; x < CW; x++) u32[o++] = (bits & (0x80 >> x)) ? fg : bg;
        }
      }
    }
    // blinking cursor (underline) at the BIOS cursor position — or, with a real ROM, where the CRTC
    // puts it: location 0Eh/0Fh, shape 0Ah (bit 5 = off) / 0Bh.
    let cur = this.machine.bios && this.machine.bios.cursor, ccol = u8[0x450], crow = u8[0x451];
    if (vga) {
      const c = vga.crtc, loc = ((c[0x0e] << 8) | c[0x0f]) - vga.startAddr();
      cur = { start: c[0x0a] & 0x1f, end: c[0x0b] & 0x1f, hidden: (c[0x0a] & 0x20) !== 0 || (c[0x0a] & 0x1f) > (c[0x0b] & 0x1f) };
      ccol = loc % cols; crow = Math.floor(loc / cols);
    }
    if (((this.frame >> 4) & 1) && !(cur && cur.hidden)) {
      if (crow >= 0 && crow < rows && ccol < cols) {
        const fg = pal[ci(p16(base + (crow * cols + ccol) * 2) >> 8 & 0x0f)] || pal[7];
        const y0 = cur ? Math.min(cur.start, CH - 1) : CH - 3, y1 = cur ? Math.min(cur.end, CH - 1) : CH - 1;
        for (let y = y0; y <= y1; y++) {
          let o = (crow * CH + y) * W + ccol * CW;
          for (let x = 0; x < CW; x++) u32[o++] = fg;
        }
      }
    }
  }

  /** Text columns and rows as the CRTC defines them, or null when it is not programmed for text (our
   *  POST loads no CRTC, and our mode set no table for modes 0, 1 and 7: those registers stay zero). */
  _textDims(vga) {
    const c = vga.crtc; if (!c || !c[0x01] || !c[0x12]) return null;
    const ov = c[0x07], cols = c[0x01] + 1;
    let lines = (c[0x12] | (((ov >> 1) & 1) << 8) | (((ov >> 6) & 1) << 9)) + 1;
    if (c[0x09] & 0x80) lines >>= 1;
    const rows = Math.floor(lines / ((c[0x09] & 0x1f) + 1));
    return cols >= 20 && cols <= 132 && rows >= 1 && rows <= 100 ? { cols, rows } : null;
  }

  _renderGfx13() {
    const vga = this.machine.vga, W = vga && vga.crtc ? this._gfx256Width(vga) : 320, H = vga && vga.crtc ? this._modeXHeight(vga) : 200;
    this._ensure(W, H);
    const mem = this.mem, u32 = this.u32, pal = this.pal;
    const u8 = mem.u8, base = VRAM_GFX;
    // Chained mode 13h stride = CRTC Offset(0x13) × 8 (offset counts planar-address pairs;
    // ×2 for the pair, ×4 for the 4 chained planes). Standard 13h offset=40 → 320, so every
    // ordinary intro keeps the plain linear read below. Demos that re-program the offset for a
    // wider virtual page (Helium: offset=32 → 256-byte lines) or page-flip via the start address
    // take the general path. start address is in planar dwords → ×4 to reach a linear byte.
    const off = vga && vga.crtc ? vga.crtc[0x13] : 0;
    const stride = off ? off * 8 : 320;
    const start = vga && vga.startAddr ? (vga.startAddr() << 2) : 0;
    if (stride === 320 && start === 0 && W === 320 && H === 200) { for (let i = 0; i < 320 * 200; i++) u32[i] = pal[u8[base + i]]; return; }
    for (let y = 0, o = 0; y < H; y++) { const row = (start + y * stride) & 0xffff; for (let x = 0; x < W; x++) u32[o++] = pal[u8[base + ((row + x) & 0xffff)]]; }
  }

  // Mode-X (unchained 256-colour): pixel (x,y) lives in plane (x&3) at plane-offset
  // start + y*stride + (x>>2). Each plane byte is a full 8-bit palette index. Wolf3D
  // ("Mode Y", 320×200) and Pinball Fantasies draw this way.
  _card256() {
    const v = this.machine.vga;
    return !!(v && (v.gc[5] & 0x40) && (v.gc[6] & 0x01));
  }

  /** Pixels a 256-colour mode shows across: character clocks up to the horizontal display end (01h)
   *  + 1 or the start of horizontal blanking (02h), whichever comes first — blanking wins over the
   *  display on a VGA — 4 pixels each (the dot clock is halved, two dots a pixel). 80 → 320 for mode
   *  13h and Mode X. Helium ends the display at 72 and blanks from 63: DOSBox-X's capture of it is
   *  252 pixels wide (QEMU ignores the blanking and shows 288, the hidden 36 included); this drew the
   *  standard 320 and squashed the picture. Falls back when the CRTC is unset. */
  _gfx256Width(vga) {
    const c = vga.crtc, hde = (c[0x01] & 0xff) + 1, hbs = c[0x02] & 0xff;
    const w = (hbs && hbs < hde ? hbs : hde) * 4;
    return w >= 128 && w <= 400 ? w : 320;
  }

  /** Scanlines a 256-colour unchained mode shows, from the CRTC as the card counts them: the vertical
   *  display end, over (max scan line + 1), halved again by double scan. 200 for Mode X, 400 for the
   *  "Mode Y" Windows 9x paints its logo in (CRTC 09h = 40h). Falls back when the CRTC is unset. */
  _modeXHeight(vga) {
    const c = vga.crtc, ov = c[0x07];
    const vde = (c[0x12] | (((ov >> 1) & 1) << 8) | (((ov >> 6) & 1) << 9)) + 1;
    let h = Math.floor(vde / ((c[0x09] & 0x1f) + 1));   // vertical blanking not applied: DOSBox-X does not either
    if (c[0x09] & 0x80) h >>= 1;
    return h >= 100 && h <= 512 ? h : (vga.height || 200);
  }

  _renderModeX() {
    const vga = this.machine.vga, W = this._gfx256Width(vga), H = this._modeXHeight(vga);
    this._ensure(W, H);
    const u32 = this.u32, pal = this.pal, planes = vga.planes, PLANE = 0x10000;
    const stride = vga.crtc[0x13] ? vga.crtc[0x13] * 2 : (W >> 2);   // plane-offset addresses per scanline (320px → 80)
    const start = vga.startAddr();
    for (let y = 0; y < H; y++) {
      const rowOff = (start + y * stride) & 0xffff;
      let o = y * W;
      for (let x = 0; x < W; x++) u32[o++] = pal[planes[((x & 3) * PLANE) + ((rowOff + (x >> 2)) & 0xffff)]];
    }
  }

  // CGA graphics (modes 4/5 = 320×200×4-colour, 2 bits/pixel; mode 6 = 640×200 mono, 1 bit/pixel).
  // The B800 framebuffer is interleaved: even scanlines at +0x0000, odd at +0x2000, 80 bytes/row.
  // Colours come from the 0x3D9 colour-select register mapped onto DAC entries 0-15 (the CGA hues).
  _renderCGA(mode) {
    const u8 = this.mem.u8, base = VRAM_TEXT, pal = this.pal;
    const color = (this.machine.bios.cga || { color: 0x30 }).color;
    if (mode === 6) {                                   // 640×200 mono
      this._ensure(640, 200);
      const u32 = this.u32, fg = pal[(color & 0x0f) || 15], bg = pal[0];
      for (let y = 0; y < 200; y++) {
        const row = ((y & 1) ? 0x2000 : 0) + (y >> 1) * 80; let o = y * 640;
        for (let xb = 0; xb < 80; xb++) { const b = u8[base + row + xb]; for (let bit = 7; bit >= 0; bit--) u32[o++] = (b >> bit) & 1 ? fg : bg; }
      }
      return;
    }
    this._ensure(320, 200);                             // modes 4/5: 320×200×4
    const u32 = this.u32;
    const hi = (color & 0x10) ? 8 : 0;                  // intensity → bright hues
    const set = (color & 0x20) ? [3, 5, 7] : [2, 4, 6]; // cyan/magenta/white  vs  green/red/brown
    // On a VGA the four pixel values go through attribute registers 0-3 and the DAC, like every other
    // mode — AH=0Bh and port 3D9h write those registers (bios.js cgaToAttr), and a program may set
    // them or the DAC directly (GentleOS reads registers 0 and 3 with AX=1007h and reprograms the two
    // DAC entries behind them). Without a VGA, the colour-select register picks the CGA hues.
    const ac = this.machine.vga && this.machine.vga.palette;
    const lut = ac ? [pal[ac[0] & 0x3f], pal[ac[1] & 0x3f], pal[ac[2] & 0x3f], pal[ac[3] & 0x3f]]
      : [pal[color & 0x0f], pal[set[0] + hi], pal[set[1] + hi], pal[set[2] + hi]];  // idx 0 = background
    for (let y = 0; y < 200; y++) {
      const row = ((y & 1) ? 0x2000 : 0) + (y >> 1) * 80; let o = y * 320;
      for (let xb = 0; xb < 80; xb++) {
        const b = u8[base + row + xb];
        u32[o++] = lut[(b >> 6) & 3]; u32[o++] = lut[(b >> 4) & 3]; u32[o++] = lut[(b >> 2) & 3]; u32[o++] = lut[b & 3];
      }
    }
  }
}
