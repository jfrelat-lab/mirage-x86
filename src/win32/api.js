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
    const face = f.face.toLowerCase(), key = [f.weight >= 600 ? `${face}:bold` : null, face].find((k) => k && fonts[k]);
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
  st.mci = new Map(); st.mciNext = 1; st.mciPlaying = 0;
  st.disk = new Map(Object.entries(files).map(([n, b]) => [n.toLowerCase(), { bytes: b, size: b.length }]));
  const baseName = (p) => p.replace(/^.*[\\/]/, '').toLowerCase();
  const diskFile = (p) => st.disk.get(baseName(p)) || (baseName(p) === 'gm.dls' ? { bytes: null, size: GM_DLS_SIZE } : null);
  const openHandle = (f) => { st.files.push({ f, pos: 0 }); return 0x4000 + st.files.length - 1; };
  const ms = (x) => Math.floor(x.lx.mono() * 1000);
  // ---- kernel32 ----------------------------------------------------------------------------------
  let vaNext = 0x10000000;
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
    HeapAlloc: ['puu', (x, heap, flags, n) => x.win.heapAlloc(n)],
    HeapFree: ['pup', () => 1],
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
      if (h < 0x2000 || h >= 0x3000) return 0;
      if (x.lx.threadExits.has(h - 0x2000)) return 0;                 // WAIT_OBJECT_0
      if (ms === 0) return 0x102;                                     // WAIT_TIMEOUT
      return x.waitUntil(x.lx.mono() + 0.001);                        // waits, a millisecond at a time, the others running
    }],
    GetExitCodeThread: ['pp', (x, h, p) => { const c = x.lx.threadExits.get(h - 0x2000); x.w32(p, c === undefined ? 259 : c); return 1; }],   // STILL_ACTIVE
    TerminateThread: ['pu', () => 1], ResumeThread: ['p', () => 1], SuspendThread: ['p', () => 0],
    GetCurrentThreadId: ['', (x) => x.lx.pid], GetCurrentProcessId: ['', () => 0x100],
    SetThreadPriority: ['pi', () => 1], SetPriorityClass: ['pu', () => 1], GetCurrentThread: ['', () => 0xfffffffe], GetCurrentProcess: ['', () => 0xffffffff],
    GetCommandLineA: ['', (x) => (st.cmd ||= (() => { const p = x.win.heapAlloc(x.win.path.length + 3); x.write(p, new TextEncoder().encode(`"${x.win.path}"\0`)); return p; })())],
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
  };
  // ---- user32 --------------------------------------------------------------------------------------
  const user32 = {
    // The window: one, the size it was made or the display mode set; its DC and GL go to the backend.
    CreateWindowExA: ['upppiiiippp' + 'p', (x, ex, cls, title, style, X, Y, w, h) => { if (w > 0 && h > 0 && w < 8192 && h < 8192) { st.w = w; st.h = h; } return st.hwnd; }],
    CreateWindowExW: ['upppiiiippp' + 'p', (x, ex, cls, title, style, X, Y, w, h) => { if (w > 0 && h > 0 && w < 8192 && h < 8192) { st.w = w; st.h = h; } return st.hwnd; }],
    ChangeDisplaySettingsA: ['pu', (x, dm) => { if (dm) { st.w = x.r32(dm + 108) || st.w; st.h = x.r32(dm + 112) || st.h; } return 0; }],   // DEVMODEA's dmPelsWidth, dmPelsHeight
    GetDC: ['p', () => st.hdc], ReleaseDC: ['pp', () => 1],
    ShowCursor: ['i', () => 0], SetCursorPos: ['ii', () => 1], ShowWindow: ['pi', () => 1], UpdateWindow: ['p', () => 1], SetWindowPos: ['ppiiiiu', () => 1],
    GetAsyncKeyState: ['i', (x, vk) => (st.keys.has(vk) ? 0x8001 : 0)],
    GetKeyState: ['i', (x, vk) => (st.keys.has(vk) ? 0x8000 : 0)],
    PeekMessageA: ['ppuuu', () => 0], PeekMessageW: ['ppuuu', () => 0],
    GetMessageA: ['ppuu', () => 1], TranslateMessage: ['p', () => 0], DispatchMessageA: ['p', () => 0],
    DefWindowProcA: ['puuu', () => 0], RegisterClassA: ['p', () => 0xc001], RegisterClassExA: ['p', () => 0xc001],
    GetSystemMetrics: ['i', (x, n) => (n === 0 ? st.w : n === 1 ? st.h : 0)],
    GetClientRect: ['pp', (x, hwnd, r) => { x.w32(r, 0); x.w32(r + 4, 0); x.w32(r + 8, st.w); x.w32(r + 12, st.h); return 1; }],
    GetWindowRect: ['pp', (x, hwnd, r) => { x.w32(r, 0); x.w32(r + 4, 0); x.w32(r + 8, st.w); x.w32(r + 12, st.h); return 1; }],
    MessageBoxA: ['pppu', () => 1], SetTimer: ['puup', () => 1], ValidateRect: ['pp', () => 1], DestroyWindow: ['p', () => 1],
    LoadCursorA: ['pp', () => 0x10003], LoadIconA: ['pp', () => 0x10002], SetCursor: ['p', () => 0], AdjustWindowRect: ['pui', () => 1],
    wsprintfA: ['ppp', NOT('user32', 'wsprintfA')[1], { cdecl: true }],
  };
  // ---- gdi32 ---------------------------------------------------------------------------------------
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
    GetStockObject: ['i', () => 0x01900010], DeleteObject: ['p', () => 1],
    SelectObject: ['pp', (x, hdc, obj) => {
      if (!st.gdi.has(obj) || st.gdi.get(obj).kind !== 'font') return 0x01900010;
      const prev = st.dcFonts.get(hdc) || 0x018a0021;                 // the DC's first font: SYSTEM_FONT's
      st.dcFonts.set(hdc, obj); return prev;
    }],
    CreateCompatibleDC: ['p', () => st.newHandle('dc', {})], DeleteDC: ['p', () => 1],
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
    malloc: ['u', (x, n) => x.win.heapAlloc(n), cd], calloc: ['uu', (x, n, k) => x.win.heapAlloc(n * k), cd], free: ['p', () => 0, cd],
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
  return [
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
  ];
}
