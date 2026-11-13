// api.js — the Win32 API of MIRAGE-WIN32, in JavaScript: what the scene's OpenGL intros of 2007-2010
// call, by DLL. A function is [signature, fn(x, ...args), options] (signatures as src/hle: i int,
// u unsigned, p pointer, f float, d double); stdcall unless { cdecl: true }; `x.win` is the process
// (src/win32/index.js), `x.backend` the window and the GL (src/hle/prism-gl.js in a page, the tracer
// headless). The GL itself is src/hle/gl.js's table, stdcall here as opengl32.dll's entry points are.
//
// A name exported but not answered says so when called (NOT): the packers resolve every name by hash
// before running, so a missing name is a crash with no name, a present one a message that names it.
import { gl as glTable, glu as gluTable } from '../hle/gl.js';
import { d3d9Apis } from './d3d9.js';
import { dsoundApis } from './dsound.js';
import { dinputApis } from './dinput.js';
import { parseTrueType } from './truetype.js';
import { parseSMF } from '../midi.js';
import { windowManager } from './wm.js';
import { ddrawApis } from './ddraw.js';
import { classicApis, loadString, decodeDib, findResource, resId } from './classic.js';
import { modernApis } from './modern.js';
import { parseAvi, decodeFrame } from './avi.js';
import { ucrtApis } from './ucrt.js';

const NOT = (dll, name, sig = '') => [sig, () => { throw new Error(`mirage-win32: ${dll}!${name} is not implemented`); }];

/*
 * OPENGL32.DLL'S EXPORTS, in the order that numbers them: Windows XP's opengl32.dll exports these 368
 * names with ordinals 1 to 366 in ASCII order (the Glmf metafile calls, OpenGL 1.1 and glDebugEntry,
 * wgl). A program can import by ordinal, and Crinkler's /RANGE does -- an intro then calls "the
 * function 37 after glAccum" -- so the numbering is part of the interface: Stripped (2009) called
 * glEnable where it meant wglCreateContext while the ordinals were ours. OpenGL 1.1's names are
 * PRISM's src/env/opengl32.c's, with glGetTexLevelParameterfv and iv, which it does not export.
 */
const GL11 = `
  glAccum glAlphaFunc glAreTexturesResident glArrayElement glBegin glBindTexture glBitmap glBlendFunc 
  glCallList glCallLists glClear glClearAccum glClearColor glClearDepth glClearIndex glClearStencil glClipPlane 
  glColor3b glColor3bv glColor3d glColor3dv glColor3f glColor3fv glColor3i glColor3iv glColor3s glColor3sv 
  glColor3ub glColor3ubv glColor3ui glColor3uiv glColor3us glColor3usv glColor4b glColor4bv glColor4d 
  glColor4dv glColor4f glColor4fv glColor4i glColor4iv glColor4s glColor4sv glColor4ub glColor4ubv glColor4ui 
  glColor4uiv glColor4us glColor4usv glColorMask glColorMaterial glColorPointer glCopyPixels glCopyTexImage1D 
  glCopyTexImage2D glCopyTexSubImage1D glCopyTexSubImage2D glCullFace glDeleteLists glDeleteTextures 
  glDepthFunc glDepthMask glDepthRange glDisable glDisableClientState glDrawArrays glDrawBuffer glDrawElements 
  glDrawPixels glEdgeFlag glEdgeFlagPointer glEdgeFlagv glEnable glEnableClientState glEnd glEndList 
  glEvalCoord1d glEvalCoord1dv glEvalCoord1f glEvalCoord1fv glEvalCoord2d glEvalCoord2dv glEvalCoord2f 
  glEvalCoord2fv glEvalMesh1 glEvalMesh2 glEvalPoint1 glEvalPoint2 glFeedbackBuffer glFinish glFlush glFogf 
  glFogfv glFogi glFogiv glFrontFace glFrustum glGenLists glGenTextures glGetBooleanv glGetClipPlane 
  glGetDoublev glGetError glGetFloatv glGetIntegerv glGetLightfv glGetLightiv glGetMapdv glGetMapfv glGetMapiv 
  glGetMaterialfv glGetMaterialiv glGetPixelMapfv glGetPixelMapuiv glGetPixelMapusv glGetPointerv 
  glGetPolygonStipple glGetString glGetTexEnvfv glGetTexEnviv glGetTexGendv glGetTexGenfv glGetTexGeniv 
  glGetTexImage glGetTexLevelParameterfv glGetTexLevelParameteriv glGetTexParameterfv glGetTexParameteriv glHint glIndexMask glIndexPointer glIndexd glIndexdv 
  glIndexf glIndexfv glIndexi glIndexiv glIndexs glIndexsv glIndexub glIndexubv glInitNames glInterleavedArrays 
  glIsEnabled glIsList glIsTexture glLightModelf glLightModelfv glLightModeli glLightModeliv glLightf glLightfv 
  glLighti glLightiv glLineStipple glLineWidth glListBase glLoadIdentity glLoadMatrixd glLoadMatrixf glLoadName 
  glLogicOp glMap1d glMap1f glMap2d glMap2f glMapGrid1d glMapGrid1f glMapGrid2d glMapGrid2f glMaterialf 
  glMaterialfv glMateriali glMaterialiv glMatrixMode glMultMatrixd glMultMatrixf glNewList glNormal3b 
  glNormal3bv glNormal3d glNormal3dv glNormal3f glNormal3fv glNormal3i glNormal3iv glNormal3s glNormal3sv 
  glNormalPointer glOrtho glPassThrough glPixelMapfv glPixelMapuiv glPixelMapusv glPixelStoref glPixelStorei 
  glPixelTransferf glPixelTransferi glPixelZoom glPointSize glPolygonMode glPolygonOffset glPolygonStipple 
  glPopAttrib glPopClientAttrib glPopMatrix glPopName glPrioritizeTextures glPushAttrib glPushClientAttrib 
  glPushMatrix glPushName glRasterPos2d glRasterPos2dv glRasterPos2f glRasterPos2fv glRasterPos2i 
  glRasterPos2iv glRasterPos2s glRasterPos2sv glRasterPos3d glRasterPos3dv glRasterPos3f glRasterPos3fv 
  glRasterPos3i glRasterPos3iv glRasterPos3s glRasterPos3sv glRasterPos4d glRasterPos4dv glRasterPos4f 
  glRasterPos4fv glRasterPos4i glRasterPos4iv glRasterPos4s glRasterPos4sv glReadBuffer glReadPixels glRectd 
  glRectdv glRectf glRectfv glRecti glRectiv glRects glRectsv glRenderMode glRotated glRotatef glScaled 
  glScalef glScissor glSelectBuffer glShadeModel glStencilFunc glStencilMask glStencilOp glTexCoord1d 
  glTexCoord1dv glTexCoord1f glTexCoord1fv glTexCoord1i glTexCoord1iv glTexCoord1s glTexCoord1sv glTexCoord2d 
  glTexCoord2dv glTexCoord2f glTexCoord2fv glTexCoord2i glTexCoord2iv glTexCoord2s glTexCoord2sv glTexCoord3d 
  glTexCoord3dv glTexCoord3f glTexCoord3fv glTexCoord3i glTexCoord3iv glTexCoord3s glTexCoord3sv glTexCoord4d 
  glTexCoord4dv glTexCoord4f glTexCoord4fv glTexCoord4i glTexCoord4iv glTexCoord4s glTexCoord4sv 
  glTexCoordPointer glTexEnvf glTexEnvfv glTexEnvi glTexEnviv glTexGend glTexGendv glTexGenf glTexGenfv 
  glTexGeni glTexGeniv glTexImage1D glTexImage2D glTexParameterf glTexParameterfv glTexParameteri 
  glTexParameteriv glTexSubImage1D glTexSubImage2D glTranslated glTranslatef glVertex2d glVertex2dv glVertex2f 
  glVertex2fv glVertex2i glVertex2iv glVertex2s glVertex2sv glVertex3d glVertex3dv glVertex3f glVertex3fv 
  glVertex3i glVertex3iv glVertex3s glVertex3sv glVertex4d glVertex4dv glVertex4f glVertex4fv glVertex4i 
  glVertex4iv glVertex4s glVertex4sv glVertexPointer glViewport
`.trim().split(/\s+/);
const OPENGL32 = ['GlmfBeginGlsBlock', 'GlmfCloseMetaFile', 'GlmfEndGlsBlock', 'GlmfEndPlayback', 'GlmfInitPlayback', 'GlmfPlayGlsRecord',
  ...GL11, 'glDebugEntry',
  'wglChoosePixelFormat', 'wglCopyContext', 'wglCreateContext', 'wglCreateLayerContext', 'wglDeleteContext', 'wglDescribeLayerPlane',
  'wglDescribePixelFormat', 'wglGetCurrentContext', 'wglGetCurrentDC', 'wglGetDefaultProcAddress', 'wglGetLayerPaletteEntries',
  'wglGetPixelFormat', 'wglGetProcAddress', 'wglMakeCurrent', 'wglRealizeLayerPalette', 'wglSetLayerPaletteEntries', 'wglSetPixelFormat',
  'wglShareLists', 'wglSwapBuffers', 'wglSwapLayerBuffers', 'wglSwapMultipleBuffers', 'wglUseFontBitmapsA', 'wglUseFontBitmapsW',
  'wglUseFontOutlinesA', 'wglUseFontOutlinesW'].sort((p, q) => (p < q ? -1 : p > q ? 1 : 0));
/** `fns` numbered as opengl32.dll numbers them, every one of its names present (NOT those unanswered). */
const numbered = (fns) => {
  const out = {};
  OPENGL32.forEach((name, i) => { const f = fns[name] || NOT('opengl32', name); out[name] = [f[0], f[1], { ...(f[2] || {}), ordinal: i + 1 }]; });
  for (const [name, f] of Object.entries(fns)) if (!out[name]) out[name] = f;   // GL 2.0 and extensions: wglGetProcAddress's
  return out;
};

/** The process's window and its GL context, as the APIs below share them. */
/*
 * The faces Windows XP answers with another (HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\
 * FontSubstitutes, as XP installs it): a program that asks for "Times" gets Times New Roman. luxo4k (2009)
 * writes its title in "times".
 */
export const FONT_SUBSTITUTES = { times: 'times new roman', helvetica: 'arial', 'ms shell dlg': 'microsoft sans serif', 'ms shell dlg 2': 'tahoma' };

function windowState(fonts = {}) {
  const st = { hwnd: 0x10010, hdc: 0x1001, hglrc: 0x10000, w: 640, h: 480, mode: null, lastSwap: 0, keys: new Set(), msgs: [] };
  // GDI's objects (fonts, DCs) by handle; the font selected into each DC.
  st.gdi = new Map(); st.dcFonts = new Map();
  // The stock fonts (GetStockObject 10-17): OEM_FIXED_FONT, ANSI_FIXED_FONT, ANSI_VAR_FONT, SYSTEM_FONT,
  // DEVICE_DEFAULT_FONT, SYSTEM_FIXED_FONT, DEFAULT_GUI_FONT -- the last the one dialogs are drawn in
  // (MS Shell Dlg 8 points: 11 pixels at 96 dpi).
  [[10, 'courier new', -12, 400, 1], [11, 'courier new', -12, 400, 1], [12, 'ms sans serif', -11, 400, 2], [13, 'system', -13, 700, 2],
    [14, 'system', -13, 700, 2], [16, 'courier new', -13, 400, 1], [17, 'ms shell dlg', -11, 400, 2]]
    .forEach(([i, face, height, weight, pitch]) => st.gdi.set(0x01900010 + i, { kind: 'font', face, height, weight, pitch, charset: 1 }));
  let next = 0x0a0a0001;
  st.newHandle = (kind, props) => { const hnd = next++; st.gdi.set(hnd, { kind, ...props }); return hnd; };
  // The outlines of the font selected into `hdc` (src/win32/truetype.js), or null: `fonts` holds a face's
  // .ttf under its lower-case name ("tahoma", "tahoma:bold" for a weight of 600 or more).
  const parsed = new Map();
  // A DC with no font selected draws in SYSTEM_FONT (GetStockObject 13), as Windows' do: Spider's score.
  st.dcFont = (hdc) => {
    const f = st.gdi.get(st.dcFonts.get(hdc) ?? 0x0190001d);
    if (!f) return null;
    // No face named: the font mapper's choice by pitch -- FIXED_PITCH (1) Courier New, else Arial; on a
    // Japanese system MS Gothic first (Cave Story names none until its Config.dat does).
    const faces = f.face ? [f.face.toLowerCase()] : [...(st.acp === 932 ? ['ms gothic'] : []), (f.pitch & 3) === 1 ? 'courier new' : 'arial'];
    if (FONT_SUBSTITUTES[faces[0]]) faces.push(FONT_SUBSTITUTES[faces[0]]);
    // ...and, of the faces this machine has none, Arial (the mapper's nearest for MS Sans Serif, System).
    const key = [...faces, 'arial'].flatMap((face) => [f.weight >= 600 ? `${face}:bold` : null, face]).find((k) => k && fonts[k]);
    if (!key) return null;
    if (!parsed.has(key)) parsed.set(key, parseTrueType(fonts[key]));
    return parsed.get(key);
  };
  return st;
}

/** The DLLs' tables. `gl`, `glu`: the GL and GLU entry points to use instead of the tracer's (in a page,
 *  src/hle/prism-gl.js's, on PRISM's gl.js) — the same signatures. `fonts`: the TrueType fonts a program
 *  may select, { "tahoma": bytes, "tahoma:bold": bytes } (src/win32/fonts.js finds them in a page).
 *  `files`: files a program may open (OpenFile), by lower-case base name, { "gm.dls": bytes }. */
const GM_DLS_SIZE = 3440660;
// A block grown in place when it fits, else moved: the old contents copied, what grows zeroed if asked.
function reAlloc(x, p, n, zero) {
  if (!p) { const q = x.win.heapAlloc(n); if (zero) x.write(q, new Uint8Array(n)); return q; }
  const old = x.win.heapSize(p);
  if (n <= old) return p;
  const q = x.win.heapAlloc(n);
  x.write(q, x.bytes(p, old)); if (zero) x.write(q + old, new Uint8Array(n - old));
  x.win.heapFree(p); return q;
}

