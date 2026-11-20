// glide.js — glide2x.dll for MIRAGE-WIN32: 3dfx's Glide 2.x, the Voodoo's own API, made on the OpenGL the
// page has (PRISM's gl.js through x.backend.gl, as opengl32's calls are), as the Glide wrappers of the 2000s
// make it (nGlide, dgVoodoo). Its exports are the stdcall names the games import (_grGlideInit@0 ...).
//
// A Voodoo draws what the program has already projected: each vertex its screen x and y, its 1/w (oow) and
// 1/z (ooz), its colour, and per texture unit s/w and t/w. Given to OpenGL as (x·W, y·W, d·W, W) with
// W = 1/oow under an orthographic projection of the screen, the GPU divides back and interpolates the colour
// and the texture coordinates with perspective, as the Voodoo does. The depth d is ooz / 65535 for the
// z-buffer, W/(1+W) (increasing with distance) for the w-buffer.
//
// Texture memory is the program's to manage: it downloads each mipmap level of a texture at an address of a
// TMU and later points a texture source at that address (grTexSource). Here each address is an OpenGL texture,
// its levels converted to RGBA from Glide's formats (RGB 565, ARGB 1555 and 4444, the palette's P8 -- made
// again when the palette changes -- alpha and intensity); a download over an address range drops the textures
// it overlaps. Texture coordinates run 0..256 along a texture's longer side.
//
// The colour and alpha combine units are OpenGL's texture environment for what the games ask (the texture
// alone, the texture times the iterated colour, the iterated or constant colour alone); blending, the depth
// test, alpha test and colour masks are OpenGL's own. Not here yet: fog (grFogTable), the chroma key, the
// linear frame buffer's writes, a second TMU.
//
// glide.h (Glide 2.43) for the constants and the structures.

const GL = {
  POINTS: 0, LINES: 1, TRIANGLE_FAN: 6, NEVER: 0x200, DEPTH_TEST: 0xb71, ALPHA_TEST: 0xbc0, BLEND: 0xbe2, TEXTURE_2D: 0xde1,
  COLOR_BUFFER_BIT: 0x4000, DEPTH_BUFFER_BIT: 0x100, PROJECTION: 0x1701, MODELVIEW: 0x1700, RGBA: 0x1908, UNSIGNED_BYTE: 0x1401,
  TEXTURE_MAG_FILTER: 0x2800, TEXTURE_MIN_FILTER: 0x2801, TEXTURE_WRAP_S: 0x2802, TEXTURE_WRAP_T: 0x2803, NEAREST: 0x2600, LINEAR: 0x2601,
  NEAREST_MIPMAP_NEAREST: 0x2700, LINEAR_MIPMAP_NEAREST: 0x2701, REPEAT: 0x2901, CLAMP_TO_EDGE: 0x812f, TEXTURE_MAX_LEVEL: 0x813d,
  TEXTURE_ENV: 0x2300, TEXTURE_ENV_MODE: 0x2200, MODULATE: 0x2100, REPLACE: 0x1e01, CULL_FACE: 0xb44,
  ZERO: 0, ONE: 1, SRC_COLOR: 0x300, ONE_MINUS_SRC_COLOR: 0x301, SRC_ALPHA: 0x302, ONE_MINUS_SRC_ALPHA: 0x303, DST_ALPHA: 0x304,
  ONE_MINUS_DST_ALPHA: 0x305, DST_COLOR: 0x306, ONE_MINUS_DST_COLOR: 0x307, SRC_ALPHA_SATURATE: 0x308,
};
// GrScreenResolution_t.
const RES = [[320, 200], [320, 240], [400, 256], [512, 384], [640, 200], [640, 350], [640, 400], [640, 480],
  [800, 600], [960, 720], [856, 480], [512, 256], [1024, 768], [1280, 1024], [1600, 1200], [400, 300]];
