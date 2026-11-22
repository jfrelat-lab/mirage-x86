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

import { D3D7_VTABLES, IID_D3D7, d3d7Impl } from './d3d7.js';
import { fvfSize, recordD3D9 } from './d3d9.js';

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
// DirectX 3's: IDirectDraw2 is IDirectDraw with SetDisplayMode's refresh rate and flags, and
// GetAvailableVidMem; the surfaces 2 and 3 add the DirectDraw they came from, page locking and
// SetSurfaceDesc. NESticle for Windows 95 (1997) asks for IDirectDraw2.
VTABLES.IDirectDraw2 = VTABLES.IDirectDraw.replace('SetDisplayMode:3', 'SetDisplayMode:5') + ' GetAvailableVidMem:3';
VTABLES.IDirectDrawSurface2 = VTABLES.IDirectDrawSurface + ' GetDDInterface:1 PageLock:1 PageUnlock:1';
VTABLES.IDirectDrawSurface3 = VTABLES.IDirectDrawSurface2 + ' SetSurfaceDesc:2';
// DirectX 6 and 7's: IDirectDraw4 and 7 take DDSURFACEDESC2 (124 bytes, DDSCAPS2) and add the device's
// identifier; the surfaces 4 and 7 add private data, a uniqueness value, and (7) a texture's priority and
// LOD. Direct3D 7 (d3d7.js) is reached from IDirectDraw7. Unreal Tournament's D3DDrv (1999) asks for them.
VTABLES.IDirectDraw4 = VTABLES.IDirectDraw2 + ' GetSurfaceFromDC:2 RestoreAllSurfaces:0 TestCooperativeLevel:0 GetDeviceIdentifier:2';
VTABLES.IDirectDraw7 = VTABLES.IDirectDraw4 + ' StartModeTest:3 EvaluateMode:2';
VTABLES.IDirectDrawSurface4 = VTABLES.IDirectDrawSurface3 + ' SetPrivateData:4 GetPrivateData:3 FreePrivateData:1 GetUniquenessValue:1 ChangeUniquenessValue:0';
VTABLES.IDirectDrawSurface7 = VTABLES.IDirectDrawSurface4 + ' SetPriority:1 GetPriority:1 SetLOD:1 GetLOD:1';
VTABLES.IDirectDrawGammaControl = `${UNK} GetGammaRamp:2 SetGammaRamp:2`;
Object.assign(VTABLES, D3D7_VTABLES);
const METHODS = Object.fromEntries(Object.entries(VTABLES).map(([i, s]) => [i, s.trim().split(/\s+/).map((t) => t.split(':'))]));
// The interfaces by IID (its first dword, then the rest as GUID text), and the family each belongs to:
// QueryInterface answers within the family, a pointer of its own onto the same object.
const IIDS = {
  '6c14db80-a733-11ce-a521-0020af0be560': 'IDirectDraw', 'b3a6f3e0-2b43-11cf-a2de-00aa00b93356': 'IDirectDraw2',
  '6c14db81-a733-11ce-a521-0020af0be560': 'IDirectDrawSurface', '57805885-6eef-11cf-9441-a82303c10e27': 'IDirectDrawSurface2',
  'da044e00-69b2-11d0-a1d5-00aa00b8dfbb': 'IDirectDrawSurface3', '00000000-0000-0000-c000-000000000046': 'IUnknown',
  '9c59509a-39bd-11d1-8c4a-00c04fd930c5': 'IDirectDraw4', '15e65ec0-3b9c-11d2-b92f-00609797ea5b': 'IDirectDraw7',
  '0b2b8630-ad35-11d0-8ea6-00609797ea5b': 'IDirectDrawSurface4', '06675a80-3b9b-11d2-b92f-00609797ea5b': 'IDirectDrawSurface7',
  '69c11c3e-b46b-11d1-ad7a-00c04fc29b4e': 'IDirectDrawGammaControl', ...IID_D3D7,
};
const FAMILY = (iface) => iface.replace(/\d$/, '');

