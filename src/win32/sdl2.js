// sdl2.js — SDL2.dll and SDL2_mixer.dll for MIRAGE-WIN32, made in JavaScript (machine.hle "sdl2"): PRISM's
// SDL 2 and SDL_mixer (vendor/prism/src/env/sdl2.js, sdl2-surface.js, sdlmixer.js -- one SDL for both
// projects, ROADMAP O9) on the program's own memory, and here what PRISM's page does for its programs: a
// Windows window to show the frames in, and the window's messages as SDL's events. An image that does not
// name it runs the SDL2.dll beside the program, in x86, as before -- the reference this one is held to.
//
// The functions are PRISM's, their signatures (how to read the caller's stack) too: sdl2Builtins,
// surfaceBuiltins, imageBuiltins and mixerBuiltins, the declarations PRISM's compiler takes, read here as
// cdecl stacks. What a Windows program needs and PRISM's programs do not is made here (WINDOW below):
//
//   SDL_CreateWindow    a top-level window of MIRAGE-WIN32's (CreateWindowEx, no window procedure: the
//                       messages are SDL's to take), its client area the size asked; FULLSCREEN and
//                       FULLSCREEN_DESKTOP a popup the size of the screen, as SDL's Windows driver makes them
//   SDL_RenderPresent   the frame PRISM publishes, stretched over the renderer's viewport as SDL's software
//                       renderer stretches it, into the window's pixels
//   SDL_RenderGetScale, SDL_RenderGetViewport  SDL 2.0.22's logical size (UpdateLogicalSize): the scale a
//                       float, the viewport in logical units -- Abuse maps its mouse by them
//   SDL_PollEvent       the window's messages first (PeekMessage, as SDL_PumpEvents does): keys by their
//                       scancode, the mouse in window coordinates for SDL_GetMouseState and in logical ones
//                       in the events (SDL_RendererEventWatch), the wheel, WM_CLOSE as SDL_QUIT
//   SDL_UpperBlit       an 8-bit surface onto a 32-bit one a row at a time (PRISM's, a byte at a time, otherwise)
//   SDL_WarpMouseInWindow, SDL_ShowCursor, SDL_Delay, SDL_GetWindowDisplayMode, SDL_ShowSimpleMessageBox
//
//   The audio device, timers, threads: SDL's own threads as threads of the program's (CreateThread's), each
//                       running a few instructions made here that wait in a trap and call the program's
//                       function (src/hle/sdl12.js's loops): the device's callback, or its queue
//                       (SDL_QueueAudio), played on the machine's card (lx.dspPlay); SDL_mixer's buffers,
//                       mixed by PRISM on the guest's clock, played the same way; mutexes, semaphores,
//                       condition variables and atomics for those threads
//   Window events: SHOWN, EXPOSED, FOCUS_GAINED when made; SIZE_CHANGED and RESIZED when its client area changes
//
// Not made: a program's own RWops (PRISM calls their functions through M.icall, which stops here, named),
// Mix_SetPostMix's hook, music, SDL_SaveBMP's file.
import { prismM } from '../hle/prism-gl.js';
import { audioLoop, threadCall, timerLoop } from '../hle/sdl12.js';
import { HLE_BASE } from '../hle/elfso.js';

const WS_POPUP = 0x80000000, WS_VISIBLE = 0x10000000, STYLE_NORMAL = 0x00ca0000;   // WS_OVERLAPPED|CAPTION|SYSMENU|MINIMIZEBOX
const STYLE_RESIZABLE = 0x00050000, SDL_WINDOW_RESIZABLE = 0x20;                    // WS_THICKFRAME|MAXIMIZEBOX, SDL's
const SDL_WINDOW_FULLSCREEN = 0x1, SDL_WINDOWPOS_MASK = 0xffff0000, SDL_WINDOWPOS_UNDEFINED = 0x1fff0000, SDL_WINDOWPOS_CENTERED = 0x2fff0000;
const SDL_QUIT = 0x100, SDL_WINDOWEVENT = 0x200, SDL_MOUSEMOTION = 0x400, SDL_MOUSEBUTTONUP = 0x402, SDL_MOUSEWHEEL = 0x403;

/** A PRISM type as MIRAGE's signature letter(s): 'p' a pointer, 'i'/'u' a 32-bit integer, 'f'/'d', 'uu' 64 bits. */
const LETTER = { INT: 'i', LONG: 'i', SHORT: 'i', CHAR: 'i', SCHAR: 'i', UINT: 'u', ULONG: 'u', USHORT: 'u', UCHAR: 'u', BOOL: 'u', FLOAT: 'f', DOUBLE: 'd', LLONG: 'uu', ULLONG: 'uu' };
const T = new Proxy({}, { get: (_, k) => (k === 'ptr' ? () => 'PTR' : String(k)) });
const letter = (t) => (t === 'PTR' ? 'p' : LETTER[t]);

/**
 * Which source pixel each of `dst` pixels takes when `src` are stretched over them: SDL 2.0.22's nearest
 * stretch (SDL_stretch.c), a 16.16 step of src/dst from half a step in -- not floor(i * src / dst).
 */
export function stretchSteps(src, dst) {
  const inc = Math.floor(src * 65536 / dst), out = new Int32Array(Math.max(dst, 0));
  for (let i = 0, pos = inc >> 1; i < dst; i++, pos += inc) out[i] = Math.floor(pos / 65536);
  return out;
}

/**
 * The DLLs an image's machine.hle names for MIRAGE-WIN32 ("sdl2": SDL2.dll and SDL2_mixer.dll), each a
 * function of win32Apis' context giving its tables (win32Apis' `hle`).
 */
export async function win32HleDlls(names = [], lx, mem) {
  const unknown = names.find((n) => n !== 'sdl2');
  if (unknown) throw new Error(`machine.hle: no Windows library '${unknown}' (sdl2)`);
  return names.length ? [await sdl2Dlls(lx, mem)] : [];
}

/**
 * The DLLs, once PRISM's modules are loaded: a function of win32Apis' context ({ st, user32, target })
 * giving the two tables. `lx`, `mem`: the machine's (PRISM's M is made over its memory).
 */
export async function sdl2Dlls(lx, mem) {
  const [sdl2, surface, image, mixer] = await Promise.all([
    import('../../vendor/prism/src/env/sdl2.js'), import('../../vendor/prism/src/env/sdl2-surface.js'),
    import('../../vendor/prism/src/env/sdl2-image.js'), import('../../vendor/prism/src/env/sdlmixer.js')]);
  return (w32) => makeDlls(lx, mem, w32, { sdl2, surface, image, mixer });
}

