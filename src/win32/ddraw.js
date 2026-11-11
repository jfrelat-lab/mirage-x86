// ddraw.js — DirectDraw (the interfaces of DirectX 1-3) for MIRAGE-WIN32: ddraw.dll, its COM objects made
// here as dsound.js makes DirectSound's (a pointer to a vtable of stubs that trap into the functions
// below, `this` first).
//
// The full-screen 2D of 1995-2002: a program takes the display (SetCooperativeLevel, SetDisplayMode),
// makes a primary surface with a back buffer to flip, or an off-screen surface it locks and draws into,
// attaches a palette in 8-bit modes, and copies (Blt, BltFast) and flips. Surfaces are memory of the
// program's (Lock hands it the pointer); what reaches the PRIMARY surface -- a flip, an unlock, a copy
// into it, a palette changed under it -- is converted to the screen's colours (the palette in 8 bits,
// 5:6:5 in 16, x8r8g8b8 in 32) and shown through the window manager (src/win32/wm.js), full screen.
// Quake II's ref_soft.dll is the first program here to use it. Layouts: ddraw.h (Wine's include/).

const DD_OK = 0, E_NOINTERFACE = 0x80004002, DDERR_INVALIDPARAMS = 0x80070057, DDERR_NOTFOUND = 0x887600ff;

const UNK = 'QueryInterface:2 AddRef:0 Release:0';
const VTABLES = {
  IDirectDraw: `${UNK} Compact:0 CreateClipper:3 CreatePalette:4 CreateSurface:3 DuplicateSurface:2 EnumDisplayModes:4
    EnumSurfaces:4 FlipToGDISurface:0 GetCaps:2 GetDisplayMode:1 GetFourCCCodes:2 GetGDISurface:1 GetMonitorFrequency:1
    GetScanLine:1 GetVerticalBlankStatus:1 Initialize:1 RestoreDisplayMode:0 SetCooperativeLevel:2 SetDisplayMode:3
    WaitForVerticalBlank:2`,
  IDirectDrawSurface: `${UNK} AddAttachedSurface:1 AddOverlayDirtyRect:1 Blt:5 BltBatch:3 BltFast:5 DeleteAttachedSurface:2
    EnumAttachedSurfaces:2 EnumOverlayZOrders:3 Flip:2 GetAttachedSurface:2 GetBltStatus:1 GetCaps:1 GetClipper:1
    GetColorKey:2 GetDC:1 GetFlipStatus:1 GetOverlayPosition:2 GetPalette:1 GetPixelFormat:1 GetSurfaceDesc:1 Initialize:2
    IsLost:0 Lock:4 ReleaseDC:1 Restore:0 SetClipper:1 SetColorKey:2 SetOverlayPosition:2 SetPalette:1 Unlock:1
    UpdateOverlay:5 UpdateOverlayDisplay:1 UpdateOverlayZOrder:2`,
  IDirectDrawPalette: `${UNK} GetCaps:1 GetEntries:4 Initialize:3 SetEntries:4`,
  IDirectDrawClipper: `${UNK} GetClipList:3 GetHWnd:1 Initialize:2 IsClipListChanged:1 SetClipList:2 SetHWnd:2`,
};
const METHODS = Object.fromEntries(Object.entries(VTABLES).map(([i, s]) => [i, s.trim().split(/\s+/).map((t) => t.split(':'))]));

const DDSD_CAPS = 1, DDSD_HEIGHT = 2, DDSD_WIDTH = 4, DDSD_PITCH = 8, DDSD_BACKBUFFERCOUNT = 0x20, DDSD_LPSURFACE = 0x800, DDSD_PIXELFORMAT = 0x1000;
const DDSCAPS_BACKBUFFER = 4, DDSCAPS_FLIP = 0x10, DDSCAPS_FRONTBUFFER = 0x20, DDSCAPS_OFFSCREENPLAIN = 0x40, DDSCAPS_PRIMARYSURFACE = 0x200, DDSCAPS_SYSTEMMEMORY = 0x800;
const DDBLT_COLORFILL = 0x400, DDBLT_KEYSRC = 0x8000, DDBLTFAST_SRCCOLORKEY = 1;