const DDSD_CAPS = 1, DDSD_HEIGHT = 2, DDSD_WIDTH = 4, DDSD_PITCH = 8, DDSD_BACKBUFFERCOUNT = 0x20, DDSD_LPSURFACE = 0x800, DDSD_PIXELFORMAT = 0x1000;
const DDSCAPS_BACKBUFFER = 4, DDSCAPS_FLIP = 0x10, DDSCAPS_FRONTBUFFER = 0x20, DDSCAPS_OFFSCREENPLAIN = 0x40, DDSCAPS_PRIMARYSURFACE = 0x200, DDSCAPS_SYSTEMMEMORY = 0x800;
const DDSCAPS_TEXTURE = 0x1000, DDSCAPS_3DDEVICE = 0x2000, DDSCAPS_VIDEOMEMORY = 0x4000, DDSCAPS_ZBUFFER = 0x20000, DDSCAPS_MIPMAP = 0x400000, DDSD_MIPMAPCOUNT = 0x20000;
const DDBLT_COLORFILL = 0x400, DDBLT_KEYSRC = 0x8000, DDBLTFAST_SRCCOLORKEY = 1;

/** `st`: the window state (its size, the display mode); `wm`: the window manager, which shows a frame;
 *  `send`: calls into the program (EnumDisplayModes' callback), as user32's sent messages do. */