function makeDlls(lx, mem, { st, user32, target, formatC }, { sdl2, surface, image, mixer }) {
  const enc = new TextEncoder();
  let x = null;                                                    // the context of the call being answered
  const M = prismM(lx, mem);
  // The program's heap for PRISM's allocations (surfaces, textures, chunks), freed when SDL frees them.
  Object.assign(M.rt, {
    malloc: (n) => x.win.heapAlloc(n), free: (p) => { if (p) x.win.heapFree(p); },
    calloc: (n, size) => { const p = x.win.heapAlloc(n * size); x.write(p, new Uint8Array(n * size)); return p; },
    memset: (p, c, n) => { x.write(p, new Uint8Array(n).fill(c)); return p; }, strlen: (p) => x.str(p).length,
  });
  M.write = (s) => { if (lx.onOutput) lx.onOutput(2, enc.encode(s)); };
  M.icall = (fn) => { throw new Error(`SDL2.dll: a call into the program (its function at ${(fn >>> 0).toString(16)}h) is not made in MIRAGE's SDL yet`); };
  // SDL's clock: the guest's, in milliseconds.
  const clock = { now: () => Math.floor(lx.mono() * 1000), delay: () => {}, peek: () => Math.floor(lx.mono() * 1000) };

  // ---- the window ------------------------------------------------------------------------------------
  const win = { hwnd: 0, flags: 0, w: 0, h: 0, cursor: 1, buttons: 0, mx: 0, my: 0, msg: 0, rect: 0, mod: 0 };
  const scratch = () => { if (!win.rect) { win.rect = x.win.heapAlloc(16); win.msg = x.win.heapAlloc(28); } };
  const client = () => { scratch(); user32.GetClientRect[1](x, win.hwnd, win.rect); return { w: x.r32(win.rect + 8) | 0, h: x.r32(win.rect + 12) | 0 }; };
  // SDL 2.0.22's UpdateLogicalSize (no integer scale): the scale a float, the viewport in pixels.
  const geometry = () => {
    const out = client(), lw = sdl.state.logicalW | 0, lh = sdl.state.logicalH | 0;
    if (!lw || !lh) return { scale: 1, vp: { x: 0, y: 0, w: out.w, h: out.h }, out };
    const want = lw / lh, real = out.w / out.h;
    if (Math.abs(want - real) < 0.0001) return { scale: Math.fround(out.w / lw), vp: { x: 0, y: 0, w: out.w, h: out.h }, out };
    if (want > real) { const s = Math.fround(out.w / lw), h = Math.floor(lh * s); return { scale: s, vp: { x: 0, y: ((out.h - h) / 2) | 0, w: out.w, h }, out }; }
    const s = Math.fround(out.h / lh), w = Math.floor(lw * s);
    return { scale: s, vp: { x: ((out.w - w) / 2) | 0, y: 0, w, h: out.h }, out };
  };
  const screen = () => ({ w: user32.GetSystemMetrics[1](x, 0), h: user32.GetSystemMetrics[1](x, 1) });
  const fullscreen = (flags) => (flags & SDL_WINDOW_FULLSCREEN) !== 0;
  // Where the window goes and how it looks, as WIN_CreateWindow and WIN_SetWindowFullscreen put it.
  const place = (flags, X, Y, w, h) => {
    if (fullscreen(flags)) { const s = screen(); return { style: WS_POPUP | WS_VISIBLE, X: 0, Y: 0, W: s.w, H: s.h }; }
    const s = screen(), style = STYLE_NORMAL | (flags & SDL_WINDOW_RESIZABLE ? STYLE_RESIZABLE : 0) | WS_VISIBLE;
    const pos = (v, room, n) => ((v & SDL_WINDOWPOS_MASK) === SDL_WINDOWPOS_UNDEFINED || (v & SDL_WINDOWPOS_MASK) === SDL_WINDOWPOS_CENTERED ? ((room - n) / 2) | 0 : v | 0);
    scratch(); x.write(win.rect, new Uint8Array(16)); x.w32(win.rect + 8, w); x.w32(win.rect + 12, h);
    user32.AdjustWindowRectEx[1](x, win.rect, style, 0, 0);
    const l = x.r32(win.rect) | 0, t = x.r32(win.rect + 4) | 0, r = x.r32(win.rect + 8) | 0, b = x.r32(win.rect + 12) | 0;
    return { style, X: pos(X, s.w, w) + l, Y: pos(Y, s.h, h) + t, W: r - l, H: b - t };
  };

  // ---- the window's messages, as SDL's events ---------------------------------------------------------
  const raw = (type) => { const e = new Uint8Array(56), d = new DataView(e.buffer); d.setUint32(0, type, true); d.setUint32(4, clock.now() >>> 0, true); return { e, d }; };
  // A mouse event's coordinates in the renderer's logical units (SDL_RendererEventWatch).
  const toLogical = (from) => {
    const g = geometry();
    for (const e of sdl.state.events.slice(from)) {
      const d = new DataView(e.buffer), type = d.getUint32(0, true);
      if (type < SDL_MOUSEMOTION || type > SDL_MOUSEBUTTONUP) continue;
      d.setInt32(20, Math.trunc((d.getInt32(20, true) - g.vp.x) / g.scale), true); d.setInt32(24, Math.trunc((d.getInt32(24, true) - g.vp.y) / g.scale), true);
      if (type === SDL_MOUSEMOTION) { d.setInt32(28, Math.trunc(d.getInt32(28, true) / g.scale), true); d.setInt32(32, Math.trunc(d.getInt32(32, true) / g.scale), true); }
    }
  };
  const BUTTON = { 0x201: [1, 1], 0x202: [1, 0], 0x204: [4, 1], 0x205: [4, 0], 0x207: [2, 1], 0x208: [2, 0] };
  // SIZE_CHANGED then RESIZED (SDL_OnWindowResized's order) when the client area is not what it was.
  const windowEvent = (ev, d1 = 0, d2 = 0) => { const { e, d } = raw(SDL_WINDOWEVENT); d.setUint32(8, 1, true); e[12] = ev; d.setInt32(16, d1, true); d.setInt32(20, d2, true); sdl.state.events.push(e); };
  const checkSize = () => { const c = client(); if (c.w === win.cw && c.h === win.ch) return; win.cw = c.w; win.ch = c.h; windowEvent(6, c.w, c.h); windowEvent(5, c.w, c.h); };
  const pumpMessages = () => {
    if (!win.hwnd) return;
    scratch();
    checkSize();
    for (let n = 0; n < 256 && user32.PeekMessageA[1](x, win.msg, 0, 0, 0, 1) === 1; n++) {
      const hwnd = x.r32(win.msg), m = x.r32(win.msg + 4), wp = x.r32(win.msg + 8), lp = x.r32(win.msg + 12);
      if (m === 0x0f) { user32.ValidateRect[1](x, hwnd, 0); continue; }                 // WM_PAINT: the next frame draws it
      if (m === 0x10 || m === 0x12) { sdl.state.events.push(raw(SDL_QUIT).e); continue; }  // WM_CLOSE, WM_QUIT
      if (m === 0x100 || m === 0x101 || m === 0x104 || m === 0x105) {                   // WM_(SYS)KEYDOWN/UP
        const from = sdl.state.events.length, down = !(m & 1);
        sdl.pushScan((lp >>> 16) & 0xff, (lp >>> 24) & 1, down);
        const last = sdl.state.events[sdl.state.events.length - 1];
        if (sdl.state.events.length > from && last) win.mod = new DataView(last.buffer).getUint16(24, true);   // the modifiers it reported
        if (down && (lp & 0x40000000)) for (const e of sdl.state.events.slice(from)) e[13] = 1;   // keysym's repeat
        if (down) user32.TranslateMessage[1](x, win.msg);
        continue;
      }
      if (m === 0x102) { if (wp >= 32 && wp !== 127) sdl.pushText(String.fromCharCode(wp)); continue; }   // WM_CHAR: SDL_TEXTINPUT
      if (m === 0x20a) {                                                                 // WM_MOUSEWHEEL
        const { e, d } = raw(SDL_MOUSEWHEEL), dy = Math.trunc(((wp >> 16) << 16 >> 16) / 120);
        d.setUint32(8, 1, true); d.setInt32(20, dy, true); d.setFloat32(32, dy, true);
        if (dy) sdl.state.events.push(e);
        continue;
      }
      if (m === 0x200 || BUTTON[m]) {
        const X = (lp << 16) >> 16, Y = lp >> 16, from = sdl.state.events.length;
        if (BUTTON[m]) { const [bit, down] = BUTTON[m]; win.buttons = down ? win.buttons | bit : win.buttons & ~bit; }
        sdl.pushMouse(X, Y, X - win.mx, Y - win.my, win.buttons);
        win.mx = X; win.my = Y;
        toLogical(from);
      }
    }
  };

  // ---- the frame ------------------------------------------------------------------------------------------
  // The software renderer's SDL_RenderCopy of the whole texture over the viewport: SDL 2.0.22's nearest
  // stretch (SDL_stretch.c), 16.16 steps from half a step in, written into the window's pixels.
  const present = (frame) => {
    if (!win.hwnd || frame.bpp !== 4) return;
    const g = geometry(), hdc = user32.GetDC[1](x, win.hwnd), t = target(x, hdc);
    if (!t) return;
    const { px } = t, src = frame.bytes, pitch = frame.pitch, vp = g.vp;
    if (vp.w !== t.w || vp.h !== t.h) px.fill(0);                      // a letterboxed picture's bars
    const cols = stretchSteps(frame.w, vp.w), rows = stretchSteps(frame.h, vp.h);
    for (let j = 0; j < vp.h; j++) {
      const Y = vp.y + j; if (Y < 0 || Y >= t.h) continue;
      const row = rows[j] * pitch, out = Y * t.w;
      for (let i = 0; i < vp.w; i++) {
        const X = vp.x + i; if (X < 0 || X >= t.w) continue;
        const o = row + 4 * cols[i];
        px[out + X] = (src[o + 2] << 16 | src[o + 1] << 8 | src[o]) >>> 0;
      }
    }
    t.done();
  };

  const sdl = sdl2.installSDL2(M, { clock, onPresent: (frame) => present(frame) });
  // The mixer reads a stream as SDL_RWops: its size, then its bytes from the start (PRISM's own SDL 2
  // environment gives it no reader, and Mix_LoadWAV_RW loaded nothing).
  const readRW = (rw) => {
    const n = Number(M.rt.SDL_RWsize(rw)); if (!(n > 0)) return null;
    const p = x.win.heapAlloc(n);
    try { M.rt.SDL_RWseek(rw, 0, 0); const got = Number(M.rt.SDL_RWread(rw, p, 1, n)) >>> 0; return x.bytes(p, got); } finally { x.win.heapFree(p); }
  };
  const mix = { ...mixer.MIXER_STATE, clock };
  Object.assign(M.rt, mixer.mixerApi(M, mix, { readRW }));

  /*
   * SDL_UpperBlit's commonest case made a row at a time: a whole 8-bit paletted surface onto a 32-bit one of
   * its size, nothing applied (no colour key, no blending, no alpha modulation, the destination's clip the
   * whole of it) -- Abuse's screen, every frame. PRISM's lowerBlit makes it a byte at a time through M.u8,
   * which over MIRAGE's paged memory (src/hle/prism-gl.js's Proxy) took four fifths of the run; the same
   * pixels, as PRISM's encode() makes them, a row read and a row written. Any other blit is PRISM's.
   * tools/test.js holds the two to the same bytes.
   */
  const fastBlit = (src, srcrect, dst, dstrect) => {
    if (!src || !dst || srcrect || dstrect) return null;
    const r = (p) => x.r32(p) >>> 0, i = (p) => x.r32(p) | 0;
    const w = i(src + 8), h = i(src + 12), sp = i(src + 16), spx = r(src + 20), sf = r(src + 4);
    const dw = i(dst + 8), dh = i(dst + 12), dp = i(dst + 16), dpx = r(dst + 20), df = r(dst + 4);
    if (w !== dw || h !== dh || w <= 0 || h <= 0) return null;
    if (i(dst + 36) || i(dst + 40) || i(dst + 44) !== w || i(dst + 48) !== h) return null;
    const side = sdl.state.surfaceSide && sdl.state.surfaceSide.get(src);
    if (side && (side.colorKey !== null || side.blend !== 0 || side.alphaMod !== 255)) return null;
    const pal = r(sf + 4);
    if (x.r8(sf + 9) !== 1 || !pal || r(sf + 12) || x.r8(df + 9) !== 4 || !r(df + 12)) return null;
    const shift = (m) => { let k = 0; if (m) while (!((m >>> k) & 1)) k++; return k; };
    const R = r(df + 12), G = r(df + 16), B = r(df + 20), A = r(df + 24), rs = shift(R), gs = shift(G), bs = shift(B), as = shift(A);
    const colors = x.bytes(r(pal + 4), 1024), lut = new Uint32Array(256);
    for (let k = 0; k < 256; k++) {
      const c = 4 * k;
      lut[k] = (((colors[c] << rs) & R) | ((colors[c + 1] << gs) & G) | ((colors[c + 2] << bs) & B) | (A ? (colors[c + 3] << as) & A : 0)) >>> 0;
    }
    const out = new Uint8Array(w * 4), o32 = new Uint32Array(out.buffer);
    for (let y = 0; y < h; y++) {
      const row = x.bytes(spx + y * sp, w);
      for (let k = 0; k < w; k++) o32[k] = lut[row[k]];
      x.write(dpx + y * dp, out);
    }
    return 0;
  };

  // ---- SDL's threads, as the program's ---------------------------------------------------------------------
  // A thread made here: `bytes` of guest code (sdl12.js's loops) in the program's heap, run by CreateThread's
  // machinery (its TEB, its stack). The traps they call are this DLL's functions without a name.
  const trap = (name) => x.idOf(`SDL2.dll!${name}`);
  const thread = (bytes) => { const code = x.win.heapAlloc(bytes.length); x.write(code, Uint8Array.from(bytes)); return x.win.createThread(code, 0); };
  const BLOCK = () => lx.BLOCK;
  const wait = (s) => x.waitUntil(lx.mono() + s);

  // The audio devices: id 1 SDL_OpenAudio's, 2 and up SDL_OpenAudioDevice's. A device with a callback runs
  // audioLoop (play the buffer, then call callback(userdata, buf, len) for the next); one without, a loop
  // that plays what SDL_QueueAudio queued. The card takes 8- and 16-bit samples: F32 and S32 are made 16-bit.
  const AUDIO_U8 = 0x0008, AUDIO_S16LSB = 0x8010, AUDIO_S32LSB = 0x8020, AUDIO_F32LSB = 0x8120;
  const devices = new Map(); let nextDevice = 2;
  const openAudio = (id, desired, obtained, allowed) => {
    const freq = x.r32(desired) | 0 || 22050, want = x.r16(desired + 4), chans = x.r8(desired + 6) || 2;
    let format = want;
    if (![AUDIO_U8, AUDIO_S16LSB, AUDIO_S32LSB, AUDIO_F32LSB].includes(format)) { if (!obtained || !(allowed & 2)) return -1; format = AUDIO_S16LSB; }
    const channels = chans <= 2 ? chans : obtained && (allowed & 4) ? 2 : 0;
    if (!channels) return -1;
    let samples = x.r16(desired + 8); if (!samples) { samples = 1; while (samples < freq / 23) samples <<= 1; }   // SDL's default: some 46 ms
    const bytes = (format & 0xff) >> 3, size = samples * channels * bytes, silence = format === AUDIO_U8 ? 0x80 : 0;
    const d = { id, freq, format, channels, samples, size, silence, callback: x.r32(desired + 16), userdata: x.r32(desired + 20), paused: true, queue: [], queued: 0 };
    d.buf = x.win.heapAlloc(size); x.write(d.buf, new Uint8Array(size).fill(silence));
    const out = obtained || desired;                                 // SDL writes the spec it opened back
    x.w32(out, freq); x.w16(out + 4, format); x.w8(out + 6, channels); x.w8(out + 7, silence); x.w16(out + 8, samples); x.w32(out + 12, size);
    lx.dspFormat(freq, format === AUDIO_U8 ? 8 : 0x10, channels);
    devices.set(id, d);
    d.tid = thread(d.callback ? audioLoop(trap('MIRAGE_audio'), size, d.buf, d.userdata, d.callback)
      : [0x68, ...le(id), 0x68, ...le(id), 0xb8, ...le(HLE_BASE + trap('MIRAGE_audioQueue')), 0xcd, 0x80, 0x83, 0xc4, 0x08, 0xeb, 0x100 - 22]);
    return 0;
  };
  // What the card is given: 8 or 16 bits as they are, 32-bit samples made 16-bit.
  const toCard = (d, b) => {
    if (d.format !== AUDIO_F32LSB && d.format !== AUDIO_S32LSB) return b;
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength), n = b.length >> 2, o = new Int16Array(n);
    for (let i = 0; i < n; i++) o[i] = d.format === AUDIO_F32LSB ? Math.max(-32768, Math.min(32767, Math.round(v.getFloat32(4 * i, true) * 32767))) : v.getInt32(4 * i, true) >> 16;
    return new Uint8Array(o.buffer);
  };
  const closeAudio = (id) => { const d = devices.get(id); if (!d) return; lx.killThread(d.tid); x.win.heapFree(d.buf); devices.delete(id); };
  const status = (id) => { const d = devices.get(id); return !d ? 0 : d.paused ? 2 : 1; };   // SDL_AUDIO_STOPPED, PLAYING, PAUSED
  const le = (v) => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];

  // Timers: timerLoop's thread each, `rec` (the interval, then what the callback returned) its id.
  const timers = new Map();
  // Mutexes { owner, count }, semaphores { count }, conditions { seq }, by their block; a thread waiting keeps
  // where it is in `waits` (a wait is its call made again until it may go on).
  const sync = new Map(), waits = new Map();
  const lock = (m) => { const o = sync.get(m); if (!o) return -1; if (o.owner && o.owner !== lx.pid) return null; o.owner = lx.pid; o.count++; return 0; };
  const unlock = (m) => { const o = sync.get(m); if (!o || o.owner !== lx.pid) return -1; if (!--o.count) o.owner = 0; return 0; };
  // SDL_CondWait(TimeOut): the mutex let go, a signal waited for (or the time), the mutex taken again.
  const condWait = (c, m, ms) => {
    const k = lx.pid, cv = sync.get(c); if (!cv) return -1;
    let w = waits.get(k);
    if (!w || w.c !== c) { w = { c, seq: cv.seq, until: ms >= 0 ? lx.mono() + ms / 1000 : Infinity, phase: 0, count: 0 }; waits.set(k, w); const o = sync.get(m); w.count = o ? o.count : 0; if (o) { o.owner = 0; o.count = 0; } }
    if (w.phase === 0) {
      if (cv.seq === w.seq && lx.mono() < w.until) return w.until === Infinity ? wait(0.001) : x.waitUntil(Math.min(w.until, lx.mono() + 0.001));
      w.phase = 1; w.timedOut = cv.seq === w.seq;
    }
    const o = sync.get(m);
    if (o && o.owner && o.owner !== k) return wait(0.001);
    if (o) { o.owner = k; o.count = w.count || 1; }
    waits.delete(k);
    return w.timedOut ? 1 : 0;                                       // SDL_MUTEX_TIMEDOUT
  };
  const semWait = (sem, ms) => {
    const o = sync.get(sem); if (!o) return -1;
    if (o.count > 0) { o.count--; waits.delete(lx.pid); return 0; }
    if (ms === 0) return 1;
    let w = waits.get(lx.pid); if (!w || w.sem !== sem) waits.set(lx.pid, w = { sem, until: ms > 0 ? lx.mono() + ms / 1000 : Infinity });
    if (lx.mono() >= w.until) { waits.delete(lx.pid); return 1; }
    return x.waitUntil(Math.min(w.until, lx.mono() + 0.001));
  };
  // SDL_mixer's buffers: mixed by PRISM as the guest's clock makes them due (its pump), each queued for the
  // card by a thread of its own that plays them as the card takes them.
  let mixer_ = null;
  mix.onMixed = (buf, len) => { if (mixer_) { mixer_.queue.push(x.bytes(buf, len)); if (mixer_.queue.length > 16) mixer_.queue.shift(); } };

  const THREADS = {
    SDL_OpenAudio: ['pp', (desired, obtained) => { if (devices.has(1)) return -1; return openAudio(1, desired, obtained, 0); }],
    SDL_OpenAudioDevice: ['pipi' + 'i', (name, capture, desired, obtained, allowed) => { if (capture) return 0; const id = nextDevice++; return openAudio(id, desired, obtained, allowed) ? 0 : id; }],
    SDL_PauseAudio: ['i', (on) => { const d = devices.get(1); if (d) d.paused = !!on; }],
    SDL_PauseAudioDevice: ['ui', (id, on) => { const d = devices.get(id); if (d) d.paused = !!on; }],
    SDL_CloseAudio: ['', () => closeAudio(1)], SDL_CloseAudioDevice: ['u', (id) => closeAudio(id)],
    SDL_GetAudioStatus: ['', () => status(1)], SDL_GetAudioDeviceStatus: ['u', (id) => status(id)],
    // The callback runs only between the traps of its thread, and threads change only at system calls: a
    // lock has nothing to wait for.
    SDL_LockAudio: ['', () => {}], SDL_UnlockAudio: ['', () => {}], SDL_LockAudioDevice: ['u', () => {}], SDL_UnlockAudioDevice: ['u', () => {}],
    SDL_QueueAudio: ['upu', (id, data, len) => { const d = devices.get(id); if (!d || d.callback) return -1; if (len) { d.queue.push(x.bytes(data, len)); d.queued += len; } return 0; }],
    SDL_GetQueuedAudioSize: ['u', (id) => { const d = devices.get(id); return d && !d.callback ? d.queued : 0; }],
    SDL_ClearQueuedAudio: ['u', (id) => { const d = devices.get(id); if (d) { d.queue = []; d.queued = 0; } }],
    // audioLoop's trap: the buffer the callback filled to the card (waiting while it is full), then silence
    // in it for the next call, as SDL clears the stream before each.
    MIRAGE_audio: ['', () => {
      const d = [...devices.values()].find((v) => v.tid === lx.pid);
      if (!d || d.paused) return wait(0.01);
      const r = lx.dspPlay(toCard(d, x.bytes(d.buf, d.size)));
      if (r === BLOCK()) return r;
      x.write(d.buf, new Uint8Array(d.size).fill(d.silence));
      return 0;
    }],
    MIRAGE_audioQueue: ['u', (id) => {
      const d = devices.get(id);
      if (!d || d.paused || !d.queue.length) return wait(0.005);
      const r = lx.dspPlay(toCard(d, d.queue[0]));
      if (r === BLOCK()) return r;
      d.queued -= d.queue.shift().length;
      return 0;
    }],
    MIRAGE_mixer: ['u', () => {
      mix.pump();
      if (!mixer_ || !mixer_.queue.length) return wait(0.005);
      const r = lx.dspPlay(mixer_.queue[0]);
      if (r === BLOCK()) return r;
      mixer_.queue.shift();
      return 0;
    }],
    // SDL_AddTimer(interval, callback, param): timerLoop until the callback returns 0 or SDL_RemoveTimer.
    SDL_AddTimer: ['upp', (interval, callback, param) => {
      const rec = x.win.heapAlloc(8); x.w32(rec, interval);
      timers.set(rec, { due: lx.mono() + interval / 1000, removed: false });
      thread(timerLoop(trap('MIRAGE_timer'), trap('MIRAGE_threadExit'), rec, callback, param));
      return rec;
    }],
    SDL_RemoveTimer: ['p', (rec) => { const t = timers.get(rec); if (!t || t.removed) return 0; t.removed = true; return 1; }],
    MIRAGE_timer: ['p', (rec) => {
      const t = timers.get(rec), ms = x.r32(rec);
      if (!t || t.removed || !ms) { timers.delete(rec); return 1; }
      if (lx.mono() < t.due) return x.waitUntil(t.due);
      t.due = lx.mono() + ms / 1000;
      return 0;
    }],
    MIRAGE_threadExit: ['i', (code) => { lx.exitThread(code); return 0; }],
    // SDL_CreateThread(fn, name, data, beginthread, endthread) -- Windows' SDL passes the C runtime's two --
    // and SDL_CreateThreadWithStackSize: fn(data) on a thread of the program's; SDL_Thread* holds its id.
    SDL_CreateThread: ['pppp' + 'p', (fn, name, data) => { const t = x.win.heapAlloc(8); x.w32(t, thread(threadCall(fn, data, trap('MIRAGE_threadExit')))); return t; }],
    SDL_CreateThreadWithStackSize: ['ppupp' + 'p', (fn, name, size, data) => { const t = x.win.heapAlloc(8); x.w32(t, thread(threadCall(fn, data, trap('MIRAGE_threadExit')))); return t; }],
    SDL_WaitThread: ['pp', (t, st) => { if (!t) return; const tid = x.r32(t); if (!lx.threadExits.has(tid)) return wait(0.001); if (st) x.w32(st, lx.threadExits.get(tid)); }],
    SDL_DetachThread: ['p', () => {}], SDL_GetThreadID: ['p', (t) => (t ? x.r32(t) : lx.pid)], SDL_ThreadID: ['', () => lx.pid],
    SDL_SetThreadPriority: ['i', () => 0],
    SDL_CreateMutex: ['', () => { const m = x.win.heapAlloc(8); sync.set(m, { owner: 0, count: 0 }); return m; }],
    SDL_LockMutex: ['p', (m) => lock(m) ?? wait(0.001)], SDL_TryLockMutex: ['p', (m) => lock(m) ?? 1], SDL_UnlockMutex: ['p', (m) => unlock(m)],
    SDL_DestroyMutex: ['p', (m) => { if (sync.delete(m)) x.win.heapFree(m); }],
    SDL_CreateSemaphore: ['u', (n) => { const p = x.win.heapAlloc(8); sync.set(p, { count: n }); return p; }],
    SDL_DestroySemaphore: ['p', (p) => { if (sync.delete(p)) x.win.heapFree(p); }],
    SDL_SemWait: ['p', (p) => semWait(p, -1)], SDL_SemTryWait: ['p', (p) => semWait(p, 0)], SDL_SemWaitTimeout: ['pu', (p, ms) => semWait(p, ms)],
    SDL_SemPost: ['p', (p) => { const o = sync.get(p); if (!o) return -1; o.count++; return 0; }], SDL_SemValue: ['p', (p) => (sync.get(p) || { count: 0 }).count],
    SDL_CreateCond: ['', () => { const c = x.win.heapAlloc(8); sync.set(c, { seq: 0 }); return c; }],
    SDL_DestroyCond: ['p', (c) => { if (sync.delete(c)) x.win.heapFree(c); }],
    SDL_CondSignal: ['p', (c) => { const o = sync.get(c); if (!o) return -1; o.seq++; return 0; }], SDL_CondBroadcast: ['p', (c) => { const o = sync.get(c); if (!o) return -1; o.seq++; return 0; }],
    SDL_CondWait: ['pp', (c, m) => condWait(c, m, -1)], SDL_CondWaitTimeout: ['ppu', (c, m, ms) => condWait(c, m, ms)],
    // Atomics: threads change only at system calls, so a read and a write are one step.
    SDL_AtomicGet: ['p', (a) => x.r32(a) | 0], SDL_AtomicSet: ['pi', (a, v) => { const o = x.r32(a) | 0; x.w32(a, v); return o; }],
    SDL_AtomicAdd: ['pi', (a, v) => { const o = x.r32(a) | 0; x.w32(a, o + v); return o; }],
    SDL_AtomicCAS: ['pii', (a, o, n) => { if ((x.r32(a) | 0) !== o) return 0; x.w32(a, n); return 1; }],
    SDL_AtomicGetPtr: ['p', (a) => x.r32(a)], SDL_AtomicSetPtr: ['pp', (a, v) => { const o = x.r32(a); x.w32(a, v); return o; }],
    SDL_AtomicCASPtr: ['ppp', (a, o, n) => { if (x.r32(a) !== o) return 0; x.w32(a, n); return 1; }],
    SDL_AtomicTryLock: ['p', (a) => { if (x.r32(a)) return 0; x.w32(a, 1); return 1; }], SDL_AtomicLock: ['p', (a) => (x.r32(a) ? wait(0.0001) : (x.w32(a, 1), undefined))],
    SDL_AtomicUnlock: ['p', (a) => { x.w32(a, 0); }],
  };
  // ---- the C library SDL carries (SDL_stdinc.h), and what PRISM's programs never asked ------------------------------
  const enc8 = new TextEncoder(), wstr = (p) => { let n = 0; while (x.r16(p + 2 * n)) n++; return n; };
  const ICONV = { 'UTF-8': 'utf8', UTF8: 'utf8', ASCII: 'latin1', 'US-ASCII': 'latin1', LATIN1: 'latin1', 'ISO-8859-1': 'latin1', 'UTF-16LE': 'utf16', 'UCS-2LE': 'utf16', 'UCS-2-INTERNAL': 'utf16', 'UTF-16': 'utf16', 'UCS-2': 'utf16', WCHAR_T: 'utf16', 'UTF-32LE': 'utf32', 'UCS-4LE': 'utf32', 'UCS-4-INTERNAL': 'utf32', 'UTF-32': 'utf32', 'UCS-4': 'utf32' };
  const decode = (kind, b) => kind === 'utf8' ? new TextDecoder().decode(b) : kind === 'latin1' ? String.fromCharCode(...b)
    : kind === 'utf16' ? String.fromCharCode(...new Uint16Array(b.buffer.slice(b.byteOffset, b.byteOffset + (b.length & ~1))))
    : String.fromCodePoint(...new Uint32Array(b.buffer.slice(b.byteOffset, b.byteOffset + (b.length & ~3))));
  const encode = (kind, t) => kind === 'utf8' ? enc8.encode(t) : kind === 'latin1' ? Uint8Array.from(t, (c) => (c.charCodeAt(0) < 256 ? c.charCodeAt(0) : 63))
    : kind === 'utf16' ? new Uint8Array(Uint16Array.from(t, (c) => c.charCodeAt(0)).buffer) : new Uint8Array(Uint32Array.from([...t], (c) => c.codePointAt(0)).buffer);
  const LIBC = {
    SDL_malloc: ['u', (n) => x.win.heapAlloc(n || 1)],
    SDL_calloc: ['uu', (n, size) => { const p = x.win.heapAlloc(n * size || 1); x.write(p, new Uint8Array(n * size)); return p; }],
    SDL_realloc: ['pu', (p, n) => { const q = x.win.heapAlloc(n || 1); if (p) { x.write(q, x.bytes(p, Math.min(x.win.heapSize(p), n))); x.win.heapFree(p); } return q; }],
    SDL_memcpy: ['ppu', (d, src, n) => { if (n) x.write(d, x.bytes(src, n)); return d; }],
    SDL_memmove: ['ppu', (d, src, n) => { if (n) x.write(d, x.bytes(src, n)); return d; }],
    SDL_wcslen: ['p', (p) => wstr(p)],
    // SDL_SetError(fmt, ...): the message as printf makes it, kept for SDL_GetError; -1.
    SDL_SetError: ['p', (fmt) => { const t = formatC(x, x.str(fmt, 1024), (x.cpu.reg[4] >>> 0) + 8).slice(0, 1023); sdl.state.error = M.mod.intern([...enc8.encode(t), 0]); return -1; }],
    SDL_vsnprintf: ['pupp', (buf, n, fmt, ap) => { const t = enc8.encode(formatC(x, x.str(fmt, 4096), ap)); if (n) { const k = Math.min(t.length, n - 1); x.write(buf, t.subarray(0, k)); x.w8(buf + k, 0); } return t.length; }],
    // SDL_iconv_string(to, from, in, bytes): the text in a new block (SDL_free), four zero bytes after it.
    SDL_iconv_string: ['pppu', (to, from, inp, n) => {
      const t = ICONV[x.str(to, 64).toUpperCase()], f = ICONV[x.str(from, 64).toUpperCase()];
      if (!t || !f) return 0;
      const out = encode(t, decode(f, x.bytes(inp, n))), p = x.win.heapAlloc(out.length + 4);
      x.write(p, out); x.write(p + out.length, new Uint8Array(4)); return p;
    }],
    SDL_GetModState: ['', () => win.mod], SDL_SetMainReady: ['', () => {}], SDL_JoystickNameForIndex: ['i', () => 0],
  };
  const INTERNAL = new Set(['MIRAGE_audio', 'MIRAGE_audioQueue', 'MIRAGE_mixer', 'MIRAGE_timer', 'MIRAGE_threadExit']);

  const WINDOW = {
    SDL_UpperBlit: ['pppp', (src, srcrect, dst, dstrect) => fastBlit(src, srcrect, dst, dstrect) ?? M.rt.SDL_UpperBlit(src, srcrect, dst, dstrect)],
    SDL_CreateWindow: ['ppiiiiu', (title, X, Y, w, h, flags) => {
      M.rt.SDL_CreateWindow(title, X, Y, w, h, flags);
      const p = place(flags, X, Y, w, h);
      win.flags = flags; win.w = w; win.h = h;
      win.hwnd = user32.CreateWindowExA[1](x, 0, 0x5d12, title, p.style >>> 0, p.X, p.Y, p.W, p.H, 0, 0, 0, 0);
      const rec = st.wins && st.wins.get(win.hwnd); if (rec) rec.ex = 0;  // CreateWindowEx read its extended style off this call's stack
      // A window shown, exposed and given the keyboard, as SDL's Windows driver reports it (SDL_WINDOWEVENT
      // SHOWN 1, EXPOSED 3, FOCUS_GAINED 12): a program's first events. Abuse reads the mouse at each.
      for (const ev of [1, 3, 12]) windowEvent(ev);
      const c = client(); win.cw = c.w; win.ch = c.h;
      return sdl.state.window;
    }],
    // The window's size and place, as SDL's Windows driver sets them (WIN_SetWindowSize/Position: the frame
    // made round the client area asked); the size it has, its client area's.
    SDL_SetWindowSize: ['pii', (window, w, h) => {
      M.rt.SDL_SetWindowSize(window, w, h); win.w = w; win.h = h;
      if (!win.hwnd || fullscreen(win.flags)) return;
      const p = place(win.flags, 0, 0, w, h);
      user32.SetWindowPos[1](x, win.hwnd, 0, 0, 0, p.W, p.H, 0x16);  // SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE
    }],
    SDL_SetWindowPosition: ['pii', (window, X, Y) => {
      if (!win.hwnd || fullscreen(win.flags)) return;
      const p = place(win.flags, X, Y, win.w, win.h);
      user32.SetWindowPos[1](x, win.hwnd, 0, p.X, p.Y, 0, 0, 0x15);  // SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE
    }],
    SDL_GetWindowSize: ['ppp', (window, wp, hp) => { const c = win.hwnd ? client() : { w: win.w, h: win.h }; if (wp) x.w32(wp, c.w); if (hp) x.w32(hp, c.h); }],
    SDL_ShowWindow: ['p', () => { if (win.hwnd) user32.ShowWindow[1](x, win.hwnd, 5); }],
    SDL_HideWindow: ['p', () => { if (win.hwnd) user32.ShowWindow[1](x, win.hwnd, 0); }],
    // One display, MIRAGE-WIN32's desktop.
    SDL_GetNumVideoDisplays: ['', () => 1], SDL_GetWindowDisplayIndex: ['p', () => 0],
    SDL_GetDisplayBounds: ['ip', (i, rect) => { if (i || !rect) return -1; const sc = screen(); x.w32(rect, 0); x.w32(rect + 4, 0); x.w32(rect + 8, sc.w); x.w32(rect + 12, sc.h); return 0; }],
    SDL_GetDesktopDisplayMode: ['ip', (i, mode) => { if (i || !mode) return -1; const sc = screen(); x.write(mode, new Uint8Array(20)); x.w32(mode, 0x16161804); x.w32(mode + 4, sc.w); x.w32(mode + 8, sc.h); x.w32(mode + 12, 60); return 0; }],
    SDL_SetWindowFullscreen: ['pu', (window, flags) => {
      if (!win.hwnd) return -1;
      // The window's own flags (RESIZABLE...) with the fullscreen ones asked.
      const all = (win.flags & ~0x1001) | (flags & 0x1001), p = place(all, SDL_WINDOWPOS_CENTERED, SDL_WINDOWPOS_CENTERED, win.w, win.h);
      user32.SetWindowLongA[1](x, win.hwnd, -16, p.style >>> 0);
      user32.SetWindowPos[1](x, win.hwnd, 0, p.X, p.Y, p.W, p.H, 0x24);   // SWP_NOZORDER | SWP_FRAMECHANGED
      win.flags = (win.flags & ~0x1001) | (flags & 0x1001);
      return 0;
    }],
    // SDL_DisplayMode { format, w, h, refresh_rate, driverdata }: the window's own size, as SDL 2.0.22 answered
    // Abuse ("640x480 0bpp") for a FULLSCREEN_DESKTOP window.
    SDL_GetWindowDisplayMode: ['pp', (window, mode) => { if (!mode) return -1; x.write(mode, new Uint8Array(20)); x.w32(mode + 4, win.w); x.w32(mode + 8, win.h); return 0; }],
    SDL_RenderGetScale: ['ppp', (r, xp, yp) => { const g = geometry(); if (xp) M.mod.dv.setFloat32(xp, g.scale); if (yp) M.mod.dv.setFloat32(yp, g.scale); }],
    SDL_RenderGetViewport: ['pp', (r, rect) => {
      if (!rect) return;
      const g = geometry();
      [g.vp.x, g.vp.y, g.vp.w, g.vp.h].forEach((v, i) => x.w32(rect + 4 * i, Math.trunc(v / g.scale)));
    }],
    // SDL_PollEvent(NULL) asks whether one is waiting and leaves it there (Abuse's IsPending asks so before
    // each SysEvent; PRISM's takes it off the queue).
    SDL_PollEvent: ['p', (evt) => { pumpMessages(); if (!evt) { sdl.state.pump(); return sdl.state.events.length ? 1 : 0; } return M.rt.SDL_PollEvent(evt); }],
    SDL_PumpEvents: ['', () => { pumpMessages(); }],
    SDL_GetMouseState: ['pp', (xp, yp) => { if (xp) x.w32(xp, win.mx); if (yp) x.w32(yp, win.my); return win.buttons; }],
    SDL_WarpMouseInWindow: ['pii', (window, X, Y) => {
      if (!win.hwnd) return;
      scratch(); x.w32(win.rect, X); x.w32(win.rect + 4, Y);
      user32.ClientToScreen[1](x, win.hwnd, win.rect);
      user32.SetCursorPos[1](x, x.r32(win.rect) | 0, x.r32(win.rect + 4) | 0);
      win.mx = X; win.my = Y;
    }],
    // SDL_ShowCursor(SDL_QUERY -1 / SDL_DISABLE 0 / SDL_ENABLE 1): the state it was in.
    SDL_ShowCursor: ['i', (toggle) => {
      const was = win.cursor;
      if (toggle >= 0 && (toggle ? 1 : 0) !== was) { win.cursor = toggle ? 1 : 0; user32.ShowCursor[1](x, win.cursor); }
      return was;
    }],
    SDL_Delay: ['u', (ms) => { sdl.state.pump(); if (!ms) { lx.yieldAfter = true; return 0; } return x.sleep(ms / 1000); }],
    SDL_ShowSimpleMessageBox: ['uppp', (flags, title, msg) => { M.write(`${x.str(title, 256)}: ${x.str(msg, 4096)}\n`); return 0; }],
    // SDL_AllocRW / SDL_FreeRW: the struct alone (SDL_RWops, 48 bytes on Win32), freed without closing what it
    // reads. A stream of PRISM's (SDL_RWFrom*) is a handle, not a struct: freeing it lets PRISM's record go.
    SDL_AllocRW: ['', () => { const p = x.win.heapAlloc(48); x.write(p, new Uint8Array(48)); return p; }],
    SDL_FreeRW: ['p', (rw) => { if (!rw) return; if (rw >= 0x51000000 && rw < 0x52000000) M.rt.SDL_RWclose(rw); else x.win.heapFree(rw); }],
    SDL_SaveBMP_RW: ['ppi', (s, rw, free) => { if (free && rw) M.rt.SDL_RWclose(rw); sdl.state.error = M.mod.intern([...enc.encode('SDL_SaveBMP: no files are written here'), 0]); return -1; }],
  };
  // SDL_mixer's functions a Windows build exports that PRISM's programs reach by macro or not at all.
  const MIXER = {
    // The device as PRISM opens it, played by a thread of its own (MIRAGE_mixer) on the machine's card.
    Mix_OpenAudio: ['iuii', (freq, format, channels, chunk) => {
      const r = M.rt.Mix_OpenAudio(freq, format, channels, chunk);
      if (r === 0 && !mixer_) {
        lx.dspFormat(mix.freq, (mix.format & 0xff) === 8 ? 8 : 0x10, mix.outChannels);
        mixer_ = { queue: [] };
        mixer_.tid = thread([0x68, 0, 0, 0, 0, 0x68, 0, 0, 0, 0, 0xb8, ...le(HLE_BASE + trap('MIRAGE_mixer')), 0xcd, 0x80, 0x83, 0xc4, 0x08, 0xeb, 0x100 - 22]);
      }
      return r;
    }],
    Mix_CloseAudio: ['', () => { M.rt.Mix_CloseAudio(); if (mixer_) { lx.killThread(mixer_.tid); mixer_ = null; } }],
    // freesrc: the stream closed once read, as SDL_mixer does.
    Mix_LoadWAV_RW: ['pi', (rw, free) => { const c = M.rt.Mix_LoadWAV_RW(rw, free); if (free && rw) M.rt.SDL_RWclose(rw); return c; }],
    Mix_PlayChannel: ['ipi', (ch, chunk, loops) => M.rt.Mix_PlayChannelTimed(ch, chunk, loops, -1)],
    // A group's fade: its channels stopped at once (the fade itself is not made); how many were playing.
    Mix_FadeOutGroup: ['ii', (tag, ms) => { const n = M.rt.Mix_Playing(-1); M.rt.Mix_HaltChannel(-1); return n; }],
    Mix_LoadMUS_RW: ['pi', (rw, free) => { if (free && rw) M.rt.SDL_RWclose(rw); return M.rt.Mix_LoadMUS(0); }],
  };

  // PRISM's functions, read off the caller's stack by their declarations; a void one returns nothing.
  const decls = { ...sdl2.sdl2Builtins(T), ...surface.surfaceBuiltins(T), ...image.imageBuiltins(T) };
  const wrap = (name, sig, fn, ret) => [sig, (cx, ...a) => {
    x = cx;
    const r = fn(...a);
    if (ret === 'FLOAT' || ret === 'DOUBLE') return { st0: Number(r) || 0 };
    if (ret === 'LLONG' || ret === 'ULLONG') { const v = BigInt.asUintN(64, BigInt(r ?? 0)); return { eax: Number(v & 0xffffffffn), edx: Number(v >> 32n) }; }
    return typeof r === 'number' ? r : typeof r === 'boolean' ? +r : undefined;
  }, { cdecl: true }];
  const fromPrism = (table) => {
    const out = {};
    for (const [name, d] of Object.entries(table)) {
      if (d.variadic || typeof M.rt[name] !== 'function') continue;  // SDL_Log & co: PRISM's C, not made here
      const letters = d.params.map(letter);
      if (letters.some((l) => !l)) continue;
      const join = letters.some((l) => l === 'uu');
      out[name] = wrap(name, letters.join(''), join ? (...a) => {
        const args = []; let i = 0;
        for (const l of letters) { if (l === 'uu') { args.push(a[i] + a[i + 1] * 4294967296); i += 2; } else args.push(a[i++]); }
        return M.rt[name](...args);
      } : (...a) => M.rt[name](...a), d.ret);
    }
    return out;
  };
  const own = (table) => Object.fromEntries(Object.entries(table).map(([name, [sig, fn]]) => [name, [sig, (cx, ...a) => { x = cx; return fn(...a); }, { cdecl: true, ...(INTERNAL.has(name) ? { noName: true } : {}) }]]));
  return [
    { dll: 'SDL2.dll', fns: { ...fromPrism(decls), ...own(LIBC), ...own(THREADS), ...own(WINDOW) } },
    { dll: 'SDL2_mixer.dll', fns: { ...fromPrism(mixer.mixerBuiltins(T)), ...own(MIXER) } },
  ];
}