// GrAlphaBlendFnc_t as a source factor, and as a destination factor (2 and 6 name the other buffer's colour).
const SRC_BLEND = [GL.ZERO, GL.SRC_ALPHA, GL.DST_COLOR, GL.DST_ALPHA, GL.ONE, GL.ONE_MINUS_SRC_ALPHA, GL.ONE_MINUS_DST_COLOR, GL.ONE_MINUS_DST_ALPHA];
const DST_BLEND = [GL.ZERO, GL.SRC_ALPHA, GL.SRC_COLOR, GL.DST_ALPHA, GL.ONE, GL.ONE_MINUS_SRC_ALPHA, GL.ONE_MINUS_SRC_COLOR, GL.ONE_MINUS_DST_ALPHA];
// Combine: GR_COMBINE_FUNCTION_*, GR_COMBINE_FACTOR_*, GR_COMBINE_LOCAL_*, GR_COMBINE_OTHER_*.
const F_ZERO = 0, F_LOCAL = 1, F_LOCAL_ALPHA = 2, F_SCALE_OTHER = 3;
const FACTOR_ONE = 8, LOCAL_CONSTANT = 1, OTHER_TEXTURE = 1;
const TEXFMT_16 = 8;                                                   // formats from 8 up: two bytes a texel
const PALETTE_TABLE = 2;                                               // GR_TEXTABLE_PALETTE

/** The texture's size at its largest level: GrLOD_t (0 is 256, 8 is 1) and GrAspectRatio_t (0 8x1 ... 3 1x1 ... 6 1x8). */
export const texSize = (largeLod, aspect) => {
  const n = 256 >> largeLod;
  return aspect <= 3 ? { w: n, h: Math.max(1, n >> (3 - aspect)) } : { w: Math.max(1, n >> (aspect - 3)), h: n };
};
/** grTexCalcMemRequired: every level from largeLod to smallLod, a byte or two a texel, 8-byte aligned. */
export const texMem = (smallLod, largeLod, aspect, fmt) => {
  const { w, h } = texSize(largeLod, aspect), bpp = fmt >= TEXFMT_16 ? 2 : 1;
  let n = 0;
  for (let l = 0; l <= smallLod - largeLod; l++) n += Math.max(1, w >> l) * Math.max(1, h >> l) * bpp;
  return (n + 7) & ~7;
};
/** One level's texels (Glide's format `fmt`, w x h, bytes `src`) as RGBA; `pal` the palette (0x00RRGGBB). */
export const toRGBA = (fmt, w, h, src, pal) => {
  const n = w * h, out = new Uint8Array(n * 4);
  const put = (i, r, g, b, a) => { out[4 * i] = r; out[4 * i + 1] = g; out[4 * i + 2] = b; out[4 * i + 3] = a; };
  const s16 = (i) => src[2 * i] | (src[2 * i + 1] << 8);
  for (let i = 0; i < n; i++) {
    switch (fmt) {
      case 0: { const v = src[i]; put(i, (v >> 5) * 255 / 7, ((v >> 2) & 7) * 255 / 7, (v & 3) * 85, 255); break; }   // RGB_332
      case 2: put(i, 255, 255, 255, src[i]); break;                                                                // ALPHA_8
      case 3: put(i, src[i], src[i], src[i], 255); break;                                                          // INTENSITY_8
      case 4: { const v = src[i], a = (v >> 4) * 17, c = (v & 15) * 17; put(i, c, c, c, a); break; }               // ALPHA_INTENSITY_44
      case 5: { const c = pal ? pal[src[i]] : 0; put(i, (c >> 16) & 255, (c >> 8) & 255, c & 255, 255); break; }   // P_8
      case 8: { const v = s16(i), c = v & 255; put(i, (c >> 5) * 255 / 7, ((c >> 2) & 7) * 255 / 7, (c & 3) * 85, v >> 8); break; }   // ARGB_8332
      case 0xa: { const v = s16(i); put(i, ((v >> 11) & 31) * 255 / 31, ((v >> 5) & 63) * 255 / 63, (v & 31) * 255 / 31, 255); break; }   // RGB_565
      case 0xb: { const v = s16(i); put(i, ((v >> 10) & 31) * 255 / 31, ((v >> 5) & 31) * 255 / 31, (v & 31) * 255 / 31, v & 0x8000 ? 255 : 0); break; }   // ARGB_1555
      case 0xc: { const v = s16(i); put(i, ((v >> 8) & 15) * 17, ((v >> 4) & 15) * 17, (v & 15) * 17, (v >> 12) * 17); break; }   // ARGB_4444
      case 0xd: { const v = s16(i), c = v & 255; put(i, c, c, c, v >> 8); break; }                              // ALPHA_INTENSITY_88
      case 0xe: { const v = s16(i), c = pal ? pal[v & 255] : 0; put(i, (c >> 16) & 255, (c >> 8) & 255, c & 255, v >> 8); break; }   // AP_88
      default: put(i, 255, 0, 255, 255);                                // YIQ and the rest: not here, a visible colour
    }
  }
  return out;
};
/** guFogTableIndexToW: the w a fog table's entry stands for (glide.h's formula). */
export const fogIndexToW = (i) => 2 ** (3 + (i >> 2)) / (8 - (i & 3));