export function ddrawApis(st, wm, send) {
  const objs = new Map(), vtables = new Map();
  const vtable = (x, iface) => {
    if (!vtables.has(iface)) {
      const mod = x.win.load('ddraw.dll'), ms = METHODS[iface], v = x.win.heapAlloc(ms.length * 4);
      ms.forEach(([n], i) => x.w32(v + 4 * i, mod.exports.get(`${iface}::${n}`)));
      vtables.set(iface, v);
    }
    return vtables.get(iface);
  };
  const make = (x, iface, props) => {
    const p = x.win.heapAlloc(16);
    x.w32(p, vtable(x, iface));
    objs.set(p, { iface, ref: 1, ...props });
    return p;
  };
  // The object behind `p` as another interface of its family: one pointer per interface, kept with it.
  const as = (x, p, iface) => {
    const ob = objs.get(p >>> 0); ob.views ||= { [ob.iface]: p >>> 0 };
    if (!ob.views[iface]) { const q = x.win.heapAlloc(16); x.w32(q, vtable(x, iface)); objs.set(q, ob); ob.views[iface] = q; }
    ob.ref++; return ob.views[iface];
  };
  const guid = (x, p) => { const b = x.bytes(p, 16), h = (i, n) => [...b.slice(i, i + n)].map((v) => v.toString(16).padStart(2, '0')).join('');
    return `${h(0, 4).match(/../g).reverse().join('')}-${h(4, 2).match(/../g).reverse().join('')}-${h(6, 2).match(/../g).reverse().join('')}-${h(8, 2)}-${h(10, 6)}`; };
  const o = (p) => objs.get(p >>> 0);
  const mode = { w: 640, h: 480, bpp: 8 };
  const vbl = { due: 0 };                                              // the vertical blank the last flip waits for
  // The display: the program's mode once it set one (full screen), else the desktop, 32 bits as GDI
  // reports it -- a windowed program's primary surface is the whole screen, its window somewhere on it.
  const display = () => (st.modeSet ? mode : { w: st.desk.w, h: st.desk.h, bpp: 32 });

  // ---- surfaces: memory of the program's, a pitch rounded to 4 bytes ------------------------------
  const surface = (x, w, h, bpp, props = {}) => {
    const pitch = ((w * (bpp >> 3)) + 3) & ~3, mem = x.win.heapAlloc(pitch * h);
    x.write(mem, new Uint8Array(pitch * h));
    return make(x, props.iface || 'IDirectDrawSurface', { w, h, bpp, pitch, mem, key: null, palette: 0, ...props });
  };
  // DDPIXELFORMAT (32 bytes at `p`): RGB, its bit count and masks (a surface's own, `m`, when it was made
  // with them -- a texture's 1:5:5:5 or 4:4:4:4, its alpha mask then DDPF_ALPHAPIXELS); PALETTEINDEXED8 in
  // 8 bits; a z-buffer's DDPF_ZBUFFER, its depth and z mask.
  const putFormat = (x, p, bpp, m = null) => {
    x.write(p, new Uint8Array(32)); x.w32(p, 32);
    if (m && m.z) { x.w32(p + 4, 0x400 | (m.s ? 0x4000 : 0)); x.w32(p + 12, bpp); x.w32(p + 16, m.s ? 8 : 0); x.w32(p + 20, m.z); x.w32(p + 24, m.s); return; }
    x.w32(p + 4, bpp === 8 ? 0x60 : 0x40 | (m && m.a ? 1 : 0)); x.w32(p + 12, bpp);    // DDPF_PALETTEINDEXED8 | RGB, or RGB
    const masks = m ? [m.r, m.g, m.b, m.a] : bpp === 16 ? [0xf800, 0x7e0, 0x1f, 0] : bpp >= 24 ? [0xff0000, 0xff00, 0xff, 0] : [0, 0, 0, 0];
    masks.forEach((v, i) => x.w32(p + 16 + 4 * i, v));
  };
  // A surface's caps (DDSCAPS' first dword) as it was made.
  const capsOf = (s) => s.primary ? DDSCAPS_PRIMARYSURFACE | DDSCAPS_FRONTBUFFER | (s.three ? DDSCAPS_3DDEVICE : 0) : s.back ? DDSCAPS_BACKBUFFER | (s.three ? DDSCAPS_3DDEVICE : 0)
    : s.zbuf ? DDSCAPS_ZBUFFER | DDSCAPS_VIDEOMEMORY : s.texture ? DDSCAPS_TEXTURE | (s.mipLevel !== undefined ? DDSCAPS_MIPMAP : 0) | DDSCAPS_VIDEOMEMORY
      : DDSCAPS_OFFSCREENPLAIN | DDSCAPS_SYSTEMMEMORY;
  // DDSURFACEDESC (108 bytes): what Lock and GetSurfaceDesc fill, the surface's pointer when locked.
  const putDesc = (x, p, s, at) => {
    const size = x.r32(p) || 108;
    x.write(p, new Uint8Array(Math.min(size, 124))); x.w32(p, size);
    x.w32(p + 4, DDSD_CAPS | DDSD_HEIGHT | DDSD_WIDTH | DDSD_PITCH | DDSD_PIXELFORMAT | (at ? DDSD_LPSURFACE : 0));
    x.w32(p + 8, s.h); x.w32(p + 12, s.w); x.w32(p + 16, s.pitch); if (at) x.w32(p + 36, at);
    putFormat(x, p + 72, s.bpp, s.fmt);
    x.w32(p + 104, capsOf(s));
    if (s.mips) { x.w32(p + 4, x.r32(p + 4) | DDSD_MIPMAPCOUNT); x.w32(p + 24, s.mips.length); }
  };
  // A RECT (left, top, right, bottom) or the whole surface.
  const rect = (x, p, s) => (p ? { l: x.r32(p) | 0, t: x.r32(p + 4) | 0, r: x.r32(p + 8) | 0, b: x.r32(p + 12) | 0 } : { l: 0, t: 0, r: s.w, b: s.h });

  // ---- the screen: the primary surface's pixels in the screen's colours ----------------------------
  const primary = () => [...objs.values()].find((s) => s.primary);
  // Full screen the whole surface is the picture; on the desktop (no mode set) the window's client area
  // is cut from it where the window is -- Cave Story in a window blits its frame there, through a clipper.
  // On a dialog application's desktop (AWT's: its toolkit's window hidden, each frame a window of its
  // own) the primary surface is the desktop: what was drawn -- `r`, inside the clipper's window -- is
  // copied there. Shown as a 640x480 window, Java2Demo's frame was cut at a corner.
  const toDesk = (x, s, r, sc) => {
    const cw = s.clipper && o(s.clipper) && o(s.clipper).hwnd && st.clientOnScreen(o(s.clipper).hwnd);
    if (cw) r = { l: Math.max(r.l, cw.l), t: Math.max(r.t, cw.t), r: Math.min(r.r, cw.r), b: Math.min(r.b, cw.b) };
    const l = Math.max(0, r.l), t = Math.max(0, r.t), R = Math.min(r.r, s.w, sc.w), B = Math.min(r.b, s.h, sc.h), N = s.bpp >> 3;
    if (R <= l || B <= t) return;
    for (let y = t; y < B; y++) {
      const raw = x.bytes(s.mem + y * s.pitch + l * N, (R - l) * N);
      for (let i = 0, X = l; X < R; i += N, X++) {
        sc.px[y * sc.w + X] = N === 4 || N === 3 ? raw[i + 2] << 16 | raw[i + 1] << 8 | raw[i]
          : N === 2 ? (((raw[i] | raw[i + 1] << 8) >> 11) & 31) << 19 | (((raw[i] | raw[i + 1] << 8) >> 5) & 63) << 10 | (raw[i] & 31) << 3 : raw[i] * 0x010101;
      }
    }
    wm.presentDesk(x.lx, sc);
  };
  const show = (x, r = null) => {
    const s = primary(); if (!s) return;
    const sc = s.desktop && !st.modeSet && st.deskScreen && st.deskScreen();
    if (sc) { if (r) toDesk(x, s, r, sc); return; }
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

  // A surface's pixels as B, G, R, A bytes (A8R8G8B8 in memory), by its format's masks: each channel
  // scaled to 8 bits, opaque without an alpha mask; a source colour key, where one is set, transparent.
  const chan = (m) => { if (!m) return null; let sh = 0; while (!((m >>> sh) & 1)) sh++; return [m >>> 0, sh, (m >>> sh) >>> 0]; };
  const texels = (x, s) => {
    const B = s.bpp >> 3, out = new Uint8Array(s.w * s.h * 4), raw = x.bytes(s.mem, s.pitch * s.h);
    const m = s.fmt || (B === 2 ? { r: 0xf800, g: 0x7e0, b: 0x1f, a: 0 } : { r: 0xff0000, g: 0xff00, b: 0xff, a: 0 });
    const cs = [chan(m.b), chan(m.g), chan(m.r), chan(m.a)], key = s.key;
    for (let y = 0; y < s.h; y++) for (let i = 0; i < s.w; i++) {
      const a = y * s.pitch + i * B; let v = 0; for (let k = 0; k < B; k++) v |= raw[a + k] << (8 * k);
      v >>>= 0;
      const q = (y * s.w + i) * 4;
      for (let c = 0; c < 4; c++) { const ch = cs[c]; out[q + c] = ch ? Math.round(((v & ch[0]) >>> ch[1]) * 255 / ch[2]) : 255; }
      if (key !== null && v === key) out[q + 3] = 0;
    }
    return out;
  };
  // Direct3D 7's Load: a texture's levels copied from another of the same size and format.
  const copySurface = (x, dst, src) => {
    const d = o(dst), s = o(src); if (!d || !s) return;
    const dl = d.mips || [dst], sl = s.mips || [src];
    dl.forEach((p, i) => { const a = o(p), b = sl[i] && o(sl[i]); if (!b) return; copy(x, a, { l: 0, t: 0, r: a.w, b: a.h }, b, { l: 0, t: 0, r: b.w, b: b.h }, false); a.dirty = true; });
  };
  const d7 = d3d7Impl({ o, make, as: (x, p, i) => as(x, p, i), st, send, texels, copySurface, fvfSize, record: recordD3D9 });

  const unknown = {
    QueryInterface: (x, self, riid, pp) => {
      const ob = o(self), want = riid && IIDS[guid(x, riid)];
      // IDirect3D7 from IDirectDraw7: an object of its own, on this DirectDraw.
      if (ob && want === 'IDirect3D7' && FAMILY(ob.iface) === 'IDirectDraw') { x.w32(pp, make(x, 'IDirect3D7', { dd: self >>> 0 })); ob.ref++; return DD_OK; }
      const iface = want === 'IUnknown' ? ob.iface : want;
      if (!ob || !iface || FAMILY(iface) !== FAMILY(ob.iface)) { if (pp) x.w32(pp, 0); return E_NOINTERFACE; }
      x.w32(pp, as(x, self, iface)); return DD_OK;
    },
    AddRef: (x, self) => ++o(self).ref,
    Release: (x, self) => { const ob = o(self); if (!ob) return 0; if (--ob.ref > 0) return ob.ref; if (ob.iface === 'IDirect3DDevice7') d7.release(self); objs.delete(self >>> 0); return 0; },
  };
  const IMPL = {
    IDirectDraw: {
      Compact: () => DD_OK, Initialize: () => DD_OK, FlipToGDISurface: () => DD_OK,
      // DDSCL_EXCLUSIVE with DDSCL_FULLSCREEN: the window takes the screen and becomes the active one --
      // shown, WM_ACTIVATEAPP, WM_NCACTIVATE, WM_ACTIVATE, WM_SETFOCUS, as Windows sends them then.
      // NESticle for Windows 95 never shows its window itself, and runs only once it has been activated.
      SetCooperativeLevel: (x, self, hwnd, flags) => {
        o(self).exclusive = !!(flags & 0x10);
        if ((flags & 0x11) !== 0x11 || st.active || (hwnd >>> 0) !== (st.hwnd >>> 0)) return DD_OK;
        st.shown = st.active = true; wm.dirty = true;
        return send(x, [[0x1c, 1, 0, hwnd], [0x86, 1, 0, hwnd], [0x06, 1, 0, hwnd], [0x07, 0, 0, hwnd]], () => DD_OK, 12);
      },
      // A display mode: the screen becomes it, full screen, as ChangeDisplaySettings makes it.
      SetDisplayMode: (x, self, w, h, bpp) => {
        Object.assign(mode, { w, h, bpp }); st.w = w; st.h = h; st.modeSet = true; wm.dirty = true; return DD_OK;
      },
      RestoreDisplayMode: () => { st.modeSet = false; wm.dirty = true; return DD_OK; },
      GetDisplayMode: (x, self, p) => { const m = display(); putDesc(x, p, { w: m.w, h: m.h, bpp: m.bpp, pitch: m.w * (m.bpp >> 3) }, 0); return DD_OK; },
      // DDCAPS: the size the program says, everything else zero (no hardware acceleration to report).
      // DDCAPS: the size the program says. The driver's (`drv`): 3D, blits, colour keys, and the surfaces it
      // makes -- textures, a 3D device, z-buffers of 16, 24 and 32 bits, 32 MB of video memory; the
      // emulation layer's (`hel`) zero. Direct3D 7's programs look for DDCAPS_3D and the z depths; Unreal
      // Tournament's D3DDrv refused a card that cannot render in a window ("D3D Device: Fullscreen only").
      GetCaps: (x, self, drv, hel) => {
        for (const p of [drv, hel]) if (p) { const n = x.r32(p) || 316; x.write(p, new Uint8Array(n)); x.w32(p, n); }
        if (drv && /[47]$/.test(o(self).iface)) {
          const n = x.r32(drv), caps = DDSCAPS_TEXTURE | DDSCAPS_3DDEVICE | DDSCAPS_ZBUFFER | DDSCAPS_MIPMAP | DDSCAPS_FLIP | DDSCAPS_PRIMARYSURFACE | DDSCAPS_VIDEOMEMORY | DDSCAPS_OFFSCREENPLAIN;
          x.w32(drv + 4, 0x1 | 0x40 | 0x200 | 0x400000 | 0x4000000);   // DDCAPS_3D, BLT, BLTSTRETCH, COLORKEY, BLTCOLORFILL
          x.w32(drv + 8, 0x80000 | 0x20000);                            // DDCAPS2_CANRENDERWINDOWED, PRIMARYGAMMA
          x.w32(drv + 12, 0x200);                                       // DDCKEYCAPS_SRCBLT
          x.w32(drv + 56, 0x400 | 0x200 | 0x100);                       // z-buffer depths: DDBD_16, 24, 32
          x.w32(drv + 60, 32 << 20); x.w32(drv + 64, 32 << 20);
          if (n >= 136) x.w32(drv + 132, caps);
          if (n >= 380) x.w32(drv + 360, caps);
        }
        return DD_OK;
      },
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
      // From IDirectDraw4 and 7 a surface is of the matching interface; Direct3D 7's surfaces are its
      // flip chain with DDSCAPS_3DDEVICE, a z-buffer (its depth at the pixel format's bit count), and
      // textures -- their pixel format's masks kept, a mipmap chain made at once (DDSD_MIPMAPCOUNT's levels,
      // or down to 1x1), each level a surface the one above hands out (GetAttachedSurface).
      CreateSurface: (x, self, d, pp) => {
        const flags = x.r32(d + 4), caps = x.r32(d + 104), m = display();
        const iface = { IDirectDraw4: 'IDirectDrawSurface4', IDirectDraw7: 'IDirectDrawSurface7' }[o(self).iface] || 'IDirectDrawSurface';
        const three = !!(caps & DDSCAPS_3DDEVICE);
        if (caps & DDSCAPS_PRIMARYSURFACE) {
          const p = surface(x, m.w, m.h, m.bpp, { primary: true, desktop: !st.modeSet, iface, three });
          if (flags & DDSD_BACKBUFFERCOUNT && x.r32(d + 20) && caps & DDSCAPS_FLIP) o(p).backBuffer = surface(x, m.w, m.h, m.bpp, { back: true, iface, three });
          x.w32(pp, p); return DD_OK;
        }
        const w = flags & DDSD_WIDTH ? x.r32(d + 12) : m.w, h = flags & DDSD_HEIGHT ? x.r32(d + 8) : m.h;
        const bpp = flags & DDSD_PIXELFORMAT ? x.r32(d + 84) || m.bpp : m.bpp;
        if (caps & DDSCAPS_ZBUFFER) {
          const zb = flags & DDSD_PIXELFORMAT ? x.r32(d + 84) : 16, s = zb === 32 ? x.r32(d + 100) : 0;
          x.w32(pp, surface(x, w, h, zb === 16 ? 16 : 32, { zbuf: true, iface, fmt: { z: x.r32(d + 92) || (zb === 16 ? 0xffff : 0xffffff), s } })); return DD_OK;
        }
        if (!w || !h || ![8, 16, 24, 32].includes(bpp)) return DDERR_INVALIDPARAMS;
        const fmt = flags & DDSD_PIXELFORMAT && x.r32(d + 76) & 0x40 ? { r: x.r32(d + 88), g: x.r32(d + 92), b: x.r32(d + 96), a: x.r32(d + 76) & 1 ? x.r32(d + 100) : 0 } : null;
        if (caps & DDSCAPS_TEXTURE) {
          let n = 1;
          if (caps & DDSCAPS_MIPMAP) { if (flags & DDSD_MIPMAPCOUNT) n = Math.max(1, x.r32(d + 24)); else while ((w >> n) || (h >> n)) n++; }
          const top = surface(x, w, h, bpp, { texture: true, iface, fmt, dirty: true });
          if (n > 1) {
            const mips = [top];
            for (let l = 1; l < n; l++) mips.push(surface(x, Math.max(1, w >> l), Math.max(1, h >> l), bpp, { texture: true, iface, fmt, top, mipLevel: l, dirty: true }));
            mips.forEach((p, l) => { o(p).next = mips[l + 1] || 0; });
            o(top).mips = mips; o(top).mipLevel = 0;
          }
          x.w32(pp, top); return DD_OK;
        }
        x.w32(pp, surface(x, w, h, bpp, { iface, fmt, three })); return DD_OK;
      },
      // Each mode by the program's callback (stdcall: the description, the context), the modes of
      // XP's display list: 640x480 to 1024x768 at 8, 16 and 32 bits.
      EnumDisplayModes: (x, self, flags, want, ctx, cb) => {
        const modes = [[320, 200], [320, 240], [640, 480], [800, 600], [1024, 768]].flatMap(([w, h]) => [8, 16, 32].map((b) => [w, h, b]));
        const size = /[47]$/.test(o(self).iface) ? 124 : 108;
        const calls = modes.map(([w, h, b]) => { const d = x.win.heapAlloc(size); x.w32(d, size); putDesc(x, d, { w, h, bpp: b, pitch: w * (b >> 3) }, 0); x.w32(d + 104, 0); return { fn: cb, args: [d, ctx] }; });
        return send(x, calls, () => DD_OK, 20);
      },
      EnumSurfaces: () => DD_OK, DuplicateSurface: () => DDERR_INVALIDPARAMS, GetGDISurface: () => DDERR_NOTFOUND,
    },
    IDirectDrawSurface: {
      // The surface attached by its caps: a texture's next mipmap level, a render target's z-buffer, a
      // primary's back buffer.
      GetAttachedSurface: (x, self, caps, pp) => {
        const s = o(self), c = caps ? x.r32(caps) : 0;
        const b = c & DDSCAPS_MIPMAP ? s.next : c & DDSCAPS_ZBUFFER ? s.zbuffer : s.backBuffer;
        if (!b) { x.w32(pp, 0); return DDERR_NOTFOUND; }
        o(b).ref++; x.w32(pp, b); return DD_OK;
      },
      // A z-buffer attached to the flip chain is the 3D device's depth buffer.
      AddAttachedSurface: (x, self, a) => {
        const s = o(self), z = o(a); if (!z) return DDERR_INVALIDPARAMS;
        if (z.zbuf) { s.zbuffer = a >>> 0; z.ref++; if (s.backBuffer) o(s.backBuffer).zbuffer = a >>> 0; }
        return DD_OK;
      },
      DeleteAttachedSurface: (x, self, flags, a) => { const s = o(self); if (s.zbuffer === a >>> 0 || !a) s.zbuffer = 0; return DD_OK; },
      // The surfaces attached (a primary's back buffer), each to the program's callback (stdcall: the
      // surface, its description, the context), AddRef'd as Windows hands them. SciTech MGL (WinQuake)
      // finds its back buffer so, and asked again and again while none came.
      EnumAttachedSurfaces: (x, self, ctx, cb) => {
        const b = o(self).backBuffer;
        if (!b || !cb) return DD_OK;
        o(b).ref++;
        const d = x.win.heapAlloc(108); x.w32(d, 108); putDesc(x, d, o(b), 0);
        return send(x, [{ fn: cb, args: [b, d, ctx] }], () => DD_OK, 12);
      },
      GetSurfaceDesc: (x, self, p) => { putDesc(x, p, o(self), 0); return DD_OK; },
      GetPixelFormat: (x, self, p) => { putFormat(x, p, o(self).bpp); return DD_OK; },
      GetCaps: (x, self, p) => { x.w32(p, capsOf(o(self))); return DD_OK; },
      // Lock hands out the surface's memory (at the rectangle's corner); Unlock of the primary shows it.
      Lock: (x, self, r, d) => { const s = o(self), rc = rect(x, r, s); s.locked = rc; putDesc(x, d, s, s.mem + rc.t * s.pitch + rc.l * (s.bpp >> 3)); return DD_OK; },
      Unlock: (x, self) => { const s = o(self); if (s.texture) s.dirty = true; if (s.primary && !d7.devices.size) show(x, s.locked); return DD_OK; },
      // Flip: the back buffer's memory becomes the front's, and is shown -- at the screen's next
      // vertical blank, 60 times a second, as a card flips: the call waits for it. Returning at once,
      // NESticle (1997) flipped 700 frames a second and its emulation got a twentieth of the machine.
      Flip: (x, self) => {
        const now = x.lx.mono();
        if (vbl.due && now < vbl.due) return x.waitUntil(vbl.due);
        vbl.due = (Math.floor(now * 60) + 1) / 60;
        const f = o(self), b = f.backBuffer && o(f.backBuffer);
        if (d7.devices.size) return d7.present(x);                   // a Direct3D 7 device's picture
        if (b) [f.mem, b.mem] = [b.mem, f.mem];
        show(x); return DD_OK;
      },
      // Blt: a copy (stretched to the destination rectangle) or a colour fill (DDBLTFX's dwFillColor at 80).
      Blt: (x, self, dr, src, sr, flags, fx) => {
        const d = o(self);
        // A device's render target copied onto the primary: a windowed Direct3D 7 device's frame.
        if (d.primary && d7.devices.size && src && o(src) && (o(src).back || o(src).three)) return d7.present(x);
        if (d.texture) d.dirty = true;
        if (flags & DDBLT_COLORFILL) fill(x, d, rect(x, dr, d), fx ? x.r32(fx + 80) : 0);
        else if (src && o(src)) copy(x, d, rect(x, dr, d), o(src), rect(x, sr, o(src)), !!(flags & DDBLT_KEYSRC));
        if (d.primary) show(x, rect(x, dr, d)); return DD_OK;
      },
      BltFast: (x, self, X, Y, src, sr, flags) => {
        const d = o(self), s = o(src); if (!s) return DDERR_INVALIDPARAMS;
        if (d.texture) d.dirty = true;
        const r = rect(x, sr, s);
        const dr = { l: X, t: Y, r: X + r.r - r.l, b: Y + r.b - r.t };
        copy(x, d, dr, s, r, !!(flags & DDBLTFAST_SRCCOLORKEY));
        if (d.primary) show(x, dr); return DD_OK;
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
        const bm = st.newHandle('bitmap', { w: s.w, h: s.h, px, load: (x) => toPx(x, s, px), store: (x) => { fromPx(x, s, px); if (s.texture) s.dirty = true; if (s.primary) show(x, { l: 0, t: 0, r: s.w, b: s.h }); } });
        const dc = st.newHandle('dc', {}); st.dcBitmaps.set(dc, bm);
        s.dc = { dc, bm }; x.w32(pdc, dc); return DD_OK;
      },
      ReleaseDC: (x, self) => {
        const s = o(self); if (!s.dc) return DDERR_INVALIDPARAMS;
        st.dcBitmaps.delete(s.dc.dc); st.gdi.delete(s.dc.bm); st.gdi.delete(s.dc.dc); s.dc = null; return DD_OK;
      },
      SetClipper: (x, self, c) => { o(self).clipper = c >>> 0; return DD_OK; }, GetClipper: () => DDERR_NOTFOUND, IsLost: () => DD_OK, Restore: () => DD_OK,
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
  IMPL.IDirectDraw2 = { ...IMPL.IDirectDraw,
    // DDSCAPS, then the total and free video memory: 8 MB, all free (nothing is in video memory here).
    GetAvailableVidMem: (x, self, caps, total, free) => { if (total) x.w32(total, 8 << 20); if (free) x.w32(free, 8 << 20); return DD_OK; } };
  IMPL.IDirectDrawSurface2 = { ...IMPL.IDirectDrawSurface,
    GetDDInterface: (x, self, pp) => { x.w32(pp, 0); return DDERR_INVALIDPARAMS; }, PageLock: () => DD_OK, PageUnlock: () => DD_OK };
  IMPL.IDirectDrawSurface3 = { ...IMPL.IDirectDrawSurface2, SetSurfaceDesc: () => DDERR_INVALIDPARAMS };
  IMPL.IDirectDraw4 = { ...IMPL.IDirectDraw2,
    GetSurfaceFromDC: () => DDERR_NOTFOUND, RestoreAllSurfaces: () => DD_OK, TestCooperativeLevel: () => DD_OK,
    // DDDEVICEIDENTIFIER(2): the driver's file and description (512 bytes each), its version, vendor and
    // device ids (none), a GUID -- MIRAGE's display.
    GetDeviceIdentifier: (x, self, p) => {
      x.write(p, new Uint8Array(1068)); const enc = (s) => new TextEncoder().encode(`${s}\0`);
      x.write(p, enc('mirage.drv')); x.write(p + 512, enc('MIRAGE display (Direct3D 7 on WebGL2)')); x.w32(p + 1024, 0x00010000); x.w32(p + 1028, 0x00040005);
      return DD_OK;
    } };
  IMPL.IDirectDraw7 = { ...IMPL.IDirectDraw4, StartModeTest: () => DD_OK, EvaluateMode: () => DD_OK };
  IMPL.IDirectDrawSurface4 = { ...IMPL.IDirectDrawSurface3, SetPrivateData: () => DD_OK, GetPrivateData: () => DDERR_NOTFOUND, FreePrivateData: () => DD_OK,
    GetUniquenessValue: (x, self, p) => { x.w32(p, 1); return DD_OK; }, ChangeUniquenessValue: () => DD_OK };
  IMPL.IDirectDrawSurface7 = { ...IMPL.IDirectDrawSurface4, SetPriority: () => DD_OK, GetPriority: (x, self, p) => { x.w32(p, 0); return DD_OK; },
    SetLOD: () => DD_OK, GetLOD: (x, self, p) => { x.w32(p, 0); return DD_OK; } };
  IMPL.IDirectDrawGammaControl = { GetGammaRamp: () => DD_OK, SetGammaRamp: () => DD_OK };
  Object.assign(IMPL, d7.IMPL);
  const sigOf = (s) => 'p' + (/^\d+$/.test(s) ? 'u'.repeat(+s) : s);
  const fns = {
    // DirectDrawCreate(guid, lplpDD, outer): the one display.
    DirectDrawCreate: ['ppp', (x, guid, pp) => { x.w32(pp, make(x, 'IDirectDraw', {})); return DD_OK; }],
    // DirectDrawCreateEx(guid, lplpDD, IID_IDirectDraw7, outer): DirectX 7's.
    DirectDrawCreateEx: ['pppp', (x, g, pp, riid) => {
      const want = riid && IIDS[guid(x, riid)];
      if (want !== 'IDirectDraw7') { x.w32(pp, 0); return DDERR_INVALIDPARAMS; }
      x.w32(pp, make(x, 'IDirectDraw7', {})); return DD_OK;
    }],
    // DirectDrawEnumerateExA(callback(GUID, description, name, context, monitor), context, flags)
    DirectDrawEnumerateExA: ['ppu', (x, cb, ctx) => {
      const d = x.win.heapAlloc(64); x.write(d, new TextEncoder().encode('Primary Display Driver\0display\0'));
      return send(x, [{ fn: cb, args: [0, d, d + 23, ctx, 0] }], () => DD_OK, 12);
    }],
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