/** `st`: the window state (its size, the display mode); `wm`: the window manager, which shows a frame;
 *  `send`: calls into the program (EnumDisplayModes' callback), as user32's sent messages do. */
export function ddrawApis(st, wm, send) {
  const objs = new Map(), vtables = new Map();
  const make = (x, iface, props) => {
    if (!vtables.has(iface)) {
      const mod = x.win.load('ddraw.dll'), ms = METHODS[iface], v = x.win.heapAlloc(ms.length * 4);
      ms.forEach(([n], i) => x.w32(v + 4 * i, mod.exports.get(`${iface}::${n}`)));
      vtables.set(iface, v);
    }
    const p = x.win.heapAlloc(16);
    x.w32(p, vtables.get(iface));
    objs.set(p, { iface, ref: 1, ...props });
    return p;
  };
  const o = (p) => objs.get(p >>> 0);
  const mode = { w: 640, h: 480, bpp: 8 };
  // The display: the program's mode once it set one (full screen), else the desktop, 32 bits as GDI
  // reports it -- a windowed program's primary surface is the whole screen, its window somewhere on it.
  const display = () => (st.modeSet ? mode : { w: st.desk.w, h: st.desk.h, bpp: 32 });

  // ---- surfaces: memory of the program's, a pitch rounded to 4 bytes ------------------------------
  const surface = (x, w, h, bpp, props = {}) => {
    const pitch = ((w * (bpp >> 3)) + 3) & ~3, mem = x.win.heapAlloc(pitch * h);
    x.write(mem, new Uint8Array(pitch * h));
    return make(x, 'IDirectDrawSurface', { w, h, bpp, pitch, mem, key: null, palette: 0, ...props });
  };
  // DDPIXELFORMAT (32 bytes at `p`): RGB, its bit count and masks; PALETTEINDEXED8 in 8 bits.
  const putFormat = (x, p, bpp) => {
    x.write(p, new Uint8Array(32)); x.w32(p, 32);
    x.w32(p + 4, bpp === 8 ? 0x60 : 0x40); x.w32(p + 12, bpp);    // DDPF_PALETTEINDEXED8 | RGB, or RGB
    const masks = bpp === 16 ? [0xf800, 0x7e0, 0x1f] : bpp >= 24 ? [0xff0000, 0xff00, 0xff] : [0, 0, 0];
    masks.forEach((m, i) => x.w32(p + 16 + 4 * i, m));
  };
  // DDSURFACEDESC (108 bytes): what Lock and GetSurfaceDesc fill, the surface's pointer when locked.
  const putDesc = (x, p, s, at) => {
    const size = x.r32(p) || 108;
    x.write(p, new Uint8Array(Math.min(size, 124))); x.w32(p, size);
    x.w32(p + 4, DDSD_CAPS | DDSD_HEIGHT | DDSD_WIDTH | DDSD_PITCH | DDSD_PIXELFORMAT | (at ? DDSD_LPSURFACE : 0));
    x.w32(p + 8, s.h); x.w32(p + 12, s.w); x.w32(p + 16, s.pitch); if (at) x.w32(p + 36, at);
    putFormat(x, p + 72, s.bpp);
    x.w32(p + 104, s.primary ? DDSCAPS_PRIMARYSURFACE | DDSCAPS_FRONTBUFFER : s.back ? DDSCAPS_BACKBUFFER : DDSCAPS_OFFSCREENPLAIN | DDSCAPS_SYSTEMMEMORY);
  };
  // A RECT (left, top, right, bottom) or the whole surface.
  const rect = (x, p, s) => (p ? { l: x.r32(p) | 0, t: x.r32(p + 4) | 0, r: x.r32(p + 8) | 0, b: x.r32(p + 12) | 0 } : { l: 0, t: 0, r: s.w, b: s.h });

  // ---- the screen: the primary surface's pixels in the screen's colours ----------------------------
  const primary = () => [...objs.values()].find((s) => s.primary);
  // Full screen the whole surface is the picture; on the desktop (no mode set) the window's client area
  // is cut from it where the window is -- Cave Story in a window blits its frame there, through a clipper.
  const show = (x) => {
    const s = primary(); if (!s) return;
    const c = s.desktop && !st.modeSet ? (wm.framed() ? wm.client() : { x: st.x | 0, y: st.y | 0, w: st.w, h: st.h }) : { x: 0, y: 0, w: s.w, h: s.h };
    const px = new Uint32Array(c.w * c.h), B = s.bpp >> 3;
    const pal = s.palette && o(s.palette) ? o(s.palette).colors : null;
    for (let j = 0; j < c.h; j++) {
      const y = c.y + j; if (y < 0 || y >= s.h) continue;
      const raw = x.bytes(s.mem + y * s.pitch, s.pitch);
      for (let i = 0; i < c.w; i++) {
        const X = c.x + i; if (X < 0 || X >= s.w) continue;
        const a = X * B;
        if (B === 1) px[j * c.w + i] = pal ? pal[raw[a]] : raw[a] * 0x010101;
        else if (B === 2) { const v = raw[a] | raw[a + 1] << 8; px[j * c.w + i] = ((v >> 11) & 31) << 19 | ((v >> 5) & 63) << 10 | (v & 31) << 3; }   // 5:6:5
        else px[j * c.w + i] = raw[a + 2] << 16 | raw[a + 1] << 8 | raw[a];
      }
    }
    wm.present(x.lx, { w: c.w, h: c.h, px });
  };

  // ---- copies between surfaces: same depth, nearest pixels when the sizes differ, a source colour key
  const copy = (x, dst, dr, src, sr, keyed) => {
    const B = dst.bpp >> 3, dw = dr.r - dr.l, dh = dr.b - dr.t, sw = sr.r - sr.l, sh = sr.b - sr.t;
    if (dw <= 0 || dh <= 0 || sw <= 0 || sh <= 0) return;
    // The source's rows as they are read (a sprite is a few rows of a large sheet), each from its left edge.
    const sl = Math.max(0, sr.l), rows = new Map(), row = (y) => { let r = rows.get(y); if (!r) rows.set(y, r = x.bytes(src.mem + y * src.pitch + sl * B, Math.max(0, Math.min(src.w, sr.r) - sl) * B)); return r; };
    const key = keyed && src.key !== null ? src.key : null;
    for (let j = 0; j < dh; j++) {
      const ty = dr.t + j; if (ty < 0 || ty >= dst.h) continue;
      const sy = sr.t + Math.floor(j * sh / dh); if (sy < 0 || sy >= src.h) continue;
      let any = false;
      const out = x.bytes(dst.mem + ty * dst.pitch + Math.max(0, dr.l) * B, Math.max(0, Math.min(dw, dst.w - dr.l)) * B);
      for (let i = 0; i < dw; i++) {
        const tx = dr.l + i; if (tx < 0 || tx >= dst.w) continue;
        const sx = sr.l + Math.floor(i * sw / dw); if (sx < 0 || sx >= src.w) continue;
        const sraw = row(sy), a = (sx - sl) * B;
        let v = 0; for (let k = 0; k < B; k++) v |= sraw[a + k] << (8 * k);
        if (key !== null && v === key) continue;
        for (let k = 0; k < B; k++) out[(tx - Math.max(0, dr.l)) * B + k] = (v >>> (8 * k)) & 255;
        any = true;
      }
      if (any || key === null) x.write(dst.mem + ty * dst.pitch + Math.max(0, dr.l) * B, out);
    }
  };
  const fill = (x, dst, dr, colour) => {
    const B = dst.bpp >> 3, l = Math.max(0, dr.l), r = Math.min(dst.w, dr.r);
    if (r <= l) return;
    const row = new Uint8Array((r - l) * B); for (let i = 0; i < r - l; i++) for (let k = 0; k < B; k++) row[i * B + k] = (colour >>> (8 * k)) & 255;
    for (let y = Math.max(0, dr.t); y < Math.min(dst.h, dr.b); y++) x.write(dst.mem + y * dst.pitch + l * B, row);
  };

  // ---- a surface's DC (GetDC): GDI draws on its pixels -- a bitmap of the window manager's 0x00RRGGBB
  // that src/win32/api.js's GDI loads from the surface before each call and stores back after, in the
  // surface's format (8 bits: the nearest colour of its palette). Cave Story draws its pictures, loaded
  // with LoadImage, onto its surfaces so, and its text with TextOut.
  const toPx = (x, s, px) => {
    const raw = x.bytes(s.mem, s.pitch * s.h), B = s.bpp >> 3, pal = B === 1 && s.palette && o(s.palette) ? o(s.palette).colors : null;
    for (let y = 0; y < s.h; y++) for (let i = 0; i < s.w; i++) {
      const a = y * s.pitch + i * B;
      px[y * s.w + i] = B === 1 ? (pal ? pal[raw[a]] : raw[a] * 0x010101)
        : B === 2 ? (() => { const v = raw[a] | raw[a + 1] << 8, r = (v >> 11) & 31, g = (v >> 5) & 63, b = v & 31; return (r << 3 | r >> 2) << 16 | (g << 2 | g >> 4) << 8 | (b << 3 | b >> 2); })()
          : raw[a + 2] << 16 | raw[a + 1] << 8 | raw[a];
    }
  };
  const fromPx = (x, s, px) => {
    const B = s.bpp >> 3, out = new Uint8Array(s.pitch * s.h), pal = B === 1 && s.palette && o(s.palette) ? o(s.palette).colors : null, near = new Map();
    const index = (c) => {
      if (!pal) return ((c >> 16 & 255) * 77 + (c >> 8 & 255) * 151 + (c & 255) * 28) >> 8;
      let k = near.get(c); if (k !== undefined) return k;
      let best = 1e9; k = 0;
      for (let i = 0; i < 256; i++) { const p = pal[i], d = ((p >> 16 & 255) - (c >> 16 & 255)) ** 2 + ((p >> 8 & 255) - (c >> 8 & 255)) ** 2 + ((p & 255) - (c & 255)) ** 2; if (d < best) { best = d; k = i; } }
      near.set(c, k); return k;
    };
    for (let y = 0; y < s.h; y++) for (let i = 0; i < s.w; i++) {
      const a = y * s.pitch + i * B, c = px[y * s.w + i];
      if (B === 1) out[a] = index(c);
      else if (B === 2) { const v = (c >> 19 & 31) << 11 | (c >> 10 & 63) << 5 | (c >> 3 & 31); out[a] = v & 255; out[a + 1] = v >> 8; }
      else { out[a] = c & 255; out[a + 1] = c >> 8 & 255; out[a + 2] = c >> 16 & 255; }
    }
    x.write(s.mem, out);
  };

  const unknown = {
    QueryInterface: (x, self, riid, pp) => { if (pp) x.w32(pp, 0); return E_NOINTERFACE; },   // DirectDraw 1 only, so far
    AddRef: (x, self) => ++o(self).ref,
    Release: (x, self) => { const ob = o(self); if (!ob) return 0; if (--ob.ref > 0) return ob.ref; objs.delete(self >>> 0); return 0; },
  };
  const IMPL = {
    IDirectDraw: {
      Compact: () => DD_OK, Initialize: () => DD_OK, FlipToGDISurface: () => DD_OK,
      SetCooperativeLevel: (x, self, hwnd, flags) => { o(self).exclusive = !!(flags & 0x10); return DD_OK; },   // DDSCL_EXCLUSIVE
      // A display mode: the screen becomes it, full screen, as ChangeDisplaySettings makes it.
      SetDisplayMode: (x, self, w, h, bpp) => {
        Object.assign(mode, { w, h, bpp }); st.w = w; st.h = h; st.modeSet = true; wm.dirty = true; return DD_OK;
      },
      RestoreDisplayMode: () => { st.modeSet = false; wm.dirty = true; return DD_OK; },
      GetDisplayMode: (x, self, p) => { const m = display(); putDesc(x, p, { w: m.w, h: m.h, bpp: m.bpp, pitch: m.w * (m.bpp >> 3) }, 0); return DD_OK; },
      // DDCAPS: the size the program says, everything else zero (no hardware acceleration to report).
      GetCaps: (x, self, drv, hel) => { for (const p of [drv, hel]) if (p) { const n = x.r32(p) || 316; x.write(p, new Uint8Array(n)); x.w32(p, n); } return DD_OK; },
      GetMonitorFrequency: (x, self, p) => { if (p) x.w32(p, 60); return DD_OK; },
      GetVerticalBlankStatus: (x, self, p) => { if (p) x.w32(p, 1); return DD_OK; },
      WaitForVerticalBlank: () => DD_OK, GetScanLine: (x, self, p) => { if (p) x.w32(p, 0); return DD_OK; },
      GetFourCCCodes: (x, self, n) => { if (n) x.w32(n, 0); return DD_OK; },
      CreateClipper: (x, self, flags, pp) => { x.w32(pp, make(x, 'IDirectDrawClipper', { hwnd: 0 })); return DD_OK; },
      // PALETTEENTRY: red, green, blue, flags -- kept as 0x00RRGGBB.
      CreatePalette: (x, self, flags, entries, pp) => {
        const colors = new Uint32Array(256);
        for (let i = 0; i < 256 && entries; i++) { const e = x.r32(entries + 4 * i); colors[i] = ((e & 255) << 16) | (e & 0xff00) | ((e >> 16) & 255); }
        x.w32(pp, make(x, 'IDirectDrawPalette', { colors })); return DD_OK;
      },
      // DDSURFACEDESC's flags at 4, height 8, width 12, back buffer count 20, pixel format 72, caps 104.
      CreateSurface: (x, self, d, pp) => {
        const flags = x.r32(d + 4), caps = x.r32(d + 104), m = display();
        if (caps & DDSCAPS_PRIMARYSURFACE) {
          const p = surface(x, m.w, m.h, m.bpp, { primary: true, desktop: !st.modeSet });
          if (flags & DDSD_BACKBUFFERCOUNT && x.r32(d + 20) && caps & DDSCAPS_FLIP) o(p).backBuffer = surface(x, m.w, m.h, m.bpp, { back: true });
          x.w32(pp, p); return DD_OK;
        }
        const w = flags & DDSD_WIDTH ? x.r32(d + 12) : m.w, h = flags & DDSD_HEIGHT ? x.r32(d + 8) : m.h;
        const bpp = flags & DDSD_PIXELFORMAT ? x.r32(d + 84) || m.bpp : m.bpp;
        if (!w || !h || ![8, 16, 24, 32].includes(bpp)) return DDERR_INVALIDPARAMS;
        x.w32(pp, surface(x, w, h, bpp)); return DD_OK;
      },
      // Each mode by the program's callback (stdcall: the description, the context), the modes of
      // XP's display list: 640x480 to 1024x768 at 8, 16 and 32 bits.
      EnumDisplayModes: (x, self, flags, want, ctx, cb) => {
        const modes = [[320, 200], [320, 240], [640, 480], [800, 600], [1024, 768]].flatMap(([w, h]) => [8, 16, 32].map((b) => [w, h, b]));
        const calls = modes.map(([w, h, b]) => { const d = x.win.heapAlloc(108); x.w32(d, 108); putDesc(x, d, { w, h, bpp: b, pitch: w * (b >> 3) }, 0); x.w32(d + 104, 0); return { fn: cb, args: [d, ctx] }; });
        return send(x, calls, () => DD_OK, 20);
      },
      EnumSurfaces: () => DD_OK, DuplicateSurface: () => DDERR_INVALIDPARAMS, GetGDISurface: () => DDERR_NOTFOUND,
    },
    IDirectDrawSurface: {
      GetAttachedSurface: (x, self, caps, pp) => { const b = o(self).backBuffer; if (!b) return DDERR_NOTFOUND; o(b).ref++; x.w32(pp, b); return DD_OK; },
      AddAttachedSurface: () => DD_OK, DeleteAttachedSurface: () => DD_OK, EnumAttachedSurfaces: () => DD_OK,
      GetSurfaceDesc: (x, self, p) => { putDesc(x, p, o(self), 0); return DD_OK; },
      GetPixelFormat: (x, self, p) => { putFormat(x, p, o(self).bpp); return DD_OK; },
      GetCaps: (x, self, p) => { const s = o(self); x.w32(p, s.primary ? DDSCAPS_PRIMARYSURFACE : s.back ? DDSCAPS_BACKBUFFER : DDSCAPS_OFFSCREENPLAIN); return DD_OK; },
      // Lock hands out the surface's memory (at the rectangle's corner); Unlock of the primary shows it.
      Lock: (x, self, r, d) => { const s = o(self), rc = rect(x, r, s); putDesc(x, d, s, s.mem + rc.t * s.pitch + rc.l * (s.bpp >> 3)); return DD_OK; },
      Unlock: (x, self) => { if (o(self).primary) show(x); return DD_OK; },
      // Flip: the back buffer's memory becomes the front's, and is shown.
      Flip: (x, self) => {
        const f = o(self), b = f.backBuffer && o(f.backBuffer);
        if (b) [f.mem, b.mem] = [b.mem, f.mem];
        show(x); return DD_OK;
      },
      // Blt: a copy (stretched to the destination rectangle) or a colour fill (DDBLTFX's dwFillColor at 80).
      Blt: (x, self, dr, src, sr, flags, fx) => {
        const d = o(self);
        if (flags & DDBLT_COLORFILL) fill(x, d, rect(x, dr, d), fx ? x.r32(fx + 80) : 0);
        else if (src && o(src)) copy(x, d, rect(x, dr, d), o(src), rect(x, sr, o(src)), !!(flags & DDBLT_KEYSRC));
        if (d.primary) show(x); return DD_OK;
      },
      BltFast: (x, self, X, Y, src, sr, flags) => {
        const d = o(self), s = o(src); if (!s) return DDERR_INVALIDPARAMS;
        const r = rect(x, sr, s);
        copy(x, d, { l: X, t: Y, r: X + r.r - r.l, b: Y + r.b - r.t }, s, r, !!(flags & DDBLTFAST_SRCCOLORKEY));
        if (d.primary) show(x); return DD_OK;
      },
      BltBatch: () => DD_OK,
      // DDCOLORKEY: the low colour of the range; DDCKEY_SRCBLT (8) is the one copies honour.
      SetColorKey: (x, self, flags, k) => { if (flags & 8) o(self).key = k ? x.r32(k) : null; return DD_OK; },
      GetColorKey: (x, self, flags, k) => { const v = o(self).key; if (v === null) return DDERR_NOTFOUND; x.w32(k, v); x.w32(k + 4, v); return DD_OK; },
      SetPalette: (x, self, pal) => { const s = o(self); s.palette = pal >>> 0; if (pal && o(pal)) o(pal).ref++; if (s.primary) show(x); return DD_OK; },
      GetPalette: (x, self, pp) => { const p = o(self).palette; if (!p) return DDERR_NOTFOUND; o(p).ref++; x.w32(pp, p); return DD_OK; },
      // GetDC(&hdc): a DC whose bitmap is the surface (above); ReleaseDC ends it, and shows the primary.
      GetDC: (x, self, pdc) => {
        const s = o(self); if (s.dc) return 0x8876021c;                // DDERR_DCALREADYCREATED
        const px = new Uint32Array(s.w * s.h);
        const bm = st.newHandle('bitmap', { w: s.w, h: s.h, px, load: (x) => toPx(x, s, px), store: (x) => { fromPx(x, s, px); if (s.primary) show(x); } });
        const dc = st.newHandle('dc', {}); st.dcBitmaps.set(dc, bm);
        s.dc = { dc, bm }; x.w32(pdc, dc); return DD_OK;
      },
      ReleaseDC: (x, self) => {
        const s = o(self); if (!s.dc) return DDERR_INVALIDPARAMS;
        st.dcBitmaps.delete(s.dc.dc); st.gdi.delete(s.dc.bm); st.gdi.delete(s.dc.dc); s.dc = null; return DD_OK;
      },
      SetClipper: () => DD_OK, GetClipper: () => DDERR_NOTFOUND, IsLost: () => DD_OK, Restore: () => DD_OK,
      GetBltStatus: () => DD_OK, GetFlipStatus: () => DD_OK, Initialize: () => DD_OK,
    },
    IDirectDrawPalette: {
      GetCaps: (x, self, p) => { x.w32(p, 4 | 0x40); return DD_OK; },   // DDPCAPS_8BIT | ALLOW256
      GetEntries: (x, self, flags, start, n, out) => { const c = o(self).colors; for (let i = 0; i < n && start + i < 256; i++) { const v = c[start + i]; x.w32(out + 4 * i, ((v >> 16) & 255) | (v & 0xff00) | ((v & 255) << 16)); } return DD_OK; },
      // A palette changed under the screen shows at once: an 8-bit game fades by its palette alone.
      SetEntries: (x, self, flags, start, n, e) => {
        const c = o(self).colors;
        for (let i = 0; i < n && start + i < 256; i++) { const v = x.r32(e + 4 * i); c[start + i] = ((v & 255) << 16) | (v & 0xff00) | ((v >> 16) & 255); }
        const p = primary(); if (p && p.palette === self >>> 0) show(x);
        return DD_OK;
      },
      Initialize: () => DD_OK,
    },
    IDirectDrawClipper: {
      SetHWnd: (x, self, flags, hwnd) => { o(self).hwnd = hwnd; return DD_OK; }, GetHWnd: (x, self, p) => { x.w32(p, o(self).hwnd); return DD_OK; },
      IsClipListChanged: (x, self, p) => { if (p) x.w32(p, 0); return DD_OK; }, Initialize: () => DD_OK,
    },
  };
  const sigOf = (s) => 'p' + 'u'.repeat(+s);
  const fns = {
    // DirectDrawCreate(guid, lplpDD, outer): the one display.
    DirectDrawCreate: ['ppp', (x, guid, pp) => { x.w32(pp, make(x, 'IDirectDraw', {})); return DD_OK; }],
    DirectDrawCreateClipper: ['upp', (x, flags, pp) => { x.w32(pp, make(x, 'IDirectDrawClipper', { hwnd: 0 })); return DD_OK; }],
    // DirectDrawEnumerateA(callback, context): the primary display driver, once (GUID NULL).
    DirectDrawEnumerateA: ['pp', (x, cb, ctx) => {
      const d = x.win.heapAlloc(64); x.write(d, new TextEncoder().encode('Primary Display Driver\0display\0'));
      return send(x, [{ fn: cb, args: [0, d, d + 23, ctx] }], () => DD_OK, 8);
    }],
  };
  let ord = 1000;
  for (const [iface, ms] of Object.entries(METHODS)) for (const [n, s] of ms) {
    const f = unknown[n] || IMPL[iface][n] || (() => { throw new Error(`mirage-win32: ${iface}::${n} is not implemented`); });
    fns[`${iface}::${n}`] = [sigOf(s), f, { ordinal: ord++ }];
  }
  return { dll: 'ddraw.dll', fns };
}
