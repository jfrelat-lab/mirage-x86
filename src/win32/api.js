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
import { parseTrueType } from './truetype.js';
import { parseSMF } from '../midi.js';

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
  let next = 0x0a0a0001;
  st.newHandle = (kind, props) => { const hnd = next++; st.gdi.set(hnd, { kind, ...props }); return hnd; };
  // The outlines of the font selected into `hdc` (src/win32/truetype.js), or null: `fonts` holds a face's
  // .ttf under its lower-case name ("tahoma", "tahoma:bold" for a weight of 600 or more).
  const parsed = new Map();
  st.dcFont = (hdc) => {
    const f = st.gdi.get(st.dcFonts.get(hdc));
    if (!f) return null;
    const faces = [f.face.toLowerCase()];
    if (FONT_SUBSTITUTES[faces[0]]) faces.push(FONT_SUBSTITUTES[faces[0]]);
    const key = faces.flatMap((face) => [f.weight >= 600 ? `${face}:bold` : null, face]).find((k) => k && fonts[k]);
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
export function win32Apis({ gl, glu, fonts, files = {} } = {}) {
  const st = windowState(fonts);
  st.files = [];                                                      // handle - 4000h -> { f, pos }
  st.events = new Map(); st.dcBitmaps = new Map(); st.dcStates = new Map();
  const dcState = (hdc) => { let d = st.dcStates.get(hdc); if (!d) st.dcStates.set(hdc, d = { bkMode: 2, bkColor: 0xffffff, textColor: 0 }); return d; };
  // A DC's font in pixels: its em (lfHeight < 0 is the character height, > 0 the cell's), its ascent
  // and descent as the font's win metrics give them.
  const textMetrics = (hdc) => {
    const f = st.gdi.get(st.dcFonts.get(hdc)) || { height: 16, weight: 400 }, font = st.dcFont(hdc);
    const asc = font ? font.winAscent : 0.8, desc = font ? font.winDescent : 0.2, em = font ? font.em : 1;
    const h = f.height || 16, ppem = h < 0 ? -h : Math.max(1, Math.round(h * em / (asc + desc)));
    const ascent = Math.round(asc * ppem / em), descent = Math.round(desc * ppem / em);
    return { font, ppem, ascent, descent, height: ascent + descent, avg: Math.max(1, Math.round(ppem / 2)), max: ppem, weight: f.weight || 400 };
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
  st.disk = new Map(Object.entries(files).map(([n, b]) => [n.toLowerCase(), { bytes: b, size: b.length }]));
  const baseName = (p) => p.replace(/^.*[\\/]/, '').toLowerCase();
  const diskFile = (p) => st.disk.get(baseName(p)) || (baseName(p) === 'gm.dls' ? { bytes: null, size: GM_DLS_SIZE } : null);
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
    LoadLibraryA: ['p', (x, name) => {
      const s = x.str(name, 256), m = x.win.load(s);
      if (!m && /^[\w.\\: -]{1,64}$/.test(s)) x.win.say(`LoadLibraryA("${s}"): not made here`);
      return m ? m.base : 0;
    }],
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
    HeapReAlloc: ['puup', (x, heap, flags, p, n) => {
      const old = x.win.heapSize(p);
      if (n <= old) return p;
      const q = x.win.heapAlloc(n);
      x.write(q, x.bytes(p, old)); if (flags & 8) x.write(q + old, new Uint8Array(n - old));
      x.win.heapFree(p); return q;
    }],
    GlobalAlloc: ['uu', (x, flags, n) => x.win.heapAlloc(n)],
    LocalAlloc: ['uu', (x, flags, n) => x.win.heapAlloc(n)],
    GlobalFree: ['p', () => 0], LocalFree: ['p', () => 0],
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
    GetCommandLineA: ['', (x) => (st.cmd ||= (() => { const b = new TextEncoder().encode(`"${x.win.path}"${x.win.args ? ' ' + x.win.args : ''}\0`), p = x.win.heapAlloc(b.length); x.write(p, b); return p; })())],   // the program's path quoted, then its arguments
    GetVersion: ['', () => 0x0a280105],                                 // 5.1, build 2600: Windows XP
    GetLastError: ['', () => 0], SetLastError: ['u', () => 0],
    SetUnhandledExceptionFilter: ['p', () => 0], SetErrorMode: ['u', () => 0],
    CloseHandle: ['p', () => 1], WaitForSingleObject: ['pu', () => 0],
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
      const name = baseName(x.str(pName));
      let f = diskFile(name);
      if (disp === 2 || disp === 5 || (!f && (disp === 1 || disp === 4))) {   // CREATE_ALWAYS, TRUNCATE_EXISTING, or made
        if (disp === 5 && !f) return -1;
        f = { bytes: new Uint8Array(0), size: 0 }; st.disk.set(name, f);
      } else if (!f || disp === 1) return -1;                          // INVALID_HANDLE_VALUE
      return openHandle(f);
    }],
    WriteFile: ['ppupp', (x, h, buf, n, pDone) => {
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
    SetFilePointer: ['pipu', (x, h, dist, pHigh, how) => {
      const o = st.files[h - 0x4000];
      if (!o) return -1;                                               // INVALID_SET_FILE_POINTER
      if (pHigh) x.w32(pHigh, 0);
      o.pos = Math.max(0, (how === 1 ? o.pos : how === 2 ? o.f.size : 0) + dist);
      return o.pos;
    }],
    DeleteFileA: ['p', (x, pName) => (st.disk.delete(baseName(x.str(pName))) ? 1 : 0)],
    OutputDebugStringA: ['p', () => 0],
    SetEndOfFile: ['p', (x, h) => { const o = st.files[h - 0x4000]; if (!o) return 0; o.f.size = o.pos; return 1; }],
    FlushFileBuffers: ['p', () => 1],
    // A name on the program's disk is a file (FILE_ATTRIBUTE_ARCHIVE); the disk has no directories but
    // its root, so anything else is not there.
    GetFileAttributesA: ['p', (x, pName) => { const n = x.str(pName); return /^[a-z]:\\?$|^\.?[\\/]?$/i.test(n) ? 0x10 : diskFile(n) ? 0x20 : 0xffffffff; }],
    CreateDirectoryA: ['pp', () => 1],
    GetCurrentDirectoryA: ['up', (x, n, buf) => { if (n >= 4) x.write(buf, new TextEncoder().encode('C:\\\0')); return 3; }],
    GetSystemDirectoryA: ['pu', (x, buf, n) => { const s = 'C:\\WINDOWS\\system32'; if (n > s.length) x.write(buf, new TextEncoder().encode(s + '\0')); return s.length; }],
    // FindFirstFileA over the disk: '*' and '?' in the base name; WIN32_FIND_DATAA's attributes at 0,
    // size at 32 (low dword), name at 44. A search handle is 5000h up.
    FindFirstFileA: ['pp', (x, pPat, fd) => {
      const pat = baseName(x.str(pPat)), re = new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
      const list = [...st.disk.keys()].filter((n) => re.test(n));
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
      const m = h && h !== x.win.base ? x.win.moduleAt(h) : null, s = m ? `C:\\WINDOWS\\system32\\${m.name}` : x.win.path;
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
    GetACP: ['', () => 1252], GetOEMCP: ['', () => 437],
    GetCPInfo: ['up', (x, cp, p) => { x.write(p, new Uint8Array(20)); x.w32(p, 1); x.write(p + 4, Uint8Array.of(0x3f)); return 1; }],
    MultiByteToWideChar: ['uupipi', (x, cp, flags, src, n, dst, max) => {
      const b = n < 0 ? x.bytes(src, x.str(src).length + 1) : x.bytes(src, n);
      if (!max) return b.length;
      const k = Math.min(b.length, max), w = new Uint8Array(k * 2); for (let i = 0; i < k; i++) w[2 * i] = b[i];
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
  // WIN32_FIND_DATAA for a file of the disk: archive, its size, its name.
  function findFill(x, fd, name) {
    x.write(fd, new Uint8Array(320)); x.w32(fd, 0x20); x.w32(fd + 32, st.disk.get(name).size);
    x.write(fd + 44, new TextEncoder().encode(name.slice(0, 259) + '\0'));
  }
  // ---- user32 --------------------------------------------------------------------------------------
  // Window classes by name and atom, and the window's procedure.
  st.classes = new Map();
  const registerClass = (x, proc, name) => {
    const atom = 0xc001 + (st.atoms = (st.atoms || 0) + 1) - 1;
    st.classes.set(atom, proc); if (name >= 0x10000) st.classes.set(x.str(name, 256).toLowerCase(), proc);
    return atom;
  };
  const createWindow = (x, cls, style, w, h, wide) => {
    const key = cls < 0x10000 ? cls : (wide ? String.fromCharCode(...wideRead(x, cls, -1, true)) : x.str(cls, 256)).toLowerCase();
    if (st.classes.has(key)) st.wndProc = st.classes.get(key);
    const b = style & 0xc00000 ? 3 : style & 0x800000 ? 1 : 0, cap = (style & 0xc00000) === 0xc00000 ? 19 : 0;   // as AdjustWindowRectEx
    if (w > 0 && h > 0 && w < 8192 && h < 8192) { st.w = Math.max(1, w - 2 * b); st.h = Math.max(1, h - 2 * b - cap); }
    return st.hwnd;
  };
  const putMsg = (x, m, e) => { x.w32(m, st.hwnd); x.w32(m + 4, e.msg); x.w32(m + 8, e.wp); x.w32(m + 12, e.lp); x.w32(m + 16, e.time || 0); x.w32(m + 20, st.mouseX ?? 0); x.w32(m + 24, st.mouseY ?? 0); };
  const user32 = {
    // The window: one, the size it was made or the display mode set; its DC and GL go to the backend.
    // The window: its client area is what a framed window keeps inside the frame AdjustWindowRectEx adds;
    // its procedure is its class's (by name or by atom), which DispatchMessageA calls.
    CreateWindowExA: ['upppiiiippp' + 'p', (x, ex, cls, title, style, X, Y, w, h) => createWindow(x, cls, style, w, h, false)],
    CreateWindowExW: ['upppiiiippp' + 'p', (x, ex, cls, title, style, X, Y, w, h) => createWindow(x, cls, style, w, h, true)],
    ChangeDisplaySettingsA: ['pu', (x, dm) => { if (dm) { st.w = x.r32(dm + 108) || st.w; st.h = x.r32(dm + 112) || st.h; } return 0; }],   // DEVMODEA's dmPelsWidth, dmPelsHeight
    GetDC: ['p', () => st.hdc], ReleaseDC: ['pp', () => 1],
    ShowCursor: ['i', () => 0], SetCursorPos: ['ii', (x, X, Y) => { st.mouseX = X; st.mouseY = Y; return 1; }], ShowWindow: ['pi', () => 1], UpdateWindow: ['p', () => 1], SetWindowPos: ['ppiiiiu', () => 1],
    GetAsyncKeyState: ['i', (x, vk) => (st.keys.has(vk) ? 0x8001 : 0)],
    GetCursorPos: ['p', (x, p) => { x.w32(p, st.mouseX ?? (st.w >> 1)); x.w32(p + 4, st.mouseY ?? (st.h >> 1)); return 1; }],
    PostQuitMessage: ['i', () => 0],
    GetKeyState: ['i', (x, vk) => (st.keys.has(vk) ? 0x8000 : 0)],
    // The message queue: what the visitor's keys and mouse put there (win32Apis(...).input). MSG is
    // hwnd, message, wParam, lParam, time, pt; PM_REMOVE (1) takes it off the queue.
    PeekMessageA: ['ppuuu', (x, m, hwnd, min, max, remove) => { if (!st.msgs.length) return 0; putMsg(x, m, st.msgs[0]); if (remove & 1) st.msgs.shift(); return 1; }],
    PeekMessageW: ['ppuuu', (x, m, hwnd, min, max, remove) => user32.PeekMessageA[1](x, m, hwnd, min, max, remove)],
    // GetMessageA waits for one, as an idle window does (the call is made again when the time comes);
    // WM_QUIT (12h) makes it return 0.
    GetMessageA: ['ppuu', (x, m) => { if (!st.msgs.length) return x.waitUntil(x.lx.mono() + 0.01); const e = st.msgs.shift(); putMsg(x, m, e); return e.msg === 0x12 ? 0 : 1; }],
    TranslateMessage: ['p', () => 0],
    // DispatchMessageA runs the window's procedure in the program: its four arguments pushed, its return
    // into this stub's `ret 4`, which then returns to the caller with what the procedure returned.
    DispatchMessageA: ['p', (x, m) => {
      const proc = st.wndProc; if (!proc) return 0;
      const c = x.cpu, args = [x.r32(m), x.r32(m + 4), x.r32(m + 8), x.r32(m + 12)];
      let sp = c.reg[4] >>> 0;
      for (const v of [c.eip >>> 0, ...args].reverse()) { sp -= 4; x.w32(sp, v); }
      c.reg[4] = sp; c.eip = proc; return 0;
    }],
    DefWindowProcA: ['puuu', () => 0],
    // WNDCLASSA: lpfnWndProc at 4, lpszClassName at 36; WNDCLASSEXA: at 8 and 40. An atom of its own each.
    RegisterClassA: ['p', (x, wc) => registerClass(x, x.r32(wc + 4), x.r32(wc + 36))],
    RegisterClassExA: ['p', (x, wc) => registerClass(x, x.r32(wc + 8), x.r32(wc + 40))],
    GetSystemMetrics: ['i', (x, n) => (n === 0 ? st.w : n === 1 ? st.h : 0)],
    GetClientRect: ['pp', (x, hwnd, r) => { x.w32(r, 0); x.w32(r + 4, 0); x.w32(r + 8, st.w); x.w32(r + 12, st.h); return 1; }],
    GetWindowRect: ['pp', (x, hwnd, r) => { x.w32(r, 0); x.w32(r + 4, 0); x.w32(r + 8, st.w); x.w32(r + 12, st.h); return 1; }],
    // A message box is not shown; its caption and text go to the log, where an error says what it is.
    MessageBoxA: ['pppu', (x, hwnd, text, cap) => { x.win.say(`MessageBoxA("${cap ? x.str(cap, 128) : ''}"): ${text ? x.str(text, 1024) : ''}`); return 1; }], SetTimer: ['puup', () => 1], ValidateRect: ['pp', () => 1], DestroyWindow: ['p', () => 1],
    LoadCursorA: ['pp', () => 0x10003], LoadIconA: ['pp', () => 0x10002], SetCursor: ['p', () => 0], AdjustWindowRect: ['pui', () => 1],
    wsprintfA: ['ppp', NOT('user32', 'wsprintfA')[1], { cdecl: true }],
    // A program's own windows beyond the first (WinQuake's start-up dialog, made from its resources and
    // destroyed once the game window is up): a handle of their own, never on the screen here.
    CreateDialogParamA: ['pppp' + 'p', () => 0x10020],
    GetActiveWindow: ['', () => st.hwnd], SetActiveWindow: ['p', () => st.hwnd], SetForegroundWindow: ['p', () => 1],
    SetFocus: ['p', () => st.hwnd], EnableWindow: ['pi', () => 0], MessageBeep: ['u', () => 1],
    SetCapture: ['p', () => 0], ReleaseCapture: ['', () => 1], ClipCursor: ['p', () => 1],
    InvalidateRect: ['ppi', () => 1], PostMessageA: ['puuu', () => 1], SendMessageA: ['puuu', () => 0], KillTimer: ['pu', () => 1],
    SetWindowLongA: ['piu', () => 0],
    // WM_PAINT's DC: the window's, the whole client area to paint (PAINTSTRUCT: hdc, fErase, rcPaint).
    BeginPaint: ['pp', (x, hwnd, ps) => { x.write(ps, new Uint8Array(64)); x.w32(ps, st.hdc); x.w32(ps + 16, st.w); x.w32(ps + 20, st.h); return st.hdc; }],
    EndPaint: ['pp', () => 1],
    // WINDOWPLACEMENT: its length at 0, then flags, show state, the two points and the normal rectangle.
    GetWindowPlacement: ['pp', (x, hwnd, p) => { x.write(p, new Uint8Array(44)); x.w32(p, 44); x.w32(p + 8, 1); x.w32(p + 36, st.w); x.w32(p + 40, st.h); return 1; }],
    SetWindowPlacement: ['pp', () => 1],
    // The frame XP's classic style puts round a client area: a 3-pixel border and an 18-pixel caption
    // (WS_CAPTION), a 1-pixel border alone (WS_BORDER) -- what AdjustWindowRectEx adds.
    AdjustWindowRectEx: ['puiu', (x, r, style) => {
      const b = style & 0xc00000 ? 3 : style & 0x800000 ? 1 : 0, cap = (style & 0xc00000) === 0xc00000 ? 19 : 0;
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
    SystemParametersInfoA: ['uupu', (x, what, n, p) => { if (what === 0x30 && p) { x.w32(p, 0); x.w32(p + 4, 0); x.w32(p + 8, st.w); x.w32(p + 12, st.h); } return 1; }],
    // No string resources are read here: an empty string, as for an id the table lacks.
    LoadStringA: ['pupi', (x, inst, id, buf, n) => { if (n > 0) x.write(buf, Uint8Array.of(0)); return 0; }],
    // No message ever arrives here, so it waits its time out (WAIT_TIMEOUT), as an idle window does.
    MsgWaitForMultipleObjects: ['upiuu', (x, n, handles, all, ms) => { if (!ms) return 0x102; const r = x.sleep(Math.min(ms, 1000) / 1000); return r === 0 ? 0x102 : r; }],
  };
  // ---- gdi32 ---------------------------------------------------------------------------------------
  // Text drawn into a bitmap (ExtTextOutA), at the pen (X, Y), the cell's top.
  const textOut = (x, bm, d, m, X, Y, opts, rect, str, n) => {
    const text = x.bytes(str, Math.max(0, n)), bgr = (c) => ((c & 0xff) << 16) | (c & 0xff00) | ((c >>> 16) & 0xff);
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
  // Where a DC's drawing lands, as pixels { w, h, px } and done() to put them where they belong: the
  // screen for the window's DC, the selected bitmap (and a section's memory) for a memory DC.
  const target = (x, hdc) => {
    if (isWindowDC(hdc)) { const sc = screen(); return { ...sc, done: () => { if (x.lx.fbShow && !(sc.w & 7) && sc.w >= 320 && sc.h >= 200) x.lx.fbShow(sc.px, sc.w, sc.h); } }; }
    const bm = st.gdi.get(st.dcBitmaps.get(hdc));
    if (!bm || bm.kind !== 'bitmap' || bm.dib8) return null;          // drawing into an 8-bit section: not here
    if (bm.dib) dibCopy(x, bm, 0, bm.h, bm.dib.bits, bm.dib.bmi, true);
    return { w: bm.w, h: bm.h, px: bm.px, done: () => { if (bm.dib) dibCopy(x, bm, 0, bm.h, bm.dib.bits, bm.dib.bmi, false); } };
  };
  // A DC's pixels to read: (x, y) -> 0x00RRGGBB, or null.
  const source = (x, hdc) => {
    if (isWindowDC(hdc)) { const sc = screen(); return { w: sc.w, h: sc.h, at: (X, Y) => sc.px[Y * sc.w + X] }; }
    const bm = st.gdi.get(st.dcBitmaps.get(hdc));
    if (!bm || bm.kind !== 'bitmap') return null;
    if (bm.dib8) {
      const { bits, stride } = bm.dib8, raw = x.bytes(bits, stride * bm.h), c = bm.colors;
      return { w: bm.w, h: bm.h, at: (X, Y) => c[raw[(bm.up ? bm.h - 1 - Y : Y) * stride + X]] };
    }
    if (bm.dib) dibCopy(x, bm, 0, bm.h, bm.dib.bits, bm.dib.bmi, true);
    return { w: bm.w, h: bm.h, at: (X, Y) => bm.px[Y * bm.w + X] };
  };
  const blit = (x, dst, dx, dy, dw, dh, src, sx, sy, sw, sh) => {
    const s = source(x, src), t = target(x, dst);
    if (!s || !t || !dw || !dh) return 1;
    for (let j = 0; j < Math.abs(dh); j++) {
      const ty = dy + (dh < 0 ? -j : j); if (ty < 0 || ty >= t.h) continue;
      const syy = sy + Math.floor(j * sh / Math.abs(dh)); if (syy < 0 || syy >= s.h) continue;
      for (let i = 0; i < Math.abs(dw); i++) {
        const tx = dx + (dw < 0 ? -i : i); if (tx < 0 || tx >= t.w) continue;
        const sxx = sx + Math.floor(i * sw / Math.abs(dw)); if (sxx < 0 || sxx >= s.w) continue;
        t.px[ty * t.w + tx] = s.at(sxx, syy);
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
      st.lastSwap = now; x.backend.swap(); return 1;
    }],
    // Fonts and device contexts: what a font names and the DC it is selected into, for D3DXCreateText
    // (st.dcFont) to find its outlines among the fonts the page handed over.
    GetStockObject: ['i', () => 0x01900010], DeleteObject: ['p', (x, h) => { st.gdi.delete(h); return 1; }],
    SelectObject: ['pp', (x, hdc, obj) => {
      const o = st.gdi.get(obj);
      if (o && o.kind === 'bitmap') { const prev = st.dcBitmaps.get(hdc) || 0x0185000f; st.dcBitmaps.set(hdc, obj); return prev; }   // DEFAULT_BITMAP's
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
    GetTextExtentPoint32A: ['ppip', (x, hdc, str, n, size) => {
      const m = textMetrics(hdc);
      let w = 0;
      for (const c of x.bytes(str, Math.max(0, n))) w += m.font ? m.font.glyph(c, m.ppem).cellIncX : m.avg;
      x.w32(size, w); x.w32(size + 4, m.height); return 1;
    }],
    ExtTextOutA: ['piiuppip', (x, hdc, X, Y, opts, rect, str, n) => {
      const bm = st.gdi.get(st.dcBitmaps.get(hdc)), d = dcState(hdc), m = textMetrics(hdc);
      if (!bm || bm.kind !== 'bitmap') return 1;
      if (bm.dib) dibCopy(x, bm, 0, bm.h, bm.dib.bits, bm.dib.bmi, true);   // a DIB section: its pixels are the program's memory
      const r = textOut(x, bm, d, m, X, Y, opts, rect, str, n);
      if (bm.dib) dibCopy(x, bm, 0, bm.h, bm.dib.bits, bm.dib.bmi, false);
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
    SetSystemPaletteUse: ['pu', () => 1], GetSystemPaletteUse: ['p', () => 1],   // SYSPAL_STATIC
    // Raster copies: SRCCOPY between DCs (a section selected in a memory DC, the window's own), the
    // stretch by nearest pixels; into the window they reach the screen (lx.fbShow). PatBlt fills
    // BLACKNESS and WHITENESS; other operations copy (WinQuake asks SRCCOPY only).
    BitBlt: ['piiiipiiu', (x, dst, dx, dy, w, h, src, sx, sy) => blit(x, dst, dx, dy, w, h, src, sx, sy, w, h)],
    StretchBlt: ['piiiipiiiiu', (x, dst, dx, dy, dw, dh, src, sx, sy, sw, sh) => blit(x, dst, dx, dy, dw, dh, src, sx, sy, sw, sh)],
    PatBlt: ['piiiiu', (x, hdc, X, Y, w, h, rop) => {
      const c = rop === 0x42 ? 0 : rop === 0xff0062 ? 0xffffff : null;
      if (c === null) return 1;
      const t = target(x, hdc); if (t) { fillRect(t, X, Y, X + w, Y + h, c); t.done(); }
      return 1;
    }],
    CreateFontA: ['iiiiiuuuuuuuup', (x, h, w, esc, orient, weight, italic, underline, strike, charset, outPrec, clipPrec, quality, pitch, face) =>
      st.newHandle('font', { height: h, weight, face: x.str(face, 32) })],
    // LOGFONTA: lfHeight at 0, lfWeight at 16, lfFaceName at 28.
    CreateFontIndirectA: ['p', (x, p) => st.newHandle('font', { height: x.r32(p) | 0, weight: x.r32(p + 16), face: x.str(p + 28, 32) })],
  };
  // ---- opengl32 and glu32: src/hle/gl.js's GL, stdcall; wgl ------------------------------------------
  const opengl32 = { ...(gl || glTable().fns) };
  delete opengl32.glXGetProcAddress; delete opengl32.glXGetProcAddressARB;
  Object.assign(opengl32, {
    wglCreateContext: ['p', () => st.hglrc],
    wglMakeCurrent: ['pp', (x, hdc, ctx) => { if (ctx && !st.mode) { st.mode = true; x.backend.setVideoMode(st.w, st.h, true); } return 1; }],
    wglDeleteContext: ['p', () => 1],
    wglGetProcAddress: ['p', (x, name) => x.win.proc(x.win.modules.get('opengl32.dll'), x.str(name))],
    wglUseFontBitmapsA: ['puuu', () => 1],
    wglSwapLayerBuffers: ['pu', (x) => gdi32.SwapBuffers[1](x)],
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
  const winmm = {
    // No joystick: none counted, and the one asked about is unplugged (JOYERR_UNPLUGGED).
    joyGetNumDevs: ['', () => 0], joyGetDevCapsA: ['upu', () => 167], joyGetPosEx: ['up', () => 167],
    timeGetTime: ['', (x) => ms(x)], timeBeginPeriod: ['u', () => 0], timeEndPeriod: ['u', () => 0],
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
    PlaySoundA: ['ppu', (x, p, mod, flags) => playMemory(x, p, flags)],
    waveOutGetNumDevs: ['', () => 1],
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
    // sprintf(buf, fmt, ...): %d %i %u %x %X %c %s %f %%, with width and precision, the arguments read from
    // the caller's stack after the format (cdecl's varargs: doubles are 8 bytes there).
    sprintf: ['pp', (x, buf, fmt) => {
      let ap = (x.cpu.reg[4] >>> 0) + 12, out = '';
      const f = x.str(fmt);
      for (let i = 0; i < f.length; i++) {
        if (f[i] !== '%') { out += f[i]; continue; }
        const m = /^([-+ 0#]*)(\d*)(?:\.(\d+))?(l|h)?([diuxXcsfg%])/.exec(f.slice(i + 1));
        if (!m) { out += '%'; continue; }
        i += m[0].length;
        const [, flags, width, prec, , c] = m;
        let v;
        if (c === '%') v = '%';
        else if (c === 'f' || c === 'g') { v = x.f64(ap).toFixed(prec === undefined ? 6 : +prec); ap += 8; }
        else if (c === 's') { v = x.str(x.r32(ap)); ap += 4; }
        else if (c === 'c') { v = String.fromCharCode(x.r32(ap) & 255); ap += 4; }
        else { const n = x.r32(ap); ap += 4; v = c === 'x' ? n.toString(16) : c === 'X' ? n.toString(16).toUpperCase() : c === 'u' ? String(n) : String(n | 0); }
        if (width) v = v.padStart(+width, flags.includes('0') && c !== 's' ? '0' : ' ');
        out += v;
      }
      x.write(buf, new TextEncoder().encode(out + '\0'));
      return out.length;
    }, cd],
  };
  const tables = [
    { dll: 'msvcrt.dll', fns: msvcrt },
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
    { dll: 'wsock32.dll', fns: wsock32 },
    // The registry: empty. A key opens as not found (ERROR_FILE_NOT_FOUND), so nothing is read from it
    // or written to it, as on a machine where the program never ran.
    { dll: 'advapi32.dll', fns: { RegOpenKeyExA: ['ppuup', () => 2], RegCreateKeyExA: ['ppupuuppp', () => 2], RegQueryValueExA: ['pppppp', () => 2],
      RegSetValueExA: ['ppuupu', () => 2], RegCloseKey: ['p', () => 0] } },
  ];
  /*
   * The visitor's input, as Windows posts it to the window: a key by its PC scancode (set 1; 0xE0-
   * prefixed keys `ext`) as WM_KEYDOWN / WM_KEYUP (Alt as WM_SYSKEY*), the scancode in lParam's bits
   * 16-23 where WinQuake's MapKey reads it, the virtual key in wParam; the mouse as WM_MOUSEMOVE and
   * button messages, its moves added to the cursor that GetCursorPos reads (WinQuake recentres it
   * with SetCursorPos each frame and turns by the difference).
   */
  tables.input = {
    key(down, scan, ext = false) {
      const vk = scanToVk(scan, ext), alt = vk === 0x12;
      if (down) st.keys.add(vk); else st.keys.delete(vk);
      st.msgs.push({ msg: (alt ? 0x104 : 0x100) + (down ? 0 : 1), wp: vk, lp: (1 | (scan & 0xff) << 16 | (ext ? 1 << 24 : 0) | (down ? 0 : 0xc0000000)) >>> 0 });
    },
    mouseMove(dx, dy) {
      st.mouseX = (st.mouseX ?? st.w >> 1) + dx; st.mouseY = (st.mouseY ?? st.h >> 1) + dy;
      st.msgs.push({ msg: 0x200, wp: st.buttons | 0, lp: ((st.mouseY & 0xffff) << 16 | (st.mouseX & 0xffff)) >>> 0 });
    },
    mouseButton(b, down) {                                          // 0 left, 1 right, 2 middle
      const bit = [1, 2, 0x10][b], msg = [0x201, 0x204, 0x207][b] + (down ? 0 : 1);
      st.buttons = down ? (st.buttons | 0) | bit : (st.buttons | 0) & ~bit;
      st.msgs.push({ msg, wp: st.buttons, lp: ((st.mouseY ?? 0) & 0xffff) << 16 | ((st.mouseX ?? 0) & 0xffff) });
    },
  };
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
 * wsock32.dll, Winsock 1.1 by its ordinals (a program imports these by number): a machine with no
 * network. WSAStartup fails with WSASYSNOTREADY, as on a PC with no TCP/IP installed, and a program
 * gives its network up there -- WinQuake says "Winsock initialization failed" and plays alone. Every
 * socket call fails the same way; byte order and dotted addresses are only arithmetic, and answer.
 */
const NONET = 10091;                                                  // WSASYSNOTREADY
const sw16 = (v) => ((v & 0xff) << 8) | ((v >> 8) & 0xff), sw32 = (v) => (((v & 0xff) << 24) | ((v & 0xff00) << 8) | ((v >>> 8) & 0xff00) | (v >>> 24)) >>> 0;
const wsock32 = {
  accept: ['ppp', () => -1, { ordinal: 1 }], bind: ['ppi', () => -1, { ordinal: 2 }], closesocket: ['p', () => -1, { ordinal: 3 }],
  connect: ['ppi', () => -1, { ordinal: 4 }], getpeername: ['ppp', () => -1, { ordinal: 5 }], getsockname: ['ppp', () => -1, { ordinal: 6 }],
  getsockopt: ['piipp', () => -1, { ordinal: 7 }], htonl: ['u', (x, v) => sw32(v), { ordinal: 8 }], htons: ['u', (x, v) => sw16(v), { ordinal: 9 }],
  inet_addr: ['p', (x, p) => {                                        // "a.b.c.d" in network order, INADDR_NONE otherwise
    const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(x.str(p, 32));
    return m && m.slice(1).every((n) => +n < 256) ? (+m[1] | +m[2] << 8 | +m[3] << 16 | +m[4] << 24) >>> 0 : 0xffffffff;
  }, { ordinal: 10 }],
  inet_ntoa: ['u', (x, a) => {                                        // into one buffer of its own, as Winsock's per-thread one
    const b = new TextEncoder().encode(`${a & 255}.${(a >>> 8) & 255}.${(a >>> 16) & 255}.${a >>> 24}\0`);
    x.ntoaBuf ||= x.win.heapAlloc(16); x.write(x.ntoaBuf, b); return x.ntoaBuf;
  }, { ordinal: 11 }],
  ioctlsocket: ['pip', () => -1, { ordinal: 12 }], listen: ['pi', () => -1, { ordinal: 13 }],
  ntohl: ['u', (x, v) => sw32(v), { ordinal: 14 }], ntohs: ['u', (x, v) => sw16(v), { ordinal: 15 }],
  recv: ['ppii', () => -1, { ordinal: 16 }], recvfrom: ['ppiipp', () => -1, { ordinal: 17 }], select: ['ipppp', () => -1, { ordinal: 18 }],
  send: ['ppii', () => -1, { ordinal: 19 }], sendto: ['ppiipi', () => -1, { ordinal: 20 }], setsockopt: ['piipi', () => -1, { ordinal: 21 }],
  shutdown: ['pi', () => -1, { ordinal: 22 }], socket: ['iii', () => -1, { ordinal: 23 }],
  gethostbyaddr: ['pii', () => 0, { ordinal: 51 }], gethostbyname: ['p', () => 0, { ordinal: 52 }], getprotobyname: ['p', () => 0, { ordinal: 53 }],
  getprotobynumber: ['i', () => 0, { ordinal: 54 }], getservbyname: ['pp', () => 0, { ordinal: 55 }], getservbyport: ['ip', () => 0, { ordinal: 56 }],
  gethostname: ['pi', () => -1, { ordinal: 57 }],
  WSASetBlockingHook: ['p', () => 0, { ordinal: 109 }], WSAUnhookBlockingHook: ['', () => -1, { ordinal: 110 }],
  WSAGetLastError: ['', () => NONET, { ordinal: 111 }], WSASetLastError: ['i', () => 0, { ordinal: 112 }],
  WSACancelBlockingCall: ['', () => -1, { ordinal: 113 }], WSAIsBlocking: ['', () => 0, { ordinal: 114 }],
  WSAStartup: ['up', () => NONET, { ordinal: 115 }], WSACleanup: ['', () => -1, { ordinal: 116 }],
  __WSAFDIsSet: ['pp', () => 0, { ordinal: 151 }],
};