export function glideApis({ st }) {
  const g = {                                                          // the board's state
    open: false, w: 640, h: 480, origin: 0, lastSwap: -1, depthMode: 0, depthMask: true, depthFn: 1,
    cc: [F_SCALE_OTHER, 1, 0, OTHER_TEXTURE, 0], ac: [F_SCALE_OTHER, 1, 0, OTHER_TEXTURE, 0], constant: 0xffffffff,
    tex: new Map(), cur: null, palette: new Uint32Array(256), palVer: 0, clampS: 0, clampT: 0, minF: 1, magF: 1, mip: 0,
  };
  const gl = (x, name, ...a) => x.backend.gl(name, a);
  // What the colour combine unit asks, as OpenGL's texture environment: textured or not, and how.
  const applyCombine = (x) => {
    const [fn, factor, local, other] = g.cc;
    const textured = fn !== F_ZERO && fn !== F_LOCAL && fn !== F_LOCAL_ALPHA && other === OTHER_TEXTURE && g.cur;
    if (textured) {
      gl(x, 'glEnable', GL.TEXTURE_2D);
      gl(x, 'glTexEnvi', GL.TEXTURE_ENV, GL.TEXTURE_ENV_MODE, factor === FACTOR_ONE ? GL.REPLACE : GL.MODULATE);
    } else gl(x, 'glDisable', GL.TEXTURE_2D);
    g.useConstant = (textured ? factor !== FACTOR_ONE : true) && local === LOCAL_CONSTANT;
    g.black = fn === F_ZERO;
  };
  // A texture: its levels converted from what was downloaded, made again when the palette it used changed.
  const upload = (x, t) => {
    gl(x, 'glBindTexture', GL.TEXTURE_2D, t.name);
    for (const [l, raw] of t.levels) gl(x, 'glTexImage2D', GL.TEXTURE_2D, l, GL.RGBA, raw.w, raw.h, 0, GL.RGBA, GL.UNSIGNED_BYTE, toRGBA(t.fmt, raw.w, raw.h, raw.bytes, g.palette));
    t.palVer = g.palVer;
  };
  const params = (x, t) => {
    const mip = g.mip && t.levels.size > 1;
    gl(x, 'glTexParameteri', GL.TEXTURE_2D, GL.TEXTURE_MAX_LEVEL, mip ? Math.max(...t.levels.keys()) : 0);
    gl(x, 'glTexParameteri', GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, mip ? (g.minF ? GL.LINEAR_MIPMAP_NEAREST : GL.NEAREST_MIPMAP_NEAREST) : g.minF ? GL.LINEAR : GL.NEAREST);
    gl(x, 'glTexParameteri', GL.TEXTURE_2D, GL.TEXTURE_MAG_FILTER, g.magF ? GL.LINEAR : GL.NEAREST);
    gl(x, 'glTexParameteri', GL.TEXTURE_2D, GL.TEXTURE_WRAP_S, g.clampS ? GL.CLAMP_TO_EDGE : GL.REPEAT);
    gl(x, 'glTexParameteri', GL.TEXTURE_2D, GL.TEXTURE_WRAP_T, g.clampT ? GL.CLAMP_TO_EDGE : GL.REPEAT);
  };
  const bind = (x) => {
    const t = g.cur; if (!t) return;
    const paletted = t.fmt === 5 || t.fmt === 0xe;
    if (paletted && t.palVer !== g.palVer) upload(x, t);
    else gl(x, 'glBindTexture', GL.TEXTURE_2D, t.name);
    params(x, t);
  };
  // A vertex (GrVertex, 72 bytes): x, y, z, r, g, b, ooz, a, oow, then s/w, t/w, 1/w of each TMU.
  const vertex = (x, p) => {
    const f = (o) => x.f32(p + o), oow = f(32) || 1e-6, W = 1 / oow, sx = f(0), sy = f(4);
    const d = g.depthMode === 1 || g.depthMode === 3 ? f(24) / 65535 : W / (1 + W);
    if (g.black) gl(x, 'glColor4f', 0, 0, 0, f(28) / 255);
    else if (g.useConstant) { const c = g.constant; gl(x, 'glColor4f', ((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255, (c >>> 24) / 255); }
    else gl(x, 'glColor4f', f(12) / 255, f(16) / 255, f(20) / 255, f(28) / 255);
    if (g.cur) { const tw = f(44) || oow; gl(x, 'glTexCoord2f', (f(36) / tw) * g.cur.sScale, (f(40) / tw) * g.cur.tScale); }
    gl(x, 'glVertex4f', sx * W, sy * W, d * W, W);
  };
  const draw = (x, mode, ptrs) => {
    applyCombine(x); if (g.cur) bind(x);
    gl(x, 'glBegin', mode); for (const p of ptrs) vertex(x, p); gl(x, 'glEnd');
  };
  const screen = (x) => {
    gl(x, 'glViewport', 0, 0, g.w, g.h);
    gl(x, 'glMatrixMode', GL.PROJECTION); gl(x, 'glLoadIdentity');
    gl(x, 'glOrtho', 0, g.w, g.origin ? 0 : g.h, g.origin ? g.h : 0, 0, -1);   // GR_ORIGIN_UPPER_LEFT 0, LOWER_LEFT 1
    gl(x, 'glMatrixMode', GL.MODELVIEW); gl(x, 'glLoadIdentity');
    gl(x, 'glDisable', GL.CULL_FACE);
  };
  const depth = (x) => {
    if (g.depthMode) { gl(x, 'glEnable', GL.DEPTH_TEST); gl(x, 'glDepthFunc', GL.NEVER + (g.depthFn & 7)); } else gl(x, 'glDisable', GL.DEPTH_TEST);
    gl(x, 'glDepthMask', g.depthMask ? 1 : 0);
  };
  // GrHwConfiguration: one Voodoo 2 (GR_SSTTYPE_Voodoo2, 3), 4 MiB of frame buffer, one TMU of 4 MiB.
  const hwConfig = (x, p) => {
    x.write(p, new Uint8Array(4 + 4 * 44)); x.w32(p, 1);
    [3, 4, 2, 1, 0, 2, 4].forEach((v, i) => x.w32(p + 4 + 4 * i, v));   // type; fbRam, fbiRev, nTexelfx, sliDetect; tmu 0: rev, ram
    return 1;
  };
  const fns = {
    _grGlideInit$0: ['', () => 0], _grGlideShutdown$0: ['', () => 0],
    _grGlideGetVersion$4: ['p', (x, p) => { x.write(p, new TextEncoder().encode('2.43\0')); return 0; }],
    _grSstQueryBoards$4: ['p', (x, p) => hwConfig(x, p)], _grSstQueryHardware$4: ['p', (x, p) => hwConfig(x, p)],
    _grSstSelect$4: ['u', () => 0], _grErrorSetCallback$4: ['p', () => 0], _grHints$8: ['uu', () => 0],
    // The board's screen: the picture WebGL draws, at the resolution asked (GR_RESOLUTION_NONE: the window's).
    _grSstWinOpen$28: ['puuuuuu', (x, hwnd, res, refresh, cfmt, origin) => {
      const [w, h] = RES[res] || [st.w || 640, st.h || 480];
      Object.assign(g, { open: true, w, h, origin, cfmt });
      x.backend.setVideoMode(w, h, true); screen(x); depth(x);
      return 1;
    }],
    _grSstWinClose$0: ['', () => { g.open = false; return 0; }],
    _grSstScreenWidth$0: ['', () => ({ st0: g.w })], _grSstScreenHeight$0: ['', () => ({ st0: g.h })],
    // Swapped on the vertical blank: no faster than sixty a second of the guest's clock, one frame in flight.
    _grBufferSwap$4: ['u', (x) => {
      const now = x.lx.mono();
      if (now < g.lastSwap + 1 / 60) return x.waitUntil(g.lastSwap + 1 / 60);
      if (x.backend.swapReady && !x.backend.swapReady()) return x.waitUntil(now + 0.002);
      g.lastSwap = now; x.backend.swap(); return 0;
    }],
    _grBufferNumPending$0: ['', () => 0],
    // grBufferClear(colour as grSstWinOpen's format says -- ARGB here --, alpha, depth 0..65535).
    _grBufferClear$12: ['uuu', (x, c, a, dz) => {
      gl(x, 'glClearColor', ((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255, (a & 255) / 255);
      gl(x, 'glClearDepth', (dz & 0xffff) / 65535);
      gl(x, 'glDepthMask', 1); gl(x, 'glClear', GL.COLOR_BUFFER_BIT | (g.depthMode ? GL.DEPTH_BUFFER_BIT : 0)); gl(x, 'glDepthMask', g.depthMask ? 1 : 0);
      return 0;
    }],
    _grColorMask$8: ['uu', (x, rgb, a) => { gl(x, 'glColorMask', rgb ? 1 : 0, rgb ? 1 : 0, rgb ? 1 : 0, a ? 1 : 0); return 0; }],
    _grDepthMask$4: ['u', (x, on) => { g.depthMask = !!on; depth(x); return 0; }],
    _grDepthBufferMode$4: ['u', (x, m) => { g.depthMode = m; depth(x); return 0; }],
    _grDepthBufferFunction$4: ['u', (x, f) => { g.depthFn = f; depth(x); return 0; }],
    _grDepthBiasLevel$4: ['i', () => 0], _grDitherMode$4: ['u', () => 0],
    _grAlphaBlendFunction$16: ['uuuu', (x, sf, df) => {
      if (sf === 4 && df === 0) gl(x, 'glDisable', GL.BLEND);
      else { gl(x, 'glEnable', GL.BLEND); gl(x, 'glBlendFunc', SRC_BLEND[sf] ?? GL.ONE, sf === 0xf ? GL.SRC_ALPHA_SATURATE : DST_BLEND[df] ?? GL.ZERO); }
      return 0;
    }],
    _grAlphaTestFunction$4: ['u', (x, f) => { g.alphaFn = f; if ((f & 7) === 7) gl(x, 'glDisable', GL.ALPHA_TEST); else { gl(x, 'glEnable', GL.ALPHA_TEST); gl(x, 'glAlphaFunc', GL.NEVER + (f & 7), (g.alphaRef | 0) / 255); } return 0; }],
    _grAlphaTestReferenceValue$4: ['u', (x, v) => { g.alphaRef = v & 255; if (g.alphaFn !== undefined && (g.alphaFn & 7) !== 7) gl(x, 'glAlphaFunc', GL.NEVER + (g.alphaFn & 7), g.alphaRef / 255); return 0; }],
    _grColorCombine$20: ['uuuuu', (x, fn, factor, local, other, inv) => { g.cc = [fn, factor, local, other, inv]; return 0; }],
    _grAlphaCombine$20: ['uuuuu', (x, fn, factor, local, other, inv) => { g.ac = [fn, factor, local, other, inv]; return 0; }],
    _grConstantColorValue$4: ['u', (x, c) => { g.constant = c >>> 0; return 0; }],
    _grChromakeyMode$4: ['u', () => 0], _grChromakeyValue$4: ['u', () => 0],
    _grFogMode$4: ['u', () => 0], _grFogColorValue$4: ['u', () => 0], _grFogTable$4: ['p', () => 0],
    _grGammaCorrectionValue$4: ['f', (x, v) => { if (x.backend.setGamma) x.backend.setGamma(v > 0 ? v : 1); return 0; }],
    _grDrawPolygonVertexList$8: ['up', (x, n, v) => { draw(x, GL.TRIANGLE_FAN, Array.from({ length: n }, (_, i) => v + 72 * i)); return 0; }],
    _grDrawPlanarPolygonVertexList$8: ['up', (x, n, v) => { draw(x, GL.TRIANGLE_FAN, Array.from({ length: n }, (_, i) => v + 72 * i)); return 0; }],
    _grDrawLine$8: ['pp', (x, a, b) => { draw(x, GL.LINES, [a, b]); return 0; }],
    // Texture memory: 4 MiB a TMU, addresses 0 up.
    _grTexMinAddress$4: ['u', () => 0], _grTexMaxAddress$4: ['u', () => 0x3ffff8],
    _grTexCalcMemRequired$16: ['uuuu', (x, small, large, aspect, fmt) => texMem(small, large, aspect, fmt)],
    // A level downloaded at an address: the texture there (made, or dropped and made again when its format or
    // size changed); the textures whose memory it overlaps are gone.
    _grTexDownloadMipMapLevel$32: ['uuuuuuup', (x, tmu, addr, lod, large, aspect, fmt, evenOdd, data) => {
      const key = `${tmu}:${addr}`, { w, h } = texSize(large, aspect), l = lod - large, lw = Math.max(1, w >> l), lh = Math.max(1, h >> l);
      let t = g.tex.get(key);
      if (!t || t.fmt !== fmt || t.w !== w || t.h !== h) {
        const end = addr + texMem(8, large, aspect, fmt);
        for (const [k, o] of g.tex) if (k !== key && o.tmu === tmu && o.addr < end && addr < o.end) { g.tex.delete(k); if (g.cur === o) g.cur = null; }
        t = { tmu, addr, end, fmt, w, h, levels: new Map(), name: x.backend.gl('glGenTexture', []) || g.tex.size + 1,
          sScale: 1 / (w >= h ? 256 : 256 * w / h), tScale: 1 / (h >= w ? 256 : 256 * h / w), palVer: -1 };
        g.tex.set(key, t);
      }
      const bytes = x.bytes(data, lw * lh * (fmt >= TEXFMT_16 ? 2 : 1)).slice();
      t.levels.set(l, { w: lw, h: lh, bytes });
      gl(x, 'glBindTexture', GL.TEXTURE_2D, t.name);
      gl(x, 'glTexImage2D', GL.TEXTURE_2D, l, GL.RGBA, lw, lh, 0, GL.RGBA, GL.UNSIGNED_BYTE, toRGBA(fmt, lw, lh, bytes, g.palette));
      t.palVer = g.palVer;
      return 0;
    }],
    _grTexDownloadMipMapLevelPartial$40: ['uuuuuuupii', (x, tmu, addr, lod, large, aspect, fmt, evenOdd, data, first, last) => {
      // Rows first..last of the level: kept with the rest of it, and the whole level given again.
      const key = `${tmu}:${addr}`, t = g.tex.get(key), { w, h } = texSize(large, aspect), l = lod - large, lw = Math.max(1, w >> l), lh = Math.max(1, h >> l), bpp = fmt >= TEXFMT_16 ? 2 : 1;
      if (!t || !t.levels.has(l)) return fns._grTexDownloadMipMapLevel$32[1](x, tmu, addr, lod, large, aspect, fmt, evenOdd, data);
      const lev = t.levels.get(l);
      lev.bytes.set(x.bytes(data, (last - first + 1) * lw * bpp), first * lw * bpp);
      gl(x, 'glBindTexture', GL.TEXTURE_2D, t.name);
      gl(x, 'glTexImage2D', GL.TEXTURE_2D, l, GL.RGBA, lw, lh, 0, GL.RGBA, GL.UNSIGNED_BYTE, toRGBA(fmt, lw, lh, lev.bytes, g.palette));
      return 0;
    }],
    // The palette (256 entries 0x00RRGGBB): the paletted textures are made again from it when next used.
    _grTexDownloadTable$12: ['uup', (x, tmu, type, data) => {
      if (type === PALETTE_TABLE) { for (let i = 0; i < 256; i++) g.palette[i] = x.r32(data + 4 * i) & 0xffffff; g.palVer++; }
      return 0;
    }],
    // The texture drawn with from now on: the one downloaded at that address (GrTexInfo: smallLod, largeLod, aspect, format, data).
    _grTexSource$16: ['uuup', (x, tmu, addr) => { g.cur = g.tex.get(`${tmu}:${addr}`) || null; return 0; }],
    _grTexClampMode$12: ['uuu', (x, tmu, s, t) => { g.clampS = s; g.clampT = t; return 0; }],
    _grTexFilterMode$12: ['uuu', (x, tmu, min, mag) => { g.minF = min; g.magF = mag; return 0; }],
    _grTexMipMapMode$12: ['uuu', (x, tmu, mode) => { g.mip = mode; return 0; }],
    _grTexLodBiasValue$8: ['uf', () => 0],
    _grTexCombine$28: ['uuuuuuu', () => 0],
    _grLfbLock$24: ['uuuuup', () => 0], _grLfbUnlock$8: ['uu', () => 0],   // FXFALSE: no linear frame buffer yet
    _grLfbReadRegion$28: ['uuuuuup', () => 0],
    // The utility library: combine functions by name, as glide.h's guColorCombineFunction maps them.
    _guColorCombineFunction$4: ['u', (x, f) => {
      // GR_COLORCOMBINE_ZERO 0, CCRGB 1, ITRGB 2, ITRGB_DELTA0 3, DECAL_TEXTURE 4, TEXTURE_TIMES_CCRGB 5, TEXTURE_TIMES_ITRGB 6 ...
      g.cc = [[F_ZERO, 0, 0, 0], [F_LOCAL, 0, LOCAL_CONSTANT, 0], [F_LOCAL, 0, 0, 0], [F_LOCAL, 0, 0, 0], [F_SCALE_OTHER, FACTOR_ONE, 0, OTHER_TEXTURE],
        [F_SCALE_OTHER, 1, LOCAL_CONSTANT, OTHER_TEXTURE], [F_SCALE_OTHER, 1, 0, OTHER_TEXTURE]][f] || [F_SCALE_OTHER, 1, 0, OTHER_TEXTURE];
      return 0;
    }],
    _guAlphaSource$4: ['u', () => 0], _guTexCombineFunction$8: ['uu', () => 0],
    _guFogTableIndexToW$4: ['i', (x, i) => ({ st0: fogIndexToW(i) })],
  };
  // The exported names: '$' for '@' above (an object key is easier so).
  const out = {}; for (const [k, v] of Object.entries(fns)) out[k.replace('$', '@')] = v;
  return [{ dll: 'glide2x.dll', fns: out }];
}