export function win32Apis({ gl, glu, fonts, files = {}, env = {}, codepage = 1252, desk = null } = {}) {
  const st = windowState(fonts);
  // The system's code page (GetACP): 1252, a Western Windows XP's, or 932, a Japanese one's -- what the
  // ANSI calls' bytes mean, Shift-JIS there (Cave Story's text, 2004). An image's `machine.codepage`.
  st.acp = codepage === 932 ? 932 : 1252;
  const sjis = new TextDecoder('shift_jis');
  /** Bytes of the system's code page as UTF-16 code units. */
  st.ansiDecode = (b) => (st.acp === 932 ? [...sjis.decode(b)].flatMap((c) => { const v = c.codePointAt(0); return v > 0xffff ? [0xd800 + ((v - 0x10000) >> 10), 0xdc00 + ((v - 0x10000) & 0x3ff)] : [v]; }) : [...b]);
  const wm = windowManager(st);                                       // the screen the window sits on (src/win32/wm.js)
  // The desktop's size, "800x600" (the page's choice, an image's machine.desktop): 1024x768 otherwise.
  { const [dw, dh] = String(desk || '').split('x').map(Number); if (dw >= 320 && dh >= 200) st.desk = { w: dw, h: dh }; }
  st.files = [];                                                      // handle - 4000h -> { f, pos }
  st.env = new Map(Object.entries(env).map(([k, v]) => [k.toUpperCase(), String(v)]));   // the environment beyond PATH (GetEnvironmentVariable)
  st.events = new Map(); st.dcBitmaps = new Map(); st.dcStates = new Map();
  const dcState = (hdc) => { let d = st.dcStates.get(hdc); if (!d) st.dcStates.set(hdc, d = { bkMode: 2, bkColor: 0xffffff, textColor: 0 }); return d; };
  // A DC's font in pixels: its em (lfHeight < 0 is the character height, > 0 the cell's), its ascent
  // and descent as the font's win metrics give them.
  const textMetrics = (hdc) => {
    const f = st.gdi.get(st.dcFonts.get(hdc) ?? 0x0190001d) || { height: 16, weight: 400 }, font = st.dcFont(hdc);
    const asc = font ? font.winAscent : 0.8, desc = font ? font.winDescent : 0.2, em = font ? font.em : 1;
    const h = f.height || 16, ppem = h < 0 ? -h : Math.max(1, Math.round(h * em / (asc + desc)));
    const ascent = Math.round(asc * ppem / em), descent = Math.round(desc * ppem / em);
    return { font, ppem, ascent, descent, height: ascent + descent, avg: Math.max(1, Math.round(ppem / 2)), max: ppem, weight: f.weight || 400 };
  };
  // A string's characters as GDI draws it: the bytes of the font's character set -- SHIFTJIS_CHARSET
  // (128), or DEFAULT_CHARSET (1) on a system whose code page is Shift-JIS, decoded as Shift-JIS; else
  // each byte its own character (Windows-1252's letters are Unicode's below 256 but for 80-9F).
  const textChars = (hdc, b) => {
    const f = st.gdi.get(st.dcFonts.get(hdc)), cs = f ? f.charset : 1;
    return cs === 128 || (cs === 1 && st.acp === 932) ? [...sjis.decode(b)].map((c) => c.codePointAt(0)) : [...b];
  };
  const fillRect = (bm, x0, y0, x1, y1, c) => {
    for (let y = Math.max(0, y0); y < Math.min(bm.h, y1); y++) bm.px.fill(c, y * bm.w + Math.max(0, x0), y * bm.w + Math.max(0, Math.min(bm.w, x1)));
  };
  // A glyph's outline (truetype.js: y up, origin at the pen) filled at pixel centres, nonzero winding.
  const fillGlyph = (bm, g, ox, oy, c) => {
    const edges = [];
    for (const ct of g.contours) {
      let p = ct.start;
      const line = (q) => { if (p[1] !== q[1]) edges.push([ox + p[0], oy - p[1], ox + q[0], oy - q[1]]); p = q; };
      for (const cv of ct.curves) {
        if (!cv.spline) { for (const q of cv.pts) line(q); continue; }
        const pts = cv.pts;                                            // off-curve points, then the end on the curve
        for (let i = 0; i < pts.length - 1; i++) {
          const c1 = pts[i], end = i === pts.length - 2 ? pts[i + 1] : [(pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2], a = p;
          for (let k = 1; k <= 8; k++) { const t = k / 8, u = 1 - t; line([u * u * a[0] + 2 * u * t * c1[0] + t * t * end[0], u * u * a[1] + 2 * u * t * c1[1] + t * t * end[1]]); }
        }
      }
      line(ct.start);
    }
    const ys = edges.flatMap((e) => [e[1], e[3]]);
    for (let y = Math.max(0, Math.floor(Math.min(...ys))); y <= Math.min(bm.h - 1, Math.ceil(Math.max(...ys))); y++) {
      const yc = y + 0.5, xs = [];
      for (const [x0, y0, x1, y1] of edges) {
        if ((y0 <= yc && y1 > yc) || (y1 <= yc && y0 > yc)) xs.push([x0 + (yc - y0) * (x1 - x0) / (y1 - y0), y1 > y0 ? 1 : -1]);
      }
      xs.sort((a, b) => a[0] - b[0]);
      let wind = 0;
      for (let i = 0; i < xs.length - 1; i++) {
        wind += xs[i][1];
        if (!wind) continue;
        for (let X = Math.max(0, Math.ceil(xs[i][0] - 0.5)); X < Math.min(bm.w, Math.ceil(xs[i + 1][0] - 0.5)); X++) bm.px[y * bm.w + X] = c;
      }
    }
  };
  // A DIB to or from a bitmap: BITMAPINFOHEADER's height > 0 bottom-up, < 0 top-down; 24 or 32 bits.
  const dibCopy = (x, bm, start, lines, bits, bmi, toBitmap) => {
    const w = x.r32(bmi + 4) | 0, h = x.r32(bmi + 8) | 0, bpp = x.r16(bmi + 14), stride = ((w * bpp + 31) >> 5) << 2;
    if ((bpp !== 24 && bpp !== 32) || w !== bm.w) return 0;
    const n = Math.min(lines, Math.abs(h) - start);
    for (let r = 0; r < n; r++) {
      const line = start + r, y = h > 0 ? bm.h - 1 - line : line, at = bits + r * stride;
      if (y < 0 || y >= bm.h) continue;
      if (toBitmap) { const b = x.bytes(at, w * bpp / 8); for (let i = 0; i < w; i++) bm.px[y * w + i] = b[i * bpp / 8 + 2] << 16 | b[i * bpp / 8 + 1] << 8 | b[i * bpp / 8]; }
      else { const b = new Uint8Array(w * bpp / 8); for (let i = 0; i < w; i++) { const v = bm.px[y * w + i]; b[i * bpp / 8] = v & 0xff; b[i * bpp / 8 + 1] = (v >> 8) & 0xff; b[i * bpp / 8 + 2] = v >> 16; } x.write(at, b); }
    }
    return n;
  };
  st.mci = new Map(); st.mciNext = 1; st.mciPlaying = 0;
  /*
   * The program's disk, C:, its root the program's directory: `files` by their path there ("art/ant.spe",
   * "id1/pak0.pak"), kept by that path in lower case with forward slashes. A name is looked up by its
   * path first -- Abuse opens "art/fonts.spe" and "lisp/common.lsp" from directories of its own -- then
   * by its base name alone, as the disk was before it had directories: Half-Life asks for
   * "valve\\cl_dlls\\client.dll" from wherever it believes it was installed.
   */
  const relPath = (p) => {
    const out = [];
    for (const part of p.toLowerCase().replace(/\\/g, '/').replace(/^[a-z]:/, '').split('/')) {
      if (part === '..') out.pop(); else if (part && part !== '.') out.push(part);
    }
    return out.join('/');
  };
  const baseName = (p) => p.replace(/^.*[\\/]/, '').toLowerCase();
  st.disk = new Map(Object.entries(files).map(([n, b]) => [relPath(n), { bytes: b, size: b.length }]));
  const diskFile = (p) => st.disk.get(relPath(p)) || [...st.disk].find(([k]) => baseName(k) === baseName(p))?.[1]
    || (baseName(p) === 'gm.dls' ? { bytes: null, size: GM_DLS_SIZE } : null);
  // A directory of the disk: its root, or a path some file lies under.
  const diskDir = (p) => { const k = relPath(p); return !k || [...st.disk.keys()].some((n) => n.startsWith(k + '/')); };
  st.relPath = relPath; st.diskFile = diskFile; st.diskDir = diskDir;
  // A name in the system directory (system32, or 95's SYSTEM) of a DLL made here, with no wildcard.
  const sysDll = (x, p) => /^windows\/system(32)?\/[^/*?]+$/.test(relPath(p)) && !!x.win.made && x.win.made(baseName(p));
  const openHandle = (f) => { st.files.push({ f, pos: 0 }); return 0x4000 + st.files.length - 1; };
  const ms = (x) => Math.floor(x.lx.mono() * 1000);
  // ---- kernel32 ----------------------------------------------------------------------------------
  // UTF-16 for the W functions: Latin-1 both ways, as code page 1252 is for what these programs say.
  const wide = (str) => { const w = new Uint8Array(str.length * 2); for (let i = 0; i < str.length; i++) w[2 * i] = str.charCodeAt(i) & 0xff; return w; };
  const wideRead = (x, p, n, noNul) => { const cs = []; for (let i = 0; n < 0 ? true : i < n; i++) { const c = x.r16(p + 2 * i); if (n < 0 && !c) { if (!noNul) cs.push(0); break; } cs.push(c); } return cs; };
  const ctype1 = (c) => (c >= 65 && c <= 90 ? 0x181 : c >= 97 && c <= 122 ? 0x182 : c >= 48 && c <= 57 ? 0x84 : c === 32 ? 0x48 : c === 9 ? 0x68
    : c >= 10 && c <= 13 ? 0x28 : c < 32 || c === 127 ? 0x20 : c < 127 ? 0x10 : 0) | (c >= 65 && c <= 70 || c >= 97 && c <= 102 ? 0x80 : 0);
  const lcmap = (c, f) => (f & 0x100 && c >= 65 && c <= 90 ? c + 32 : f & 0x200 && c >= 97 && c <= 122 ? c - 32 : c);   // LCMAP_LOWERCASE, UPPERCASE
  const compare = (a, b, flags) => {                                  // CSTR_LESS_THAN 1, EQUAL 2, GREATER 3; NORM_IGNORECASE 1
    const f = (c) => (flags & 1 && c >= 97 && c <= 122 ? c - 32 : c);
    for (let i = 0; i < Math.min(a.length, b.length); i++) { const d = f(a[i]) - f(b[i]); if (d) return d < 0 ? 1 : 3; }
    return a.length === b.length ? 2 : a.length < b.length ? 1 : 3;
  };
  // VirtualAlloc's regions, above the heap's segments (10000000h to 30000000h, src/win32/index.js): they
  // began at 10000000h, inside the heap, and WinQuake's 16 MiB from HeapAlloc fell on the 4 MiB its C
  // runtime had reserved there -- "Z_CheckHeap: next block doesn't have proper back link".
  let vaNext = 0x30000000;
  const kernel32 = {
    // Crinkler's header calls it once more on the byte after its list of DLL names, and takes the NULL
    // Windows answers as the list's end: only a name that looks like one is worth a line in the log.
    // A DLL of the program's own (its disk) is mapped by the loader (src/win32/index.js); its DllMain
    // -- and those of the DLLs it brought in -- run here, DLL_PROCESS_ATTACH, before LoadLibrary returns.
    LoadLibraryA: ['p', (x, name) => {
      const s = x.str(name, 256), m = x.win.load(s);
      // Said once a name: SDL 2 asks for hid.dll at every frame, and a line each slowed the page to a crawl.
      if (!m && /^[\w.\\: -]{1,64}$/.test(s) && !(st.saidMissing ||= new Set()).has(s.toLowerCase())) { st.saidMissing.add(s.toLowerCase()); x.win.say(`LoadLibraryA("${s}"): not made here`); }
      if (!m) return 0;
      const inits = [...x.win.modules.values()].filter((d) => d.file && d.init);
      for (const d of inits) d.init = false;
      return inits.length ? send(x, inits.map((d) => ({ fn: d.entry, args: [d.base, 1, 0] })), () => m.base, 4) : m.base;
    }],
    FreeLibrary: ['p', () => 1],                                      // the image stays mapped: nothing calls into it again
    GetProcAddress: ['pp', (x, h, name) => {
      const m = x.win.moduleAt(h), what = name < 0x10000 ? name : x.str(name), r = m ? x.win.proc(m, what) : 0;
      if (!r) x.win.say(`GetProcAddress(${m ? m.name : h.toString(16)}, ${what}): none`);
      return r;
    }],
    GetModuleHandleA: ['p', (x, name) => { if (!name) return x.win.base; const m = x.win.modules.get(x.str(name).toLowerCase().replace(/^.*\\/, '')); return m ? m.base : 0; }],
    ExitProcess: ['u', (x, code) => { x.lx.exitProcess(code); return 0; }],
    ExitThread: ['u', (x, code) => { x.lx.exitThread(code); return 0; }],
    GetTickCount: ['', (x) => ms(x)],
    // Sleep(0) gives the CPU to another thread, as Windows' does.
    Sleep: ['u', (x, n) => { if (n === 0) { x.lx.yieldAfter = true; return 0; } return x.sleep(n / 1000); }],
    QueryPerformanceFrequency: ['p', (x, p) => { x.w32(p, 3579545); x.w32(p + 4, 0); return 1; }],   // XP's ACPI PM timer
    QueryPerformanceCounter: ['p', (x, p) => { const t = Math.floor(x.lx.mono() * 3579545); x.w32(p, t >>> 0); x.w32(p + 4, Math.floor(t / 4294967296)); return 1; }],
    VirtualAlloc: ['puuu', (x, addr, size) => { const p = addr || vaNext; if (!addr) vaNext += Math.ceil(size / 0x10000) * 0x10000; x.lx.lazy.push([p, p + size]); return p; }],
    VirtualFree: ['puu', () => 1],
    VirtualProtect: ['puup', (x, a, s, prot, old) => { if (old) x.w32(old, 0x40); return 1; }],
    GetProcessHeap: ['', (x) => x.lx.rdBytes && x.r32(x.win.peb + 0x18)],
    // HEAP_ZERO_MEMORY (8): a block handed out again is cleared; a new one is zero already.
    HeapAlloc: ['puu', (x, heap, flags, n) => { const p = x.win.heapAlloc(n); if (flags & 8) x.write(p, new Uint8Array(n)); return p; }],
    HeapFree: ['pup', (x, heap, flags, p) => { x.win.heapFree(p); return 1; }],
    HeapSize: ['pup', (x, heap, flags, p) => x.win.heapSize(p)],
    HeapReAlloc: ['puup', (x, heap, flags, p, n) => reAlloc(x, p, n, flags & 8)],
    GlobalAlloc: ['uu', (x, flags, n) => x.win.heapAlloc(n)],
    LocalAlloc: ['uu', (x, flags, n) => x.win.heapAlloc(n)],
    GlobalFree: ['p', () => 0], LocalFree: ['p', () => 0],
    // LocalReAlloc / GlobalReAlloc(handle, size, flags): handles are pointers here (LMEM_FIXED), so as
    // HeapReAlloc; LMEM_ZEROINIT (40h) zeroes what grows.
    LocalReAlloc: ['puu', (x, p, n, flags) => reAlloc(x, p, n, flags & 0x40)],
    GlobalReAlloc: ['puu', (x, p, n, flags) => reAlloc(x, p, n, flags & 0x40)],
    LocalSize: ['p', (x, h) => x.win.heapSize(h)],
    // Threads run in turn with the main one (src/linux.js's queue: a switch at a call that waits, or
    // after 20 ms of the guest's time). A thread's handle is its id plus 2000h; it is signalled when it ends.
    CreateThread: ['pupupp', (x, attr, stack, fn, param, flags, pid) => {
      const tid = x.win.createThread(fn, param);
      if (pid) x.w32(pid, tid);
      return 0x2000 + tid;
    }],
    WaitForSingleObject: ['pu', (x, h, ms) => {
      const ev = st.events.get(h);
      if (ev) {                                                       // an event: signalled, or wait for SetEvent
        if (ev.set) { if (!ev.manual) ev.set = false; return 0; }
        return ms === 0 ? 0x102 : x.waitUntil(x.lx.mono() + 0.001);
      }
      if (h < 0x2000 || h >= 0x3000) return 0;
      if (x.lx.threadExits.has(h - 0x2000)) return 0;                 // WAIT_OBJECT_0
      if (ms === 0) return 0x102;                                     // WAIT_TIMEOUT
      return x.waitUntil(x.lx.mono() + 0.001);                        // waits, a millisecond at a time, the others running
    }],
    // Events (handle 3000h up) and critical sections, for programs whose threads hand work over (.kkrieger
    // generates its textures on one). A critical section is owned by a thread: CRITICAL_SECTION's
    // RecursionCount at +8 and OwningThread at +12, as Windows keeps them; a thread finding it owned waits.
    CreateEventA: ['puup', (x, sa, manual, initial) => { const h = 0x3000 + st.events.size; st.events.set(h, { manual: !!manual, set: !!initial }); return h; }],
    SetEvent: ['p', (x, h) => { const ev = st.events.get(h); if (ev) ev.set = true; return ev ? 1 : 0; }],
    ResetEvent: ['p', (x, h) => { const ev = st.events.get(h); if (ev) ev.set = false; return ev ? 1 : 0; }],
    InitializeCriticalSection: ['p', (x, cs) => { x.write(cs, new Uint8Array(24)); x.w32(cs + 4, 0xffffffff); return 0; }],
    DeleteCriticalSection: ['p', () => 0],
    EnterCriticalSection: ['p', (x, cs) => {
      const me = x.lx.pid, owner = x.r32(cs + 12);
      if (owner && owner !== me) return x.waitUntil(x.lx.mono() + 0.001);
      x.w32(cs + 12, me); x.w32(cs + 8, x.r32(cs + 8) + 1); return 0;
    }],
    LeaveCriticalSection: ['p', (x, cs) => { const n = Math.max(0, (x.r32(cs + 8) | 0) - 1); x.w32(cs + 8, n); if (!n) x.w32(cs + 12, 0); return 0; }],
    GetExitCodeThread: ['pp', (x, h, p) => { const c = x.lx.threadExits.get(h - 0x2000); x.w32(p, c === undefined ? 259 : c); return 1; }],   // STILL_ACTIVE
    TerminateThread: ['pu', () => 1], ResumeThread: ['p', () => 1], SuspendThread: ['p', () => 0],
    GetCurrentThreadId: ['', (x) => x.lx.pid], GetCurrentProcessId: ['', () => 0x100],
    SetThreadPriority: ['pi', () => 1], SetPriorityClass: ['pu', () => 1], GetCurrentThread: ['', () => 0xfffffffe], GetCurrentProcess: ['', () => 0xffffffff],
    // DuplicateHandle: the same handle back (a pseudo-handle -- GetCurrentThread's -- stays one: every call here
    // that takes a thread handle answers for the program's own threads alike).
    DuplicateHandle: ['ppppuiu', (x, sp, h, dp, out) => { if (out) x.w32(out, h); return 1; }],
    GetCommandLineA: ['', (x) => (st.cmd ||= (() => { const b = new TextEncoder().encode(`"${x.win.path}"${x.win.args ? ' ' + x.win.args : ''}\0`), p = x.win.heapAlloc(b.length); x.write(p, b); return p; })())],   // the program's path quoted, then its arguments
    GetVersion: ['', () => 0x0a280105],                                 // 5.1, build 2600: Windows XP
    GetLastError: ['', () => 0], SetLastError: ['u', () => 0],
    SetUnhandledExceptionFilter: ['p', () => 0], SetErrorMode: ['u', () => 0],
    CloseHandle: ['p', () => 1],
    /*
     * Files: a small disk of the program's own, by base name. On it: those `files` names ({ "gm.dls":
     * bytes }), what the program writes (CreateFileA, WriteFile), and XP's system32\drivers\gm.dls
     * (Roland's GS sound set for the Microsoft synthesizer), which is not shipped: without the visitor's
     * own it opens as 3,440,660 zero bytes, its size on XP, so its instruments are silent. Stiletto
     * (RGBA, 2010) reads its instruments from it, trying "drivers/gm.dls" then "drivers/etc/gm.dls" --
     * OpenFile searches the system directory -- and runs off the end of its list when neither opens.
     * Photon Race 2 (2008) writes its song to a .mid file, plays it through MCI and deletes it.
     */
    OpenFile: ['ppu', (x, pName, of, style) => {
      const f = diskFile(x.str(pName));
      if (of) { x.write(of, new Uint8Array(136)); x.write(of, Uint8Array.of(136)); }
      if (!f || style & 0x1003) { if (of) x.w16(of + 2, 2); return -1; }   // OF_WRITE, OF_READWRITE, OF_CREATE: no
      return openHandle(f);
    }],
    // CreateFileA(name, access, share, sa, disposition, flags, template)
    CreateFileA: ['puupuup', (x, pName, access, share, sa, disp) => {
      const name = x.str(pName);
      let f = diskFile(name);
      if (disp === 2 || disp === 5 || (!f && (disp === 1 || disp === 4))) {   // CREATE_ALWAYS, TRUNCATE_EXISTING, or made
        if (disp === 5 && !f) return -1;
        f = { bytes: new Uint8Array(0), size: 0 }; st.disk.set(relPath(name), f);
      } else if (!f || disp === 1) return -1;                          // INVALID_HANDLE_VALUE
      return openHandle(f);
    }],
    WriteFile: ['ppupp', (x, h, buf, n, pDone) => {
      // The console's output and error (GetStdHandle's 11h, 12h): the process's stdout and stderr.
      if (h === 0x11 || h === 0x12) { if (x.lx.onOutput) x.lx.onOutput(h === 0x11 ? 1 : 2, x.bytes(buf, n)); if (pDone) x.w32(pDone, n); return 1; }
      const o = st.files[h - 0x4000];
      if (!o || !o.f.bytes) { if (pDone) x.w32(pDone, 0); return 0; }
      const f = o.f, end = o.pos + n;
      if (end > f.bytes.length) { const b = new Uint8Array(Math.max(end, f.bytes.length * 2)); b.set(f.bytes); f.bytes = b; }
      f.bytes.set(x.bytes(buf, n), o.pos); o.pos = end; f.size = Math.max(f.size, end);
      if (pDone) x.w32(pDone, n);
      return 1;
    }],
    ReadFile: ['ppupp', (x, h, buf, n, pRead) => {
      const o = st.files[h - 0x4000];
      if (!o) { if (pRead) x.w32(pRead, 0); return 0; }
      const k = Math.max(0, Math.min(n, o.f.size - o.pos));
      x.write(buf, o.f.bytes ? o.f.bytes.subarray(o.pos, o.pos + k) : new Uint8Array(k));
      o.pos += k; if (pRead) x.w32(pRead, k);
      return 1;
    }],
    // Windows 3.x's file calls, kept by Win32 (Pinball reads its table and its sounds so): _lopen's mode
    // OF_READ 0, OF_WRITE 1, OF_READWRITE 2; HFILE_ERROR (-1) when the file is not there. _hread/_hwrite are
    // _lread/_lwrite beyond 64 KB.
    _lopen: ['pi', (x, pName, mode) => { const f = diskFile(x.str(pName)); return f ? openHandle(f) : -1; }],
    _lcreat: ['pi', (x, pName) => kernel32.CreateFileA[1](x, pName, 0x40000000, 0, 0, 2, 0x80, 0)],
    _lclose: ['p', (x, h) => (st.files[h - 0x4000] ? 0 : -1)],
    _lread: ['ppu', (x, h, buf, n) => { const r = x.win.heapAlloc(4); try { return kernel32.ReadFile[1](x, h, buf, n, r, 0) ? x.r32(r) : -1; } finally { x.win.heapFree(r); } }],
    _lwrite: ['ppu', (x, h, buf, n) => { const r = x.win.heapAlloc(4); try { return kernel32.WriteFile[1](x, h, buf, n, r, 0) ? x.r32(r) : -1; } finally { x.win.heapFree(r); } }],
    _hread: ['ppu', (x, h, buf, n) => kernel32._lread[1](x, h, buf, n)], _hwrite: ['ppu', (x, h, buf, n) => kernel32._lwrite[1](x, h, buf, n)],
    _llseek: ['pii', (x, h, off, origin) => kernel32.SetFilePointer[1](x, h, off, 0, origin)],
    SetFilePointer: ['pipu', (x, h, dist, pHigh, how) => {
      const o = st.files[h - 0x4000];
      if (!o) return -1;                                               // INVALID_SET_FILE_POINTER
      if (pHigh) x.w32(pHigh, 0);
      o.pos = Math.max(0, (how === 1 ? o.pos : how === 2 ? o.f.size : 0) + dist);
      return o.pos;
    }],
    DeleteFileA: ['p', (x, pName) => { const f = diskFile(x.str(pName)), k = f && [...st.disk].find(([, v]) => v === f)?.[0]; return k ? (st.disk.delete(k), 1) : 0; }],
    OutputDebugStringA: ['p', () => 0],
    // GetFileSize: the low 32 bits returned, the high ones at `high` (0: no file here reaches 4 GB).
    GetFileSize: ['pp', (x, h, high) => { const o = st.files[h - 0x4000]; if (!o) return 0xffffffff; if (high) x.w32(high, 0); return o.f.size >>> 0; }],
    // SYSTEMTIME -> FILETIME (100 ns since 1601), the time taken as UTC.
    SystemTimeToFileTime: ['pp', (x, p, ft) => {
      const t = Date.UTC(x.r16(p), x.r16(p + 2) - 1, x.r16(p + 6), x.r16(p + 8), x.r16(p + 10), x.r16(p + 12), x.r16(p + 14));
      const v = (BigInt(t) + 11644473600000n) * 10000n; x.w32(ft, Number(v & 0xffffffffn)); x.w32(ft + 4, Number(v >> 32n)); return 1;
    }],
    SetEndOfFile: ['p', (x, h) => { const o = st.files[h - 0x4000]; if (!o) return 0; o.f.size = o.pos; return 1; }],
    FlushFileBuffers: ['p', () => 1],
    // A name on the program's disk is a file (FILE_ATTRIBUTE_ARCHIVE); the disk has no directories but
    // its root, so anything else is not there.
    GetFileAttributesA: ['p', (x, pName) => { const n = x.str(pName); return diskDir(n) ? 0x10 : diskFile(n) || sysDll(x, n) ? 0x20 : 0xffffffff; }],
    CreateDirectoryA: ['pp', () => 1],
    GetCurrentDirectoryA: ['up', (x, n, buf) => { if (n >= 4) x.write(buf, new TextEncoder().encode('C:\\\0')); return 3; }],
    GetSystemDirectoryA: ['pu', (x, buf, n) => { const s = 'C:\\WINDOWS\\system32'; if (n > s.length) x.write(buf, new TextEncoder().encode(s + '\0')); return s.length; }],
    // FindFirstFileA over the disk: '*' and '?' in the base name; WIN32_FIND_DATAA's attributes at 0,
    // size at 32 (low dword), name at 44. A search handle is 5000h up.
    FindFirstFileA: ['pp', (x, pPat, fd) => {
      // The pattern's directory, then its base name; a name with no directory of its own is found by base
      // name anywhere, as the disk was before it had directories.
      const full = x.str(pPat), pat = baseName(full), dir = relPath(full.replace(/[^\\/]*$/, '')), re = new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
      const inDir = [...st.disk.keys()].filter((n) => n.replace(/\/?[^/]*$/, '') === dir);
      let list = (inDir.length ? inDir : [...st.disk.keys()]).filter((n) => re.test(baseName(n)));
      // A DLL made here, asked for by its name in the system directory: there. SciTech MGL (WinQuake)
      // looks for system32\ddraw.dll before it offers DirectDraw's modes.
      if (!list.length && sysDll(x, full)) list = [`windows/system32/${pat.toLowerCase()}`];
      if (!list.length) return -1;
      st.finds ||= []; st.finds.push({ list, i: 0 });
      const h = 0x5000 + st.finds.length - 1; findFill(x, fd, list[0]); return h;
    }],
    FindNextFileA: ['pp', (x, h, fd) => { const s = st.finds && st.finds[h - 0x5000]; if (!s || ++s.i >= s.list.length) return 0; findFill(x, fd, s.list[s.i]); return 1; }],
    FindClose: ['p', () => 1],
    GetFileType: ['p', (x, h) => (h >= 0x4000 && h < 0x5000 ? 1 : h >= 0x10 && h <= 0x12 ? 2 : 0)],   // DISK, CHAR (the console), UNKNOWN
    GetStdHandle: ['i', (x, n) => (n >= -12 && n <= -10 ? 0x10 + (-10 - n) : -1)],                     // 10h input, 11h output, 12h error
    SetStdHandle: ['ip', () => 1], SetHandleCount: ['u', (x, n) => n],
    // ---- what the Visual C++ runtime asks at start-up --------------------------------------------------
    HeapCreate: ['uuu', (x) => x.r32(x.win.peb + 0x18)], HeapDestroy: ['p', () => 1],   // one heap serves every handle
    GetVersionExA: ['p', (x, p) => {                                 // OSVERSIONINFOA: Windows XP, build 2600
      if (x.r32(p) < 148) return 0;
      x.w32(p + 4, 5); x.w32(p + 8, 1); x.w32(p + 12, 2600); x.w32(p + 16, 2); x.write(p + 20, new Uint8Array(128)); return 1;
    }],
    GetStartupInfoA: ['p', (x, p) => { x.write(p, new Uint8Array(68)); x.w32(p, 68); return 0; }],
    GetModuleFileNameA: ['ppu', (x, h, buf, n) => {
      const m = h && h !== x.win.base ? x.win.moduleAt(h) : null, s = m ? (m.file ? `C:\\${m.name}` : `C:\\WINDOWS\\system32\\${m.name}`) : x.win.path;
      const k = Math.min(s.length, n - 1); if (n) x.write(buf, new TextEncoder().encode(s.slice(0, k) + '\0')); return k;
    }],
    // The environment: one variable, as a block of NUL-terminated strings ending in an empty one.
    GetEnvironmentStrings: ['', (x) => (st.envA ||= (() => { const b = new TextEncoder().encode('PATH=C:\\WINDOWS\\system32\0\0'), p = x.win.heapAlloc(b.length); x.write(p, b); return p; })())],
    GetEnvironmentStringsW: ['', (x) => (st.envW ||= (() => { const w = wide('PATH=C:\\WINDOWS\\system32\0\0'), p = x.win.heapAlloc(w.length); x.write(p, w); return p; })())],
    FreeEnvironmentStringsA: ['p', () => 1], FreeEnvironmentStringsW: ['p', () => 1], SetEnvironmentVariableA: ['pp', () => 1],
    GlobalMemoryStatus: ['p', (x, p) => {                            // MEMORYSTATUS: 64 MiB of RAM, half free, a 2 GiB address space
      const v = [32, 0, 64 << 20, 32 << 20, 192 << 20, 160 << 20, 0x7ffe0000, 0x7f000000];
      v.forEach((n, i) => x.w32(p + i * 4, n)); return 0;
    }],
    GlobalLock: ['p', (x, h) => h], GlobalUnlock: ['p', () => 1],
    // Code pages: Windows-1252 for ANSI, 437 for OEM, one byte a character either way.
    GetACP: ['', () => st.acp], GetOEMCP: ['', () => (st.acp === 932 ? 932 : 437)],
    // CPINFO: MaxCharSize, DefaultChar, LeadByte ranges -- Shift-JIS's lead bytes 81-9F and E0-FC.
    GetCPInfo: ['up', (x, cp, p) => {
      const dbcs = (cp === 0 || cp === 1 || cp === 3 ? st.acp : cp) === 932;
      x.write(p, new Uint8Array(20)); x.w32(p, dbcs ? 2 : 1); x.write(p + 4, Uint8Array.of(dbcs ? 0x3f : 0x3f));
      if (dbcs) x.write(p + 6, Uint8Array.of(0x81, 0x9f, 0xe0, 0xfc));
      return 1;
    }],
    MultiByteToWideChar: ['uupipi', (x, cp, flags, src, n, dst, max) => {
      const b = n < 0 ? x.bytes(src, x.str(src).length + 1) : x.bytes(src, n);
      const u = (cp === 0 || cp === 1 || cp === 3 ? st.acp : cp) === 932 && st.acp === 932 ? st.ansiDecode(b) : [...b];
      if (!max) return u.length;
      const k = Math.min(u.length, max), w = new Uint8Array(k * 2); for (let i = 0; i < k; i++) { w[2 * i] = u[i] & 255; w[2 * i + 1] = u[i] >> 8; }
      x.write(dst, w); return k;
    }],
    WideCharToMultiByte: ['uupipipp', (x, cp, flags, src, n, dst, max) => {
      const cs = wideRead(x, src, n);
      if (!max) return cs.length;
      const k = Math.min(cs.length, max); x.write(dst, Uint8Array.from(cs.slice(0, k), (c) => (c < 256 ? c : 0x3f))); return k;
    }],
    // CT_CTYPE1 of each character, as the C locale classes them (ctype's isupper, isdigit...).
    GetStringTypeA: ['uupip', (x, lcid, type, src, n, out) => { const b = n < 0 ? [...x.bytes(src, x.str(src).length + 1)] : [...x.bytes(src, n)]; b.forEach((c, i) => x.w16(out + 2 * i, ctype1(c))); return 1; }],
    GetStringTypeW: ['upip', (x, type, src, n, out) => { wideRead(x, src, n).forEach((c, i) => x.w16(out + 2 * i, ctype1(c))); return 1; }],
    LCMapStringA: ['uupipi', (x, lcid, flags, src, n, dst, max) => {
      const b = [...(n < 0 ? x.bytes(src, x.str(src).length + 1) : x.bytes(src, n))].map((c) => lcmap(c, flags));
      if (!max) return b.length; const k = Math.min(b.length, max); x.write(dst, Uint8Array.from(b.slice(0, k))); return k;
    }],
    LCMapStringW: ['uupipi', (x, lcid, flags, src, n, dst, max) => {
      const cs = wideRead(x, src, n).map((c) => lcmap(c, flags));
      if (!max) return cs.length; const k = Math.min(cs.length, max); cs.slice(0, k).forEach((c, i) => x.w16(dst + 2 * i, c)); return k;
    }],
    CompareStringA: ['uupipi', (x, lcid, flags, a, na, b, nb) => compare([...(na < 0 ? new TextEncoder().encode(x.str(a)) : x.bytes(a, na))], [...(nb < 0 ? new TextEncoder().encode(x.str(b)) : x.bytes(b, nb))], flags)],
    CompareStringW: ['uupipi', (x, lcid, flags, a, na, b, nb) => compare(wideRead(x, a, na, true), wideRead(x, b, nb, true), flags)],
    // Exceptions. RtlUnwind takes the frames off TEB's list down to the target, as ntdll's does once the
    // handlers below it have run; the runtime calls it from its own handler.
    RtlUnwind: ['pppu', (x, target) => { if (target) x.w32(x.win.teb, target); return 0; }],
    RaiseException: ['uuup', (x, code) => { throw new Error(`mirage-win32: RaiseException(${code.toString(16)})`); }],
    UnhandledExceptionFilter: ['p', () => 1],                         // EXCEPTION_EXECUTE_HANDLER
    TerminateProcess: ['pu', (x, h, code) => { x.lx.exitProcess(code); return 1; }],
    // ---- what Quake II's executable and its DLLs ask beyond WinQuake --------------------------------
    // Thread-local slots, one table per thread; TlsAlloc hands out indices from 0, as XP's first free.
    TlsAlloc: ['', () => (st.tlsNext = (st.tlsNext | 0) + 1) - 1],
    TlsFree: ['u', () => 1],
    TlsSetValue: ['up', (x, i, v) => { st.tls ||= new Map(); const id = x.lx.pid; if (!st.tls.has(id)) st.tls.set(id, new Map()); st.tls.get(id).set(i, v >>> 0); return 1; }],
    TlsGetValue: ['u', (x, i) => (st.tls && st.tls.get(x.lx.pid) && st.tls.get(x.lx.pid).get(i)) || 0],
    // Interlocked: one CPU at a time runs here, so a read and a write are atomic; the new value returned.
    InterlockedIncrement: ['p', (x, p) => { const v = (x.r32(p) + 1) | 0; x.w32(p, v); return v; }],
    InterlockedDecrement: ['p', (x, p) => { const v = (x.r32(p) - 1) | 0; x.w32(p, v); return v; }],
    // The time: the guest's clock from the moment it started (lx.epoch), in UTC; the time zone is UTC.
    GetSystemTime: ['p', (x, p) => { putSystemTime(x, p, new Date((x.lx.epoch + x.lx.mono()) * 1000)); return 0; }],
    GetLocalTime: ['p', (x, p) => { putSystemTime(x, p, new Date((x.lx.epoch + x.lx.mono()) * 1000)); return 0; }],
    GetTimeZoneInformation: ['p', (x, p) => { x.write(p, new Uint8Array(172)); return 0; }],   // TIME_ZONE_ID_UNKNOWN, no bias
    FileTimeToSystemTime: ['pp', (x, ft, p) => { const t = (x.r32(ft + 4) * 4294967296 + x.r32(ft)) / 1e4 - 11644473600000; putSystemTime(x, p, new Date(t)); return 1; }],
    FileTimeToLocalFileTime: ['pp', (x, a, b) => { x.w32(b, x.r32(a)); x.w32(b + 4, x.r32(a + 4)); return 1; }],
    GlobalSize: ['p', (x, h) => x.win.heapSize(h)],
    GetDriveTypeA: ['p', () => 3],                                    // DRIVE_FIXED: C:, the program's disk
    MoveFileA: ['pp', (x, a, b) => { const f = diskFile(x.str(a)), k = f && [...st.disk].find(([, v]) => v === f)?.[0]; if (!k) return 0; st.disk.delete(k); st.disk.set(relPath(x.str(b)), f); return 1; }],
    // A path on C:, whose root is the program's directory: "C:\\" and the name, the part after the last
    // backslash pointed at.
    GetFullPathNameA: ['pupp', (x, name, n, buf, part) => {
      let p = x.str(name, 260).replace(/\//g, '\\'); if (!/^[a-z]:/i.test(p)) p = 'C:\\' + p.replace(/^\.?\\/, '');
      if (n <= p.length) return p.length + 1;
      x.write(buf, new TextEncoder().encode(p + '\0')); if (part) x.w32(part, buf + p.lastIndexOf('\\') + 1); return p.length;
    }],
    GetLocaleInfoA: ['uupi', () => 0], GetLocaleInfoW: ['uupi', () => 0],   // no locale data: the C runtime keeps the C locale
    SetEnvironmentVariableW: ['pp', () => 1], FormatMessageA: ['uppuppp', () => 0],
    // The console of a text-mode program (WinQuake's dedicated server): there is none to open, and none
    // has input or a screen buffer to read. A program run in a window never asks.
    AllocConsole: ['', () => 0], FreeConsole: ['', () => 1],
    GetNumberOfConsoleInputEvents: ['pp', (x, h, p) => { if (p) x.w32(p, 0); return 1; }],
    ReadConsoleInputA: ['ppup', (x, h, buf, n, p) => { if (p) x.w32(p, 0); return 1; }],
    WriteConsoleInputA: ['ppup', () => 0], GetConsoleScreenBufferInfo: ['pp', () => 0], ReadConsoleOutputCharacterA: ['ppuup', () => 0],
    SetConsoleWindowInfo: ['pip', () => 0], SetConsoleScreenBufferSize: ['pu', () => 0], GetLargestConsoleWindowSize: ['p', () => 0],
    // Memory shared with a parent process (WinQuake's -HFILE, from id's launcher): no file mapping here.
    MapViewOfFile: ['puuuu', () => 0], UnmapViewOfFile: ['p', () => 1],
    // The first of several objects to be signalled: an event set, or a thread ended, as WaitForSingleObject.
    WaitForMultipleObjects: ['upiu', (x, n, hs, all, ms) => {
      for (let i = 0; i < n; i++) {
        const h = x.r32(hs + 4 * i), ev = st.events.get(h);
        if (ev ? ev.set : h >= 0x2000 && h < 0x3000 && x.lx.threadExits.has(h - 0x2000)) { if (ev && !ev.manual) ev.set = false; return i; }
      }
      return ms === 0 ? 0x102 : x.waitUntil(x.lx.mono() + 0.001);
    }],
  };
  // SYSTEMTIME: year, month, day of the week, day, hour, minute, second, millisecond.
  function putSystemTime(x, p, d) {
    [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDay(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()].forEach((v, i) => x.w16(p + 2 * i, v));
  }
  // WIN32_FIND_DATAA for a file of the disk: archive, its size, its name.
  function findFill(x, fd, name) {
    x.write(fd, new Uint8Array(320)); x.w32(fd, 0x20); x.w32(fd + 32, st.disk.has(name) ? st.disk.get(name).size : 0x10000);
    x.write(fd + 44, new TextEncoder().encode(baseName(name).slice(0, 259) + '\0'));
  }
  // printf's formatting, the arguments read from `ap` on: %d %i %u %x %X %c %s %f %g %%, with flags,
  // width and precision (doubles take 8 bytes there, as cdecl's varargs lay them out).
  function formatC(x, f, ap) {
    let out = '';
    for (let i = 0; i < f.length; i++) {
      if (f[i] !== '%') { out += f[i]; continue; }
      const m = /^([-+ 0#]*)(\d*)(?:\.(\d+))?(l|h)?([diuxXcsfg%])/.exec(f.slice(i + 1));
      if (!m) { out += '%'; continue; }
      i += m[0].length;
      const [, flags, width, prec, , c] = m;
      let v;
      if (c === '%') v = '%';
      else if (c === 'f' || c === 'g') { v = x.f64(ap).toFixed(prec === undefined ? 6 : +prec); ap += 8; }
      else if (c === 's') { v = x.str(x.r32(ap)); if (prec !== undefined) v = v.slice(0, +prec); ap += 4; }
      else if (c === 'c') { v = String.fromCharCode(x.r32(ap) & 255); ap += 4; }
      else { const n = x.r32(ap); ap += 4; v = c === 'x' ? n.toString(16) : c === 'X' ? n.toString(16).toUpperCase() : c === 'u' ? String(n) : String(n | 0); if (prec !== undefined && c !== 'c') v = v.padStart(+prec, '0'); }
      if (width) v = flags.includes('-') ? v.padEnd(+width) : v.padStart(+width, flags.includes('0') && c !== 's' ? '0' : ' ');
      out += v;
    }
    return out;
  }
  // ---- user32 --------------------------------------------------------------------------------------
  // Window classes by name and atom, and the window's procedure.
  st.classes = new Map();
  const registerClass = (x, proc, name) => {
    const atom = 0xc001 + (st.atoms = (st.atoms || 0) + 1) - 1;
    st.classes.set(atom, proc); if (name >= 0x10000) st.classes.set(x.str(name, 256).toLowerCase(), proc);
    if (name >= 0x10000) st.classNames.set(atom, x.str(name, 256));
    return atom;
  };
  st.classNames = new Map(); st.classInfo = new Map();
  const classInfo = (x, atom, name, bytes) => { st.classInfo.set(atom, bytes); if (name >= 0x10000) st.classInfo.set(x.str(name, 256).toLowerCase(), bytes); };
  // The system's own classes: their procedure is DefWindowProcA's entry point (a dialog's, DefDlgProcA's),
  // which a program may call, and replace with its own and call on (MFC subclasses every control).
  const systemProc = (x, key) => {
    // ... and a class nobody registered here (comctl32's SysAnimate32, ToolbarWindow32): DefWindowProcA's,
    // which paints it as nothing and so validates it, rather than a WM_PAINT that never ends.
    const name = key === '#32770' || key === 32770 ? 'DefDlgProcA' : typeof key === 'string' ? 'DefWindowProcA' : null;
    return name ? x.win.proc(x.win.load('user32.dll'), name) : 0;
  };
  // ---- windows beyond the program's main one (a dialog, its controls, MFC's frames): each its record,
  // its procedure, its parent and control id. The first top-level window is the one the screen shows.
  st.wins = new Map(); st.hooks = new Map();
  const win = (h) => st.wins.get(h);
  const procOf = (h) => (h === st.hwnd ? st.wndProc : win(h) ? win(h).proc : 0);
  let nextHwnd = 0x10100;
  const createWindow = (x, cls, style, w, h, wide, X, Y, title, parent = 0, menu = 0) => {
    // The main window, unless it is a child, or another class's while the main one lives (MFC's dialogs
    // beside its frame); the main class's again is the main window made anew (a game's new video mode).
    const k0 = cls < 0x10000 ? cls : (wide ? String.fromCharCode(...wideRead(x, cls, -1, true)) : x.str(cls, 256)).toLowerCase();
    // A message-only window (its parent HWND_MESSAGE, -3: SDL 2's helper window) is never shown, so never
    // the main one: it receives messages and nothing else.
    if (parent === 0xfffffffd) return createOther(x, cls, style & ~0x10000000, w, h, wide, X, Y, title, parent, menu, { messageOnly: true });
    if ((style & 0x40000000) || (st.mainMade && !st.destroyed && k0 !== st.mainClass)) return createOther(x, cls, style, w, h, wide, X, Y, title, parent, menu);
    st.mainMade = true; st.mainClass = k0;
    // Where it sits on the desktop (CW_USEDEFAULT: the first cascade position) and its caption.
    st.x = X === -0x80000000 ? 22 : X; st.y = Y === -0x80000000 || X === -0x80000000 ? 22 : Y; st.placed = X !== -0x80000000;
    st.title = title ? (wide ? String.fromCharCode(...wideRead(x, title, -1, true)) : x.str(title, 256)) : '';
    const key = cls < 0x10000 ? cls : (wide ? String.fromCharCode(...wideRead(x, cls, -1, true)) : x.str(cls, 256)).toLowerCase();
    if (st.classes.has(key)) st.wndProc = st.classes.get(key);
    // Its menu bar: the one CreateWindowEx was given, else its class's (WNDCLASS's lpszMenuName, at 32 of
    // what classInfo keeps, its hInstance at 16), loaded from the resources.
    st.menu = menu || classMenu(x, key);
    st.style = style; st.destroyed = false; st.shown = !!(style & 0x10000000); st.active = false; resize(w, h);   // a new window: WS_VISIBLE shows it
    // What CreateWindowEx sends before it returns: WM_NCCREATE and WM_CREATE with the CREATESTRUCT
    // made of its own arguments (on the caller's stack, in CREATESTRUCT's order reversed), then
    // WM_SIZE and WM_MOVE.
    const a = (x.cpu.reg[4] >>> 0) + 4, cs = x.win.heapAlloc(48);
    [11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0].forEach((k, i) => x.w32(cs + 4 * i, x.r32(a + 4 * k)));
    // WS_VISIBLE: shown and activated before CreateWindowEx returns, as Windows does it -- Quake II
    // creates its window visible and only takes the mouse once WM_ACTIVATE has said it is active.
    const shown = st.shown ? (st.active = true, ACTIVATE) : [];
    st.wins.set(st.hwnd, { hwnd: st.hwnd, main: true, cls: key, parent: 0, id: 0, ex: x.r32(a), erase: true });   // its first WM_PAINT erases
    // An overlapped window placed by Windows (CW_USEDEFAULT) gets its WM_SIZE and WM_MOVE when first shown,
    // not from CreateWindowEx (Wine's WIN_NEED_SIZE): Solitaire makes its game after CreateWindowEx returns,
    // and its WM_SIZE, sent before, read through a pointer still null.
    st.needSize = X === -0x80000000 && !(style & 0xc0000000) && !shown.length;
    const sized = st.needSize ? [] : [[0x05, 0, sizeLp()], [0x03, 0, 0]];
    return send(x, [...cbt(x, st.hwnd, cs), [0x81, 0, cs], [0x01, 0, cs], ...sized, ...shown], () => st.hwnd, 48);
  };
  // WH_CBT's HCBT_CREATEWND (3), before WM_NCCREATE: MFC attaches its CWnd to the window there, and
  // takes a creation it never heard of for one that failed.
  const cbt = (x, hwnd, cs) => {
    const hook = st.hooks.get(5); if (!hook) return [];
    const p = x.win.heapAlloc(8); x.w32(p, cs); x.w32(p + 4, 0);
    return [{ fn: hook, args: [3, hwnd, p] }];
  };
  /** A window that is not the main one: a child (a control), a dialog, a second top-level window. */
  // A class's menu (WNDCLASS's lpszMenuName, at 32 of what classInfo keeps, its hInstance at 16), loaded.
  const classMenu = (x, key) => {
    const info = st.classInfo && st.classInfo.get(key), cm = info && (info[32] | info[33] << 8 | info[34] << 16 | info[35] << 24) >>> 0;
    return cm && st.loadMenu ? st.loadMenu(x, (info[16] | info[17] << 8 | info[18] << 16 | info[19] << 24) >>> 0, cm) : 0;
  };
  const createOther = (x, cls, style, w, h, wide, X, Y, title, parent, menu, extra = {}) => {
    const key = cls < 0x10000 ? cls : (wide ? String.fromCharCode(...wideRead(x, cls, -1, true)) : x.str(cls, 256)).toLowerCase();
    const proc = st.classes.get(key) || systemProc(x, key);
    const hwnd = nextHwnd; nextHwnd += 4;
    const t = title ? (title < 0x10000 ? '' : wide ? String.fromCharCode(...wideRead(x, title, -1, true)) : x.str(title, 256)) : '';
    // CW_USEDEFAULT (a top-level window's): the first cascade position, and a size of its own when that too
    // is left to Windows -- Jazz Jackrabbit 2's game window, made after its splash.
    const top = !(style & 0x40000000), dflt = (v) => top && (v | 0) === -0x80000000;
    if (dflt(w)) { w = 640; h = 480; }
    if (dflt(X)) { X = 22; Y = 22; }
    const bar = style & 0x40000000 ? 0 : menu || classMenu(x, key);  // a top-level window's menu bar, kept for when it is the screen's
    const rec = { hwnd, cls: key, proc, style: style >>> 0, parent, id: style & 0x40000000 ? menu : 0, bar, x: X | 0, y: Y | 0, w: w | 0, h: h | 0,
      title: t, visible: !!(style & 0x10000000), enabled: !(style & 0x08000000), long: new Map(), ...extra };
    st.wins.set(hwnd, rec);
    if (!proc) return hwnd;
    const a = (x.cpu.reg[4] >>> 0) + 4, cs = x.win.heapAlloc(48);
    [11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0].forEach((k, i) => x.w32(cs + 4 * i, x.r32(a + 4 * k)));
    if (extra.params !== undefined) x.w32(cs, extra.params);
    const to = (m) => [m[0], m[1], m[2], hwnd];
    return send(x, [...cbt(x, hwnd, cs), to([0x81, 0, cs]), to([0x01, 0, cs]), to([0x05, 0, ((rec.h & 0xffff) << 16 | (rec.w & 0xffff)) >>> 0]), to([0x03, 0, 0])],
      () => hwnd, extra.pop ?? 48);
  };
  st.createOther = createOther;
  /*
   * The modal loop, made once in the program's memory: stdcall modalLoop(data), data = { +0 ended, +4 the
   * dialog, +8 its result, +12 a MSG }:
   *   L: cmp [esi],0 / jne D / GetMessageA(&msg,0,0,0) / jz D / IsDialogMessageA(dlg,&msg) / jnz L /
   *      TranslateMessage(&msg) / DispatchMessageA(&msg) / jmp L
   *   D: DestroyWindow(dlg) / mov eax,[esi+8] / ret 4
   */
  const modalLoop = (x) => {
    if (st.modalLoop) return st.modalLoop;
    const u = x.win.load('user32.dll'), fns = ['GetMessageA', 'IsDialogMessageA', 'TranslateMessage', 'DispatchMessageA', 'DestroyWindow'];
    const cells = x.win.heapAlloc(4 * fns.length), code = x.win.heapAlloc(128);
    fns.forEach((n, i) => x.w32(cells + 4 * i, x.win.proc(u, n)));
    const le = (v) => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255], call = (i) => [0xff, 0x15, ...le(cells + 4 * i)], msg = [0x8d, 0x46, 0x0c, 0x50];
    const b = [0x56, 0x8b, 0x74, 0x24, 0x08], L = b.length;
    b.push(0x83, 0x3e, 0x00, 0x75, 0); const j1 = b.length - 1;
    b.push(0x6a, 0, 0x6a, 0, 0x6a, 0, 0x8d, 0x46, 0x0c, 0x50, ...call(0), 0x85, 0xc0, 0x74, 0); const j2 = b.length - 1;
    b.push(...msg.slice(0, 3), 0x50, 0xff, 0x76, 0x04, ...call(1), 0x85, 0xc0, 0x75, 0); b[b.length - 1] = (L - b.length) & 255;
    b.push(...msg, ...call(2), ...msg, ...call(3), 0xeb, 0); b[b.length - 1] = (L - b.length) & 255;
    const D = b.length; b[j1] = D - (j1 + 1); b[j2] = D - (j2 + 1);
    b.push(0xff, 0x76, 0x04, ...call(4), 0x8b, 0x46, 0x08, 0x5e, 0xc2, 0x04, 0x00);
    x.write(code, Uint8Array.from(b));
    return (st.modalLoop = code);
  };
  /*
   * MessageBox: a modal dialog made here -- its text (one static, lines as the text breaks them), its
   * buttons as the type's low nibble says (MB_OK, OKCANCEL, ABORTRETRYIGNORE, YESNOCANCEL, YESNO,
   * RETRYCANCEL), the first the default; centred on its owner, its caption the given one. It returns the
   * button's id, and the text goes to the log too. FreeCell's "That move is not allowed." is one.
   */
  const MB_BUTTONS = [[[1, 'OK']], [[1, 'OK'], [2, 'Cancel']], [[3, '&Abort'], [4, '&Retry'], [5, '&Ignore']], [[6, '&Yes'], [7, '&No'], [2, 'Cancel']], [[6, '&Yes'], [7, '&No']], [[4, '&Retry'], [2, 'Cancel']]];
  const messageBox = (x, owner, text, caption, type) => {
    x.win.say(`MessageBox("${caption}"): ${text}`);
    const buttons = MB_BUTTONS[type & 15] || MB_BUTTONS[0], lines = text.split(/\r?\n/);
    const tw = Math.min(280, Math.max(40, ...lines.map((l) => l.length * 4 + 8))), th = 8 * lines.length;
    const bw = buttons.length * 56 - 6, cx = Math.max(tw + 20, bw + 20), by = 10 + th + 10, cy = by + 14 + 8;
    const parts = [], u16 = (v) => parts.push(v & 255, (v >> 8) & 255), u32 = (v) => { u16(v & 0xffff); u16(v >>> 16); };
    const wstrz = (t) => { for (const c of t) u16(c.charCodeAt(0)); u16(0); }, align = () => { while (parts.length & 3) parts.push(0); };
    u32(0x80c80880); u32(0); u16(1 + buttons.length); u16(0); u16(0); u16(cx); u16(cy); u16(0); u16(0); wstrz(caption);   // DS_CENTER | DS_MODALFRAME, a caption
    align(); u32(0x50000000); u32(0); u16(10); u16(10); u16(tw); u16(th); u16(0xffff); u16(0xffff); u16(0x0082); wstrz(text); u16(0);   // the text
    buttons.forEach(([id, label], i) => {
      align(); u32(0x50010000 | (i ? 0 : 1)); u32(0); u16(((cx - bw) >> 1) + 56 * i); u16(by); u16(50); u16(14); u16(id); u16(0xffff); u16(0x0080); wstrz(label); u16(0);
    });
    const tpl = x.win.heapAlloc(parts.length); x.write(tpl, Uint8Array.from(parts));
    return createDialog(x, 0, tpl, owner || st.hwnd, 0, 0, 16, (dlg) => { const w = win(dlg); if (w) w.msgBox = buttons.map(([id]) => id); return modal(x, dlg, owner || st.hwnd, 16); });
  };
  // The dialog made: shown, its owner disabled, and modalLoop(data) called in DialogBox's place (a send
  // on DialogBox's own frame), its result DialogBox's (`pop`: DialogBox's argument bytes, MessageBox's 16).
  const modal = (x, dlg, owner, pop = 20) => {
    const w = win(dlg); if (!w) return -1;
    const data = x.win.heapAlloc(40); x.write(data, new Uint8Array(40)); x.w32(data + 4, dlg);
    w.modal = data;
    if (w.ended) { x.w32(data, 1); x.w32(data + 8, w.result); }       // EndDialog already (in WM_INITDIALOG): not shown, its result at once
    if (!w.visible && !w.ended) { w.visible = true; invalidate(dlg, true, true); }
    const o = owner && win(owner); if (o) o.enabled = false;
    w.modalOwner = owner;
    // Activated, it has the focus: its first control with WS_TABSTOP (a message box's default button) unless
    // its procedure put it inside already -- Enter and Escape reach it.
    if (st.focus !== dlg && !isAncestor(dlg, st.focus)) {
      const first = [...st.wins.values()].find((c) => c.parent === dlg && !c.dead && c.visible && c.enabled !== false && c.style & 0x10000);
      st.focus = first ? first.hwnd : dlg;
    }
    return send(x, [{ fn: modalLoop(x), args: [data] }], (eax) => eax, pop);
  };
  // The main window gone and another top-level window shown: that one is the screen's from now on, as
  // the window a program shows after its splash (Jazz Jackrabbit 2's, made while the splash was up).
  const promote = (h) => {
    const w = win(h);
    if (!w || w.dead || (w.style & 0x40000000) || w.dialog || !w.proc) return;
    // The main window left: gone (destroyed), or still there and an ordinary top-level window from now on
    // (a splash, its place and size as it had them).
    const old = win(st.hwnd);
    if (old && old.main && st.destroyed) st.wins.delete(st.hwnd);
    else if (old && old.main) Object.assign(old, { main: false, proc: st.wndProc, style: st.style >>> 0, x: st.x | 0, y: st.y | 0, w: st.w, h: st.h, title: st.title || '', visible: !!st.shown, enabled: true, long: old.long || new Map() });
    w.main = true; st.hwnd = h; st.wndProc = w.proc; st.mainClass = w.cls; st.style = w.style; st.title = w.title; st.menu = w.bar || 0;
    st.x = w.x; st.y = w.y; st.destroyed = false; st.shown = false; st.active = false;
    if (st.activeWin === h) st.activeWin = 0;
    resize(w.w, w.h);
  };
  // A top-level window other than the main one made the active one: WM_ACTIVATEAPP, WM_NCACTIVATE,
  // WM_ACTIVATE (WA_ACTIVE), WM_SETFOCUS -- once, until another is.
  const activateOther = (x, h, result, pop) => {
    const w = win(h);
    if (!w || w.main || h === st.hwnd || (w.style & 0x40000000) || st.activeWin === h) { if (h === st.hwnd) st.activeWin = 0; return result(); }
    st.activeWin = h; st.focus = h;
    return send(x, ACTIVATE.slice(1).map((m) => [...m, h]), () => result(), pop);
  };
  // ---- painting the windows that are not the main one, and a dialog that is ---------------------------
  // The screen is the main window's client area (st.screen); another window draws there, at its place:
  // a child at its parent's origin and its own offset, a popup (a dialog over the main one) at its
  // screen position less the main window's. Its DC is 02000000h with its handle in the low bits.
  st.invalid = new Set();
  const isAncestor = (a, h) => { for (let w = win(h); w && !w.main; w = win(w.parent)) if (w.parent === a) return true; return false; };
  // A dialog application lives on the desktop: its main dialog and its popups each where they are on
  // the screen, the screen the whole desktop (st.deskPx) -- deskMode. Otherwise the screen is the main
  // window's client area, framed on the desktop or alone (the games, the intros).
  const deskMode = () => !!st.mainDialog && !st.modeSet;
  const mainOrigin = () => (deskMode() ? { x: st.x | 0, y: st.y | 0 } : wm.framed() ? wm.client() : { x: 0, y: 0 });
  /** The client area's top left on the screen. */
  const screenOrigin = (h) => {
    if (!h || h === st.hwnd) return mainOrigin();
    const w = win(h); if (!w) return mainOrigin();
    if (w.style & 0x40000000) { const o = screenOrigin(w.parent); return { x: o.x + w.x, y: o.y + w.y }; }
    if (deskMode()) return { x: w.x | 0, y: w.y | 0 };
    const f = popFrame(w); return { x: (w.x | 0) + f.b, y: (w.y | 0) + f.b + f.cap };   // its client area, inside its frame
  };
  /*
   * A top-level window beside the main one (a dialog over Minesweeper) when the main window is framed on
   * the desktop: its own pixels (`layer`), its children drawn there too, and the window manager puts
   * them over the main window and the desktop, framed as its style says (popupLayers). Its x and y are
   * its frame's corner on the screen, its w and h its client area's size.
   */
  const popFrame = (w) => { const s = w.style | 0; return { b: s & 0xc00000 || s & 0x80 ? 3 : s & 0x800000 ? 1 : 0, cap: (s & 0xc00000) === 0xc00000 ? 19 : 0 }; };
  const topOf = (h) => { let w = win(h); while (w && !w.main && (w.style & 0x40000000)) w = win(w.parent); return w; };
  const layerOf = (w) => { if (!w.layer || w.layer.w !== w.w || w.layer.h !== w.h) w.layer = { w: Math.max(1, w.w), h: Math.max(1, w.h), px: new Uint32Array(Math.max(1, w.w) * Math.max(1, w.h)).fill(0xd4d0c8) }; return w.layer; };
  st.popupLayers = () => (deskMode() ? [] : [...st.wins.values()].filter((w) => !w.main && !w.dead && w.visible && !(w.style & 0x40000000) && w.layer)
    .map((w) => ({ x: w.x | 0, y: w.y | 0, ...popFrame(w), title: w.title || '', w: w.layer.w, h: w.layer.h, px: w.layer.px })));
  /** ... and in the buffer drawn on: the desktop's in deskMode, the main client area's otherwise. */
  const originOf = (h) => { const o = screenOrigin(h); if (deskMode()) return o; const m = mainOrigin(); return { x: o.x - m.x, y: o.y - m.y }; };
  const deskScreen = () => {
    const D = st.desk;
    if (!st.deskPx || st.deskPx.length !== D.w * D.h) st.deskPx = new Uint32Array(D.w * D.h).fill(0x3a6ea5);
    return { w: D.w, h: D.h, px: st.deskPx };
  };
  // What a hidden or moved window leaves: the desktop there, and the windows that were under it to paint.
  const uncoverRect = (o, W, H) => {
    if (!deskMode()) { wm.redraw(); return; }                          // a layer gone: the screen composed again, now (Pinball's splash, destroyed while the table loads for 2 s)
    const sc = deskScreen();
    for (let j = Math.max(0, o.y); j < Math.min(sc.h, o.y + H); j++) sc.px.fill(0x3a6ea5, j * sc.w + Math.max(0, o.x), j * sc.w + Math.max(0, Math.min(sc.w, o.x + W)));
    for (const w of st.wins.values()) if (!w.dead && (w.main ? st.shown : w.visible && !(w.style & 0x40000000))) invalidate(w.hwnd, true, true);
  };
  const dcFor = (h) => (!h || h === st.hwnd ? st.hdc : (0x02000000 | (h & 0xffffff)) >>> 0);
  const hwndOfDC = (hdc) => (hdc === st.hdc ? st.hwnd : ((hdc & 0xff000000) >>> 0) === 0x02000000 ? hdc & 0xffffff : 0);
  const shown = (h) => { for (let w = win(h); w; w = win(w.parent)) { if (w.main) return st.shown; if (!w.visible || w.dead) return false; if (!(w.style & 0x40000000)) return true; } return false; };
  // Invalidate: to be painted (WM_PAINT when the queue is empty), erased first if asked; with its children.
  const invalidate = (h, erase, kids = false) => {
    const w = win(h); if (!w) return;
    st.invalid.add(h); if (erase) w.erase = true;
    if (kids) for (const c of st.wins.values()) if (c.parent === h && !c.dead && (c.style & 0x40000000)) invalidate(c.hwnd, erase, true);
  };
  st.invalidate = invalidate;
  // What is due a WM_PAINT, parents before their children, shown windows only.
  const paintOrder = () => {
    const depth = (h) => { let d = 0; for (let w = win(h); w && !w.main && (w.style & 0x40000000); w = win(w.parent)) d++; return d; };
    return [...st.invalid].filter((h) => win(h) && shown(h)).sort((a, b) => depth(a) - depth(b));
  };
  st.paintDue = () => paintOrder()[0];
  // A window's place changed (SetWindowPos, MoveWindow of a window that is not the main one): SWP_NOSIZE 1,
  // SWP_NOMOVE 2, SWP_SHOWWINDOW 40h, SWP_HIDEWINDOW 80h; WM_SIZE when its size changed.
  const placeOther = (x, hwnd, X, Y, w, h, flags, pop) => {
    const o = win(hwnd); if (!o) return 0;
    const parent = o.parent && win(o.parent) ? o.parent : st.hwnd;
    if (!(o.style & 0x40000000) && o.visible) uncoverRect(screenOrigin(hwnd), o.w, o.h); else invalidate(parent, true, true);
    if (!(flags & 2)) { o.x = X; o.y = Y; }
    const sized = !(flags & 1) && (o.w !== w || o.h !== h);
    if (!(flags & 1)) { o.w = w; o.h = h; }
    if (flags & 0x40) o.visible = true; if (flags & 0x80) o.visible = false;
    invalidate(hwnd, true, true);
    return sized ? send(x, [[0x05, 0, ((o.h & 0xffff) << 16 | (o.w & 0xffff)) >>> 0, hwnd]], () => 1, pop) : 1;
  };
  // DefWindowProc's part for the windows made here: the system controls painted and clicked, the
  // background erased with the class's brush, text set and got. undefined: the rest (below).
  const ctlBrush = 0x01a00000 + 15;                                      // COLOR_3DFACE's
  const defWindow = (x, hwnd, msg, wp, lp) => {
    const w = win(hwnd); if (!w) return undefined;
    if (w.main && !st.mainDialog && msg !== 0x14) return undefined;      // a game's or an intro's window: as it always was, but erased with its class's brush
    if ((w.cls === 'combobox' || w.cls === 'listbox') && LIST_OPS[w.cls][msg]) return listOp(x, hwnd, w, LIST_OPS[w.cls][msg], wp, lp);
    if (w.cls === 'combobox' || w.cls === 'listbox') { const r = listInput(x, hwnd, w, msg, wp, lp); if (r !== undefined) return r; }
    // A tree view (SysTreeView32): its items kept as handles, none drawn yet. TVM_INSERTITEM gives each a
    // handle (the StarCraft installer's folder tree stops, "exp1: Error 0", on NULL), TVM_DELETEITEM and
    // the others answer as an empty tree does.
    if (w.cls === 'systreeview32' && msg >= 0x1100 && msg < 0x1200) {
      if (msg === 0x1100 || msg === 0x1132) return (w.treeNext = (w.treeNext || 0x1000) + 1);   // TVM_INSERTITEMA/W
      if (msg === 0x1101) return 1;                                                               // TVM_DELETEITEM
      return 0;
    }
    switch (msg) {
      case 0x0c: w.title = lp ? x.str(lp, 1024) : ''; if (hwnd === st.hwnd) st.title = w.title; invalidate(hwnd, true); return 1;   // WM_SETTEXT
      case 0x0d: { const t = (w.title || '').slice(0, Math.max(0, wp - 1)); if (wp) x.write(lp, new TextEncoder().encode(t + '\0')); return t.length; }   // WM_GETTEXT
      case 0x0e: return (w.title || '').length;                          // WM_GETTEXTLENGTH
      case 0x30: w.font = wp; if (lp & 0xffff) invalidate(hwnd, true); return 0;   // WM_SETFONT
      case 0x31: return w.font || 0;                                     // WM_GETFONT
      case 0x14: {                                                       // WM_ERASEBKGND: the class's background
        const info = st.classInfo.get(w.cls), br = w.cls === '#32770' ? ctlBrush : info ? (info[28] | info[29] << 8 | info[30] << 16 | info[31] << 24) >>> 0 : 0;
        const c = brushColor(br); if (c === null || !br) return 0;
        const t = target(x, wp); if (t) { fillRect(t, 0, 0, t.w, t.h, c); t.done(); } return 1;
      }
      case 0x132: case 0x133: case 0x134: case 0x135: case 0x136: case 0x137: case 0x138: return ctlBrush;   // WM_CTLCOLOR*: the face
      case 0xf0: return w.checked | 0;                                   // BM_GETCHECK
      case 0xf1: w.checked = wp; invalidate(hwnd, true); return 0;       // BM_SETCHECK
      case 0xf2: return (w.checked | 0) | (w.pushed ? 4 : 0);            // BM_GETSTATE
      case 0xf3: w.pushed = !!wp; invalidate(hwnd, true); return 0;      // BM_SETSTATE
      case 0xf4: w.style = (w.style & ~0xffff) | (wp & 0xffff); if (lp) invalidate(hwnd, true); return 0;   // BM_SETSTYLE
      case 0xf7: case 0x172: { const prev = w.imageHandle || 0; w.imageHandle = lp; invalidate(hwnd, true); return prev; }   // BM_SETIMAGE, STM_SETIMAGE
      case 0xf6: case 0x173: return w.imageHandle || 0;                  // BM_GETIMAGE, STM_GETIMAGE
      case 0x87: return w.cls === 'button' ? 0x2000 | ((w.style & 15) === 1 ? 0x10 : 0x20) : 0;   // WM_GETDLGCODE
      case 0x0f: return paintControl(x, hwnd, w);                        // WM_PAINT
      /*
       * An edit control's typing: WM_CHAR adds a character (replacing the text when it is all selected, as on
       * getting the focus), Backspace takes the last off; EM_SETSEL 0, -1 selects all. Its parent hears
       * EN_CHANGE (300h). The caret is always at the end.
       */
      case 0x102: if (w.cls === 'edit') {
        const t = w.selAll ? '' : w.title || '';
        if (wp === 8) w.title = w.selAll ? '' : t.slice(0, -1);
        else if (wp >= 32 && wp < 256 && !(w.style & 0x800)) { if (w.style & 0x2000 && !(wp >= 48 && wp <= 57)) return 0; w.title = t + String.fromCharCode(wp); }   // ES_READONLY, ES_NUMBER
        else return 0;
        w.selAll = false; invalidate(hwnd, true);
        st.msgs.push({ msg: 0x111, wp: (0x300 << 16 | (w.id & 0xffff)) >>> 0, lp: hwnd, hwnd: w.parent });
        return 0;
      } break;
      case 0xb1: if (w.cls === 'edit') { w.selAll = wp === 0 && (lp | 0) === -1; invalidate(hwnd, true); return 1; } break;   // EM_SETSEL
      case 0xc5: if (w.cls === 'edit') return 0; break;                  // EM_LIMITTEXT
      case 0x201: if (w.cls === 'edit') { st.focus = hwnd; w.selAll = false; invalidate(hwnd, true); return 0; }   // a click: the focus, the caret at the end
        if (w.cls === 'button' && w.enabled !== false) { w.pushed = true; st.capture = hwnd; invalidate(hwnd, false); return 0; } break;   // WM_LBUTTONDOWN
      case 0x202:                                                         // WM_LBUTTONUP: a click when it is let go over the button
        if (w.cls === 'button' && w.pushed) {
          w.pushed = false; st.capture = 0; invalidate(hwnd, false);
          const X = (lp << 16) >> 16, Y = lp >> 16;
          const type = w.style & 15;
          if (type === 2 || type === 3) w.checked = w.checked ? 0 : 1;   // a check box toggles
          if (X >= 0 && Y >= 0 && X < w.w && Y < w.h) return send(x, [[0x111, (0 << 16) | (w.id & 0xffff), hwnd, w.parent]], () => 0, 16);   // WM_COMMAND, BN_CLICKED
          return 0;
        }
        break;
      default: break;
    }
    return undefined;
  };
  /*
   * List boxes and combo boxes (3D Pinball's Player Controls, a drop-down list of keys for each flipper):
   * their items -- text and a DWORD each, sorted when the style says -- as the LB_ and CB_ messages keep
   * them, the selection, and its text as a combo box's own. A drop-down's list opens under its field on a
   * click and a click on an item chooses it (CBN_SELCHANGE to the parent); the arrow keys move the choice.
   */
  const LIST_OPS = {
    combobox: { 0x143: 'add', 0x144: 'del', 0x146: 'count', 0x147: 'getsel', 0x148: 'gettext', 0x149: 'textlen', 0x14a: 'insert', 0x14b: 'reset', 0x14c: 'find',
      0x14d: 'select', 0x14e: 'setsel', 0x14f: 'show', 0x150: 'getdata', 0x151: 'setdata', 0x157: 'dropped', 0x158: 'findexact' },
    listbox: { 0x180: 'add', 0x181: 'insert', 0x182: 'del', 0x184: 'reset', 0x186: 'setsel', 0x188: 'getsel', 0x189: 'gettext', 0x18a: 'textlen', 0x18b: 'count',
      0x18c: 'select', 0x18f: 'find', 0x199: 'getdata', 0x19a: 'setdata', 0x1a2: 'findexact' },
  };
  const isDrop = (w) => w.cls === 'combobox' && (w.style & 3) !== 1;     // CBS_DROPDOWN, CBS_DROPDOWNLIST: a field and a list that opens
  const notifyParent = (w, code) => st.msgs.push({ msg: 0x111, wp: ((code << 16) | (w.id & 0xffff)) >>> 0, lp: w.hwnd, hwnd: w.parent });
  const listOp = (x, hwnd, w, op, wp, lp) => {
    const items = (w.items ||= []), combo = w.cls === 'combobox', n = items.length, i = wp | 0;
    const strs = !(w.style & 0x30) || (w.style & (combo ? 0x200 : 0x40));   // owner-drawn without HASSTRINGS: lParam is the item's data
    const sorted = w.style & (combo ? 0x100 : 2);
    const pick = (k) => { w.sel = k; if (combo) w.title = k >= 0 && items[k] ? items[k].text : ''; invalidate(hwnd, true); return k; };
    const find = (exact) => {
      const want = strs ? x.str(lp, 1024).toLowerCase() : null;
      for (let k = 1; k <= n; k++) { const j = (i + k + n) % n, it = items[j]; if (strs ? (exact ? it.text.toLowerCase() === want : it.text.toLowerCase().startsWith(want)) : it.data === lp) return j; }
      return -1;
    };
    switch (op) {
      case 'add': case 'insert': {
        const it = { text: strs ? x.str(lp, 1024) : '', data: strs ? 0 : lp };
        let at = op === 'insert' ? (i < 0 || i > n ? n : i) : n;
        if (op === 'add' && sorted && strs) { at = items.findIndex((o) => o.text.toLowerCase() > it.text.toLowerCase()); if (at < 0) at = n; }
        items.splice(at, 0, it); if ((w.sel ?? -1) >= at) w.sel++; invalidate(hwnd, true); return at;
      }
      case 'del': if (i < 0 || i >= n) return -1; items.splice(i, 1); if (w.sel === i) pick(-1); else if (w.sel > i) w.sel--; invalidate(hwnd, true); return items.length;
      case 'reset': items.length = 0; pick(-1); return 0;
      case 'count': return n;
      case 'getsel': return w.sel ?? -1;
      case 'setsel': return i >= 0 && i < n ? pick(i) : (pick(-1), combo || i !== -1 ? -1 : 0);
      case 'gettext': if (i < 0 || i >= n) return -1; if (!strs) { x.w32(lp, items[i].data); return 4; } x.write(lp, new TextEncoder().encode(items[i].text + '\0')); return items[i].text.length;
      case 'textlen': return i < 0 || i >= n ? -1 : strs ? items[i].text.length : 4;
      case 'find': return find(false);
      case 'findexact': return find(true);
      case 'select': { const k = find(false); return k < 0 ? -1 : pick(k); }
      case 'getdata': return i < 0 || i >= n ? -1 : items[i].data >>> 0;
      case 'setdata': if (i < 0 || i >= n) return -1; items[i].data = lp >>> 0; return 1;
      case 'dropped': return w.dropped ? 1 : 0;
      case 'show': if (!!wp !== !!w.dropped) toggleDrop(w, !!wp); return 1;
      default: return 0;
    }
  };
  const toggleDrop = (w, open) => {
    w.dropped = open;
    if (open) { st.focus = w.hwnd; st.capture = w.hwnd; } else { if (st.capture === w.hwnd) st.capture = 0; invalidate(w.parent, true, true); }
    invalidate(w.hwnd, true);
  };
  const listInput = (x, hwnd, w, msg, wp, lp) => {
    const X = (lp << 16) >> 16, Y = lp >> 16, items = w.items || [], rowH = w.rowH || 16;
    const choose = (k) => { if (k < 0 || k >= items.length || k === w.sel) return; w.sel = k; if (w.cls === 'combobox') w.title = items[k].text; invalidate(hwnd, true); notifyParent(w, 1); };   // CBN_SELCHANGE, LBN_SELCHANGE
    if (msg === 0x201) {                                                  // WM_LBUTTONDOWN
      st.focus = hwnd;
      if (w.cls === 'listbox') { choose(Math.floor((Y - 2) / rowH) + (w.top | 0)); return 0; }
      if (!isDrop(w)) return 0;
      if (!w.dropped) { if (Y < (w.fieldH || 21)) { toggleDrop(w, true); notifyParent(w, 7); } return 0; }   // CBN_DROPDOWN
      const inList = X >= 0 && X < w.w && Y >= (w.fieldH || 21) && Y < w.h;
      if (inList) choose(Math.floor((Y - (w.fieldH || 21) - 1) / rowH));
      toggleDrop(w, false); notifyParent(w, 8);                           // CBN_CLOSEUP
      return 0;
    }
    if (msg === 0x202 || msg === 0x200) return 0;
    if (msg === 0x100 && (wp === 0x26 || wp === 0x28)) { choose(Math.max(0, Math.min(items.length - 1, (w.sel ?? -1) + (wp === 0x28 ? 1 : -1)))); return 0; }   // Up, Down
    if (msg === 0x100 && (wp === 0x0d || wp === 0x1b) && w.dropped) { toggleDrop(w, false); return 0; }
    if (msg === 0x87) return 0x01 | 0x04;                                // WM_GETDLGCODE: DLGC_WANTARROWS | DLGC_WANTCHARS
    return undefined;
  };
  // A list's or a combo box's face: a sunken white field, the drop-down's button with its arrow, the items.
  const drawList = (x, hwnd, w, hdc) => {
    const t = target(x, hdc); if (!t) return;
    if (w.font) st.dcFonts.set(hdc, w.font);
    const m = textMetrics(hdc), d = dcState(hdc), rowH = (w.rowH = Math.max(12, m.height + 2)), items = w.items || [];
    const put = (str, X, Y, ink) => {
      if (!str) return; const buf = x.win.heapAlloc(str.length + 1); x.write(buf, Uint8Array.from(str, (c) => c.charCodeAt(0) & 255));
      const keep = [d.bkMode, d.textColor]; d.bkMode = 1; d.textColor = ink; textOut(x, t, d, m, X, Y, 0, 0, buf, str.length); [d.bkMode, d.textColor] = keep; x.win.heapFree(buf);
    };
    const sunken = (x0, y0, x1, y1) => {
      fillRect(t, x0, y0, x1, y1, 0xffffff);
      fillRect(t, x0, y0, x1, y0 + 1, 0x808080); fillRect(t, x0, y0, x0 + 1, y1, 0x808080); fillRect(t, x0, y1 - 1, x1, y1, 0xffffff); fillRect(t, x1 - 1, y0, x1, y1, 0xffffff);
      fillRect(t, x0 + 1, y0 + 1, x1 - 1, y0 + 2, 0x404040); fillRect(t, x0 + 1, y0 + 1, x0 + 2, y1 - 1, 0x404040);
    };
    const row = (k, Y, x0, x1) => {
      const on = k === w.sel && (w.cls === 'listbox' || w.dropped || st.focus === hwnd);
      if (on) fillRect(t, x0, Y, x1, Y + rowH, 0x0a246a);
      put(items[k] ? items[k].text : '', x0 + 2, Y + 1, on ? 0xffffff : 0);
    };
    if (!isDrop(w)) {
      sunken(0, 0, t.w, t.h);
      const vis = Math.max(1, Math.floor((t.h - 4) / rowH));
      if ((w.sel ?? -1) >= 0) w.top = Math.max(0, Math.min(w.sel, Math.max(w.top | 0, w.sel - vis + 1)));
      for (let k = w.top | 0, Y = 2; k < items.length && Y + rowH <= t.h - 2; k++, Y += rowH) row(k, Y, 2, t.w - 2);
      t.done(); return;
    }
    const fh = (w.fieldH = Math.min(t.h, m.height + 8));
    sunken(0, 0, t.w, fh);
    const bx = t.w - 2 - 16;                                              // the button: raised, a black arrow down
    fillRect(t, bx, 2, t.w - 2, fh - 2, 0xd4d0c8);
    fillRect(t, bx, 2, t.w - 2, 3, 0xffffff); fillRect(t, bx, 2, bx + 1, fh - 2, 0xffffff); fillRect(t, bx, fh - 3, t.w - 2, fh - 2, 0x404040); fillRect(t, t.w - 3, 2, t.w - 2, fh - 2, 0x404040);
    const ax = bx + 4, ay = (fh >> 1) - 2; for (let k = 0; k < 4; k++) fillRect(t, ax + k, ay + k, ax + 7 - k, ay + k + 1, 0);
    if (w.sel >= 0) row(w.sel, (fh - rowH) >> 1, 3, bx - 1);
    if (w.dropped) {
      const lh = Math.min(t.h - fh, items.length * rowH + 2);
      fillRect(t, 0, fh, t.w, fh + lh, 0); fillRect(t, 1, fh + 1, t.w - 1, fh + lh - 1, 0xffffff);
      for (let k = 0, Y = fh + 1; k < items.length && Y + rowH <= fh + lh; k++, Y += rowH) row(k, Y, 1, t.w - 1);
    }
    t.done();
  };
  // A system control's WM_PAINT: an owner-drawn button asks its parent (WM_DRAWITEM); a push button,
  // a check box and a static are drawn here, text in the DC's colours after WM_CTLCOLOR* to the parent.
  const paintControl = (x, hwnd, w) => {
    st.invalid.delete(hwnd);
    const hdc = dcFor(hwnd), type = w.style & 15;
    if (w.cls === 'button' && type === 11) {                             // BS_OWNERDRAW
      const dis = x.win.heapAlloc(48);
      [4, w.id, 0, 1, (w.pushed ? 1 : 0) | (w.enabled === false ? 4 : 0) | (st.focus === hwnd ? 0x10 : 0), hwnd, hdc, 0, 0, w.w, w.h, 0].forEach((v, i) => x.w32(dis + 4 * i, v));
      return send(x, [[0x2b, w.id, dis, w.parent]], () => 0, 16);       // WM_DRAWITEM
    }
    // An edit control (Minesweeper's Custom Field): its face white, sunken, its text; any other window
    // (a dialog) erased with its brush (WM_ERASEBKGND) and validated, as DefWindowProc's BeginPaint does --
    // left due, it was painted again and again.
    if (w.cls === 'edit') return send(x, [[0x133, hdc, hwnd, w.parent]], () => { drawControl(x, hwnd, w, hdc, 0); return 0; }, 16);   // WM_CTLCOLOREDIT
    if (w.cls === 'combobox' || w.cls === 'listbox') return send(x, [[w.cls === 'listbox' ? 0x134 : 0x133, hdc, hwnd, w.parent]], () => { drawList(x, hwnd, w, hdc); return 0; }, 16);
    if (w.cls !== 'button' && w.cls !== 'static') {
      if (!w.erase) return 0;
      w.erase = false; return send(x, [[0x14, hdc, 0, hwnd]], () => 0, 16);
    }
    const ctl = w.cls === 'static' ? 0x138 : 0x135;                       // WM_CTLCOLORSTATIC, WM_CTLCOLORBTN
    return send(x, [[ctl, hdc, hwnd, w.parent]], (br) => { drawControl(x, hwnd, w, hdc, br); return 0; }, 16);
  };
  /** An icon of a module's resources (RT_GROUP_ICON 14 -> its first RT_ICON 3: a DIB twice its height, its
   *  colours then its AND mask) as a bitmap with a `mask` (1: transparent). */
  const loadIcon = (x, base, id) => {
    const g = findResource(x, base, 14, id); if (!g || x.r16(g.at + 4) < 1) return 0;
    const r = findResource(x, base, 3, x.r16(g.at + 6 + 12)); if (!r) return 0;
    const at = r.at, h2 = x.r32(at + 8), head = x.win.heapAlloc(r.size); x.write(head, x.bytes(at, r.size)); x.w32(head + 8, h2 >> 1);
    const d = decodeDib(x, head); x.win.heapFree(head); if (!d) return 0;
    const bpp = x.r16(at + 14), n = bpp <= 8 ? (x.r32(at + 32) || 1 << bpp) : 0, colours = at + x.r32(at) + 4 * n;
    const xs = ((d.w * bpp + 31) >> 5) << 2, ms = ((d.w + 31) >> 5) << 2, mask = new Uint8Array(d.w * d.h), m = colours + xs * d.h;
    for (let j = 0; j < d.h; j++) for (let i = 0; i < d.w; i++) mask[(d.h - 1 - j) * d.w + i] = (x.r8(m + j * ms + (i >> 3)) >> (7 - (i & 7))) & 1;
    return st.newHandle('bitmap', { ...d, mask });
  };
  const drawControl = (x, hwnd, w, hdc, br) => {
    const t = target(x, hdc); if (!t) return;
    const type = w.style & 15, face = brushColor(br || ctlBrush) ?? 0xd4d0c8, d = dcState(hdc);
    if (w.cls === 'static' && (type === 14 || type === 3)) {              // SS_BITMAP, SS_ICON: its picture
      // An icon named in the template by its resource id (Spider's cards beside its difficulties): loaded
      // from the program's RT_GROUP_ICON, its first image, its transparent pixels left as they are.
      if (type === 3 && w.image && !st.gdi.get(w.imageHandle)) w.imageHandle = loadIcon(x, x.win.base, w.image);
      const bm = st.gdi.get(w.imageHandle);
      if (bm && bm.px) for (let j = 0; j < Math.min(bm.h, t.h); j++) for (let i = 0; i < Math.min(bm.w, t.w); i++) { const c = bm.px[j * bm.w + i]; if (!bm.mask || !bm.mask[j * bm.w + i]) t.px[j * t.w + i] = c; }
      t.done(); return;
    }
    // A group box (BS_GROUPBOX) is a frame and its caption, the controls inside it showing through: filled, it
    // hid them (3D Pinball's Player Controls, its two group boxes made after the controls they hold).
    const group = w.cls === 'button' && type === 7;
    if (br && !group) fillRect(t, 0, 0, t.w, t.h, face);
    if (group) {
      if (w.font) st.dcFonts.set(hdc, w.font);
      const top = textMetrics(hdc).height >> 1;
      fillRect(t, 0, top, t.w - 1, top + 1, 0x808080); fillRect(t, 0, top, 1, t.h - 1, 0x808080); fillRect(t, 0, t.h - 2, t.w - 1, t.h - 1, 0x808080); fillRect(t, t.w - 2, top, t.w - 1, t.h - 1, 0x808080);
      fillRect(t, 1, top + 1, t.w - 2, top + 2, 0xffffff); fillRect(t, 1, top + 1, 2, t.h - 2, 0xffffff); fillRect(t, 0, t.h - 1, t.w, t.h, 0xffffff); fillRect(t, t.w - 1, top, t.w, t.h, 0xffffff);
    }
    if (w.cls === 'edit') {                                               // white, in a sunken edge (WS_EX_CLIENTEDGE's or WS_BORDER's)
      fillRect(t, 0, 0, t.w, t.h, 0xffffff);
      fillRect(t, 0, 0, t.w, 1, 0x808080); fillRect(t, 0, 0, 1, t.h, 0x808080); fillRect(t, 0, t.h - 1, t.w, t.h, 0xd4d0c8); fillRect(t, t.w - 1, 0, t.w, t.h, 0xd4d0c8);
      fillRect(t, 1, 1, t.w - 1, 2, 0x404040); fillRect(t, 1, 1, 2, t.h - 1, 0x404040);
    }
    // A check box (2, 3) or a radio button (4, 9): its box or its circle at the left, white and sunken, its
    // mark as BM_SETCHECK left it.
    const box = w.cls === 'button' && [2, 3, 4, 9, 5, 6].includes(type) && type !== 7;
    if (box) {
      const by = (t.h - 13) >> 1, round = type === 4 || type === 9;
      if (round) {
        for (let j = 0; j < 12; j++) for (let i = 0; i < 12; i++) { const r = Math.hypot(i - 5.5, j - 5.5); if (r <= 6) t.px[(by + j) * t.w + i] = r > 5 ? (i + j < 11 ? 0x808080 : 0xffffff) : r > 4 ? (i + j < 11 ? 0x404040 : 0xd4d0c8) : 0xffffff; }
        if (w.checked) for (let j = 4; j < 8; j++) for (let i = 4; i < 8; i++) if (Math.hypot(i - 5.5, j - 5.5) < 2.3) t.px[(by + j) * t.w + i] = 0;
      } else {
        fillRect(t, 0, by, 13, by + 13, 0xffffff); fillRect(t, 0, by, 12, by + 1, 0x808080); fillRect(t, 0, by, 1, by + 12, 0x808080);
        fillRect(t, 1, by + 1, 11, by + 2, 0x404040); fillRect(t, 1, by + 1, 2, by + 11, 0x404040);
        if (w.checked) [3, 4, 5, 4, 3, 2, 1].forEach((dy, k) => fillRect(t, 3 + k, by + 3 + dy, 4 + k, by + 6 + dy, 0));
      }
    }
    if (w.cls === 'button' && (type === 0 || type === 1)) {               // a push button, raised or pressed
      const lt = w.pushed ? 0x404040 : 0xffffff, dk = w.pushed ? 0xffffff : 0x404040;
      fillRect(t, 0, 0, t.w, 1, lt); fillRect(t, 0, 0, 1, t.h, lt); fillRect(t, 0, t.h - 1, t.w, t.h, dk); fillRect(t, t.w - 1, 0, t.w, t.h, dk);
    }
    const text = (w.title || '').replace(/&(.)/g, '$1');
    if (text) {
      if (w.font) st.dcFonts.set(hdc, w.font);
      const m = textMetrics(hdc), buf = x.win.heapAlloc(text.length + 1);
      x.write(buf, Uint8Array.from(text, (c) => c.charCodeAt(0) & 255));
      const widthOf = (str) => { let n = 0; for (const ch of str) n += m.font ? m.font.glyph(ch.charCodeAt(0) & 255, m.ppem).cellIncX : m.avg; return n; };
      // A static's text (SS_LEFT, SS_CENTER, SS_RIGHT) breaks between words to its width, as DrawText's
      // DT_WORDBREAK: Pinball's instructions, "Left Table Bump" on two lines.
      const lines = [];
      if (w.cls === 'static' && (w.style & 15) <= 2) {
        for (const para of text.split(/\r?\n/)) {
          let line = '';
          for (const word of para.split(' ')) { const next = line ? line + ' ' + word : word; if (line && widthOf(next) > t.w) { lines.push(line); line = word; } else line = next; }
          lines.push(line);
        }
      } else lines.push(text);
      const ink = d.textColor;
      lines.forEach((ln, k) => {
        const width = widthOf(ln);
        const X = w.cls === 'edit' ? 4 : group ? 8 : w.cls === 'button' ? (type <= 1 ? (t.w - width) >> 1 : 16) : (w.style & 3) === 1 ? (t.w - width) >> 1 : (w.style & 3) === 2 ? t.w - width : 0;
        const Y = group ? 0 : w.cls === 'button' || w.cls === 'edit' ? (t.h - m.height) >> 1 : k * m.height;
        if (Y >= t.h) return;
        if (group) fillRect(t, X - 2, 0, X + width + 2, m.height, face);
        // An edit control with the focus and its text all selected: white on the selection's blue.
        const sel = w.cls === 'edit' && w.selAll && st.focus === hwnd;
        if (sel) { fillRect(t, X, Y, X + width, Y + m.height, 0x0a246a); d.textColor = 0xffffff; }
        x.write(buf, Uint8Array.from(ln, (c) => c.charCodeAt(0) & 255));
        const keep = d.bkMode; d.bkMode = 1; textOut(x, t, d, m, X, Y, 0, 0, buf, ln.length); d.bkMode = keep; d.textColor = ink;
      });
      x.win.heapFree(buf);
    }
    t.done();
  };
  /*
   * A dialog from its template in memory (CreateDialogIndirectParam, and CreateDialogParam's resource):
   * DLGTEMPLATE or DLGTEMPLATEEX, its controls after it, sizes in dialog units -- MS Sans Serif 8's,
   * 6 x 13 pixels for 4 x 8 units. The dialog's procedure is DefDlgProcA's, which calls the program's
   * DLGPROC; the windows are all made first, then what Windows sends goes as one sequence: to the
   * dialog WM_NCCREATE and WM_CREATE, each control its own and WM_SETFONT, then WM_INITDIALOG.
   */
  const createDialog = (x, inst, tpl, parent, dlgProc, param, pop, then = (dlg) => dlg) => {
    let p = tpl;
    const u16 = () => { const v = x.r16(p); p += 2; return v; }, u32 = () => { const v = x.r32(p); p += 4; return v; }, i16 = () => (u16() << 16) >> 16;
    const sz = () => { const c = x.r16(p); if (c === 0xffff) { p += 4; return x.r16(p - 2); } let t = ''; for (let ch; (ch = u16());) t += String.fromCharCode(ch); return t; };
    const align = () => { p = (p + 3) & ~3; };
    const ex = x.r16(tpl + 2) === 0xffff;
    let style, exStyle, n;
    if (ex) { p += 4; u32(); exStyle = u32(); style = u32(); n = u16(); } else { style = u32(); exStyle = u32(); n = u16(); }
    const X = i16(), Y = i16(), cx = i16(), cy = i16(), menu = sz(), cls = sz(), title = sz();
    if (style & 0x48) { u16(); if (ex) { u16(); u16(); } sz(); }        // DS_SETFONT / DS_SHELLFONT: size, (weight, italic, charset), face
    const du = (v, axis) => Math.round(v * (axis ? 13 : 6) / (axis ? 8 : 4));
    const dlg = nextHwnd; nextHwnd += 4;
    const dProc = typeof cls === 'string' && cls ? st.classes.get(cls.toLowerCase()) || systemProc(x, '#32770') : systemProc(x, '#32770');
    st.wins.set(dlg, { hwnd: dlg, cls: '#32770', proc: dProc, dlgProc, style: style >>> 0, parent, id: 0, x: du(X, 0), y: du(Y, 1), w: du(cx, 0), h: du(cy, 1),
      title: typeof title === 'string' ? title : '', visible: false, enabled: true, long: new Map(), dialog: true, menu, erase: true });
    // A program whose first window is a dialog (an MFC dialog application, Half-Life's launcher): that
    // dialog is the window the screen shows, as a CreateWindowEx main window would be.
    if (!st.mainMade && !parent) {
      const w = win(dlg); w.main = true; st.mainMade = true; st.mainClass = '#32770'; st.mainDialog = true;
      st.hwnd = dlg; st.wndProc = dProc; st.style = style >>> 0; st.title = w.title; st.x = w.x; st.y = w.y; st.destroyed = false; st.shown = false; st.active = false;
      st.w = Math.max(1, w.w); st.h = Math.max(1, w.h); wm.dirty = true;
    }
    // Its place, when not the main window and not in a dialog application's desktop: the template's x and y
    // from its owner's client area (DS_ABSALIGN, 1: from the screen's corner), or centred on the owner
    // (DS_CENTER, 800h), as Windows places a dialog.
    if (!win(dlg).main && !deskMode() && !(style & 0x40000000)) {
      const d = win(dlg), f = popFrame(d), W = d.w + 2 * f.b, H = d.h + 2 * f.b + f.cap;
      const ow = parent && (parent === st.hwnd || win(parent)) ? parent : st.hwnd, o = screenOrigin(ow), osz = ow === st.hwnd ? { w: st.w, h: st.h } : win(ow);
      if (style & 0x800) { d.x = o.x + ((osz.w - W) >> 1); d.y = o.y + ((osz.h - H) >> 1); }
      else if (!(style & 1)) { d.x += o.x; d.y += o.y; }
      d.x = Math.max(0, Math.min(st.desk.w - W, d.x)); d.y = Math.max(0, Math.min(st.desk.h - H, d.y));
    }
    const kids = [];
    for (let i = 0; i < n; i++) {
      align();
      let cs, cex, id;
      if (ex) { u32(); cex = u32(); cs = u32(); } else { cs = u32(); cex = u32(); }
      const kx = i16(), ky = i16(), kw = i16(), kh = i16();
      id = ex ? u32() : u16();
      const kc = sz(), kt = sz(), extra = u16(); p += extra;
      const key = typeof kc === 'number' ? ({ 0x80: 'button', 0x81: 'edit', 0x82: 'static', 0x83: 'listbox', 0x84: 'scrollbar', 0x85: 'combobox' })[kc] || kc : kc.toLowerCase();
      const h = nextHwnd; nextHwnd += 4;
      st.wins.set(h, { hwnd: h, cls: key, proc: st.classes.get(key) || systemProc(x, key), style: (cs | 0x40000000) >>> 0, ex: cex, parent: dlg, id: id & 0xffff,
        x: du(kx, 0), y: du(ky, 1), w: du(kw, 0), h: du(kh, 1), title: typeof kt === 'string' ? kt : '', image: typeof kt === 'number' ? kt : 0,
        visible: !!(cs & 0x10000000), enabled: !(cs & 0x08000000), long: new Map() });
      kids.push(h);
    }
    const csFor = (h) => {
      const w = win(h), c = x.win.heapAlloc(48);
      x.write(c, new Uint8Array(48)); x.w32(c, h === dlg ? param : 0); x.w32(c + 4, inst); x.w32(c + 12, w.parent);
      x.w32(c + 16, w.h); x.w32(c + 20, w.w); x.w32(c + 24, w.y); x.w32(c + 28, w.x); x.w32(c + 32, w.style); x.w32(c + 44, w.ex | 0);
      return c;
    };
    const sizeOf = (w) => ((w.h & 0xffff) << 16 | (w.w & 0xffff)) >>> 0;
    const font = 0x01900010 + 17;                                           // DEFAULT_GUI_FONT
    const born = (h) => { const c = csFor(h), w = win(h); return [...cbt(x, h, c), [0x81, 0, c, h], [0x01, 0, c, h], [0x05, 0, sizeOf(w), h], [0x03, 0, 0, h]]; };
    // WM_INITDIALOG's wParam: the first control with WS_TABSTOP (10000h), which has the focus when the dialog
    // procedure returns TRUE -- an edit control's text then all selected, as typing replaces it.
    const first = kids.find((h) => win(h).style & 0x10000 && win(h).visible && win(h).enabled) || kids[0] || 0;
    const msgs = [...born(dlg), [0x30, font, 0, dlg], ...kids.flatMap((h) => [...born(h), [0x30, font, 0, h]]), [0x110, first, param, dlg]];
    return send(x, msgs, (init) => {
      if (init && first && win(first)) { st.focus = first; if (win(first).cls === 'edit') win(first).selAll = true; }
      const w = win(dlg); if (w && (style & 0x10000000)) { w.visible = true; if (w.main) { st.shown = true; wm.dirty = true; } invalidate(dlg, true, true); }
      if (w && st.dialogShown) st.dialogShown(dlg);
      return then(dlg);
    }, pop);
  };
  // Its end, and its children's: WM_DESTROY to it then to them, WM_NCDESTROY to them then to it.
  const destroyOther = (x, hwnd, result, pop) => {
    const w = win(hwnd); if (!w || w.dead) return result(0) && 0;
    const all = (h) => [...st.wins.values()].filter((c) => c.parent === h && !c.dead).flatMap((c) => [c, ...all(c.hwnd)]);
    const kids = all(hwnd);
    w.dead = true; for (const c of kids) c.dead = true;
    if (w.modal && w.modalOwner && win(w.modalOwner)) win(w.modalOwner).enabled = true;   // a modal dialog's owner again
    if (w.visible && !(w.style & 0x40000000)) uncoverRect(screenOrigin(hwnd), w.w, w.h);
    if (st.focus === hwnd || kids.some((c) => c.hwnd === st.focus)) st.focus = 0;
    return send(x, [[0x02, 0, 0, hwnd], ...kids.map((c) => [0x02, 0, 0, c.hwnd]), ...kids.reverse().map((c) => [0x82, 0, 0, c.hwnd]), [0x82, 0, 0, hwnd]],
      (eax) => { st.wins.delete(hwnd); for (const c of kids) st.wins.delete(c.hwnd); return result(eax); }, pop);
  };
  // Showing and activating: WM_SHOWWINDOW, WM_ACTIVATEAPP, WM_NCACTIVATE, WM_ACTIVATE (WA_ACTIVE), WM_SETFOCUS.
  const ACTIVATE = [[0x18, 1, 0], [0x1c, 1, 0], [0x86, 1, 0], [0x06, 1, 0], [0x07, 0, 0]];
  const sizeLp = () => ((st.h & 0xffff) << 16 | (st.w & 0xffff)) >>> 0;
  // A WINDOWPOS for WM_WINDOWPOSCHANGED: the main window, its place and outer size, the SWP_ flags.
  const windowPos = (x, w, h, flags) => {
    const p = st.windowPos ||= x.win.heapAlloc(28);
    [st.hwnd, 0, st.x | 0, st.y | 0, w, h, flags].forEach((v, i) => x.w32(p + 4 * i, v >>> 0));
    return p;
  };
  /*
   * Messages Windows SENDS: the window procedure runs in the program before the API returns. The
   * procedure is entered with its four arguments and a return into user32's ordinal-only stub 2600
   * (mirageReturn), which enters it again for the next message, and after the last returns to the
   * API's caller with `result(eax)` in EAX and the API's own `pop` bytes of arguments taken, as its
   * stdcall return would. Sends nest (a procedure calling an API that sends): each its frame.
   */
  st.sends = [];
  // A call into the program: a window message [msg, wp, lp] to the window's procedure, or { fn, args }
  // (a DLL's DllMain), stdcall, returning into the stub.
  const callProc = (x, m, ret) => {
    const h = Array.isArray(m) ? (m[3] ?? st.hwnd) : 0;
    const c = x.cpu, fn = Array.isArray(m) ? procOf(h) : m.fn, args = Array.isArray(m) ? [h, m[0], m[1], m[2]] : m.args;
    let sp = c.reg[4] >>> 0;
    for (const v of [...args].reverse()) { sp -= 4; x.w32(sp, v >>> 0); }
    sp -= 4; x.w32(sp, ret); c.reg[4] = sp; c.eip = fn;
  };
  const back = (x) => x.win.proc(x.win.load('user32.dll'), 2600);
  const send = (x, msgs, result, pop) => {
    msgs = msgs.filter((m) => !Array.isArray(m) || procOf(m[3] ?? st.hwnd));
    if (!msgs.length) return result(0);
    const esp0 = x.cpu.reg[4] >>> 0;                                  // the caller's return address, its arguments above
    st.sends.push({ msgs: msgs.slice(1), result, pop, esp0 });
    callProc(x, msgs[0], back(x));
    return 0;
  };
  const mirageReturn = (x) => {
    const f = st.sends[st.sends.length - 1], c = x.cpu, eax = x.r32(c.reg[4] >>> 0);   // pushed by its stub
    if (f.msgs.length) { c.reg[4] = f.esp0; callProc(x, f.msgs.shift(), back(x)); return eax; }
    // `result` runs on the API's own frame (its return address and arguments still on the stack): one
    // that sends again (DefDlgProc's FALSE going on to DefWindowProc, which sends WM_ERASEBKGND) starts
    // its sequence from that frame, and it is that sequence's end that returns to the caller. Run after
    // the frame was taken off, a nested send found no return address there, and the stack drifted.
    st.sends.pop();
    const depth = st.sends.length, ret = x.r32(f.esp0);
    c.reg[4] = f.esp0;
    const r = f.result(eax);
    if (st.sends.length > depth) return r;                           // a new sequence: it returns, later
    c.reg[4] = (f.esp0 + 4 + f.pop) >>> 0; c.eip = ret;
    return r;
  };
  // The window made w x h (its frame included): the client area inside the frame its style has, as
  // AdjustWindowRectEx adds it -- what the screen shows.
  const resize = (w, h) => {
    const { b, cap } = wm.frame();
    if (w > 0 && h > 0 && w < 8192 && h < 8192) { st.w = Math.max(1, w - 2 * b); st.h = Math.max(1, h - 2 * b - cap); }
    wm.dirty = true;
  };
  const firstMsg = (hwnd, min, max) => st.msgs.findIndex((e) => {
    if ((min || max) && (e.msg < min || e.msg > max)) return false;
    if (!hwnd || hwnd === 0xffffffff) return true;
    let h = e.hwnd ?? st.hwnd; for (let n = 0; h && n < 64; n++) { if (h === hwnd) return true; h = win(h) && !win(h).main ? win(h).parent : 0; }
    return false;
  });
  // WM_PAINT, which Windows makes when nothing is queued: for a window due one, within the filters.
  const paintFor = (hwnd, min, max) => {
    if ((min || max) && (0x0f < min || 0x0f > max)) return 0;
    const h = st.paintDue && st.paintDue(); if (!h) return 0;
    return !hwnd || hwnd === h || isAncestor(hwnd, h) ? h : 0;
  };
  /*
   * WH_KEYBOARD (2): a key message the program takes from its queue goes to its hook first, as Windows
   * calls it from GetMessage and PeekMessage -- HC_ACTION (0) when the message is removed, HC_NOREMOVE (3)
   * when only looked at -- with the key and the message's keystroke flags; a hook that returns non-zero
   * has eaten it. Jazz Jackrabbit 2 reads its keyboard so. `then(eaten)` gives the call's result.
   */
  const keyHook = (x, e, code, then, pop) => {
    const hook = st.hooks.get(2);
    if (!hook || e.msg < 0x100 || e.msg > 0x105 || e.msg === 0x102 || e.msg === 0x103) return then(false);
    return send(x, [{ fn: hook, args: [code, e.wp, e.lp] }], (eax) => then(eax !== 0), pop);
  };
  // The timers (SetTimer): one due, within a GetMessage's or PeekMessage's filters, as a WM_TIMER (113h)
  // with its procedure, if any, in lParam; the next due again one interval later, as Windows does not
  // queue them up. `timerNext()`: when the first is due.
  st.timers = new Map();
  const timerFor = (x, hwnd, min, max) => {
    if ((min || max) && (0x113 < min || 0x113 > max)) return null;
    const now = x.lx.mono();
    for (const t of st.timers.values()) {
      if (t.next > now || (hwnd && hwnd !== 0xffffffff && t.hwnd !== hwnd && !isAncestor(hwnd, t.hwnd))) continue;
      t.next = now + t.every;
      return { msg: 0x113, wp: t.id, lp: t.fn || 0, hwnd: t.hwnd || 0, time: ms(x) };
    }
    return null;
  };
  const timerNext = () => { let n = Infinity; for (const t of st.timers.values()) n = Math.min(n, t.next); return n; };
  const putMsg = (x, m, e) => { x.w32(m, e.hwnd ?? st.hwnd); x.w32(m + 4, e.msg); x.w32(m + 8, e.wp); x.w32(m + 12, e.lp); x.w32(m + 16, e.time || 0); x.w32(m + 20, st.mouseX ?? 0); x.w32(m + 24, st.mouseY ?? 0); };
  const user32 = {
    // The window: one, the size it was made or the display mode set; its DC and GL go to the backend.
    // The window: its client area is what a framed window keeps inside the frame AdjustWindowRectEx adds;
    // its procedure is its class's (by name or by atom), which DispatchMessageA calls.
    CreateWindowExA: ['upppiiiippp' + 'p', (x, ex, cls, title, style, X, Y, w, h, parent, menu) => createWindow(x, cls, style, w, h, false, X, Y, title, parent, menu)],
    CreateWindowExW: ['upppiiiippp' + 'p', (x, ex, cls, title, style, X, Y, w, h, parent, menu) => createWindow(x, cls, style, w, h, true, X, Y, title, parent, menu)],
    // A display mode: the screen becomes it and the program's window fills it (a full-screen program
    // draws at that size); NULL gives the desktop back, where a framed window sits.
    // CDS_TEST (2) only asks whether the mode would do: it would (DISP_CHANGE_SUCCESSFUL), nothing changes.
    ChangeDisplaySettingsA: ['pu', (x, dm, flags) => {
      if (flags & 2) return 0;
      if (dm) { st.w = x.r32(dm + 108) || st.w; st.h = x.r32(dm + 112) || st.h; st.modeSet = true; } else st.modeSet = false;
      wm.dirty = true; return 0;
    }],
    SetWindowTextA: ['pp', (x, hwnd, t) => { if (hwnd === st.hwnd) { st.title = t ? x.str(t, 256) : ''; wm.redraw(); } else if (win(hwnd)) win(hwnd).title = t ? x.str(t, 256) : ''; return 1; }],
    GetWindowTextA: ['ppi', (x, hwnd, buf, n) => { const t = hwnd === st.hwnd ? (st.title || '') : win(hwnd) ? win(hwnd).title || '' : ''; if (n > 0) x.write(buf, new TextEncoder().encode(t.slice(0, n - 1) + '\0')); return Math.min(t.length, Math.max(0, n - 1)); }],
    // A point of the client area on the screen and back: the window's place and its frame.
    ClientToScreen: ['pp', (x, hwnd, p) => { const c = screenOrigin(hwnd); x.w32(p, (x.r32(p) | 0) + c.x); x.w32(p + 4, (x.r32(p + 4) | 0) + c.y); return 1; }],
    ScreenToClient: ['pp', (x, hwnd, p) => { const c = screenOrigin(hwnd); x.w32(p, (x.r32(p) | 0) - c.x); x.w32(p + 4, (x.r32(p + 4) | 0) - c.y); return 1; }],
    // MapWindowPoints: from one window's client coordinates to another's (0: the screen).
    MapWindowPoints: ['ppppu', (x, from, to, pts, n) => {
      const a = from ? screenOrigin(from) : { x: 0, y: 0 }, b = to ? screenOrigin(to) : { x: 0, y: 0 }, dx = a.x - b.x, dy = a.y - b.y;
      for (let i = 0; i < n; i++) { x.w32(pts + 8 * i, (x.r32(pts + 8 * i) | 0) + dx); x.w32(pts + 8 * i + 4, (x.r32(pts + 8 * i + 4) | 0) + dy); }
      return ((dy & 0xffff) << 16 | (dx & 0xffff)) >>> 0;
    }],
    // A window's DC: the main window's own, or a view of the screen at the window's place (dcFor).
    GetDC: ['p', (x, hwnd) => dcFor(hwnd)], ReleaseDC: ['pp', () => 1],
    // The cursor's display count (hidden below zero) and its confinement: a program that hides it and
    // clips it to its window has the mouse to itself, and the page captures the pointer for it.
    ShowCursor: ['i', (x, show) => { st.cursorCount = (st.cursorCount | 0) + (show ? 1 : -1); wm.moveCursor(); return st.cursorCount; }],
    SetCursorPos: ['ii', (x, X, Y) => { st.mouseX = X; st.mouseY = Y; wm.moveCursor(); return 1; }], // The first ShowWindow: WM_SHOWWINDOW, the application and the window activated, the focus; it
    // returns that the window was hidden. UpdateWindow paints it once (WM_PAINT).
    ShowWindow: ['pi', (x, hwnd, cmd) => {
      // The main window gone -- or only a splash (a popup without a caption) -- and a captioned top-level
      // window shown: that one is the screen's (Pinball's table after its 1-pixel splash).
      const splash = !st.destroyed && (st.style & 0x80000000) && (st.style & 0xc00000) !== 0xc00000 && !st.mainDialog;
      if (hwnd !== st.hwnd && cmd !== 0 && (st.destroyed || (splash && win(hwnd) && (win(hwnd).style & 0xc00000) === 0xc00000))) promote(hwnd);
      if (hwnd !== st.hwnd) {
        const w = win(hwnd); if (!w) return 0;
        const was = w.visible ? 1 : 0; w.visible = cmd !== 0;
        if (w.visible && !was) invalidate(hwnd, true, true);
        else if (!w.visible && was) { if (!(w.style & 0x40000000)) uncoverRect(screenOrigin(hwnd), w.w, w.h); else invalidate(w.parent || st.hwnd, true, true); }
        // SW_SHOWNORMAL 1, SW_SHOWMAXIMIZED 3, SW_SHOW 5, SW_RESTORE 9 activate a top-level window, shown or not.
        if (w.visible && !(w.style & 0x40000000) && [1, 3, 5, 9].includes(cmd) && st.activeWin !== hwnd) {
          st.activeWin = hwnd; st.focus = hwnd;
          return send(x, [...(was ? [] : [[0x18, 1, 0, hwnd]]), ...ACTIVATE.slice(1).map((m) => [...m, hwnd])], () => was, 8);
        }
        // WM_SHOWWINDOW only when that changes (a procedure that shows its window again on it, Half-Life's
        // launcher, went on for ever).
        return w.visible === !!was ? was : send(x, [[0x18, w.visible ? 1 : 0, 0, hwnd]], () => was, 8);
      }
      if (st.mainDialog && cmd !== 0 && !st.shown) invalidate(hwnd, true, true);
      if (st.active || cmd === 0) return st.shown ? 1 : 0;
      const was = st.shown ? 1 : 0; st.shown = st.active = true; wm.dirty = true;
      const sized = st.needSize ? [[0x05, 0, sizeLp()], [0x03, 0, 0]] : []; st.needSize = false;   // its first showing: WM_SIZE, WM_MOVE (above)
      return send(x, [...ACTIVATE.slice(0, 1), ...sized, ...ACTIVATE.slice(1)], () => was, 8);
    }],
    UpdateWindow: ['p', (x, hwnd) => {
      if (st.mainDialog || hwnd !== st.hwnd) { const due = paintOrder().filter((h) => h === hwnd || isAncestor(hwnd, h)); return due.length ? send(x, due.map((h) => [0x0f, 0, 0, h]), () => 1, 4) : 1; }
      return send(x, [[0x0f, 0, 0]], () => 1, 4);
    }],
    // A window moved or sized: its new size, unless SWP_NOSIZE (1). WinQuake's video modes resize its
    // window this way (vid_mode 2: 806x625 with its frame, an 800x600 picture).
    SetWindowPos: ['ppiiiiu', (x, hwnd, after, X, Y, w, h, flags) => {
      if (hwnd !== st.hwnd) return placeOther(x, hwnd, X, Y, w, h, flags, 28);
      if (deskMode()) {
        if (st.shown) uncoverRect(mainOrigin(), st.w, st.h);
        if (!(flags & 2)) { st.x = X; st.y = Y; } if (!(flags & 1)) { st.w = Math.max(1, w); st.h = Math.max(1, h); }
        if (flags & 0x40) st.shown = true; if (flags & 0x80) st.shown = false;
        invalidate(hwnd, true, true); return 1;
      }
      if (!(flags & 2)) { st.x = X; st.y = Y; st.placed = true; wm.dirty = true; }   // unless SWP_NOMOVE
      if (flags & 1) return 1;                                         // SWP_NOSIZE
      const w0 = st.w, h0 = st.h; resize(w, h);
      // WM_WINDOWPOSCHANGED (its WINDOWPOS: where and how big, frame included), then WM_SIZE, the client
      // area's new size: SDL 2 learns of a new size from the first, others from the second.
      return st.w !== w0 || st.h !== h0 ? send(x, [[0x47, 0, windowPos(x, w, h, flags)], [0x05, 0, sizeLp()]], () => 1, 28) : 1;
    }],
    MoveWindow: ['piiiii', (x, hwnd, X, Y, w, h) => {
      if (hwnd !== st.hwnd) return placeOther(x, hwnd, X, Y, w, h, 0, 24);
      if (deskMode()) { if (st.shown) uncoverRect(mainOrigin(), st.w, st.h); st.x = X; st.y = Y; st.w = Math.max(1, w); st.h = Math.max(1, h); invalidate(hwnd, true, true); return 1; }
      st.x = X; st.y = Y; st.placed = true;
      const w0 = st.w, h0 = st.h; resize(w, h);
      return st.w !== w0 || st.h !== h0 ? send(x, [[0x47, 0, windowPos(x, w, h, 0)], [0x05, 0, sizeLp()]], () => 1, 24) : 1;
    }],
    GetAsyncKeyState: ['i', (x, vk) => (st.keys.has(vk) ? 0x8001 : 0)],
    GetCursorPos: ['p', (x, p) => { x.w32(p, st.mouseX ?? (st.w >> 1)); x.w32(p + 4, st.mouseY ?? (st.h >> 1)); return 1; }],
    PostQuitMessage: ['i', (x, code) => { st.msgs.push({ msg: 0x12, wp: code >>> 0, lp: 0 }); return 0; }],   // WM_QUIT, which GetMessage ends on
    GetKeyState: ['i', (x, vk) => (st.keys.has(vk) ? 0x8000 : 0)],
    // The message queue: what the visitor's keys and mouse put there (win32Apis(...).input). MSG is
    // hwnd, message, wParam, lParam, time, pt; PM_REMOVE (1) takes it off the queue.
    // The filters: a window (its children's messages too) and a range of messages, both 0 for any.
    PeekMessageA: ['ppuuu', (x, m, hwnd, min, max, remove) => {
      if (st.videoTick) st.videoTick(x);                              // a playing video's frame due (MCI)
      const peek = () => {
        const i = firstMsg(hwnd, min, max);
        if (i < 0) {
          const p = paintFor(hwnd, min, max); if (p) { putMsg(x, m, { msg: 0x0f, wp: 0, lp: 0, hwnd: p }); return 1; }
          const t = timerFor(x, hwnd, min, max); if (t) { putMsg(x, m, t); return 1; }
          return 0;
        }
        const e = st.msgs[i];
        putMsg(x, m, e); if (remove & 1) st.msgs.splice(i, 1);
        return keyHook(x, e, remove & 1 ? 0 : 3, (eat) => (eat && !(remove & 1) && st.msgs.splice(st.msgs.indexOf(e), 1), eat ? 0 : 1), 20);
      };
      return st.pendingMove ? send(x, [[0x03, 0, takeMove()]], peek, 20) : peek();   // a window moved: WM_MOVE sent first
    }],
    PeekMessageW: ['ppuuu', (x, m, hwnd, min, max, remove) => user32.PeekMessageA[1](x, m, hwnd, min, max, remove)],
    // GetMessageA waits for one, as an idle window does (the call is made again when the time comes);
    // WM_QUIT (12h) makes it return 0.
    GetMessageA: ['ppuu', (x, m, hwnd, min, max) => {
      if (st.pendingMove) { putMsg(x, m, { msg: 0x03, wp: 0, lp: takeMove() }); return 1; }
      const i = firstMsg(hwnd, min, max);
      if (i < 0) {
        const p = paintFor(hwnd, min, max); if (p) { putMsg(x, m, { msg: 0x0f, wp: 0, lp: 0, hwnd: p }); return 1; }
        const t = timerFor(x, hwnd, min, max); if (t) { putMsg(x, m, t); return 1; }
        const vn = st.videoTick ? st.videoTick(x) : Infinity;        // a playing video: its next frame's time
        if (firstMsg(hwnd, min, max) >= 0) return user32.GetMessageA[1](x, m, hwnd, min, max);   // ...or its end, notified: taken now
        return x.waitUntil(Math.min(x.lx.mono() + 0.01, timerNext(), vn));
      }
      const e = st.msgs.splice(i, 1)[0]; putMsg(x, m, e);
      return keyHook(x, e, 0, (eat) => (eat ? (x.w32(m + 4, 0), 1) : e.msg === 0x12 ? 0 : 1), 16);   // eaten: WM_NULL in its place
    }],
    /*
     * TranslateMessage: a key that types a character posts WM_CHAR (102h) after its WM_KEYDOWN, as Windows'
     * US layout makes it -- letters with Shift or Caps Lock, digits and their shifted signs, space, Enter,
     * Backspace, Tab, Escape and the punctuation keys. It returns whether it posted one.
     */
    TranslateMessage: ['p', (x, m) => {
      if (x.r32(m + 4) !== 0x100) return 0;
      const vk = x.r32(m + 8), shift = st.keys.has(0x10), caps = !!st.capsLock;
      let c = null;
      if (vk >= 0x41 && vk <= 0x5a) c = shift !== caps ? vk : vk + 32;
      else if (vk >= 0x30 && vk <= 0x39) c = shift ? ')!@#$%^&*('.charCodeAt(vk - 0x30) : vk;
      else if (vk >= 0x60 && vk <= 0x69) c = vk - 0x30;                                 // the keypad's digits
      else if ([0x20, 0x0d, 0x08, 0x09, 0x1b].includes(vk)) c = vk;
      else { const p = { 0xba: ';:', 0xbb: '=+', 0xbc: ',<', 0xbd: '-_', 0xbe: '.>', 0xbf: '/?', 0xc0: '`~', 0xdb: '[{', 0xdc: '\\|', 0xdd: ']}', 0xde: "'\"" }[vk]; if (p) c = p.charCodeAt(shift ? 1 : 0); }
      if (c === null || st.keys.has(0x11) || st.keys.has(0x12)) return 0;
      st.msgs.unshift({ msg: 0x102, wp: c, lp: x.r32(m + 12), hwnd: x.r32(m) });
      return 1;
    }],
    // DispatchMessageA runs the window's procedure in the program: its four arguments pushed, its return
    // into this stub's `ret 4`, which then returns to the caller with what the procedure returned.
    DispatchMessageA: ['p', (x, m) => {
      // WM_TIMER with a procedure in lParam: that procedure, with the time in its place (TIMERPROC).
      const timed = x.r32(m + 4) === 0x113 && x.r32(m + 12);
      const proc = timed || procOf(x.r32(m)); if (!proc) { if (x.r32(m + 4) === 0x0f) st.invalid.delete(x.r32(m)); return 0; }
      const c = x.cpu, args = [x.r32(m), x.r32(m + 4), x.r32(m + 8), timed ? x.r32(m + 16) : x.r32(m + 12)];
      let sp = c.reg[4] >>> 0;
      for (const v of [c.eip >>> 0, ...args].reverse()) { sp -= 4; x.w32(sp, v); }
      c.reg[4] = sp; c.eip = proc; return 0;
    }],
    // What a window does with a message its procedure passes on: WM_CLOSE destroys it (WM_DESTROY and
    // WM_NCDESTROY, sent); WM_SYSCOMMAND's SC_CLOSE posts WM_CLOSE. The rest needs nothing here.
    DefWindowProcA: ['puuu', (x, hwnd, msg, wp, lp) => {
      const r = defWindow(x, hwnd, msg, wp, lp);
      if (r !== undefined) return r;
      if (msg === 0x10 && hwnd === st.hwnd && !st.destroyed) { st.destroyed = true; return send(x, [[0x02, 0, 0], [0x82, 0, 0]], () => 0, 16); }
      if (msg === 0x10 && hwnd !== st.hwnd && win(hwnd)) return destroyOther(x, hwnd, () => 0, 16);
      if (msg === 0x112 && (wp & 0xfff0) === 0xf060) st.msgs.push({ msg: 0x10, wp: 0, lp: 0 });
      return 0;
    }],
    // WNDCLASSA: lpfnWndProc at 4, lpszClassName at 36; WNDCLASSEXA: at 8 and 40. An atom of its own each.
    RegisterClassA: ['p', (x, wc) => { const a = registerClass(x, x.r32(wc + 4), x.r32(wc + 36)); classInfo(x, a, x.r32(wc + 36), x.bytes(wc, 40)); return a; }],
    RegisterClassExA: ['p', (x, wc) => { const a = registerClass(x, x.r32(wc + 8), x.r32(wc + 40)); classInfo(x, a, x.r32(wc + 40), x.bytes(wc + 4, 40)); return a; }],
    // A class's WNDCLASSA as it was registered (the system's own: their procedure), or 0 when there is none.
    GetClassInfoA: ['ppp', (x, inst, name, wc) => {
      const key = name < 0x10000 ? name : x.str(name, 256).toLowerCase(), info = st.classInfo.get(key);
      if (info) { x.write(wc, info); return 1; }
      const proc = systemProc(x, key); if (!proc) return 0;
      x.write(wc, new Uint8Array(40)); x.w32(wc + 4, proc); x.w32(wc + 36, name); return 1;
    }],
    // SM_CXSCREEN, SM_CYSCREEN (the desktop, or the mode a program set), SM_CYCAPTION and the frames as
    // XP's classic style, the work area above a 30-pixel taskbar.
    GetSystemMetrics: ['i', (x, n) => {
      const S = st.modeSet ? { w: st.w, h: st.h } : st.desk;
      // SM_CYMENU (15): the menu bar's height as the window manager draws it (src/win32/wm.js), which
      // Minesweeper adds to its board's to size its window. Scroll bars and their arrows 16, icons 32 (small
      // 16), the caption's buttons 18, 3D edges 2.
      return ({ 0: S.w, 1: S.h, 2: 16, 3: 16, 4: 18, 5: 1, 6: 1, 7: 3, 8: 3, 9: 16, 10: 16, 11: 32, 12: 32, 13: 32, 14: 32, 15: 19, 20: 16, 21: 16,
        30: 18, 31: 18, 32: 4, 33: 4, 45: 2, 46: 2, 49: 16, 50: 16, 16: S.w, 17: S.h - 30 - 19 })[n] ?? 0;
    }],
    // The desktop's (GetDesktopWindow, 10004h): the screen -- Pinball centres its window by it.
    GetClientRect: ['pp', (x, hwnd, r) => { if (hwnd === 0x10004) { const D = st.modeSet ? { w: st.w, h: st.h } : st.desk; x.w32(r, 0); x.w32(r + 4, 0); x.w32(r + 8, D.w); x.w32(r + 12, D.h); return 1; }
      const w = hwnd !== st.hwnd && win(hwnd); x.w32(r, 0); x.w32(r + 4, 0); x.w32(r + 8, w ? w.w : st.w); x.w32(r + 12, w ? w.h : st.h); return 1; }],
    // The window on the screen, its frame included: where the program put it, or the visitor dragged it.
    GetWindowRect: ['pp', (x, hwnd, r) => {
      if (hwnd === 0x10004) return user32.GetClientRect[1](x, hwnd, r);
      const w = hwnd !== st.hwnd && win(hwnd);
      if (w) { const o = screenOrigin(hwnd); x.w32(r, o.x); x.w32(r + 4, o.y); x.w32(r + 8, o.x + w.w); x.w32(r + 12, o.y + w.h); return 1; }
      const o = st.mainDialog && !wm.framed() ? { x: 0, y: 0, w: st.w, h: st.h } : wm.outer(); x.w32(r, o.x); x.w32(r + 4, o.y); x.w32(r + 8, o.x + o.w); x.w32(r + 12, o.y + o.h); return 1;
    }],
    // A message box is not shown; its caption and text go to the log, where an error says what it is.
    MessageBoxA: ['pppu', (x, hwnd, text, cap, type) => messageBox(x, hwnd, text ? x.str(text, 1024) : '', cap ? x.str(cap, 128) : 'Error', type)], SetTimer: ['puup', (x, hwnd, id, every, fn) => {
      // A timer: WM_TIMER when it is due and nothing else is queued (Minesweeper's clock); a window's by its id,
      // a thread's (no window) by a new one. USER_TIMER_MINIMUM: 10 ms.
      if (!hwnd) id = st.timerNext = (st.timerNext || 0x7000) + 1;
      st.timers.set(`${hwnd}:${id}`, { hwnd, id, every: Math.max(10, every) / 1000, next: x.lx.mono() + Math.max(10, every) / 1000, fn });
      return id || 1;
    }], ValidateRect: ['pp', (x, h) => { st.invalid.delete(h || st.hwnd); return 1; }], // The window's end: WM_DESTROY, then WM_NCDESTROY; the program's other windows (dialogs) have no procedure here.
    DestroyWindow: ['p', (x, hwnd) => {
      if (hwnd === st.hwnd) return !st.destroyed ? (st.destroyed = true, send(x, [[0x02, 0, 0], [0x82, 0, 0]], () => 1, 4)) : 1;
      return destroyOther(x, hwnd, () => 1, 4);
    }],
    LoadCursorA: ['pp', () => 0x10003], LoadIconA: ['pp', () => 0x10002], SetCursor: ['p', () => 0], AdjustWindowRect: ['pui', (x, r, style, menu) => user32.AdjustWindowRectEx[1](x, r, style, menu, 0)],
    // wsprintfA(buf, fmt, ...) (cdecl) and wvsprintfA(buf, fmt, va_list): at most 1024 characters, as Windows.
    wsprintfA: ['pp', (x, buf, fmt) => { const out = formatC(x, x.str(fmt), (x.cpu.reg[4] >>> 0) + 12).slice(0, 1023); x.write(buf, new TextEncoder().encode(out + '\0')); return out.length; }, { cdecl: true }],
    wvsprintfA: ['ppp', (x, buf, fmt, ap) => { const out = formatC(x, x.str(fmt), ap).slice(0, 1023); x.write(buf, new TextEncoder().encode(out + '\0')); return out.length; }],
    // A program's own windows beyond the first (WinQuake's start-up dialog, made from its resources and
    // destroyed once the game window is up): a handle of their own, never on the screen here.
    CreateDialogParamA: ['pppp' + 'p', (x, inst, name, parent, proc, param) => {
      const r = findResource(x, inst || x.win.base, 5, resId(x, name));
      return r ? createDialog(x, inst, r.at, parent, proc, param, 20) : 0x10020;
    }],
    // EndDialog: the dialog hidden and its result kept (a modal loop -- MFC's RunModalLoop -- ends on its own).
    EndDialog: ['pi', (x, dlg, r) => {
      const w = win(dlg); if (!w) return 0;
      w.result = r; w.ended = true;
      if (w.modal) { x.w32(w.modal, 1); x.w32(w.modal + 8, r); }      // the modal loop ends (DialogBoxParam)
      if (w.visible) { w.visible = false; if (!(w.style & 0x40000000)) uncoverRect(screenOrigin(dlg), w.w, w.h); }
      return 1;
    }],
    // A dialog's keyboard: Enter is the push button with the focus (a message box's Yes), else IDOK; Escape
    // IDCANCEL, each a WM_COMMAND posted to it, and the key taken; anything else is the caller's to dispatch.
    IsDialogMessageA: ['pp', (x, dlg, m) => {
      const h = x.r32(m), msg = x.r32(m + 4), vk = x.r32(m + 8);
      if (!win(dlg) || (h !== dlg && !isAncestor(dlg, h))) return 0;
      if (msg === 0x100 && (vk === 0x0d || vk === 0x1b)) {
        const f = win(st.focus), id = vk === 0x1b ? 2 : f && f.parent === dlg && f.cls === 'button' && !(f.style & 0xe) && f.id ? f.id : 1;
        st.msgs.push({ msg: 0x111, wp: id, lp: 0, hwnd: dlg }); return 1;
      }
      // Tab (Shift+Tab back): the focus to the next control with WS_TABSTOP, an edit control's text selected.
      if (msg === 0x100 && vk === 0x09) {
        const stops = [...st.wins.values()].filter((c) => c.parent === dlg && !c.dead && c.visible && c.enabled !== false && c.style & 0x10000);
        if (stops.length) {
          const i = stops.findIndex((c) => c.hwnd === st.focus), next = stops[(i + (st.keys.has(0x10) ? stops.length - 1 : 1) + (i < 0 ? stops.length : 0)) % stops.length];
          const prev = win(st.focus); st.focus = next.hwnd; if (next.cls === 'edit') next.selAll = true;
          invalidate(next.hwnd, true); if (prev) invalidate(prev.hwnd, true);
        }
        return 1;
      }
      if ((msg === 0x102 || msg === 0x101) && vk === 0x09) return 1;
      if ((msg === 0x102 || msg === 0x101) && (vk === 0x0d || vk === 0x1b)) return 1;
      return 0;
    }],
    // A dialog's control sent a message by its id (the dialog's GetDlgItem, then SendMessageA).
    // Its own five arguments' bytes taken off (20): through SendMessageA's 16, Pinball's Player Controls lost four a call -- 49,000 calls, its stack.
    SendDlgItemMessageA: ['piuuu', (x, dlg, id, msg, wp, lp) => user32.SendMessageA[1](x, user32.GetDlgItem[1](x, dlg, id), msg, wp, lp, 20)],
    /*
     * A modal dialog box (Minesweeper's Custom Field and Best Times): the dialog made as CreateDialog
     * makes it, shown, its owner disabled; then, in the caller's place, a loop of the program's own
     * (guest code made here, modalLoop) that takes and dispatches messages -- IsDialogMessage first --
     * until EndDialog, destroys the dialog and returns EndDialog's result to DialogBox's caller.
     */
    DialogBoxParamA: ['ppppp', (x, inst, name, parent, proc, param) => {
      const r = findResource(x, inst || x.win.base, 5, resId(x, name)); if (!r) return -1;
      return createDialog(x, inst, r.at, parent, proc, param, 20, (dlg) => modal(x, dlg, parent));
    }],
    DialogBoxIndirectParamA: ['ppppp', (x, inst, tpl, parent, proc, param) => createDialog(x, inst, tpl, parent, proc, param, 20, (dlg) => modal(x, dlg, parent))],
    CreateDialogIndirectParamA: ['ppppp', (x, inst, tpl, parent, proc, param) => createDialog(x, inst, tpl, parent, proc, param, 20)],
    // DefDlgProcA: the dialog's DLGPROC first; what it does not handle (FALSE) goes to DefWindowProc, what it
    // does returns its DWL_MSGRESULT (WM_INITDIALOG and the messages that answer with a value: its own).
    DefDlgProcA: ['puuu', (x, hwnd, msg, wp, lp) => {
      const w = win(hwnd), fn = w && w.dlgProc;
      // A message box's buttons end it with their id; Escape (IDCANCEL) is its only button's when it has
      // no Cancel (MB_OK), and nothing for Yes/No.
      if (w && w.msgBox && msg === 0x111 && !(wp >>> 16)) {
        let id = wp & 0xffff; if (!w.msgBox.includes(id)) { if (w.msgBox.length !== 1) return 0; id = w.msgBox[0]; }
        return user32.EndDialog[1](x, hwnd, id);
      }
      if (!fn) return user32.DefWindowProcA[1](x, hwnd, msg, wp, lp);
      return send(x, [{ fn, args: [hwnd, msg, wp, lp] }], (eax) => {
        if (!eax) return user32.DefWindowProcA[1](x, hwnd, msg, wp, lp);
        return [0x110, 0x19, 0x133, 0x134, 0x135, 0x136, 0x137, 0x138, 0x2b, 0x0f].includes(msg) ? eax : (w.long.get(0) ?? eax);
      }, 16);
    }],
    // A dialog's control by its id; a window not made here (WinQuake's start-up dialog) has none.
    // A dialog's control by its id: its text, as text or a number; its check (BM_SETCHECK's state).
    SetDlgItemTextA: ['pip', (x, dlg, id, t) => user32.SetWindowTextA[1](x, user32.GetDlgItem[1](x, dlg, id), t)],
    GetDlgItemTextA: ['pipi', (x, dlg, id, buf, n) => user32.GetWindowTextA[1](x, user32.GetDlgItem[1](x, dlg, id), buf, n)],
    SetDlgItemInt: ['piui', (x, dlg, id, v, signed) => { const h = user32.GetDlgItem[1](x, dlg, id), w = win(h); if (!w) return 0; w.title = String(signed ? v | 0 : v >>> 0); invalidate(h, true); return 1; }],
    GetDlgItemInt: ['pipi', (x, dlg, id, ok, signed) => {
      const w = win(user32.GetDlgItem[1](x, dlg, id)), m = w && /^\s*(-?\d+)/.exec(w.title || ''), v = m ? parseInt(m[1], 10) : 0, good = !!m && (signed || v >= 0);
      if (ok) x.w32(ok, good ? 1 : 0); return good ? v >>> 0 : 0;
    }],
    CheckDlgButton: ['piu', (x, dlg, id, c) => { const h = user32.GetDlgItem[1](x, dlg, id), w = win(h); if (!w) return 0; w.checked = c; invalidate(h, true); return 1; }],
    IsDlgButtonChecked: ['pi', (x, dlg, id) => { const w = win(user32.GetDlgItem[1](x, dlg, id)); return w ? w.checked | 0 : 0; }],
    CheckRadioButton: ['piii', (x, dlg, first, last, check) => {
      for (let id = first; id <= last; id++) { const h = user32.GetDlgItem[1](x, dlg, id), w = win(h); if (w) { w.checked = id === check ? 1 : 0; invalidate(h, true); } }
      return 1;
    }],
    FlashWindow: ['pi', () => 0],
    SetScrollPos: ['piii', () => 0],
    // DeferWindowPos: each move made at once (the result is the same: windows in their new places).
    BeginDeferWindowPos: ['i', () => 0x7100], EndDeferWindowPos: ['p', () => 1],
    DeferWindowPos: ['pppiiiiu', (x, h, hwnd, after, X, Y, w, hh, flags) => { const o = win(hwnd); if (o && hwnd !== st.hwnd) { if (!(flags & 2)) { o.x = X; o.y = Y; } if (!(flags & 1)) { o.w = w; o.h = hh; } invalidate(o.parent || st.hwnd, true, true); } return h; }],
    // Text with tabs: drawn as TextOut draws it (tab stops not expanded); its extent as GetTextExtentPoint32's.
    TabbedTextOutA: ['piipiipi', (x, hdc, X, Y, s, n) => { gdi32.TextOutA[1](x, hdc, X, Y, s, n); const sz = x.win.heapAlloc(8); gdi32.GetTextExtentPoint32A[1](x, hdc, s, n, sz); const r = (x.r16(sz + 4) << 16) | x.r16(sz); x.win.heapFree(sz); return r; }],
    GetTabbedTextExtentA: ['ppiip', (x, hdc, s, n) => { const sz = x.win.heapAlloc(8); gdi32.GetTextExtentPoint32A[1](x, hdc, s, n, sz); const r = (x.r16(sz + 4) << 16) | x.r16(sz); x.win.heapFree(sz); return r; }],
    GrayStringA: ['pppiiiiii', () => 1],                               // drawn by a callback of the program's: not here
    // DDE's packed lParams: an atom pair packed as is, unpacked into its words.
    ReuseDDElParam: ['puuuu', (x, lp, msgIn, msgOut, lo, hi) => ((hi & 0xffff) << 16 | (lo & 0xffff)) >>> 0],
    UnpackDDElParam: ['uupp', (x, msg, lp, plo, phi) => { if (plo) x.w32(plo, lp & 0xffff); if (phi) x.w32(phi, lp >>> 16); return 1; }],
    // The next (or previous) control with WS_TABSTOP in a dialog, after `h`.
    GetNextDlgTabItem: ['ppi', (x, dlg, h, prev) => {
      const stops = [...st.wins.values()].filter((c) => c.parent === dlg && !c.dead && c.visible && c.enabled !== false && c.style & 0x10000);
      if (!stops.length) return 0; const i = stops.findIndex((c) => c.hwnd === h);
      return stops[(i + (prev ? stops.length - 1 : 1) + (i < 0 ? stops.length : 0)) % stops.length].hwnd;
    }],
    // WaitMessage: until something is queued, as GetMessage waits.
    WaitMessage: ['', (x) => (st.msgs.length || st.pendingMove || (st.paintDue && st.paintDue()) ? 1 : x.waitUntil(x.lx.mono() + 0.01))],
    // GetKeyNameTextA(lParam, buf, n): the key's name, from its scancode (bits 16-23) and extended bit (24).
    GetKeyNameTextA: ['ipi', (x, lp, buf, n) => {
      const vk = scanToVk((lp >> 16) & 0xff, !!(lp & 0x1000000));
      const name = ({ 0x08: 'Backspace', 0x09: 'Tab', 0x0d: 'Enter', 0x10: 'Shift', 0x11: 'Ctrl', 0x12: 'Alt', 0x14: 'Caps Lock', 0x1b: 'Esc', 0x20: 'Space',
        0x25: 'Left', 0x26: 'Up', 0x27: 'Right', 0x28: 'Down', 0x2d: 'Insert', 0x2e: 'Delete', 0x24: 'Home', 0x23: 'End', 0x21: 'Page Up', 0x22: 'Page Down' })[vk]
        || (vk >= 0x70 && vk <= 0x7b ? 'F' + (vk - 0x6f) : vk >= 0x30 && vk <= 0x5a ? String.fromCharCode(vk) : '');
      if (n <= 0) return 0; const t = name.slice(0, n - 1); x.write(buf, new TextEncoder().encode(t + '\0')); return t.length;
    }],
    GetDlgItem: ['pi', (x, dlg, id) => [...st.wins.values()].find((w) => w.parent === dlg && !w.dead && w.id === (id & 0xffff))?.hwnd || 0],
    // GWL_STYLE, GWL_EXSTYLE, GWL_WNDPROC of the window.
    GetWindowLongA: ['pi', (x, hwnd, i) => {
      if (hwnd === st.hwnd) return i === -16 ? st.style >>> 0 : i === -4 ? st.wndProc >>> 0 : i === 4 && win(hwnd) && win(hwnd).dlgProc !== undefined ? win(hwnd).dlgProc : (win(hwnd) && win(hwnd).long && win(hwnd).long.get(i)) || 0;
      const w = win(hwnd); if (!w) return 0;
      return i === -16 ? w.style : i === -4 ? w.proc >>> 0 : i === -12 ? w.id >>> 0 : i === -8 ? w.parent : i === 4 && w.dlgProc ? w.dlgProc : (w.long.get(i) || 0) >>> 0;
    }],
    RegisterWindowMessageA: ['p', () => 0xc100 + (st.winMsgs = (st.winMsgs | 0) + 1)],
    RegisterHotKey: ['piuu', () => 1], UnregisterHotKey: ['pi', () => 1], UnregisterClassA: ['pp', () => 1],
    // No clipboard here: OpenClipboard fails, as when another program holds it.
    OpenClipboard: ['p', () => 0], GetClipboardData: ['u', () => 0], CloseClipboard: ['', () => 1],
    // The classic scheme's system colours (COLORREF, 0x00BBGGRR); setting them changes nothing here.
    GetSysColor: ['i', (x, i) => ({ 1: 0xa56e3a, 2: 0x6a240a, 4: 0xc8d0d4, 5: 0xffffff, 6: 0x000000, 8: 0x000000, 9: 0xffffff, 15: 0xc8d0d4, 16: 0x808080, 18: 0x000000, 20: 0xffffff })[i] ?? 0],
    SetSysColors: ['ipp', () => 1],
    // The active window: the main one, until another top-level window is shown or brought forward (Half-
    // Life's engine window over its launcher), which then gets what Windows sends on activation -- its
    // WM_ACTIVATEAPP and WM_ACTIVATE are what tell a game it may take the screen and the mouse.
    GetActiveWindow: ['', () => st.activeWin || st.hwnd],
    SetActiveWindow: ['p', (x, h) => activateOther(x, h, () => st.activeWin || st.hwnd, 4)],
    SetForegroundWindow: ['p', (x, h) => activateOther(x, h, () => 1, 4)],
    SetFocus: ['p', (x, h) => {
      const prev = st.focus || st.hwnd; st.focus = h;
      let top = h; while (win(top) && (win(top).style & 0x40000000) && !win(top).main) top = win(top).parent;   // its top-level window, made the active one
      return win(top) && !win(top).main && top !== st.hwnd && st.activeWin !== top ? activateOther(x, top, () => prev, 4) : prev;
    }],
    EnableWindow: ['pi', (x, h, on) => { const w = win(h); if (!w) return 0; const was = w.enabled === false; if (w.enabled !== !!on) { w.enabled = !!on; invalidate(h, true); } return was ? 1 : 0; }],
    MessageBeep: ['u', () => 1],
    SetCapture: ['p', (x, h) => { const prev = st.capture || 0; st.capture = h && win(h) && !win(h).main ? h : 0; return prev; }],
    ReleaseCapture: ['', () => { st.capture = 0; return 1; }],
    ClipCursor: ['p', (x, r) => { st.clip = r ? { l: x.r32(r) | 0, t: x.r32(r + 4) | 0, r: x.r32(r + 8) | 0, b: x.r32(r + 12) | 0 } : null; return 1; }],
    // InvalidateRect: a WM_PAINT due, the main window's too (Minesweeper's new game).
    InvalidateRect: ['ppi', (x, h, r, erase) => { invalidate(h || st.hwnd, !!erase); return 1; }], PostMessageA: ['puuu', (x, hwnd, msg, wp, lp) => { st.msgs.push({ msg, wp, lp, ...(hwnd && hwnd !== st.hwnd ? { hwnd } : {}) }); return 1; }],
    SendMessageA: ['puuu', (x, hwnd, msg, wp, lp, pop = 16) => (procOf(hwnd) ? send(x, [[msg, wp, lp, hwnd]], (eax) => eax, pop) : 0)], KillTimer: ['pu', (x, hwnd, id) => (st.timers.delete(`${hwnd}:${id}`) ? 1 : 0)],
    // GWL_STYLE (-16): the frame the window's size includes from now on (WinQuake's windowed and full-screen modes).
    SetWindowLongA: ['pii', (x, hwnd, i, v) => {
      if (hwnd === st.hwnd) {
        if (i === -16) { const prev = st.style | 0; st.style = v; return prev; }
        if (i === -4) { const prev = st.wndProc | 0; st.wndProc = v >>> 0; if (win(hwnd)) win(hwnd).proc = v >>> 0; return prev; }   // subclassed
        if (i === 4 && win(hwnd) && win(hwnd).dlgProc !== undefined) { const w = win(hwnd), prev = w.dlgProc | 0; w.dlgProc = v >>> 0; return prev; }
        const w = win(hwnd); if (!w) return 0; if (!w.long) w.long = new Map(); const prev = w.long.get(i) || 0; w.long.set(i, v); return prev;
      }
      const w = win(hwnd); if (!w) return 0;
      const field = { [-16]: 'style', [-4]: 'proc', [-12]: 'id', [-8]: 'parent' }[i] || (i === 4 && w.dlgProc !== undefined ? 'dlgProc' : null);
      if (field) { const prev = w[field] | 0; w[field] = v >>> 0; return prev; }
      const prev = w.long.get(i) || 0; w.long.set(i, v); return prev;
    }],
    // WM_PAINT's DC: the window's, the whole client area to paint (PAINTSTRUCT: hdc, fErase, rcPaint).
    // A window's DC to paint with, the whole client area its rcPaint; its update region validated, and
    // erased first (WM_ERASEBKGND) when it was invalidated so.
    BeginPaint: ['pp', (x, hwnd, ps) => {
      const w = hwnd !== st.hwnd && win(hwnd), hdc = dcFor(hwnd), erase = (win(hwnd) || {}).erase;
      x.write(ps, new Uint8Array(64)); x.w32(ps, hdc); x.w32(ps + 16, w ? w.w : st.w); x.w32(ps + 20, w ? w.h : st.h);
      st.invalid.delete(hwnd); if (win(hwnd)) win(hwnd).erase = false;
      if (erase) return send(x, [[0x14, hdc, 0, hwnd]], (r) => { x.w32(ps + 4, r ? 0 : 1); return hdc; }, 8);   // WM_ERASEBKGND: the class's brush (Minesweeper's grey)
      return hdc;
    }],
    EndPaint: ['pp', () => 1],
    // WINDOWPLACEMENT: its length at 0, then flags, show state, the two points and the normal rectangle.
    GetWindowPlacement: ['pp', (x, hwnd, p) => { x.write(p, new Uint8Array(44)); x.w32(p, 44); x.w32(p + 8, 1); x.w32(p + 36, st.w); x.w32(p + 40, st.h); return 1; }],
    SetWindowPlacement: ['pp', () => 1],
    // The frame XP's classic style puts round a client area: a 3-pixel border and an 18-pixel caption
    // (WS_CAPTION), a 1-pixel border alone (WS_BORDER) -- what AdjustWindowRectEx adds.
    AdjustWindowRectEx: ['puiu', (x, r, style, menu) => {
      const b = style & 0xc00000 ? 3 : style & 0x800000 ? 1 : 0, cap = (style & 0xc00000) === 0xc00000 ? 19 + (menu ? 19 : 0) : 0;
      x.w32(r, (x.r32(r) | 0) - b); x.w32(r + 4, (x.r32(r + 4) | 0) - b - cap); x.w32(r + 8, (x.r32(r + 8) | 0) + b); x.w32(r + 12, (x.r32(r + 12) | 0) + b);
      return 1;
    }],
    // The display's modes, one by one as EnumDisplaySettings lists them: DEVMODEA's dmBitsPerPel at
    // 104, dmPelsWidth 108, dmPelsHeight 112, dmDisplayFrequency 120 (its size, 156, at 36).
    EnumDisplaySettingsA: ['pup', (x, dev, i, dm) => {
      const modes = [[640, 480], [800, 600], [1024, 768]].flatMap(([w, h]) => [8, 16, 32].map((b) => [w, h, b]));
      const m = i === 0xffffffff || i === 0xfffffffe ? [st.w, st.h, 32] : modes[i];
      if (!m) return 0;
      x.w16(dm + 36, 156); x.w32(dm + 104, m[2]); x.w32(dm + 108, m[0]); x.w32(dm + 112, m[1]); x.w32(dm + 120, 60); x.w32(dm + 40, 0x1c0000);
      return 1;
    }],
    // SPI_GETWORKAREA (30h): the screen; anything else asked is answered without change.
    // SPI_GETWORKAREA (30h); SPI_GETNONCLIENTMETRICS (29h): XP's classic metrics -- 1-pixel borders,
    // 18-pixel captions and menu bar, Tahoma 8 points (bold in captions) -- which Jazz Jackrabbit 2 draws
    // its own caption with.
    SystemParametersInfoA: ['uupu', (x, what, n, p) => {
      if (what === 0x30 && p) { x.w32(p, 0); x.w32(p + 4, 0); x.w32(p + 8, st.w); x.w32(p + 12, st.h); }
      if (what === 0x29 && p) {
        const font = (at, bold) => { x.write(at, new Uint8Array(60)); x.w32(at, -11); x.w32(at + 16, bold ? 700 : 400); x.write(at + 28, new TextEncoder().encode('Tahoma\0')); };
        x.w32(p, 340); [1, 16, 16, 18, 18].forEach((v, i) => x.w32(p + 4 + 4 * i, v)); font(p + 24, true);
        x.w32(p + 84, 12); x.w32(p + 88, 15); font(p + 92, true);
        x.w32(p + 152, 18); x.w32(p + 156, 18); font(p + 160, false); font(p + 220, false); font(p + 280, false);
      }
      return 1;
    }],
    // The module's string table (RT_STRING); an empty string for an id it lacks.
    LoadStringA: ['pupi', (x, inst, id, buf, n) => {
      const s = loadString(x, inst || x.win.base, id) || '';
      if (n <= 0) return 0;
      const b = Uint8Array.from(s.slice(0, n - 1), (c) => c.charCodeAt(0) & 0xff); x.write(buf, b); x.w8(buf + b.length, 0); return b.length;
    }],
    // No message ever arrives here, so it waits its time out (WAIT_TIMEOUT), as an idle window does.
    // Its stub pushes EAX before it traps: what the procedure returned (a stub's own `mov eax, id` had
    // put the function's number in its place, and every send's result was that number).
    mirageReturn: ['', (x) => mirageReturn(x), { ordinal: 2600, noName: true, keepEax: true }],
    // Hooks: WH_CBT's (5) called as windows are made; the others (MFC's WH_MSGFILTER) kept, never called.
    SetWindowsHookExA: ['ippu', (x, id, fn) => { st.hooks.set(id, fn); return 0x4000 + id; }],
    UnhookWindowsHookEx: ['p', (x, h) => { st.hooks.delete(h - 0x4000); return 1; }],
    CallNextHookEx: ['piuu', () => 0],
    // What a window is, and where: the main one and the others alike.
    IsWindow: ['p', (x, h) => (h === st.hwnd ? (st.destroyed ? 0 : 1) : win(h) && !win(h).dead ? 1 : 0)],
    IsWindowVisible: ['p', (x, h) => (h === st.hwnd ? (st.shown ? 1 : 0) : win(h) && win(h).visible ? 1 : 0)],
    IsWindowEnabled: ['p', (x, h) => (win(h) && win(h).enabled === false ? 0 : 1)],
    IsIconic: ['p', () => 0], IsZoomed: ['p', () => 0],
    GetParent: ['p', (x, h) => (win(h) ? win(h).parent : 0)],
    IsChild: ['pp', (x, p, h) => { for (let w = win(h); w; w = win(w.parent)) if (w.parent === p) return 1; return 0; }],
    GetDesktopWindow: ['', () => 0x10004], GetForegroundWindow: ['', () => st.activeWin || st.hwnd],
    GetFocus: ['', () => st.focus || st.hwnd], GetCapture: ['', () => st.capture || 0],
    GetLastActivePopup: ['p', (x, h) => h], GetTopWindow: ['p', (x, h) => [...st.wins.values()].find((w) => w.parent === h && !w.dead)?.hwnd || 0],
    // GetWindow: GW_HWNDNEXT 2, GW_HWNDPREV 3, GW_OWNER 4, GW_CHILD 5, GW_HWNDFIRST 0, GW_HWNDLAST 1.
    GetWindow: ['pu', (x, h, cmd) => {
      if (cmd === 5) return [...st.wins.values()].find((w) => w.parent === h && !w.dead && !w.main)?.hwnd || 0;
      if (cmd === 4) return win(h) ? win(h).parent : 0;
      const w = win(h); if (!w) return 0;
      const sib = [...st.wins.values()].filter((c) => c.parent === w.parent && !c.dead && !c.main), i = sib.indexOf(w);
      return (cmd === 2 ? sib[i + 1] : cmd === 3 ? sib[i - 1] : cmd === 0 ? sib[0] : cmd === 1 ? sib[sib.length - 1] : null)?.hwnd || 0;
    }],
    GetDlgCtrlID: ['p', (x, h) => (win(h) ? win(h).id : 0)],
    GetClassNameA: ['ppi', (x, h, buf, n) => {
      const w = win(h), k = w ? w.cls : st.mainClass, name = typeof k === 'number' ? (st.classNames.get(k) || '#' + k) : k || '';
      if (n <= 0) return 0; const t = name.slice(0, n - 1); x.write(buf, new TextEncoder().encode(t + '\0')); return t.length;
    }],
    GetWindowTextLengthA: ['p', (x, h) => (h === st.hwnd ? (st.title || '').length : win(h) ? (win(h).title || '').length : 0)],
    CallWindowProcA: ['ppuuu', (x, fn, h, msg, wp, lp) => (fn ? send(x, [{ fn, args: [h, msg, wp, lp] }], (eax) => eax, 20) : 0)],
    WindowFromPoint: ['ii', () => st.hwnd],
    WindowFromDC: ['p', (x, hdc) => hwndOfDC(hdc) || st.hwnd],
    GetWindowDC: ['p', () => st.hdc],
    BringWindowToTop: ['p', () => 1], ShowOwnedPopups: ['pi', () => 1],
    RedrawWindow: ['pppu', () => 1], ExcludeUpdateRgn: ['pp', () => 1],
    FindWindowA: ['pp', () => 0],
    DestroyCaret: ['', () => 1], ShowCaret: ['p', () => 1], HideCaret: ['p', () => 1],
    MsgWaitForMultipleObjects: ['upiuu', (x, n, handles, all, ms) => { if (!ms) return 0x102; const r = x.sleep(Math.min(ms, 1000) / 1000); return r === 0 ? 0x102 : r; }],
  };
  // ---- gdi32 ---------------------------------------------------------------------------------------
  // Text drawn into a bitmap (ExtTextOutA), at the pen (X, Y), the cell's top.
  const textOut = (x, bm, d, m, X, Y, opts, rect, str, n, hdc) => {
    const text = textChars(hdc, x.bytes(str, Math.max(0, n))), bgr = (c) => ((c & 0xff) << 16) | (c & 0xff00) | ((c >>> 16) & 0xff);
    let width = 0;
    const glyphs = [...text].map((c) => { const g = m.font ? m.font.glyph(c, m.ppem) : null; const at = width; width += g ? g.cellIncX : m.avg; return { g, at }; });
    if (d.bkMode !== 1) fillRect(bm, X, Y, X + width, Y + m.height, bgr(d.bkColor));   // OPAQUE: the cells' background
    if (opts & 2 && rect) fillRect(bm, x.r32(rect) | 0, x.r32(rect + 4) | 0, x.r32(rect + 8) | 0, x.r32(rect + 12) | 0, bgr(d.bkColor));   // ETO_OPAQUE
    for (const { g, at } of glyphs) if (g) fillGlyph(bm, g, X + at, Y + m.ascent, bgr(d.textColor));
    return 1;
  };
  // The window's client area: what reaches the screen.
  const screen = () => { if (!st.screen || st.screen.w !== st.w || st.screen.h !== st.h) st.screen = { w: st.w, h: st.h, px: new Uint32Array(st.w * st.h) }; return st.screen; };
  const isWindowDC = (hdc) => hdc === st.hdc;
  // Another window's DC: its rectangle of the screen, copied out to draw on and back when done.
  const viewOf = (x, hdc) => {
    const h = hwndOfDC(hdc), w = win(h); if (!w || (h === st.hwnd && !deskMode())) return null;
    const top = !deskMode() && topOf(h), layered = top && !top.main;
    const sc = deskMode() ? deskScreen() : layered ? layerOf(top) : screen();
    const o = layered ? (() => { const a = screenOrigin(h), b = screenOrigin(top.hwnd); return { x: a.x - b.x, y: a.y - b.y }; })() : originOf(h), W = Math.max(0, h === st.hwnd ? st.w : w.w), H = Math.max(0, h === st.hwnd ? st.h : w.h), px = new Uint32Array(W * H);
    for (let j = 0; j < H; j++) { const y = o.y + j; if (y < 0 || y >= sc.h) continue; for (let i = 0; i < W; i++) { const X = o.x + i; if (X >= 0 && X < sc.w) px[j * W + i] = sc.px[y * sc.w + X]; } }
    return { w: W, h: H, px, o, sc };
  };
  // WS_CLIPCHILDREN: what the main window draws does not reach its children -- their pixels put back once
  // it has drawn (Solitaire's card, dragged or flying over its status bar, left green there). A function
  // that restores them, or null when there is nothing to keep.
  const clipKids = (sc) => {
    if (!(st.style & 0x2000000)) return null;
    const kids = [...st.wins.values()].filter((c) => c.parent === st.hwnd && !c.dead && c.visible && (c.style & 0x40000000) && c.w > 0 && c.h > 0);
    if (!kids.length) return null;
    const saved = kids.map((c) => {
      const x0 = Math.max(0, c.x | 0), y0 = Math.max(0, c.y | 0), x1 = Math.min(sc.w, (c.x | 0) + c.w), y1 = Math.min(sc.h, (c.y | 0) + c.h);
      if (x1 <= x0 || y1 <= y0) return null;
      const rows = []; for (let y = y0; y < y1; y++) rows.push(sc.px.slice(y * sc.w + x0, y * sc.w + x1));
      return { x0, y0, rows };
    }).filter(Boolean);
    return () => { for (const r of saved) r.rows.forEach((row, j) => sc.px.set(row, (r.y0 + j) * sc.w + r.x0)); };
  };
  // Where a DC's drawing lands, as pixels { w, h, px } and done() to put them where they belong: the
  // screen for the window's DC, the selected bitmap (and a section's memory) for a memory DC.
  const target = (x, hdc) => {
    if (isWindowDC(hdc) && !deskMode()) {
      const sc = screen(), keep = clipKids(sc);
      return { ...sc, done: () => { if (keep) keep(); wm.present(x.lx, sc); } };
    }
    const v = viewOf(x, hdc);
    // A hidden window's DC on the desktop draws nothing there, as on Windows: Half-Life's launcher blackens its
    // main dialog before it is shown, which left a black rectangle under the intro.
    if (v && deskMode() && !shown(hwndOfDC(hdc))) return { w: v.w, h: v.h, px: v.px, done: () => {} };
    if (v) return { w: v.w, h: v.h, px: v.px, done: () => {
      const { sc, o } = v;
      for (let j = 0; j < v.h; j++) { const y = o.y + j; if (y < 0 || y >= sc.h) continue; for (let i = 0; i < v.w; i++) { const X = o.x + i; if (X >= 0 && X < sc.w) sc.px[y * sc.w + X] = v.px[j * v.w + i]; } }
      if (deskMode()) wm.presentDesk(x.lx, sc); else if (sc === st.screen) wm.present(x.lx, sc); else { wm.dirty = true; wm.present(x.lx, null); }
    } };
    const bm = st.gdi.get(st.dcBitmaps.get(hdc));
    if (!bm || bm.kind !== 'bitmap') return null;
    // An 8-bit section: its indices as colours, and what the drawing changed back into indices of its own
    // table (the same colour's first index, or the nearest). The StarCraft installer composes its menu in
    // one and BitBlts it into another, the screen's.
    if (bm.dib8) {
      const { bits, stride } = bm.dib8, raw = x.bytes(bits, stride * bm.h), c = bm.colors, w = bm.w, h = bm.h;
      const row = (Y) => (bm.up ? h - 1 - Y : Y) * stride, px = new Uint32Array(w * h);
      for (let Y = 0; Y < h; Y++) { const r = row(Y); for (let X = 0; X < w; X++) px[Y * w + X] = c[raw[r + X]]; }
      const was = px.slice();
      return { w, h, px, done: () => {
        const near = new Map();
        for (let i = 255; i >= 0; i--) near.set(c[i], i);
        const index = (v) => {
          let k = near.get(v); if (k !== undefined) return k;
          let best = Infinity; k = 0;
          for (let i = 0; i < 256; i++) { const d = ((c[i] >> 16 & 255) - (v >> 16 & 255)) ** 2 + ((c[i] >> 8 & 255) - (v >> 8 & 255)) ** 2 + ((c[i] & 255) - (v & 255)) ** 2; if (d < best) { best = d; k = i; } }
          near.set(v, k); return k;
        };
        let lo = h, hi = -1;
        for (let Y = 0; Y < h; Y++) { const r = row(Y); for (let X = 0; X < w; X++) { const q = Y * w + X; if (px[q] !== was[q]) { raw[r + X] = index(px[q]); lo = Math.min(lo, r); hi = Math.max(hi, r); } } }
        if (hi >= 0) x.write(bits + lo, raw.subarray(lo, hi + stride));
      } };
    }
    if (bm.dib) dibCopy(x, bm, 0, bm.h, bm.dib.bits, bm.dib.bmi, true);
    if (bm.load) bm.load(x);                                          // a DirectDraw surface's DC (src/win32/ddraw.js)
    return { w: bm.w, h: bm.h, px: bm.px, done: () => { if (bm.dib) dibCopy(x, bm, 0, bm.h, bm.dib.bits, bm.dib.bmi, false); if (bm.store) bm.store(x); } };
  };
  // A DC's pixels to read: (x, y) -> 0x00RRGGBB, or null.
  const source = (x, hdc) => {
    if (isWindowDC(hdc) && !deskMode()) { const sc = screen(); return { w: sc.w, h: sc.h, at: (X, Y) => sc.px[Y * sc.w + X] }; }
    const v = viewOf(x, hdc); if (v) return { w: v.w, h: v.h, at: (X, Y) => v.px[Y * v.w + X] };
    const bm = st.gdi.get(st.dcBitmaps.get(hdc));
    if (!bm || bm.kind !== 'bitmap') return null;
    if (bm.dib8) {
      const { bits, stride } = bm.dib8, raw = x.bytes(bits, stride * bm.h), c = bm.colors;
      return { w: bm.w, h: bm.h, at: (X, Y) => c[raw[(bm.up ? bm.h - 1 - Y : Y) * stride + X]] };
    }
    if (bm.dib) dibCopy(x, bm, 0, bm.h, bm.dib.bits, bm.dib.bmi, true);
    if (bm.load) bm.load(x);
    return { w: bm.w, h: bm.h, mono: !!bm.mono, at: (X, Y) => bm.px[Y * bm.w + X] };
  };
  const rgbOf = (c) => ((c & 255) << 16) | (c & 0xff00) | ((c >>> 16) & 255);   // COLORREF -> 0x00RRGGBB
  /*
   * BitBlt and StretchBlt: the source's pixels combined with the destination's as the raster operation says --
   * SRCCOPY, SRCAND, SRCPAINT, SRCINVERT, NOTSRCCOPY, SRCERASE, NOTSRCERASE, MERGEPAINT; one that takes no
   * source (BLACKNESS, PATCOPY...) is PatBlt's. A monochrome bitmap onto a colour DC (cards.dll's empty
   * place, its 1-bit DIB under SRCAND) is in the destination's colours: 1 its background, 0 its text.
   */
  const ROPS = { 0xcc0020: (s) => s, 0x8800c6: (s, d) => s & d, 0xee0086: (s, d) => s | d, 0x660046: (s, d) => s ^ d, 0x330008: (s) => ~s & 0xffffff,
    0x440328: (s, d) => s & ~d & 0xffffff, 0x1100a6: (s, d) => ~(s | d) & 0xffffff, 0xbb0226: (s, d) => (~s | d) & 0xffffff };
  const blit = (x, dst, dx, dy, dw, dh, src, sx, sy, sw, sh, rop = 0xcc0020) => {
    rop >>>= 0;
    if (!ROPS[rop] && [0x42, 0xff0062, 0x550009, 0xf00021, 0x5a0049].includes(rop)) return gdi32.PatBlt[1](x, dst, dx, dy, dw, dh, rop);
    const op = ROPS[rop] || ROPS[0xcc0020];
    const s = source(x, src), t = target(x, dst);
    if (!s || !t || !dw || !dh) return 1;
    const d = s.mono && dcState(dst), one = d ? rgbOf(d.bkColor) : 0, zero = d ? rgbOf(d.textColor) : 0;
    const pick = s.mono ? (X, Y) => { const v = s.at(X, Y); return ((v >> 16 & 255) + (v >> 8 & 255) + (v & 255)) >= 384 ? one : zero; } : s.at;
    for (let j = 0; j < Math.abs(dh); j++) {
      const ty = dy + (dh < 0 ? -j : j); if (ty < 0 || ty >= t.h) continue;
      const syy = sy + Math.floor(j * sh / Math.abs(dh)); if (syy < 0 || syy >= s.h) continue;
      for (let i = 0; i < Math.abs(dw); i++) {
        const tx = dx + (dw < 0 ? -i : i); if (tx < 0 || tx >= t.w) continue;
        const sxx = sx + Math.floor(i * sw / Math.abs(dw)); if (sxx < 0 || sxx >= s.w) continue;
        t.px[ty * t.w + tx] = op(pick(sxx, syy), t.px[ty * t.w + tx]);
      }
    }
    t.done(); return 1;
  };
  const gdi32 = {
    ChoosePixelFormat: ['pp', () => 1], SetPixelFormat: ['pip', () => 1],
    DescribePixelFormat: ['piup', () => 1],
    // The frame: presented at most sixty times a second of the guest's clock, as a vsynced swap, and
    // not before the page has taken the last one (backend.swapReady: one frame in flight).
    SwapBuffers: ['p', (x) => {
      const now = x.lx.mono();
      if (now < st.lastSwap + 1 / 60) return x.waitUntil(st.lastSwap + 1 / 60);
      if (x.backend.swapReady && !x.backend.swapReady()) return x.waitUntil(now + 0.002);
      st.lastSwap = now; if (wm.framed()) wm.present(x.lx, null);       // the desktop and frame round WebGL's picture
      x.backend.swap(); return 1;
    }],
    // Fonts and device contexts: what a font names and the DC it is selected into, for D3DXCreateText
    // (st.dcFont) to find its outlines among the fonts the page handed over.
    // Stock objects: WHITE_BRUSH 0 to BLACK_BRUSH 4, NULL_BRUSH 5, the pens 6-8, the fonts 10-17, each its handle.
    GetStockObject: ['i', (x, i) => 0x01900010 + (i & 31)], DeleteObject: ['p', (x, h) => { st.gdi.delete(h); return 1; }],
    SelectObject: ['pp', (x, hdc, obj) => {
      const o = st.gdi.get(obj);
      if (o && o.kind === 'bitmap') { const prev = st.dcBitmaps.get(hdc) || 0x0185000f; st.dcBitmaps.set(hdc, obj); return prev; }   // DEFAULT_BITMAP's
      if ((o && o.kind === 'brush') || (!o && obj >= 0x01a00000 && obj < 0x01a00020) || (obj >= 0x01900010 && obj <= 0x01900015)) { const d = dcState(hdc), prev = d.brush || 0x01900010; d.brush = obj; return prev; }
      if ((o && o.kind === 'pen') || (obj >= 0x01900016 && obj <= 0x01900018)) { const d = dcState(hdc), prev = d.pen || 0x01b00017; d.pen = obj; return prev; }
      if (!o || o.kind !== 'font') return 0x01900010;
      const prev = st.dcFonts.get(hdc) || 0x018a0021;                 // the DC's first font: SYSTEM_FONT's
      st.dcFonts.set(hdc, obj); return prev;
    }],
    CreateCompatibleDC: ['p', () => st.newHandle('dc', {})], DeleteDC: ['p', () => 1],
    /*
     * Text into memory bitmaps, as a program draws the letters it then turns into a texture (.kkrieger):
     * a bitmap of 0x00RRGGBB pixels, ExtTextOutA filling the selected font's outlines at pixel centres
     * by the nonzero rule -- GDI's aliased text; Windows' hinting and its own fonts are not here, so the
     * letters are the visitor's font's, unhinted -- and GetDIBits/SetDIBits copying 24- and 32-bit DIBs.
     * Without a font handed over, text measures as half an em a character and draws nothing.
     */
    CreateCompatibleBitmap: ['pii', (x, hdc, w, h) => st.newHandle('bitmap', { w, h, px: new Uint32Array(Math.max(0, w * h)) })],
    SetBkMode: ['pi', (x, hdc, m) => { const d = dcState(hdc), prev = d.bkMode; d.bkMode = m; return prev; }],
    SetBkColor: ['pu', (x, hdc, c) => { const d = dcState(hdc), prev = d.bkColor; d.bkColor = c; return prev; }],
    SetTextColor: ['pu', (x, hdc, c) => { const d = dcState(hdc), prev = d.textColor; d.textColor = c; return prev; }],
    GetTextMetricsA: ['pp', (x, hdc, tm) => {
      const m = textMetrics(hdc);
      x.write(tm, new Uint8Array(56));
      [m.height, m.ascent, m.descent, m.height - m.ppem, 0, m.avg, m.max, m.weight].forEach((v, i) => x.w32(tm + 4 * i, v));
      x.write(tm + 44, Uint8Array.of(32, 255, 31, 32));               // first, last, default, break character
      return 1;
    }],
    // Printing: no job starts here (SP_ERROR); the abort procedure is kept, never called.
    StartDocA: ['pp', () => -1], StartPage: ['p', () => -1], EndPage: ['p', () => -1], EndDoc: ['p', () => -1], AbortDoc: ['p', () => -1], SetAbortProc: ['pp', () => 1],
    // The clip box: the DC's whole surface (no clipping region is kept), SIMPLEREGION; IntersectClipRect likewise.
    GetClipBox: ['pp', (x, hdc, r) => { const t = source(x, hdc), w = t ? t.w : st.w, h = t ? t.h : st.h; x.w32(r, 0); x.w32(r + 4, 0); x.w32(r + 8, w); x.w32(r + 12, h); return 2; }],
    IntersectClipRect: ['piiii', () => 2],
    // GetCharWidthA: each character's advance in the DC's font.
    GetCharWidthA: ['puup', (x, hdc, first, last, out) => {
      const m = textMetrics(hdc);
      for (let c = first; c <= last; c++) x.w32(out + 4 * (c - first), m.font ? m.font.glyph(c & 255, m.ppem).cellIncX : m.avg);
      return 1;
    }],
    GetTextExtentPoint32A: ['ppip', (x, hdc, str, n, size) => {
      const m = textMetrics(hdc);
      let w = 0;
      for (const c of textChars(hdc, x.bytes(str, Math.max(0, n)))) w += m.font ? m.font.glyph(c, m.ppem).cellIncX : m.avg;
      x.w32(size, w); x.w32(size + 4, m.height); return 1;
    }],
    ExtTextOutA: ['piiuppip', (x, hdc, X, Y, opts, rect, str, n) => {
      const bm = st.gdi.get(st.dcBitmaps.get(hdc)), d = dcState(hdc), m = textMetrics(hdc);
      if (!bm || bm.kind !== 'bitmap') return 1;
      if (bm.dib) dibCopy(x, bm, 0, bm.h, bm.dib.bits, bm.dib.bmi, true);   // a DIB section: its pixels are the program's memory
      if (bm.load) bm.load(x);                                          // a DirectDraw surface's DC
      const r = textOut(x, bm, d, m, X, Y, opts, rect, str, n, hdc);
      if (bm.dib) dibCopy(x, bm, 0, bm.h, bm.dib.bits, bm.dib.bmi, false);
      if (bm.store) bm.store(x);
      return r;
    }],
    TextOutA: ['piipi', (x, hdc, X, Y, str, n) => gdi32.ExtTextOutA[1](x, hdc, X, Y, 0, 0, str, n)],
    /*
     * CreateDIBSection: a bitmap whose pixels are in the program's memory, where it reads the text drawn
     * into it (Polystreptikum's letters, made a texture). 24 and 32 bits; the drawing goes through the
     * bitmap's own pixels, loaded from that memory before and stored back after.
     */
    CreateDIBSection: ['ppuppu', (x, hdc, bmi, usage, ppBits) => {
      const w = x.r32(bmi + 4) | 0, h = x.r32(bmi + 8) | 0, bpp = x.r16(bmi + 14);
      // 8 bits: indices into the section's own colour table, read from the program's memory when the
      // section is drawn (WinQuake's frame, through SciTech MGL). DIB_RGB_COLORS gives the table as
      // RGBQUADs; DIB_PAL_COLORS as indices into the palette selected in the DC.
      if (w > 0 && h && bpp === 8) {
        const stride = (w + 3) & ~3, bits = x.win.heapAlloc(stride * Math.abs(h)), n = x.r32(bmi + 32) || 256, colors = new Uint32Array(256);
        x.write(bits, new Uint8Array(stride * Math.abs(h)));
        const pal = st.gdi.get(dcState(hdc).palette);
        for (let i = 0; i < Math.min(n, 256); i++) {
          if (usage === 1) colors[i] = pal ? pal.colors[x.r16(bmi + 40 + 2 * i) & 255] : 0;
          else { const q = x.r32(bmi + 40 + 4 * i); colors[i] = q & 0xffffff; }
        }
        if (ppBits) x.w32(ppBits, bits);
        return st.newHandle('bitmap', { w, h: Math.abs(h), up: h > 0, px: null, dib8: { bits, stride }, colors });
      }
      if (w <= 0 || !h || (bpp !== 24 && bpp !== 32)) { if (ppBits) x.w32(ppBits, 0); return 0; }
      const stride = ((w * bpp + 31) >> 5) << 2, bits = x.win.heapAlloc(stride * Math.abs(h)), copy = x.win.heapAlloc(40);
      x.write(bits, new Uint8Array(stride * Math.abs(h)));
      x.write(copy, x.bytes(bmi, 40));
      if (ppBits) x.w32(ppBits, bits);
      return st.newHandle('bitmap', { w, h: Math.abs(h), px: new Uint32Array(w * Math.abs(h)), dib: { bits, bmi: copy } });
    }],
    GetDIBits: ['ppuuppu', (x, hdc, hbm, start, lines, bits, bmi) => {
      const bm = st.gdi.get(hbm);
      if (!bm || bm.kind !== 'bitmap') return 0;
      if (bm.dib) dibCopy(x, bm, 0, bm.h, bm.dib.bits, bm.dib.bmi, true);
      if (!bits) { x.w32(bmi + 4, bm.w); x.w32(bmi + 8, bm.h); x.w16(bmi + 12, 1); x.w16(bmi + 14, 32); x.w32(bmi + 16, 0); x.w32(bmi + 20, bm.w * bm.h * 4); return bm.h; }
      return dibCopy(x, bm, start, lines, bits, bmi, false);
    }],
    SetDIBits: ['ppuuppu', (x, hdc, hbm, start, lines, bits, bmi) => {
      const bm = st.gdi.get(hbm);
      return bm && bm.kind === 'bitmap' ? dibCopy(x, bm, start, lines, bits, bmi, true) : 0;
    }],
    // The colour table of the 8-bit section selected in a DC: RGBQUADs, as many as asked.
    SetDIBColorTable: ['puup', (x, hdc, start, n, q) => {
      const bm = st.gdi.get(st.dcBitmaps.get(hdc));
      if (!bm || !bm.colors) return 0;
      const k = Math.max(0, Math.min(n, 256 - start)); for (let i = 0; i < k; i++) bm.colors[start + i] = x.r32(q + 4 * i) & 0xffffff;
      return k;
    }],
    GetDIBColorTable: ['puup', (x, hdc, start, n, q) => {
      const bm = st.gdi.get(st.dcBitmaps.get(hdc));
      if (!bm || !bm.colors) return 0;
      const k = Math.max(0, Math.min(n, 256 - start)); for (let i = 0; i < k; i++) x.w32(q + 4 * i, bm.colors[start + i]);
      return k;
    }],
    /*
     * The screen: 32 bits a pixel, no palette (RC_PALETTE clear), as XP's desktop at its default -- so a
     * program draws through DIB sections and GDI converts, the way WinQuake's -dibonly windows do.
     */
    GetDeviceCaps: ['pi', (x, hdc, i) => ({ 8: st.w, 10: st.h, 12: 32, 14: 1, 24: -1, 38: 0x7e99, 88: 96, 90: 96, 104: 0, 106: 0, 108: 0, 116: 60, 117: st.w, 118: st.h })[i] ?? 0],
    CreateDCA: ['pppp', () => st.hdc],
    Escape: ['piipp', () => 0], SetStretchBltMode: ['pi', () => 1],
    // Palettes: LOGPALETTE's entries kept as 0x00RRGGBB; on a screen without one, realizing maps nothing.
    CreatePalette: ['p', (x, lp) => {
      const n = x.r16(lp + 2), colors = new Uint32Array(256);
      for (let i = 0; i < Math.min(n, 256); i++) { const e = x.r32(lp + 4 + 4 * i); colors[i] = ((e & 255) << 16) | (e & 0xff00) | ((e >> 16) & 255); }
      return st.newHandle('palette', { colors });
    }],
    SelectPalette: ['ppi', (x, hdc, hpal) => { const d = dcState(hdc), prev = d.palette || 0x0188000b; d.palette = hpal; return prev; }],   // DEFAULT_PALETTE's
    RealizePalette: ['p', () => 0], UnrealizeObject: ['p', () => 1],
    AnimatePalette: ['puup', (x, hpal, start, n, pe) => {
      const p = st.gdi.get(hpal); if (!p || p.kind !== 'palette') return 0;
      for (let i = 0; i < n && start + i < 256; i++) { const e = x.r32(pe + 4 * i); p.colors[start + i] = ((e & 255) << 16) | (e & 0xff00) | ((e >> 16) & 255); }
      return 1;
    }],
    GetSystemPaletteEntries: ['puup', () => 0],                       // no palette on this screen
    // A palette's entries read and changed (PALETTEENTRY: red, green, blue, flags), and its size changed;
    // the entries a palette has: 256 here, whatever LOGPALETTE asked (Pinball's grows and fills it).
    GetPaletteEntries: ['puup', (x, hpal, start, n, pe) => {
      const p = st.gdi.get(hpal); if (!p || p.kind !== 'palette') return 0;
      if (!pe) return p.size || 256;
      let k = 0; for (; k < n && start + k < 256; k++) { const c = p.colors[start + k]; x.w32(pe + 4 * k, ((c >> 16) & 255) | (c & 0xff00) | ((c & 255) << 16)); }
      return k;
    }],
    SetPaletteEntries: ['puup', (x, hpal, start, n, pe) => (gdi32.AnimatePalette[1](x, hpal, start, n, pe) ? Math.min(n, 256 - start) : 0)],
    ResizePalette: ['pu', (x, hpal, n) => { const p = st.gdi.get(hpal); if (!p || p.kind !== 'palette') return 0; p.size = Math.min(256, n); return 1; }],
    SetSystemPaletteUse: ['pu', () => 1], GetSystemPaletteUse: ['p', () => 1],   // SYSPAL_STATIC
    // Raster copies: SRCCOPY between DCs (a section selected in a memory DC, the window's own), the
    // stretch by nearest pixels; into the window they reach the screen (lx.fbShow). PatBlt fills
    // BLACKNESS and WHITENESS; other operations copy (WinQuake asks SRCCOPY only).
    // A pixel: COLORREF (0x00BBGGRR) out and in, CLR_INVALID outside the DC. SetPixel returns the colour set.
    GetPixel: ['pii', (x, hdc, X, Y) => { const s = source(x, hdc); if (!s || X < 0 || Y < 0 || X >= s.w || Y >= s.h) return 0xffffffff; const c = s.at(X, Y); return ((c & 255) << 16 | (c & 0xff00) | (c >> 16 & 255)) >>> 0; }],
    SetPixel: ['piiu', (x, hdc, X, Y, cr) => {
      const t = target(x, hdc); if (!t || X < 0 || Y < 0 || X >= t.w || Y >= t.h) return 0xffffffff;
      t.px[Y * t.w + X] = (cr & 255) << 16 | (cr & 0xff00) | (cr >> 16 & 255); t.done(); return cr & 0xffffff;
    }],
    BitBlt: ['piiiipiiu', (x, dst, dx, dy, w, h, src, sx, sy, rop) => blit(x, dst, dx, dy, w, h, src, sx, sy, w, h, rop)],
    StretchBlt: ['piiiipiiiiu', (x, dst, dx, dy, dw, dh, src, sx, sy, sw, sh, rop) => blit(x, dst, dx, dy, dw, dh, src, sx, sy, sw, sh, rop)],
    // PatBlt: BLACKNESS, WHITENESS; PATCOPY (F00021h) the DC's brush -- FreeCell's cells, filled green before
    // their edges are drawn; PATINVERT (5A0049h) the brush XORed in; DSTINVERT (550009h) the pixels inverted.
    PatBlt: ['piiiiu', (x, hdc, X, Y, w, h, rop) => {
      const brush = () => brushColor(dcState(hdc).brush ?? 0x01900010);
      const c = rop === 0x42 ? 0 : rop === 0xff0062 ? 0xffffff : rop === 0xf00021 ? brush() : null;
      if (w < 0) { X += w; w = -w; } if (h < 0) { Y += h; h = -h; }
      const t = (c !== null || rop === 0x5a0049 || rop === 0x550009) && target(x, hdc); if (!t) return 1;
      if (c !== null) fillRect(t, X, Y, X + w, Y + h, c);
      else {
        const k = rop === 0x550009 ? 0xffffff : brush() ?? 0;
        for (let j = Math.max(0, Y); j < Math.min(t.h, Y + h); j++) for (let i = Math.max(0, X); i < Math.min(t.w, X + w); i++) t.px[j * t.w + i] ^= k;
      }
      t.done(); return 1;
    }],
    CreateFontA: ['iiiiiuuuuuuuup', (x, h, w, esc, orient, weight, italic, underline, strike, charset, outPrec, clipPrec, quality, pitch, face) =>
      st.newHandle('font', { height: h, weight, charset: charset & 255, pitch: pitch & 255, face: x.str(face, 32) })],
    // LOGFONTA: lfHeight at 0, lfWeight at 16, lfCharSet at 23, lfFaceName at 28.
    CreateFontIndirectA: ['p', (x, p) => st.newHandle('font', { height: x.r32(p) | 0, weight: x.r32(p + 16), charset: x.r8(p + 23), pitch: x.r8(p + 27), face: x.str(p + 28, 32) })],
  };
  // ---- opengl32 and glu32: src/hle/gl.js's GL, stdcall; wgl ------------------------------------------
  const opengl32 = { ...(gl || glTable().fns) };
  delete opengl32.glXGetProcAddress; delete opengl32.glXGetProcAddressARB;
  Object.assign(opengl32, {
    wglCreateContext: ['p', () => st.hglrc],
    // The GL surface takes the window's size when a context is made current, and again whenever that size
    // changed: Quake II re-creates its window and context at a new video mode (800x600 from its menu).
    wglMakeCurrent: ['pp', (x, hdc, ctx) => {
      if (ctx && (!st.mode || st.glW !== st.w || st.glH !== st.h)) { st.mode = true; st.glW = st.w; st.glH = st.h; x.backend.setVideoMode(st.w, st.h, true); }
      return 1;
    }],
    wglDeleteContext: ['p', () => 1],
    wglGetCurrentDC: ['', () => (st.mode ? st.hdc : 0)], wglGetCurrentContext: ['', () => (st.mode ? st.hglrc : 0)],   // after wglMakeCurrent
    wglGetProcAddress: ['p', (x, name) => x.win.proc(x.win.modules.get('opengl32.dll'), x.str(name))],
    wglUseFontBitmapsA: ['puuu', () => 1],
    wglSwapLayerBuffers: ['pu', (x) => gdi32.SwapBuffers[1](x)],
    wglSwapBuffers: ['p', (x) => gdi32.SwapBuffers[1](x)],              // opengl32's own name for it (Quake II's ref_gl asks it by GetProcAddress)
  });
  const glu32 = { ...(glu || gluTable().fns) };
  // ---- winmm -----------------------------------------------------------------------------------------
  // ---- winmm: the clock, and waveOut -------------------------------------------------------------------
  /*
   * waveOut plays the buffers a program writes, from guest memory as the play position reaches them:
   * a 4K intro writes one buffer as long as its song and has a thread fill it while it plays, so the
   * bytes are read when they are heard, not when written. The position is the guest's clock since the
   * first write, at the format's rate, never past what was written; the mixer (src/audio.js) pulls
   * the samples through the card's place (lx.setSoundSource). Valleyball times its pictures by
   * waveOutGetPosition. A header flagged WHDR_BEGINLOOP and WHDR_ENDLOOP plays dwLoops times over
   * (cdak, 2010: a 32 KiB ring its thread refills, looped 0xFFFFFFFF times), and the position goes on
   * counting through the loops, as Wine's winmm.
   */
  const wave = { fmt: null, queue: [], total: 0, consumed: 0, t0: null, x: null };
  const bps = () => wave.fmt.rate * wave.fmt.align;
  const played = (now) => (wave.t0 === null ? 0 : Math.min(wave.total, Math.floor((now - wave.t0) * wave.fmt.rate) * wave.fmt.align));
  const retire = (x, upTo) => {                                         // headers played to their end: WHDR_DONE
    while (wave.queue.length && wave.queue[0].end <= upTo) {
      const h = wave.queue.shift();
      if (h.hdr) x.w32(h.hdr + 16, (x.r32(h.hdr + 16) | 1) & ~0x10);
    }
  };
  const drain = () => {
    const x = wave.x;
    if (!x || !wave.fmt) return { rate: 44100, samples: [] };
    const now = played(x.lx.mono()), samples = [], f = wave.fmt;
    let pos = Math.max(wave.consumed, now - bps());                    // a second at most, should nobody listen
    for (const h of wave.queue) {
      if (h.end <= pos) continue;
      if (h.start >= now) break;
      const a = Math.max(pos, h.start), b = Math.min(now, h.end), bytes = new Uint8Array(b - a);
      for (let o = a; o < b;) {                                         // a looped header: its bytes again and again
        const at = (o - h.start) % h.len, n = Math.min(b - o, h.len - at);
        bytes.set(x.bytes(h.ptr + at, n), o - a); o += n;
      }
      const dv = new DataView(bytes.buffer), step = f.align;
      for (let o = 0; o + step <= bytes.length; o += step) {
        const at = (c) => (f.tag === 3 ? Math.round(Math.max(-1, Math.min(1, dv.getFloat32(o + c * 4, true))) * 32767)
          : f.bits === 16 ? dv.getInt16(o + c * 2, true) : (bytes[o + c] - 128) << 8);
        const l = at(0); samples.push(l, f.ch > 1 ? at(1) : l);
      }
      pos = b;
    }
    wave.consumed = now;
    retire(x, now);
    return { rate: f.rate, samples };
  };
  /*
   * sndPlaySoundA / PlaySoundA with SND_MEMORY: a whole RIFF WAVE in guest memory, played from its
   * data chunk through waveOut's queue (no header of the program's to mark done). Stiletto (RGBA, 2010)
   * renders its song into one and starts it so; SND_LOOP plays it over and over. A file name, or no
   * sound (NULL stops), is silence: there are no sound files here.
   */
  const playMemory = (x, p, flags) => {
    if (!p || !(flags & 4)) { if (!p) { wave.queue = []; wave.total = wave.consumed = 0; wave.t0 = null; } return 0; }   // SND_MEMORY
    if (x.r32(p) !== 0x46464952 || x.r32(p + 8) !== 0x45564157) return 0;                      // 'RIFF' .. 'WAVE'
    const end = p + 8 + x.r32(p + 4);
    let fmt = null;
    for (let c = p + 12; c + 8 <= end; c += 8 + ((x.r32(c + 4) + 1) & ~1)) {
      const id = x.r32(c), len = x.r32(c + 4);
      if (id === 0x20746d66) { const tag = x.r16(c + 8), ch = x.r16(c + 10), rate = x.r32(c + 12), align = x.r16(c + 20), bits = x.r16(c + 22); fmt = { tag, ch, rate, bits, align: align || ch * bits / 8 }; }   // 'fmt '
      else if (id === 0x61746164 && fmt) {                                                    // 'data'
        if (!(fmt.tag === 1 && (fmt.bits === 8 || fmt.bits === 16)) && !(fmt.tag === 3 && fmt.bits === 32) || fmt.ch < 1 || fmt.ch > 2) return 0;
        const loops = flags & 8 ? 0xffffffff : 1;                                             // SND_LOOP
        Object.assign(wave, { fmt, queue: [{ hdr: 0, ptr: c + 8, len, start: 0, end: len * loops }], total: len * loops, consumed: 0, t0: x.lx.mono(), x });
        x.lx.setSoundSource(drain);
        return 1;
      }
    }
    return 0;
  };
  /*
   * MCI's videos (mciSendStringA in src/win32/classic.js, mciSendCommandA below): an AVI on the program's
   * disk (src/win32/avi.js: 8-bit, uncompressed or RLE8, PCM sound), played on the guest's clock -- each
   * GetMessage and PeekMessage takes it to the frame now due and draws that into its window (the one given
   * as its parent, or "window ... handle"), at the client area's corner; its sound through PlaySound's
   * player. At its end, or stopped, MM_MCINOTIFY (3B9h) goes to the window that asked to be told:
   * MCI_NOTIFY_SUCCESSFUL (1) at the end, MCI_NOTIFY_ABORTED (4) when stopped. A file in another codec plays
   * as nothing, at once (said in the log).
   */
  const videos = new Map(); let videoNext = 0x100;
  st.video = {
    has: (id) => videos.has(id),
    open: (x, file, parent) => {
      const f = diskFile(file); if (!f || !f.bytes) return 0;
      const avi = parseAvi(f.bytes.subarray(0, f.size));
      if (!avi) x.win.say(`MCI: ${file}: not a video this player draws (8-bit, uncompressed or RLE8)`);
      const id = ++videoNext;
      videos.set(id, { avi, parent: parent || st.hwnd, idx: avi ? new Uint8Array(avi.w * avi.h) : null, pal: avi ? avi.palette.slice() : null, at: 0, t0: 0, playing: false, notify: 0 });
      return id;
    },
    window: (id, h) => { const v = videos.get(id); if (v && h) v.parent = h; },
    dest: (id, r) => { const v = videos.get(id); if (v && r.length === 4 && r.every((n) => Number.isFinite(n))) v.dest = r; },
    breakKey: (id, vk) => { const v = videos.get(id); if (v) v.breakKey = vk; },
    broken: (id) => { const v = videos.get(id); return !!(v && v.breakKey && st.keys.has(v.breakKey)); },
    waiting: (id) => !!(videos.get(id) || {}).waiting,
    waited: (id) => { const v = videos.get(id); if (v) v.waiting = false; },
    tick: (x) => videoTick(x),
    playing: (id) => !!(videos.get(id) || {}).playing,
    size: (id) => { const v = videos.get(id); return v && v.avi ? [v.avi.w, v.avi.h] : [0, 0]; },
    play: (x, id, notify, wait = false) => {
      const v = videos.get(id); if (!v) return;
      v.notify = notify; v.playing = true; v.waiting = wait; v.t0 = x.lx.mono() - (v.at * (v.avi ? v.avi.usPerFrame : 0)) / 1e6;
      if (!v.avi) { endVideo(x, id, 1); return; }
      const a = v.avi.audio;
      if (a) {                                            // its sound: a RIFF WAVE of it in memory, through PlaySound's player
        const n = a.data.length, al = a.ch * a.bits / 8;
        if (!v.wave) {
          const p = v.wave = x.win.heapAlloc(44 + n);
          x.write(p, new TextEncoder().encode('RIFF')); x.w32(p + 4, 36 + n); x.write(p + 8, new TextEncoder().encode('WAVEfmt '));
          x.w32(p + 16, 16); x.w16(p + 20, 1); x.w16(p + 22, a.ch); x.w32(p + 24, a.rate); x.w32(p + 28, a.rate * al); x.w16(p + 32, al); x.w16(p + 34, a.bits);
          x.write(p + 36, new TextEncoder().encode('data')); x.w32(p + 40, n); x.write(p + 44, a.data);
        }
        playMemory(x, v.wave, 5);                         // SND_ASYNC | SND_MEMORY
      }
      videoTick(x);
    },
    stop: (x, id) => { const v = videos.get(id); if (v && v.playing) endVideo(x, id, 4); },
    close: (x, id) => { const v = videos.get(id); if (!v) return; if (v.playing) endVideo(x, id, 4); videos.delete(id); },
  };
  const endVideo = (x, id, code) => {
    const v = videos.get(id); if (!v) return;
    v.playing = false; if (v.avi && v.avi.audio) playMemory(x, 0, 0);
    if (v.notify) st.msgs.push({ msg: 0x3b9, wp: code, lp: id, ...(v.notify !== st.hwnd ? { hwnd: v.notify } : {}) });
    v.notify = 0;
  };
  /** The playing videos taken to the frame now due, the last one drawn; the time the next is due. */
  const videoTick = (x) => {
    let next = Infinity;
    for (const [id, v] of videos) {
      if (!v.playing || !v.avi) continue;
      const a = v.avi, due = Math.min(a.frames.length, Math.floor((x.lx.mono() - v.t0) * 1e6 / a.usPerFrame) + 1);
      if (due <= v.at) { next = Math.min(next, v.t0 + v.at * a.usPerFrame / 1e6); continue; }
      while (v.at < due) decodeFrame(a.frames[v.at++], v.idx, a.w, a.h, v.pal);
      // At its destination ("put ... destination at x y w h"), scaled to it; else at the corner, its own size.
      const t = target(x, dcFor(v.parent === st.hwnd ? 0 : v.parent));
      if (t) {
        const [dx, dy, dw, dh] = v.dest || [0, 0, a.w, a.h];
        for (let j = 0; j < dh; j++) {
          const Y = dy + j, sy = Math.floor(j * a.h / dh); if (Y < 0 || Y >= t.h) continue;
          for (let i = 0; i < dw; i++) { const X = dx + i; if (X >= 0 && X < t.w) t.px[Y * t.w + X] = v.pal[v.idx[sy * a.w + Math.floor(i * a.w / dw)]]; }
        }
        t.done();
      }
      if (v.at >= a.frames.length) endVideo(x, id, 1);
      else next = Math.min(next, v.t0 + v.at * a.usPerFrame / 1e6);
    }
    return next;
  };
  st.videoTick = videoTick;
  /*
   * mmio: RIFF files read chunk by chunk (Pinball's sounds). A file of the program's disk, its position kept;
   * MMCKINFO is ckid, cksize, fccType, dwDataOffset, dwFlags. mmioDescend finds a chunk (MMIO_FINDCHUNK 10h
   * by its id, MMIO_FINDRIFF 20h / MMIO_FINDLIST 40h by its form type) within its parent, or the next one;
   * mmioAscend goes past the chunk's end (and its pad byte).
   */
  const mmios = new Map(); let mmioNext = 0x6100;
  const mmio = {
    // The buffered side of mmio (MMIOINFO's own buffer): not here -- no buffer is given (cchBuffer 0), so a
    // program reads with mmioRead; advancing one fails (MMIOERR_CANNOTEXPAND).
    mmioGetInfo: ['ppu', (x, h, info) => { if (!mmios.has(h)) return 5; x.write(info, new Uint8Array(72)); x.w32(info + 68, h); return 0; }],
    mmioSetInfo: ['ppu', () => 0], mmioAdvance: ['ppu', () => 0x108],
    mmioOpenA: ['ppu', (x, pName, info, flags) => {
      if (flags & 0x1003) return 0;                                   // MMIO_WRITE, MMIO_READWRITE, MMIO_CREATE: no
      const f = pName && diskFile(x.str(pName)); if (!f || !f.bytes) { if (info) x.w32(info + 12, 257); return 0; }   // MMIOERR_FILENOTFOUND
      mmios.set(++mmioNext, { f, pos: 0 }); return mmioNext;
    }],
    mmioClose: ['pu', (x, h) => (mmios.delete(h) ? 0 : 5)],
    mmioRead: ['ppi', (x, h, buf, n) => {
      const m = mmios.get(h); if (!m) return -1;
      const k = Math.max(0, Math.min(n, m.f.size - m.pos)); x.write(buf, m.f.bytes.subarray(m.pos, m.pos + k)); m.pos += k; return k;
    }],
    mmioSeek: ['pii', (x, h, off, origin) => { const m = mmios.get(h); if (!m) return -1; m.pos = Math.max(0, (origin === 1 ? m.pos : origin === 2 ? m.f.size : 0) + off); return m.pos; }],
    mmioDescend: ['pppu', (x, h, ck, parent, flags) => {
      const m = mmios.get(h); if (!m) return 5;
      const b = m.f.bytes, end = parent ? x.r32(parent + 12) + x.r32(parent + 4) : m.f.size, u32 = (o) => (b[o] | b[o + 1] << 8 | b[o + 2] << 16 | b[o + 3] << 24) >>> 0;
      const want = x.r32(ck), wantType = x.r32(ck + 8);
      for (let at = m.pos; at + 8 <= end; at += 8 + ((u32(at + 4) + 1) & ~1)) {
        const id = u32(at), size = u32(at + 4), list = id === 0x46464952 || id === 0x5453494c;   // 'RIFF', 'LIST'
        const type = list ? u32(at + 8) : 0;
        const ok = flags & 0x20 ? id === 0x46464952 && type === wantType : flags & 0x40 ? id === 0x5453494c && type === wantType : flags & 0x10 ? id === want : true;
        if (!ok) continue;
        x.w32(ck, id); x.w32(ck + 4, size); x.w32(ck + 8, type); x.w32(ck + 12, at + 8); x.w32(ck + 16, 0);
        m.pos = at + 8 + (list ? 4 : 0); return 0;
      }
      return 0x101;                                                   // MMIOERR_CHUNKNOTFOUND
    }],
    mmioAscend: ['ppu', (x, h, ck) => { const m = mmios.get(h); if (!m) return 5; m.pos = x.r32(ck + 12) + ((x.r32(ck + 4) + 1) & ~1); return 0; }],
  };
  const winmm = {
    ...mmio,
    // No joystick: none counted, and the one asked about is unplugged (JOYERR_UNPLUGGED).
    joyGetNumDevs: ['', () => 0], joyGetDevCapsA: ['upu', () => 167], joyGetPosEx: ['up', () => 167], joyGetPos: ['up', () => 167],
    timeGetTime: ['', (x) => ms(x)], timeBeginPeriod: ['u', () => 0], timeEndPeriod: ['u', () => 0],
    // TIMECAPS: periods from 1 ms to a million.
    timeGetDevCaps: ['pu', (x, p, n) => { if (!p || n < 8) return 97; x.w32(p, 1); x.w32(p + 4, 1000000); return 0; }],
    /*
     * timeSetEvent(delay, resolution, callback, user, flags): a multimedia timer, as winmm runs it -- a
     * thread of its own that sleeps the delay and calls the program's TimeProc(id, 0, user, 0, 0), once or
     * (TIME_PERIODIC) until timeKillEvent; with TIME_CALLBACK_EVENT_SET (10h) it sets that event instead.
     * The thread is guest code made here, so the callback runs as any thread of the program, in turn with
     * the others. Jazz Jackrabbit 2 mixes its sound so, a buffer of waveOut's at each tick.
     */
    timeSetEvent: ['uupuu', (x, delay, res, cb, user, flags) => {
      const k32 = x.win.modules.get('kernel32.dll').exports, id = (st.mmTimers = (st.mmTimers | 0) + 1);
      const data = x.win.heapAlloc(12), code = x.win.heapAlloc(96), b = [];
      x.w32(data, 0); x.w32(data + 4, k32.get('Sleep')); x.w32(data + 8, k32.get('SetEvent'));
      const d32 = (v) => b.push(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255);
      const killed = () => { b.push(0x83, 0x3d); d32(data); b.push(0x00, 0x0f, 0x85); const at = b.length; d32(0); return at; };   // cmp [data],0; jne end
      const ends = [killed()];
      b.push(0x68); d32(Math.max(1, delay)); b.push(0xff, 0x15); d32(data + 4);                // Sleep(delay)
      ends.push(killed());
      if (flags & 0x30) { b.push(0x68); d32(cb); b.push(0xff, 0x15); d32(data + 8); }          // SetEvent(event)
      else { b.push(0x6a, 0, 0x6a, 0, 0x68); d32(user); b.push(0x6a, 0, 0x68); d32(id); b.push(0xb8); d32(cb); b.push(0xff, 0xd0); }
      if (flags & 1) { b.push(0xe9); d32(-(b.length + 4)); }                                     // TIME_PERIODIC: again
      const end = b.length; b.push(0xc3);
      for (const at of ends) { const r = end - (at + 4); b.splice(at, 4, r & 255, (r >>> 8) & 255, (r >>> 16) & 255, (r >>> 24) & 255); }
      x.write(code, Uint8Array.from(b));
      (st.mmTimer ||= new Map()).set(id, data);
      x.win.createThread(code, 0);
      return id;
    }],
    timeKillEvent: ['u', (x, id) => { const d = st.mmTimer && st.mmTimer.get(id); if (!d) return 97; x.w32(d, 1); st.mmTimer.delete(id); return 0; }],   // TIMERR_NOCANDO
    // midiOut: one device, MIRAGE's General MIDI synthesizer (src/midi.js), as Windows' MIDI mapper
    // sends to its GS synthesizer. Photon Race 2 (2008) plays its music so: short messages, no SysEx.
    midiOutGetNumDevs: ['', () => 1],
    midiOutGetDevCapsA: ['upu', (x, dev, caps, size) => {              // MIDIOUTCAPSA: MOD_SWSYNTH, 32 voices, 16 channels
      if (!caps || size < 52) return 11;                               // MMSYSERR_INVALPARAM
      x.write(caps, new Uint8Array(52)); x.w16(caps, 1); x.w16(caps + 2, 1); x.w32(caps + 4, 0x0100);
      x.write(caps + 8, new TextEncoder().encode('MIRAGE General MIDI\0'));
      x.w16(caps + 40, 7); x.w16(caps + 42, 32); x.w16(caps + 44, 32); x.w16(caps + 46, 0xffff); x.w32(caps + 48, 1);
      return 0;
    }],
    midiOutOpen: ['ppppu', (x, ph, dev, cb, inst, flags) => { x.lx.midi(); if (ph) x.w32(ph, 0x6001); return 0; }],
    midiOutShortMsg: ['pu', (x, h, msg) => { x.lx.midi().short(msg); return 0; }],
    midiOutLongMsg: ['ppu', (x, h, hdr) => { x.w32(hdr + 16, x.r32(hdr + 16) | 1); return 0; }],      // SysEx: WHDR_DONE, nothing played
    midiOutPrepareHeader: ['ppu', (x, h, hdr) => { x.w32(hdr + 16, x.r32(hdr + 16) | 2); return 0; }],
    midiOutUnprepareHeader: ['ppu', (x, h, hdr) => { x.w32(hdr + 16, x.r32(hdr + 16) & ~2); return 0; }],
    midiOutReset: ['p', (x) => { x.lx.midi().reset(); return 0; }],
    midiOutClose: ['p', (x) => { x.lx.midi().reset(); return 0; }],
    midiOutSetVolume: ['pu', () => 0], midiOutGetVolume: ['pp', (x, h, p) => { if (p) x.w32(p, 0xffffffff); return 0; }],
    /*
     * MCI: the "sequencer" device only, a Standard MIDI File played through the General MIDI synthesizer
     * (src/midi.js parseSMF, machine.midi.play). Photon Race 2 opens its .mid (MCI_OPEN with
     * MCI_OPEN_ELEMENT | MCI_OPEN_TYPE), then MCI_PLAY. Other devices (waveaudio, cdaudio): no such device.
     */
    mciSendCommandA: ['uuup', (x, dev, msg, flags, parms) => {
      if (msg === 0x803) {                                             // MCI_OPEN
        const type = flags & 0x2000 && !(flags & 0x1000) ? x.str(x.r32(parms + 8)).toLowerCase() : '';
        const elem = flags & 0x200 ? x.str(x.r32(parms + 12)) : '';
        if (type && type !== 'sequencer') return 263;                 // MCIERR_INVALID_DEVICE_NAME
        if (!type && !/\.(mid|midi|rmi)$/i.test(elem)) return 263;
        const f = elem && diskFile(elem);
        if (!f || !f.bytes) return 275;                               // MCIERR_FILE_NOT_FOUND
        let ev;
        try { ev = parseSMF(f.bytes.subarray(0, f.size)); } catch { return 0x116; }   // MCIERR_INVALID_FILE
        st.mci.set(st.mciNext, ev);
        x.w32(parms + 4, st.mciNext++);
        return 0;
      }
      // A video opened by mciSendStringA (src/win32/classic.js): played at once to its end -- MCI_PLAY with
      // MCI_NOTIFY (1) posts MM_MCINOTIFY, MCI_NOTIFY_SUCCESSFUL, to the window in its parameters' first
      // field; its other commands (window, put, where, stop, close) do nothing.
      if (st.video.has(dev)) {
        if (msg === 0x806) st.video.play(x, dev, flags & 1 && parms ? x.r32(parms) : 0);   // MCI_PLAY, MCI_NOTIFY's window first in its parameters
        else if (msg === 0x808 || msg === 0x809) st.video.stop(x, dev);                    // MCI_STOP, MCI_PAUSE
        else if (msg === 0x804) st.video.close(x, dev);                                     // MCI_CLOSE
        else if (msg === 0x841 && flags & 0x10000 && parms) st.video.window(dev, x.r32(parms + 4));   // MCI_WINDOW, MCI_DGV_WINDOW_HWND
        return 0;
      }
      const ev = st.mci.get(dev);
      if (!ev) return 257;                                             // MCIERR_INVALID_DEVICE_ID
      if (msg === 0x806) { x.lx.midi().play(ev); st.mciPlaying = dev; return 0; }      // MCI_PLAY
      if (msg === 0x808 || msg === 0x804 || msg === 0x809) {          // MCI_STOP, MCI_CLOSE, MCI_PAUSE
        if (st.mciPlaying === dev) { x.lx.midi().play(null); st.mciPlaying = 0; }
        if (msg === 0x804) st.mci.delete(dev);
        return 0;
      }
      if (msg === 0x814 && parms) {                                    // MCI_STATUS: the mode (MCI_STATUS_MODE) only
        x.w32(parms + 4, x.r32(parms + 8) === 4 ? (st.mciPlaying === dev && x.lx.midi().playing() ? 526 : 525) : 0);
        return 0;
      }
      return 0;
    }],
    sndPlaySoundA: ['pu', (x, p, flags) => playMemory(x, p, flags)],
    PlaySoundA: ['ppu', (x, p, mod, flags) => playMemory(x, p, flags), { ordinal: 2 }],   // winmm's ordinal 2 (Spider imports it so)
    waveOutGetNumDevs: ['', () => 1],
    // WAVEOUTCAPSA: every PCM format of 8 and 16 bits at 11, 22 and 44 kHz (0xfff), stereo, volume control.
    waveOutGetDevCapsA: ['upu', (x, dev, caps, size) => {
      if (!caps || size < 52) return 11;
      x.write(caps, new Uint8Array(52)); x.w16(caps, 1); x.w16(caps + 2, 2); x.w32(caps + 4, 0x0100);
      x.write(caps + 8, new TextEncoder().encode('MIRAGE Wave Out\0')); x.w32(caps + 40, 0xfff); x.w16(caps + 44, 2); x.w32(caps + 48, 4);
      return 0;
    }],
    // WAVEOUTCAPSW: the A one's fields, its name in 32 WCHARs (84 bytes).
    waveOutGetDevCapsW: ['upu', (x, dev, caps, size) => {
      if (!caps || size < 84) return 11;
      const t = x.win.heapAlloc(52);
      try { winmm.waveOutGetDevCapsA[1](x, dev, t, 52); x.write(caps, new Uint8Array(84)); x.write(caps, x.bytes(t, 8));
        const name = x.str(t + 8, 32); for (let i = 0; i < name.length; i++) x.w16(caps + 8 + 2 * i, name.charCodeAt(i));
        x.write(caps + 72, x.bytes(t + 40, 12)); } finally { x.win.heapFree(t); }
      return 0;
    }],
    waveOutGetErrorTextW: ['upu', (x, err, buf, n) => { const t = `MMSYSERR ${err}`; for (let i = 0; i < Math.min(t.length, n - 1); i++) x.w16(buf + 2 * i, t.charCodeAt(i)); if (n > 0) x.w16(buf + 2 * Math.min(t.length, n - 1), 0); return 0; }],
    // MIDI streams (midiStreamOpen, SDL_mixer's): not made here -- MMSYSERR_NOTSUPPORTED (8), and an unknown
    // stream's handle MMSYSERR_INVALHANDLE (5); a program plays its MIDI by midiOutShortMsg, or not at all.
    midiStreamOpen: ['ppuppu', () => 8], midiStreamClose: ['p', () => 5], midiStreamProperty: ['ppu', () => 5], midiStreamOut: ['ppu', () => 5],
    midiStreamPause: ['p', () => 5], midiStreamRestart: ['p', () => 5], midiStreamStop: ['p', () => 5],
    // waveIn: no recording device (MMSYSERR_BADDEVICEID, 2; an unknown handle MMSYSERR_INVALHANDLE, 5).
    waveInGetNumDevs: ['', () => 0], waveInGetDevCapsW: ['upu', () => 2], waveInOpen: ['ppppuu', () => 2],
    waveInClose: ['p', () => 5], waveInPrepareHeader: ['ppu', () => 5], waveInUnprepareHeader: ['ppu', () => 5], waveInAddBuffer: ['ppu', () => 5],
    waveInStart: ['p', () => 5], waveInReset: ['p', () => 5],
    // waveOutOpen(&hwo, device, WAVEFORMATEX*, callback, instance, flags): PCM 8/16 bits or float, 1-2 channels.
    waveOutOpen: ['ppppuu', (x, ph, dev, wfx, cb, inst, flags) => {
      const tag = x.r16(wfx), ch = x.r16(wfx + 2), rate = x.r32(wfx + 4), align = x.r16(wfx + 12), bits = x.r16(wfx + 14);
      if (!(tag === 1 && (bits === 8 || bits === 16)) && !(tag === 3 && bits === 32) || ch < 1 || ch > 2) return 32;   // WAVERR_BADFORMAT
      if (flags & 1) return 0;                                         // WAVE_FORMAT_QUERY
      Object.assign(wave, { fmt: { tag, ch, rate, bits, align: align || ch * bits / 8 }, queue: [], total: 0, consumed: 0, t0: null, x });
      x.lx.setSoundSource(drain);
      if (ph) x.w32(ph, 0x5001);
      return 0;
    }],
    waveOutPrepareHeader: ['ppu', (x, h, hdr) => { x.w32(hdr + 16, x.r32(hdr + 16) | 2); return 0; }],                 // WHDR_PREPARED
    // A header still queued is not let go: WAVERR_STILLPLAYING (as Wine's winmm), which is how a
    // synthesizer's thread waits for its buffer to come back (Retrospection unprepares until it may).
    waveOutUnprepareHeader: ['ppu', (x, h, hdr) => {
      if (wave.fmt) retire(x, played(x.lx.mono()));
      if (x.r32(hdr + 16) & 0x10) return 33;
      x.w32(hdr + 16, x.r32(hdr + 16) & ~2); return 0;
    }],
    waveOutWrite: ['ppu', (x, h, hdr) => {
      const now = x.lx.mono(), ptr = x.r32(hdr), len = x.r32(hdr + 4), flags = x.r32(hdr + 16);
      const loops = (flags & 0xc) === 0xc ? Math.max(1, x.r32(hdr + 20)) : 1;   // WHDR_BEGINLOOP | WHDR_ENDLOOP
      if (wave.t0 === null) wave.t0 = now;
      else if (played(now) >= wave.total) wave.t0 = now - wave.total / bps();   // the queue had run dry: play on from here
      wave.queue.push({ hdr, ptr, len, start: wave.total, end: wave.total + len * loops });
      wave.total += len * loops;
      x.w32(hdr + 16, (x.r32(hdr + 16) | 0x10) & ~1);                 // WHDR_INQUEUE
      return 0;
    }],
    // waveOutGetPosition(hwo, MMTIME*, size): TIME_SAMPLES or TIME_MS when asked, else TIME_BYTES.
    waveOutGetPosition: ['ppu', (x, h, mmt) => {
      if (!wave.fmt) return 5;                                         // MMSYSERR_INVALHANDLE
      const pos = played(x.lx.mono()), type = x.r32(mmt);
      retire(x, pos);
      if (type === 2) x.w32(mmt + 4, pos / wave.fmt.align);
      else if (type === 1) x.w32(mmt + 4, Math.floor(pos / bps() * 1000));
      else { x.w32(mmt, 4); x.w32(mmt + 4, pos); }
      return 0;
    }],
    waveOutReset: ['p', (x) => { retire(x, Infinity); wave.queue = []; wave.total = wave.consumed = played(x.lx.mono()); return 0; }],
    waveOutClose: ['p', () => 0], waveOutSetVolume: ['pu', () => 0], waveOutPause: ['p', () => 0], waveOutRestart: ['p', () => 0],
  };
  // ---- msvcrt: the C runtime (cdecl), what an intro reaches for -------------------------------------
  // The Universal CRT (src/win32/ucrt.js), whose start-up msvcrt's shares.
  const ucrt = ucrtApis({ st, send }), ub = ucrt.find((t) => t.dll === 'ucrtbase.dll').fns;
  let seed = 1;
  const D = (f) => (x, ...a) => ({ st0: f(...a) });                   // a double on the x87 stack
  const CI = (f) => (x) => ({ st0: f(x.fpop()) });                    // _CIxxx: the argument on it too
  const CI2 = (f) => (x) => { const b = x.fpop(), a = x.fpop(); return { st0: f(a, b) }; };   // _CIpow: ST1 ^ ST0
  const ftol = (x) => { const v = Math.trunc(x.fpop()); const lo = Number(BigInt.asIntN(64, BigInt(Number.isFinite(v) ? v : 0)) & 0xffffffffn), hi = Math.floor(v / 4294967296); return { eax: lo, edx: hi }; };
  const cd = { cdecl: true };
  const msvcrt = {
    rand: ['', () => { seed = (Math.imul(seed, 214013) + 2531011) >>> 0; return (seed >>> 16) & 0x7fff; }, cd],
    srand: ['u', (x, s) => { seed = s >>> 0; return 0; }, cd],
    sin: ['d', D(Math.sin), cd], cos: ['d', D(Math.cos), cd], tan: ['d', D(Math.tan), cd], sqrt: ['d', D(Math.sqrt), cd],
    atan: ['d', D(Math.atan), cd], exp: ['d', D(Math.exp), cd], log: ['d', D(Math.log), cd], fabs: ['d', D(Math.abs), cd],
    floor: ['d', D(Math.floor), cd], ceil: ['d', D(Math.ceil), cd], pow: ['dd', D(Math.pow), cd], atan2: ['dd', D(Math.atan2), cd],
    fmod: ['dd', D((a, b) => a % b), cd],
    _CIsin: ['', CI(Math.sin), cd], _CIcos: ['', CI(Math.cos), cd], _CItan: ['', CI(Math.tan), cd], _CIsqrt: ['', CI(Math.sqrt), cd],
    _CIexp: ['', CI(Math.exp), cd], _CIlog: ['', CI(Math.log), cd], _CIatan: ['', CI(Math.atan), cd], _CIpow: ['', CI2(Math.pow), cd],
    _CIatan2: ['', CI2(Math.atan2), cd], _CIfmod: ['', CI2((a, b) => a % b), cd],
    _ftol: ['', ftol, cd], _ftol2: ['', ftol, cd], _ftol2_sse: ['', ftol, cd],
    abs: ['i', (x, v) => Math.abs(v), cd],
    malloc: ['u', (x, n) => x.win.heapAlloc(n), cd], calloc: ['uu', (x, n, k) => { const p = x.win.heapAlloc(n * k); x.write(p, new Uint8Array(n * k)); return p; }, cd], free: ['p', () => 0, cd],
    memset: ['piu', (x, p, v, n) => { x.write(p, new Uint8Array(n).fill(v)); return p; }, cd],
    memcpy: ['ppu', (x, d, s, n) => { x.write(d, x.bytes(s, n)); return d; }, cd],
    strlen: ['p', (x, p) => x.str(p).length, cd],
    time: ['p', (x, p) => { const t = x.lx.now ? x.lx.now() : Math.floor(Date.now() / 1000); if (p) x.w32(p, t); return t; }, cd],
    clock: ['', (x) => ms(x), cd],
    exit: ['i', (x, c) => { x.lx.exit(c); return 0; }, cd],
    /*
     * A Visual C++ 4-6 program's start-up (mainCRTStartup in its own code): its app type, the C
     * initializers (_initterm, through the UCRT's), its arguments (__getmainargs: argc, argv and the
     * environment, as the UCRT keeps them), the floating-point control word, _fmode and _commode; the
     * command line as a variable (_acmdln, a DATA export), and _adjust_fdiv, the Pentium FDIV bug's
     * workaround switch: 0, this FPU divides right. _except_handler3 is the handler a __try frame names:
     * called only on an exception, it lets the search go on; _XcptFilter, the top filter: the same.
     */
    __set_app_type: ['i', () => 0, cd], __setusermatherr: ub.__setusermatherr, _initterm: ub._initterm,
    __p__commode: ub.__p__commode, __p__fmode: ['', (x) => (st.fmode ||= (() => { const q = x.win.heapAlloc(4); x.w32(q, 0); return q; })()), cd],
    __getmainargs: ['pppip', (x, pc, pv, pe) => {
      x.w32(pc, x.r32(ub.__p___argc[1](x))); x.w32(pv, x.r32(ub.__p___argv[1](x))); x.w32(pe, ub._get_initial_narrow_environment[1](x));
      return 0;
    }, cd],
    _controlfp: ['uu', () => 0x0009001f, cd], _exit: ub._exit,
    _acmdln: ['', (x) => kernel32.GetCommandLineA[1](x), { data: true }],
    _adjust_fdiv: ['', () => 0, { data: true }],
    _except_handler3: ['pppp', () => 1, cd], _XcptFilter: ['up', () => 0, cd],
    isdigit: ub.isdigit,
    // sprintf(buf, fmt, ...): %d %i %u %x %X %c %s %f %%, with width and precision, the arguments read from
    // the caller's stack after the format (cdecl's varargs: doubles are 8 bytes there).
    vsprintf: ['ppp', (x, buf, fmt, ap) => { const out = formatC(x, x.str(fmt), ap); x.write(buf, new TextEncoder().encode(out + '\0')); return out.length; }, cd],
    // _fullpath: a relative path below C:\ (the program's directory), in a buffer of the program's or one allocated.
    _fullpath: ['ppu', (x, buf, rel, n) => {
      const r = x.str(rel), full = /^[a-z]:/i.test(r) ? r : 'C:\\' + r.replace(/^[\\/]+/, '').replace(/\//g, '\\');
      if (buf && full.length >= n) return 0;
      const p = buf || x.win.heapAlloc(full.length + 1); x.write(p, new TextEncoder().encode(full + '\0')); return p;
    }, cd],
    sprintf: ['pp', (x, buf, fmt) => {
      const out = formatC(x, x.str(fmt), (x.cpu.reg[4] >>> 0) + 12);
      x.write(buf, new TextEncoder().encode(out + '\0'));
      return out.length;
    }, cd],
  };
  // ---- GDI's pens, brushes and shapes, and DIBs drawn straight to a DC (the classic applications') ----
  const SYSCOLORS = { 0: 0xc8d0d4, 1: 0xa56e3a, 2: 0x6a240a, 3: 0x808080, 4: 0xc8d0d4, 5: 0xffffff, 6: 0, 7: 0, 8: 0, 9: 0xffffff, 10: 0xc8d0d4, 11: 0xc8d0d4,
    12: 0x808080, 13: 0x6a240a, 14: 0xffffff, 15: 0xc8d0d4, 16: 0x808080, 17: 0x808080, 18: 0, 19: 0xc8d0d4, 20: 0xffffff, 21: 0x404040, 22: 0xc8d0d4, 23: 0, 24: 0xe1ffff };
  const rgb = (c) => ((c & 0xff) << 16) | (c & 0xff00) | ((c >>> 16) & 0xff);   // COLORREF (00BBGGRR) -> 00RRGGBB
  // A brush's colour: one made, a system colour's (GetSysColorBrush), a stock one; null for NULL_BRUSH.
  const brushColor = (h) => {
    const o = st.gdi.get(h); if (o && o.kind === 'brush') return o.color;
    if (h >= 0x01a00000 && h < 0x01a00020) return rgb(SYSCOLORS[h - 0x01a00000] ?? 0);
    if (h > 0 && h <= 31) return rgb(SYSCOLORS[h - 1] ?? 0);              // (COLOR_x + 1), a class's background
    return ({ 0x01900010: 0xffffff, 0x01900011: 0xc0c0c0, 0x01900012: 0x808080, 0x01900013: 0x404040, 0x01900014: 0 })[h] ?? null;   // NULL_BRUSH (+5): none
  };
  const rectOf = (x, r) => [x.r32(r) | 0, x.r32(r + 4) | 0, x.r32(r + 8) | 0, x.r32(r + 12) | 0];
  /** A pen's colour mixed with the screen's under the DC's mix mode (SetROP2): R2_BLACK 1, R2_NOT 6,
   *  R2_XORPEN 7, R2_NOP 11, R2_COPYPEN 13 (the default), R2_WHITE 16 -- Minesweeper draws its raised
   *  edges in R2_WHITE with whatever pen is selected. Others draw as the pen. */
  const mix = (rop, c) => (rop === 1 ? () => 0 : rop === 16 ? () => 0xffffff : rop === 6 ? (d) => d ^ 0xffffff : rop === 7 ? (d) => d ^ c : rop === 11 ? (d) => d : () => c);
  const line = (t, x0, y0, x1, y1, c, rop = 13) => {
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1, f = mix(rop, c);
    let e = dx + dy;
    for (;;) {
      if (x0 === x1 && y0 === y1) break;                                // LineTo leaves out its last point
      if (x0 >= 0 && y0 >= 0 && x0 < t.w && y0 < t.h) { const k = y0 * t.w + x0; t.px[k] = f(t.px[k]); }
      const e2 = 2 * e; if (e2 >= dy) { e += dy; x0 += sx; } if (e2 <= dx) { e += dx; y0 += sy; }
    }
  };
  // A DIB given as its header and its bits apart (StretchDIBits, SetDIBitsToDevice, CreateDIBitmap): its
  // pixels, through the decoder of packed DIBs.
  // DIB_PAL_COLORS (usage 1): its colour table is 16-bit indices into the palette selected in the DC --
  // Pinball's table, drawn by StretchDIBits so: made RGBQUADs of that palette's entries first.
  const dibPixels = (x, bmi, bits, usage = 0, hdc = 0) => {
    const hs = x.r32(bmi), bpp = x.r16(bmi + 14), n = bpp <= 8 ? (x.r32(bmi + 32) || 1 << bpp) : (x.r32(bmi + 16) === 3 ? 3 : 0);
    const w = x.r32(bmi + 4) | 0, h = Math.abs(x.r32(bmi + 8) | 0), stride = ((w * bpp + 31) >> 5) << 2, head = hs + 4 * n;
    const packed = x.win.heapAlloc(head + stride * h);
    x.write(packed, x.bytes(bmi, hs));
    if (usage === 1 && bpp <= 8) {
      const pal = st.gdi.get(dcState(hdc).palette), colors = pal && pal.kind === 'palette' ? pal.colors : new Uint32Array(256);
      for (let i = 0; i < n; i++) x.w32(packed + hs + 4 * i, colors[x.r16(bmi + hs + 2 * i) & 255]);
    } else x.write(packed + hs, x.bytes(bmi + hs, 4 * n));
    x.write(packed + head, x.bytes(bits, stride * h));
    const d = decodeDib(x, packed); x.win.heapFree(packed); return d;
  };
  const drawPixels = (x, hdc, d, dx, dy, dw, dh, sx, sy, sw, sh) => {
    const t = target(x, hdc); if (!t || !d) return 0;
    for (let j = 0; j < Math.abs(dh); j++) {
      const ty = dy + j, syy = sy + Math.floor(j * sh / Math.abs(dh)); if (ty < 0 || ty >= t.h || syy < 0 || syy >= d.h) continue;
      for (let i = 0; i < Math.abs(dw); i++) {
        const tx = dx + i, sxx = sx + Math.floor(i * sw / Math.abs(dw)); if (tx < 0 || tx >= t.w || sxx < 0 || sxx >= d.w) continue;
        t.px[ty * t.w + tx] = d.px[syy * d.w + sxx];
      }
    }
    t.done(); return Math.abs(dh);
  };
  Object.assign(gdi32, {
    CreateSolidBrush: ['u', (x, c) => st.newHandle('brush', { color: rgb(c) })],
    CreatePen: ['iiu', (x, style, w, c) => st.newHandle('pen', { color: rgb(c), style, width: w })],
    CreateBrushIndirect: ['p', (x, lb) => st.newHandle('brush', { color: rgb(x.r32(lb + 4)) })],
    MoveToEx: ['piip', (x, hdc, X, Y, old) => { const d = dcState(hdc); if (old) { x.w32(old, d.penX | 0); x.w32(old + 4, d.penY | 0); } d.penX = X; d.penY = Y; return 1; }],
    LineTo: ['pii', (x, hdc, X, Y) => {
      const d = dcState(hdc), t = target(x, hdc), pen = st.gdi.get(d.pen);
      if (t && !(pen && pen.style === 5)) { line(t, d.penX | 0, d.penY | 0, X, Y, pen ? pen.color : 0, d.rop2 || 13); t.done(); }   // PS_NULL draws nothing
      d.penX = X; d.penY = Y; return 1;
    }],
    // Ellipse: the brush inside the ellipse the rectangle bounds, the pen's one-pixel edge round it.
    Ellipse: ['piiii', (x, hdc, l, tp, r, b) => {
      const d = dcState(hdc), t = target(x, hdc); if (!t || r <= l || b <= tp) return 1;
      const fill = brushColor(d.brush ?? 0x01900010), pen = st.gdi.get(d.pen), pc = pen ? pen.color : 0;
      const cx = (l + r - 1) / 2, cy = (tp + b - 1) / 2, ax = (r - l) / 2, ay = (b - tp) / 2;
      for (let Y = tp; Y < b; Y++) for (let X = l; X < r; X++) {
        const e = ((X - cx) / ax) ** 2 + ((Y - cy) / ay) ** 2; if (e > 1 || X < 0 || Y < 0 || X >= t.w || Y >= t.h) continue;
        const edge = ((X - cx) / (ax - 1)) ** 2 + ((Y - cy) / (ay - 1)) ** 2 > 1;
        if (edge && !(pen && pen.style === 5)) t.px[Y * t.w + X] = pc; else if (fill !== null) t.px[Y * t.w + X] = fill;
      }
      t.done(); return 1;
    }],
    // InvertRect: every pixel's colour inverted (Solitaire's selected card).
    InvertRect: ['pp', (x, hdc, r) => {
      const t = target(x, hdc); if (!t) return 1;
      const [l, tp, rr, b] = rectOf(x, r);
      for (let Y = Math.max(0, tp); Y < Math.min(t.h, b); Y++) for (let X = Math.max(0, l); X < Math.min(t.w, rr); X++) t.px[Y * t.w + X] ^= 0xffffff;
      t.done(); return 1;
    }],
    // The mix mode is kept and given back (R2_COPYPEN, 13, at first); drawing is as copy.
    SetROP2: ['pi', (x, hdc, m) => { const d = dcState(hdc), prev = d.rop2 || 13; d.rop2 = m; return prev; }],
    GetROP2: ['p', (x, hdc) => dcState(hdc).rop2 || 13],
    SetBrushOrgEx: ['piip', (x, hdc, X, Y, p) => { if (p) { x.w32(p, 0); x.w32(p + 4, 0); } return 1; }],
    // A window DC's origin on the screen: its client area's corner.
    GetDCOrgEx: ['pp', (x, hdc, p) => { const o = isWindowDC(hdc) ? screenOrigin(st.hwnd) : (hdc >>> 24) === 2 && win(hdc & 0xffffff) ? screenOrigin(hdc & 0xffffff) : { x: 0, y: 0 }; x.w32(p, o.x); x.w32(p + 4, o.y); return 1; }],
    GetLayout: ['p', () => 0], SetLayout: ['pu', () => 0],             // left to right
    SetRectRgn: ['piiii', () => 1], GdiFlush: ['', () => 1],
    GetBkMode: ['p', (x, hdc) => dcState(hdc).bkMode], GetTextColor: ['p', (x, hdc) => dcState(hdc).textColor], GetBkColor: ['p', (x, hdc) => dcState(hdc).bkColor],
    // LineDDA: the program's callback for each point of the line (its last excluded), in turn.
    LineDDA: ['iiiipp', (x, x0, y0, x1, y1, fn, data) => {
      const pts = [], dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
      let e = dx - dy, X = x0, Y = y0;
      while ((X !== x1 || Y !== y1) && pts.length < 10000) { pts.push({ fn, args: [X >>> 0, Y >>> 0, data] }); const e2 = 2 * e; if (e2 > -dy) { e -= dy; X += sx; } if (e2 < dx) { e += dx; Y += sy; } }
      return send(x, pts, () => 1, 24);
    }],
    Rectangle: ['piiii', (x, hdc, l, tp, r, b) => {
      const d = dcState(hdc), t = target(x, hdc); if (!t) return 1;
      const fill = brushColor(d.brush ?? 0x01900010), pen = st.gdi.get(d.pen), pc = pen ? pen.color : 0;
      if (fill !== null) fillRect(t, l + 1, tp + 1, r - 1, b - 1, fill);
      if (!(pen && pen.style === 5)) { fillRect(t, l, tp, r, tp + 1, pc); fillRect(t, l, b - 1, r, b, pc); fillRect(t, l, tp, l + 1, b, pc); fillRect(t, r - 1, tp, r, b, pc); }
      t.done(); return 1;
    }],
    // BITMAP (bmType, bmWidth, bmHeight, bmWidthBytes, bmPlanes, bmBitsPixel, bmBits) for a bitmap;
    // LOGBRUSH for a brush; LOGPEN for a pen.
    GetObjectA: ['pip', (x, h, n, p) => {
      const o = st.gdi.get(h);
      if (!o) return 0;
      if (o.kind === 'bitmap') { if (!p) return 24; x.write(p, new Uint8Array(Math.min(n, 24))); x.w32(p + 4, o.w); x.w32(p + 8, o.h); x.w32(p + 12, o.w * 4); x.w16(p + 16, 1); x.w16(p + 18, 32); if (n >= 24) x.w32(p + 20, o.dib ? o.dib.bits : 0); return Math.min(n, 24); }
      if (o.kind === 'brush') { if (!p) return 12; x.w32(p, 0); x.w32(p + 4, rgb(o.color)); x.w32(p + 8, 0); return 12; }
      if (o.kind === 'pen') { if (!p) return 16; x.w32(p, o.style); x.w32(p + 4, o.width); x.w32(p + 8, 0); x.w32(p + 12, rgb(o.color)); return 16; }
      return 0;
    }],
    GetCurrentObject: ['pu', (x, hdc, type) => { const d = dcState(hdc); return type === 1 ? d.pen || 0x01b00017 : type === 2 ? d.brush || 0x01900010 : type === 7 ? st.dcBitmaps.get(hdc) || 0x0185000f : type === 6 ? st.dcFonts.get(hdc) || 0x018a0021 : 0; }],
    // A bitmap of the program's own bits: 1 bit (a mask) or as many as the screen's; zeroed without them.
    CreateBitmap: ['iiuup', (x, w, h, planes, bpp, bits) => {
      const px = new Uint32Array(Math.max(0, w * h));
      if (bits && bpp === 1) { const stride = ((w + 15) >> 4) << 1, raw = x.bytes(bits, stride * h); for (let y = 0; y < h; y++) for (let i = 0; i < w; i++) px[y * w + i] = (raw[y * stride + (i >> 3)] >> (7 - (i & 7))) & 1 ? 0xffffff : 0; }
      return st.newHandle('bitmap', { w, h, px, mono: bpp === 1 && planes === 1 });
    }],
    CreateDIBitmap: ['ppupp' + 'u', (x, hdc, bih, init, bits, bmi) => {
      const w = x.r32(bih + 4) | 0, h = Math.abs(x.r32(bih + 8) | 0);
      const d = init & 4 && bits && bmi ? dibPixels(x, bmi, bits) : null;   // CBM_INIT
      return st.newHandle('bitmap', d && d.w === w ? d : { w, h, px: new Uint32Array(Math.max(0, w * h)) });
    }],
    StretchDIBits: ['piiiiiiiippuu', (x, hdc, dx, dy, dw, dh, sx, sy, sw, sh, bits, bmi, usage) => {
      const d = dibPixels(x, bmi, bits, usage, hdc); if (!d) return 0;
      // The source rectangle counts from the DIB's bottom for a bottom-up DIB.
      const syTop = (x.r32(bmi + 8) | 0) > 0 ? d.h - sy - sh : sy;
      return drawPixels(x, hdc, d, dx, dy, dw, dh, sx, syTop, sw, sh);
    }],
    SetDIBitsToDevice: ['piiuuiiuuppu', (x, hdc, dx, dy, w, h, sx, sy, start, lines, bits, bmi, usage) => {
      const d = dibPixels(x, bmi, bits, usage, hdc); if (!d) return 0;
      const syTop = (x.r32(bmi + 8) | 0) > 0 ? d.h - sy - h : sy;
      return drawPixels(x, hdc, d, dx, dy, w, h, sx, syTop, w, h);
    }],
    GetTextExtentPointA: ['ppip', (x, hdc, str, n, size) => gdi32.GetTextExtentPoint32A[1](x, hdc, str, n, size)],
    CreateICA: ['pppp', () => st.hdc],
  });
  Object.assign(user32, {
    FillRect: ['ppp', (x, hdc, r, hbr) => { const c = brushColor(hbr), t = target(x, hdc); if (t && c !== null) { const [l, tp, rr, b] = rectOf(x, r); fillRect(t, l, tp, rr, b, c); t.done(); } return 1; }],
    FrameRect: ['ppp', (x, hdc, r, hbr) => {
      const c = brushColor(hbr), t = target(x, hdc); if (!t || c === null) return 1;
      const [l, tp, rr, b] = rectOf(x, r); fillRect(t, l, tp, rr, tp + 1, c); fillRect(t, l, b - 1, rr, b, c); fillRect(t, l, tp, l + 1, b, c); fillRect(t, rr - 1, tp, rr, b, c);
      t.done(); return 1;
    }],
    DrawFocusRect: ['pp', () => 1],
    // DrawTextA: its lines (and, with DT_WORDBREAK 10h, the words that fit the rectangle's width) placed
    // as DT_CENTER (1) and DT_RIGHT (2) say; DT_VCENTER (4) and DT_BOTTOM (8) for DT_SINGLELINE (20h);
    // DT_CALCRECT (400h) measures and draws nothing; "&x" is x unless DT_NOPREFIX (800h). Returns the height.
    DrawTextA: ['ppipu', (x, hdc, str, n, r, fmt) => {
      let s = n < 0 ? x.str(str) : String.fromCharCode(...x.bytes(str, n));
      if (!(fmt & 0x800)) s = s.replace(/&(.)/g, '$1');
      const m = textMetrics(hdc), [l, tp, rr, b] = rectOf(x, r);
      const widthOf = (t) => { let w = 0; for (const ch of t) w += m.font ? m.font.glyph(ch.charCodeAt(0) & 255, m.ppem).cellIncX : m.avg; return w; };
      const lines = [];
      for (const para of fmt & 0x20 ? [s.replace(/[\r\n]/g, ' ')] : s.split(/\r?\n/)) {
        if (!(fmt & 0x10)) { lines.push(para); continue; }
        let cur = '';
        for (const word of para.split(/(\s+)/)) {
          if (cur && widthOf(cur + word) > rr - l && word.trim()) { lines.push(cur.trimEnd()); cur = word.trimStart(); } else cur += word;
        }
        lines.push(cur);
      }
      const height = lines.length * m.height, widest = Math.max(0, ...lines.map(widthOf));
      if (fmt & 0x400) { x.w32(r + 8, l + (fmt & 0x10 ? Math.min(widest, rr - l) : widest)); x.w32(r + 12, tp + height); return height; }
      const t = target(x, hdc); if (!t) return height;
      const top = fmt & 0x20 && fmt & 4 ? tp + ((b - tp - m.height) >> 1) : fmt & 0x20 && fmt & 8 ? b - m.height : tp;
      lines.forEach((line, i) => {
        const w = widthOf(line), X = fmt & 1 ? l + ((rr - l - w) >> 1) : fmt & 2 ? rr - w : l;
        const buf = x.win.heapAlloc(line.length + 1); x.write(buf, Uint8Array.from(line, (c) => c.charCodeAt(0) & 255));
        textOut(x, t, dcState(hdc), m, X, top + i * m.height, 0, 0, buf, line.length); x.win.heapFree(buf);
      });
      t.done();
      return height;
    }],
    // DrawTextExA: DrawTextA's, its DRAWTEXTPARAMS (tabs, margins) not used here.
    DrawTextExA: ['ppipup', (x, hdc, str, n, r, fmt) => user32.DrawTextA[1](x, hdc, str, n, r, fmt)],
    GetSysColor: ['i', (x, i) => SYSCOLORS[i] ?? 0],
  });
  user32.InvertRect = gdi32.InvertRect; delete gdi32.InvertRect;     // user32's, drawn with gdi32's pixels
  // The classic Windows 95 calls (src/win32/classic.js), under the names not answered above.
  const classic = classicApis({ st, wm, send });
  for (const [dll, t] of [[kernel32, classic.kernel32], [user32, classic.user32], [gdi32, classic.gdi32], [winmm, classic.winmm]]) for (const [k, v] of Object.entries(t || {})) if (!(k in dll)) dll[k] = v;
  // The Unicode and post-XP calls (src/win32/modern.js), under the names still not answered.
  const modern = modernApis({ st, kernel32, user32, gdi32, send, advapi32: classic.advapi32, winmm });
  for (const [dll, t] of [[kernel32, modern.kernel32], [user32, modern.user32], [gdi32, modern.gdi32], [winmm, modern.winmm]]) for (const [k, v] of Object.entries(t || {})) if (!(k in dll)) dll[k] = v;
  /*
   * StarCraft's calls (1998): the date and time as an English Windows writes them (the clock's, or the
   * SYSTEMTIME given), one drive with room on it, no other process to start (CreateProcess and LoadModule
   * fail), text measured a character at a time, regions that are never kept (src/win32/classic.js).
   */
  const nowParts = (x, p) => {
    if (p) return { y: x.r16(p), mo: x.r16(p + 2), d: x.r16(p + 6), h: x.r16(p + 8), mi: x.r16(p + 10), s: x.r16(p + 12) };
    const t = new Date((x.lx.now ? x.lx.now() : Math.floor(Date.now() / 1000)) * 1000);
    return { y: t.getFullYear(), mo: t.getMonth() + 1, d: t.getDate(), h: t.getHours(), mi: t.getMinutes(), s: t.getSeconds() };
  };
  const putOut = (x, buf, n, str) => { if (!n) return str.length + 1; if (n <= str.length) return 0; x.write(buf, new TextEncoder().encode(str + '\0')); return str.length + 1; };
  const two = (v) => String(v).padStart(2, '0');
  Object.assign(kernel32, {
    GetDateFormatA: ['uupppi', (x, lcid, flags, date, fmt, buf, n) => { const t = nowParts(x, date); return putOut(x, buf, n, `${t.mo}/${t.d}/${String(t.y).slice(-2)}`); }],
    GetTimeFormatA: ['uupppi', (x, lcid, flags, time, fmt, buf, n) => { const t = nowParts(x, time); return putOut(x, buf, n, `${t.h % 12 || 12}:${two(t.mi)}:${two(t.s)} ${t.h < 12 ? 'AM' : 'PM'}`); }],
    GetLogicalDriveStringsA: ['up', (x, n, buf) => { if (n >= 5) x.write(buf, new TextEncoder().encode('C:\\\0\0')); return 4; }],
    // 512-byte sectors, 8 to a cluster: 256 MiB free of 512.
    GetDiskFreeSpaceA: ['ppppp', (x, root, spc, bps, free, total) => { if (spc) x.w32(spc, 8); if (bps) x.w32(bps, 512); if (free) x.w32(free, 0x10000); if (total) x.w32(total, 0x20000); return 1; }],
    VirtualLock: ['pu', () => 1], VirtualUnlock: ['pu', () => 1],
    CreateProcessA: ['pppppiuppp', () => 0], GetExitCodeProcess: ['pp', () => 0], LoadModule: ['pp', () => 2],
    GetTempPathA: ['up', (x, n, buf) => putOut(x, buf, n, 'C:\\') - 1],
    // Its installer's: no named event exists to open; files moved (MoveFileEx: MoveFile's, a delayed move
    // done at once); Windows' directory; a short name the long one (8.3 names are not kept here).
    OpenEventA: ['uip', () => 0],
    MoveFileExA: ['ppu', (x, a, b) => (b ? kernel32.MoveFileA[1](x, a, b) : kernel32.DeleteFileA[1](x, a))],
    GetWindowsDirectoryA: ['pu', (x, buf, n) => { const w = 'C:\\WINDOWS'; if (n > w.length) x.write(buf, new TextEncoder().encode(w + '\0')); return w.length; }],
    SetVolumeLabelA: ['pp', () => 1], RemoveDirectoryA: ['p', () => 1],
    GetShortPathNameA: ['ppu', (x, a, b, n) => { const t = x.str(a); if (n > t.length) x.write(b, new TextEncoder().encode(t + '\0')); return t.length; }],
    GetTempFileNameA: ['ppup', (x, path, pre, u, buf) => { const k = u || 1; x.write(buf, new TextEncoder().encode(`${x.str(path).replace(/\\?$/, '\\')}${x.str(pre, 3)}${k.toString(16).toUpperCase()}.TMP\0`)); return k; }],
  });
  for (const [k, v] of Object.entries({
    DestroyAcceleratorTable: ['p', () => 1], ExitWindowsEx: ['uu', () => 0], WaitForInputIdle: ['pu', () => 0], EnumWindows: ['pp', () => 1], FindWindowExA: ['pppp', () => 0],
    DrawEdge: ['ppuu', () => 1], CreateCursor: ['piiiipp', () => st.newHandle('cursor', {})], DestroyCursor: ['p', () => 1],
    GetUpdateRgn: ['ppi', () => 1],                                    // NULLREGION: nothing waits to be painted
    GetClassLongA: ['pi', () => 0], SetClassLongA: ['pii', () => 0],
  })) if (!(k in user32)) user32[k] = v;
  const extent = (x, hdc, str, n) => { const sz = x.win.heapAlloc(8); gdi32.GetTextExtentPoint32A[1](x, hdc, str, n, sz); const w = x.r32(sz), h = x.r32(sz + 4); x.win.heapFree(sz); return { w, h }; };
  for (const [k, v] of Object.entries({
    // How many characters fit in `max` pixels, and each one's right edge.
    GetTextExtentExPointA: ['ppiippp', (x, hdc, str, n, max, fit, dx, size) => {
      let k = 0;
      for (let i = 1; i <= n; i++) { const w = extent(x, hdc, str, i).w; if (dx) x.w32(dx + 4 * (i - 1), w); if (w <= max) k = i; }
      if (fit) x.w32(fit, k);
      const all = extent(x, hdc, str, n); x.w32(size, all.w); x.w32(size + 4, all.h); return 1;
    }],
    // ABC: no overhang -- each character's advance is its B.
    GetCharABCWidthsA: ['puup', (x, hdc, first, last, abc) => {
      const c = x.win.heapAlloc(2);
      for (let ch = first; ch <= last; ch++) { x.w8(c, ch); x.w32(abc + 12 * (ch - first), 0); x.w32(abc + 12 * (ch - first) + 4, extent(x, hdc, c, 1).w); x.w32(abc + 12 * (ch - first) + 8, 0); }
      x.win.heapFree(c); return 1;
    }],
    SetTextAlign: ['pu', () => 0], GetRegionData: ['pup', () => 0], RectInRegion: ['pp', () => 1],
  })) if (!(k in gdi32)) gdi32[k] = v;
  if (!winmm.waveOutGetID) winmm.waveOutGetID = ['pp', (x, h, p) => { if (p) x.w32(p, 0); return 0; }];
  kernel32.RtlZeroMemory = ['pu', (x, p, n) => { x.write(p, new Uint8Array(n)); return 0; }];   // kernel32's, forwarded to ntdll's (Spider imports it so)
  const tables = [
    { dll: 'msvcrt.dll', fns: msvcrt },
    /*
     * crtdll.dll, the C runtime of Windows NT 3.x's own programs (NT 3.51's Solitaire): msvcrt's functions
     * under its names -- __GetMainArgs, and _acmdln_dll, _fmode_dll, _commode_dll as DATA exports. SEH's
     * _local_unwind2 sets the frame's try level and runs no __finally block (none is called here);
     * _global_unwind2 unwinds nothing.
     */
    { dll: 'crtdll.dll', fns: { ...Object.assign({}, ...ucrt.map((t) => t.fns)), ...msvcrt, srand: msvcrt.srand, rand: msvcrt.rand, time: msvcrt.time, exit: msvcrt.exit, _exit: msvcrt._exit, _initterm: msvcrt._initterm,
      _XcptFilter: msvcrt._XcptFilter, __GetMainArgs: msvcrt.__getmainargs, _acmdln_dll: msvcrt._acmdln,
      _fmode_dll: ['', () => 0, { data: true }], _commode_dll: ['', () => 0, { data: true }],
      _local_unwind2: ['pi', (x, frame, level) => { x.w32(frame + 12, level); return 0; }, { cdecl: true }], _global_unwind2: ['p', () => 0, { cdecl: true }] } },
    { dll: 'ntdll.dll', fns: { RtlZeroMemory: ['pu', (x, p, n) => { x.write(p, new Uint8Array(n)); return 0; }] } },
    { dll: 'kernel32.dll', fns: kernel32 },
    // lz32: Crinkler imports its ordinal 4 (LZClose) so that the loader maps it, and kernel32 with it.
    { dll: 'lz32.dll', fns: { CopyLZFile: ['pp', () => 0, { ordinal: 1 }], GetExpandedNameA: ['pp', () => 0, { ordinal: 2 }], GetExpandedNameW: ['pp', () => 0, { ordinal: 3 }],
      LZClose: ['p', () => 0, { ordinal: 4 }], LZCopy: ['pp', () => 0, { ordinal: 5 }], LZDone: ['', () => 0, { ordinal: 6 }], LZInit: ['p', () => 0, { ordinal: 7 }],
      LZOpenFileA: ['ppu', () => -1, { ordinal: 8 }], LZOpenFileW: ['ppu', () => -1, { ordinal: 9 }], LZRead: ['ppi', () => 0, { ordinal: 10 }],
      LZSeek: ['pii', () => 0, { ordinal: 11 }], LZStart: ['', () => 0, { ordinal: 12 }] } },
    { dll: 'user32.dll', fns: user32 },
    { dll: 'gdi32.dll', fns: gdi32 },
    { dll: 'opengl32.dll', fns: numbered(opengl32) },
    { dll: 'glu32.dll', fns: glu32 },
    { dll: 'winmm.dll', fns: winmm },
    ...d3d9Apis(st),
    dsoundApis(),
    dinputApis(),
    ddrawApis(st, wm, send),
    { dll: 'wsock32.dll', fns: wsock32 },
    // comctl32: the common controls are registered (InitCommonControls, ordinal 17); none is drawn here.
    { dll: 'comctl32.dll', fns: { InitCommonControls: ['', () => 0, { ordinal: 17 }], InitCommonControlsEx: ['p', () => 1, { ordinal: 81 }], ImageList_Destroy: ['p', () => 1] } },
    /*
     * The common dialogs and the printers of a machine with neither: a file dialog, a find or print dialog
     * is cancelled at once (FALSE, CommDlgExtendedError 0: the user cancelled), no printer opens, a print job
     * does not start (SP_ERROR). MFC programs (Half-Life's launcher) import them all.
     */
    { dll: 'comdlg32.dll', fns: { GetOpenFileNameA: ['p', () => 0], GetSaveFileNameA: ['p', () => 0], PrintDlgA: ['p', () => 0], FindTextA: ['p', () => 0], ReplaceTextA: ['p', () => 0],
      CommDlgExtendedError: ['', () => 0],
      GetFileTitleA: ['ppu', (x, path, buf, n) => { const t = x.str(path, 260).split(/[\\/:]/).pop(); if (!buf || n <= t.length) return t.length + 1; x.write(buf, new TextEncoder().encode(t + '\0')); return 0; }] } },
    { dll: 'winspool.drv', fns: { OpenPrinterA: ['ppp', (x, name, ph) => { if (ph) x.w32(ph, 0); return 0; }], ClosePrinter: ['p', () => 1], DocumentPropertiesA: ['pppppu', () => -1] } },
    // The registry: empty. A key opens as not found (ERROR_FILE_NOT_FOUND), so nothing is read from it
    // or written to it, as on a machine where the program never ran.
    { dll: 'advapi32.dll', fns: { ...modern.advapi32, ...classic.advapi32 } },
    { dll: 'version.dll', fns: classic.version },
    { dll: 'ole32.dll', fns: { ...modern.ole32, ...classic.ole32 } },   // a registry in memory (src/win32/classic.js)
    // What SDL 2 and a program of the 2010s reach for beyond them (src/win32/modern.js); Winsock 2 is
    // Winsock 1.1's functions by the same ordinals.
    { dll: 'shell32.dll', fns: { ...modern.shell32, ...classic.shell32 } }, { dll: 'imm32.dll', fns: { ...modern.imm32, ...classic.imm32 } },
    { dll: 'shlwapi.dll', fns: classic.shlwapi }, { dll: 'setupapi.dll', fns: modern.setupapi },
    { dll: 'oleaut32.dll', fns: modern.oleaut32 }, { dll: 'ws2_32.dll', fns: wsock32 },
    // The Universal C Runtime and vcruntime140 of Visual C++ 2015 and later (src/win32/ucrt.js).
    ...ucrt,
  ];
  /*
   * The visitor's input, as Windows posts it to the window: a key by its PC scancode (set 1; 0xE0-
   * prefixed keys `ext`) as WM_KEYDOWN / WM_KEYUP (Alt as WM_SYSKEY*), the scancode in lParam's bits
   * 16-23 where WinQuake's MapKey reads it, the virtual key in wParam.
   *
   * The mouse comes two ways. Free, it is where the visitor points on the screen (mouseAt): over the
   * window's frame the window manager answers -- the caption drags the window, the close button
   * posts WM_CLOSE -- and over its client area the program gets WM_MOUSEMOVE and button messages in
   * client coordinates. Captured -- the program hid the cursor or clipped it to its window, as a game
   * does to aim; captures() tells the page to lock the pointer -- its moves are added to the cursor
   * (mouseMove), kept inside the clip, and every button is the program's: WinQuake recentres the
   * cursor with SetCursorPos each frame and turns by the difference.
   */
  const clientLp = () => { const c = wm.client(); return ((((st.mouseY | 0) - c.y) & 0xffff) << 16 | (((st.mouseX | 0) - c.x) & 0xffff)) >>> 0; };
  // The window under the pointer (main-window client coordinates): the one with the capture, else the
  // highest visible popup there or the main window, down to its deepest visible child; null for the
  // main window itself (its messages as before). A disabled window gets nothing.
  const windowAt = (X, Y) => {
    if (st.capture && win(st.capture)) return st.capture;
    const size = (h) => { if (h === st.hwnd) return { w: st.w, h: st.h }; const w = win(h); return w && isDrop(w) && !w.dropped ? { w: w.w, h: Math.min(w.h, w.fieldH || 21) } : w; };
    const inside = (h, px, py) => { const w = size(h), o = screenOrigin(h); return px >= o.x && py >= o.y && px < o.x + w.w && py < o.y + w.h; };
    const deepest = (h) => {
      // A group box, and a static without SS_NOTIFY, let the mouse through to what is under them (HTTRANSPARENT).
      const clear = (c) => (c.cls === 'button' && (c.style & 15) === 7) || (c.cls === 'static' && !(c.style & 0x100));
      const kids = [...st.wins.values()].filter((c) => c.parent === h && !c.dead && c.visible && (c.style & 0x40000000) && !clear(c) && inside(c.hwnd, X, Y)).sort((a, b) => !!a.dropped - !!b.dropped);
      return kids.length ? deepest(kids[kids.length - 1].hwnd) : h;
    };
    const pops = [...st.wins.values()].filter((w) => !w.main && !w.dead && w.visible && !(w.style & 0x40000000) && inside(w.hwnd, X, Y));
    if (!pops.length && deskMode() && !(st.shown && inside(st.hwnd, X, Y))) return -1;   // the desktop
    const h = deepest(pops.length ? pops[pops.length - 1].hwnd : st.hwnd);
    for (let w = win(h); w; w = w.main || !(w.style & 0x40000000) ? null : win(w.parent)) if (w.enabled === false) return -1;   // up to its top-level window
    return h === st.hwnd ? null : h;
  };
  // A mouse message to the window under the pointer, in its client coordinates.
  const postMouse = (msg, wp) => {
    const X = st.mouseX | 0, Y = st.mouseY | 0;                          // the screen's
    const h = st.wins.size > 1 ? windowAt(X, Y) : null;
    if (h === -1) return;
    if (!h && !deskMode()) { st.msgs.push({ msg, wp, lp: clientLp() }); return; }
    const o = screenOrigin(h || st.hwnd); if (!h) { st.msgs.push({ msg, wp, lp: (((Y - o.y) & 0xffff) << 16 | ((X - o.x) & 0xffff)) >>> 0 }); return; }
    st.msgs.push({ msg, wp, lp: (((Y - o.y) & 0xffff) << 16 | ((X - o.x) & 0xffff)) >>> 0, hwnd: h });
  };
  const captured = () => !!st.clip || (st.cursorCount | 0) < 0;
  // A drag moves the window where the visitor points; the move takes effect at the program's next
  // PeekMessage or GetMessage, which delivers WM_MOVE before anything else -- as Windows' drag loop
  // sends it -- so a program learns of it before it looks: WinQuake compares GetWindowRect with the
  // place it remembers every frame and puts its window back there when they differ.
  const postMove = () => { st.pendingMove = { x: wm.drag ? wm.drag.x : st.x, y: wm.drag ? wm.drag.y : st.y }; };
  const takeMove = () => {
    const p = st.pendingMove; st.pendingMove = null;
    st.x = p.x; st.y = p.y; wm.dirty = true;
    const c = wm.client(); return ((c.y & 0xffff) << 16 | (c.x & 0xffff)) >>> 0;
  };
  const free = () => !captured() && wm.framed();
  // An item of the menu bar pressed: its popup opened, the program told (WM_INITMENU, WM_INITMENUPOPUP);
  // a command on the bar itself is WM_COMMAND at once.
  const openMenu = (l) => {
    if (!(l.it.flags & 0x10)) { if (!(l.it.flags & 3)) st.msgs.push({ msg: 0x111, wp: l.it.id, lp: 0 }); return; }
    if (l.it.flags & 3) return;
    st.msgs.push({ msg: 0x116, wp: st.menu, lp: 0 }, { msg: 0x117, wp: l.it.sub, lp: l.i });
    wm.openPopup(l.i); wm.redraw();
  };
  tables.input = {
    key(down, scan, ext = false) {
      const vk = scanToVk(scan, ext), alt = vk === 0x12;
      if (down) st.keys.add(vk); else st.keys.delete(vk);
      // To the window with the focus: the main one, or another (Half-Life's engine window, over its launcher).
      const to = st.focus && st.focus !== st.hwnd && win(st.focus) && !win(st.focus).dead ? { hwnd: st.focus } : {};
      st.msgs.push({ msg: (alt ? 0x104 : 0x100) + (down ? 0 : 1), wp: vk, lp: (1 | (scan & 0xff) << 16 | (ext ? 1 << 24 : 0) | (down ? 0 : 0xc0000000)) >>> 0, ...to });
    },
    captures: () => captured(),
    leave() { st.pointerIn = false; wm.moveCursor(); },             // the pointer left the screen: no cursor drawn
    mouseAt(X, Y) {                                                 // free: a point of the screen
      st.mouseX = X | 0; st.mouseY = Y | 0; st.pointerIn = true;
      if (wm.popup) { const r = wm.popupHit(X, Y); const h = r === null ? -1 : r; if (h !== wm.popup.hover) { wm.popup.hover = h; wm.redraw(); return; } }
      wm.moveCursor();
      if (wm.drag) { wm.drag.x = X - wm.drag.dx; wm.drag.y = Y - wm.drag.dy; postMove(); return; }
      if (!free() || wm.hit(X, Y) === 'client') postMouse(0x200, st.buttons | 0);
    },
    mouseMove(dx, dy) {                                             // captured: a move
      let X = (st.mouseX ?? (st.w >> 1)) + dx, Y = (st.mouseY ?? (st.h >> 1)) + dy;
      if (st.clip) { X = Math.max(st.clip.l, Math.min(st.clip.r - 1, X)); Y = Math.max(st.clip.t, Math.min(st.clip.b - 1, Y)); }
      st.mouseX = X; st.mouseY = Y;
      postMouse(0x200, st.buttons | 0);
    },
    mouseButton(b, down) {                                          // 0 left, 1 right, 2 middle
      const X = st.mouseX | 0, Y = st.mouseY | 0;
      // The menu bar's popup open: a click on a command is WM_COMMAND (on the button's release, as
      // Windows), on another of the bar's items opens that one, anywhere else closes it.
      if (wm.popup && b === 0) {
        const r = wm.popupHit(X, Y);
        if (r !== null) {
          const it = r >= 0 && st.gdi.get(wm.popup.menu).items[r];
          if (!down && it && !(it.flags & 0x813) && !(it.flags & 0x10)) { wm.closePopup(); wm.redraw(); st.msgs.push({ msg: 0x111, wp: it.id, lp: 0 }); }
          return;
        }
        if (!down) return;
        const was = wm.popup.bar; wm.closePopup(); wm.redraw();
        if (wm.hit(X, Y) !== 'menu') return;
        const l = wm.menuLayout().find((q) => X >= q.x && X < q.x + q.w);
        if (!l || l.i === was) return;
        return openMenu(l);
      }
      if (free() && b === 0 && down && wm.hit(X, Y) === 'menu') {
        const l = wm.menuLayout().find((q) => X >= q.x && X < q.x + q.w);
        if (l) openMenu(l);
        return;
      }
      if (free() && b === 0) {
        if (!down && wm.drag) { postMove(); wm.drag = null; return; }
        if (!down && wm.closeArmed) { wm.closeArmed = false; wm.redraw(); if (wm.hit(X, Y) === 'close') st.msgs.push({ msg: 0x10, wp: 0, lp: 0 }); return; }
        const where = wm.hit(X, Y);
        if (down && where === 'caption') { wm.drag = { dx: X - (st.x | 0), dy: Y - (st.y | 0), x: st.x | 0, y: st.y | 0 }; return; }
        if (down && where === 'close') { wm.closeArmed = true; wm.redraw(); return; }
        if (where !== 'client') return;
      } else if (free() && wm.hit(X, Y) !== 'client') return;
      const bit = [1, 2, 0x10][b], msg = [0x201, 0x204, 0x207][b] + (down ? 0 : 1);
      st.buttons = down ? (st.buttons | 0) | bit : (st.buttons | 0) & ~bit;
      postMouse(msg, st.buttons);
    },
  };
  /** A file of the program's disk, by name (the loader's DLLs of the program's own), or null. */
  tables.readFile = (name) => { const f = diskFile(name); return f && f.bytes ? f.bytes.subarray(0, f.size) : null; };
  /** Where WebGL's picture goes on the screen, for a framed window (null: it is the whole screen). */
  // The windows as they are (tools/win32/run.mjs MIRAGE_W32WINS): handle, class, parent, id, place, style, title.
  tables.windows = () => [...st.wins.values()].map((w) => ({ hwnd: w.hwnd.toString(16), cls: w.cls, parent: (w.parent || 0).toString(16), id: w.id, rect: [w.x, w.y, w.w, w.h], style: (w.style >>> 0).toString(16), visible: !!w.visible, title: w.title, image: w.image || undefined }));
  tables.wm = { clientRect: () => (wm.framed() ? { ...wm.client(), screen: st.desk } : null), presented: () => wm.presented | 0,
    // The program's icon (its first RT_GROUP_ICON's first image): { w, h, px 0x00RRGGBB, mask 1 transparent }, or null.
    icon: (x) => { try { const b = st.gdi.get(loadIcon(x, x.win.base, null)); return b && b.px ? { w: b.w, h: b.h, px: b.px, mask: b.mask } : null; } catch { return null; } } };   // GDI frames shown
  return tables;
}

// A PC scancode (set 1) to its Windows virtual key, for a US layout.
const SCAN_VK = (() => {
  const t = {}, row = (start, keys) => [...keys].forEach((c, i) => { t[start + i] = c.charCodeAt(0); });
  row(0x02, '1234567890'); row(0x10, 'QWERTYUIOP'); row(0x1e, 'ASDFGHJKL'); row(0x2c, 'ZXCVBNM');
  Object.assign(t, { 0x01: 0x1b, 0x0c: 0xbd, 0x0d: 0xbb, 0x0e: 0x08, 0x0f: 0x09, 0x1a: 0xdb, 0x1b: 0xdd, 0x1c: 0x0d, 0x1d: 0x11, 0x27: 0xba,
    0x28: 0xde, 0x29: 0xc0, 0x2a: 0x10, 0x2b: 0xdc, 0x33: 0xbc, 0x34: 0xbe, 0x35: 0xbf, 0x36: 0x10, 0x37: 0x6a, 0x38: 0x12, 0x39: 0x20, 0x3a: 0x14 });
  for (let i = 0; i < 10; i++) t[0x3b + i] = 0x70 + i;               // F1-F10
  Object.assign(t, { 0x57: 0x7a, 0x58: 0x7b, 0x47: 0x24, 0x48: 0x26, 0x49: 0x21, 0x4b: 0x25, 0x4d: 0x27, 0x4f: 0x23, 0x50: 0x28, 0x51: 0x22, 0x52: 0x2d, 0x53: 0x2e });
  return t;
})();
const scanToVk = (scan, ext) => (ext && scan === 0x1c ? 0x0d : SCAN_VK[scan & 0x7f] || 0);

/*
 * wsock32.dll, Winsock 1.1 by its ordinals (a program imports these by number): a machine on a network
 * with nobody else on it. Winsock starts (version 1.1), sockets are made, bound and set, the machine's
 * name ("mirage") resolves to 127.0.0.1; nothing ever arrives (recvfrom: WSAEWOULDBLOCK, select: none
 * ready) and what is sent goes nowhere. Quake II stops at once if Winsock does not start, even to play
 * alone, which goes through its own loopback; WinQuake makes its UDP socket and plays alone too.
 * Connecting to anyone fails (WSAENETUNREACH). Byte order and dotted addresses are arithmetic.
 */
const WOULDBLOCK = 10035, UNREACH = 10051;
const sw16 = (v) => ((v & 0xff) << 8) | ((v >> 8) & 0xff), sw32 = (v) => (((v & 0xff) << 24) | ((v & 0xff00) << 8) | ((v >>> 8) & 0xff00) | (v >>> 24)) >>> 0;
let wsaErr = 0, sockNext = 0x100;
const sockAddr = (x, p, n) => { if (!p) return; x.write(p, new Uint8Array(16)); x.w16(p, 2); x.write(p + 4, Uint8Array.of(127, 0, 0, 1)); if (n) x.w32(n, 16); };
const fail = (e) => { wsaErr = e; return -1; };
const wsock32 = {
  accept: ['ppp', () => fail(WOULDBLOCK), { ordinal: 1 }], bind: ['ppi', () => 0, { ordinal: 2 }], closesocket: ['p', () => 0, { ordinal: 3 }],
  connect: ['ppi', () => fail(UNREACH), { ordinal: 4 }], getpeername: ['ppp', () => fail(10057), { ordinal: 5 }],
  getsockname: ['ppp', (x, s, p, n) => { sockAddr(x, p, n); return 0; }, { ordinal: 6 }],
  getsockopt: ['piipp', (x, s, l, o, v, n) => { if (v) x.w32(v, 0); if (n) x.w32(n, 4); return 0; }, { ordinal: 7 }],
  htonl: ['u', (x, v) => sw32(v), { ordinal: 8 }], htons: ['u', (x, v) => sw16(v), { ordinal: 9 }],
  inet_addr: ['p', (x, p) => {                                        // "a.b.c.d" in network order, INADDR_NONE otherwise
    const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(x.str(p, 32));
    return m && m.slice(1).every((n) => +n < 256) ? (+m[1] | +m[2] << 8 | +m[3] << 16 | +m[4] << 24) >>> 0 : 0xffffffff;
  }, { ordinal: 10 }],
  inet_ntoa: ['u', (x, a) => {                                        // into one buffer of its own, as Winsock's per-thread one
    const b = new TextEncoder().encode(`${a & 255}.${(a >>> 8) & 255}.${(a >>> 16) & 255}.${a >>> 24}\0`);
    x.ntoaBuf ||= x.win.heapAlloc(16); x.write(x.ntoaBuf, b); return x.ntoaBuf;
  }, { ordinal: 11 }],
  ioctlsocket: ['pip', (x, s, cmd, p) => { if (p && (cmd >>> 0) === 0x4004667f) x.w32(p, 0); return 0; }, { ordinal: 12 }],   // FIONBIO set; FIONREAD: nothing
  listen: ['pi', () => 0, { ordinal: 13 }],
  ntohl: ['u', (x, v) => sw32(v), { ordinal: 14 }], ntohs: ['u', (x, v) => sw16(v), { ordinal: 15 }],
  recv: ['ppii', () => fail(WOULDBLOCK), { ordinal: 16 }], recvfrom: ['ppiipp', () => fail(WOULDBLOCK), { ordinal: 17 }],
  select: ['ipppp', (x, n, r, w, e) => { for (const set of [r, e]) if (set) x.w32(set, 0); return w ? x.r32(w) : 0; }, { ordinal: 18 }],   // writable, never readable
  send: ['ppii', (x, s, b, n) => n, { ordinal: 19 }], sendto: ['ppiipi', (x, s, b, n) => n, { ordinal: 20 }],
  setsockopt: ['piipi', () => 0, { ordinal: 21 }], shutdown: ['pi', () => 0, { ordinal: 22 }],
  // Internet sockets only: IPX's (AF_IPX, Jazz Jackrabbit 2's other network) on a machine without it.
  socket: ['iii', (x, af) => (af === 2 ? sockNext++ : fail(10047)), { ordinal: 23 }],
  // hostent { h_name, h_aliases, h_addrtype, h_length, h_addr_list }: this machine, 127.0.0.1, for any name.
  gethostbyname: ['p', (x) => {
    if (!x.hostent) {
      const p = x.win.heapAlloc(64), name = p + 32, addr = p + 48, list = p + 24;
      x.write(p, new Uint8Array(64)); x.write(name, new TextEncoder().encode('mirage\0')); x.write(addr, Uint8Array.of(127, 0, 0, 1));
      x.w32(p, name); x.w32(p + 4, p + 20); x.w16(p + 8, 2); x.w16(p + 10, 4); x.w32(p + 12, list); x.w32(list, addr); x.hostent = p;
    }
    return x.hostent;
  }, { ordinal: 52 }],
  gethostbyaddr: ['pii', (x) => wsock32.gethostbyname[1](x), { ordinal: 51 }],
  getprotobyname: ['p', () => 0, { ordinal: 53 }], getprotobynumber: ['i', () => 0, { ordinal: 54 }],
  getservbyname: ['pp', () => 0, { ordinal: 55 }], getservbyport: ['ip', () => 0, { ordinal: 56 }],
  gethostname: ['pi', (x, p, n) => { if (n < 7) return fail(10014); x.write(p, new TextEncoder().encode('mirage\0')); return 0; }, { ordinal: 57 }],
  // The asynchronous calls: a socket's events as window messages, never posted (nothing arrives); a name
  // looked up fails to start (WSAENETDOWN), as with no network.
  WSAAsyncSelect: ['ppuu', () => 0, { ordinal: 101 }],
  WSAAsyncGetHostByName: ['puppi', () => (fail(10050), 0), { ordinal: 103 }],
  WSACancelAsyncRequest: ['p', () => 0, { ordinal: 108 }],
  WSASetBlockingHook: ['p', () => 0, { ordinal: 109 }], WSAUnhookBlockingHook: ['', () => 0, { ordinal: 110 }],
  WSAGetLastError: ['', () => wsaErr, { ordinal: 111 }], WSASetLastError: ['i', (x, e) => { wsaErr = e; return 0; }, { ordinal: 112 }],
  WSACancelBlockingCall: ['', () => 0, { ordinal: 113 }], WSAIsBlocking: ['', () => 0, { ordinal: 114 }],
  // WSADATA: wVersion 1.1, wHighVersion 1.1, the description, "Running", 32 sockets, 512-byte datagrams.
  WSAStartup: ['up', (x, ver, p) => {
    if (p) { x.write(p, new Uint8Array(400)); x.w16(p, 0x101); x.w16(p + 2, 0x101); x.write(p + 4, new TextEncoder().encode('MIRAGE Winsock 1.1\0')); x.write(p + 261, new TextEncoder().encode('Running\0')); x.w16(p + 390, 32); x.w16(p + 392, 512); }
    return 0;
  }, { ordinal: 115 }],
  WSACleanup: ['', () => 0, { ordinal: 116 }],
  __WSAFDIsSet: ['pp', () => 0, { ordinal: 151 }],
};
