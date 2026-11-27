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
// Not made: SDL's own threads and callbacks into the program (the audio device's, timers, a program's
// RWops) -- PRISM calls them through M.icall, which stops here, named; SDL_mixer's sound reaches no card yet
// (the mixer mixes, nobody listens); window events beyond the first three (a move, a resize); SDL_SaveBMP's file.
import { prismM } from '../hle/prism-gl.js';

const WS_POPUP = 0x80000000, WS_VISIBLE = 0x10000000, STYLE_NORMAL = 0x00ca0000;   // WS_OVERLAPPED|CAPTION|SYSMENU|MINIMIZEBOX
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

function makeDlls(lx, mem, { st, user32, target }, { sdl2, surface, image, mixer }) {
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
  const win = { hwnd: 0, flags: 0, w: 0, h: 0, cursor: 1, buttons: 0, mx: 0, my: 0, msg: 0, rect: 0 };
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
    const s = screen(), style = STYLE_NORMAL | WS_VISIBLE;
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
  const pumpMessages = () => {
    if (!win.hwnd) return;
    scratch();
    for (let n = 0; n < 256 && user32.PeekMessageA[1](x, win.msg, 0, 0, 0, 1) === 1; n++) {
      const hwnd = x.r32(win.msg), m = x.r32(win.msg + 4), wp = x.r32(win.msg + 8), lp = x.r32(win.msg + 12);
      if (m === 0x0f) { user32.ValidateRect[1](x, hwnd, 0); continue; }                 // WM_PAINT: the next frame draws it
      if (m === 0x10 || m === 0x12) { sdl.state.events.push(raw(SDL_QUIT).e); continue; }  // WM_CLOSE, WM_QUIT
      if (m === 0x100 || m === 0x101 || m === 0x104 || m === 0x105) {                   // WM_(SYS)KEYDOWN/UP
        const from = sdl.state.events.length, down = !(m & 1);
        sdl.pushScan((lp >>> 16) & 0xff, (lp >>> 24) & 1, down);
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
  const mix = { ...mixer.MIXER_STATE, clock };
  Object.assign(M.rt, mixer.mixerApi(M, mix));

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
      for (const ev of [1, 3, 12]) { const { e, d } = raw(SDL_WINDOWEVENT); d.setUint32(8, 1, true); e[12] = ev; sdl.state.events.push(e); }
      return sdl.state.window;
    }],
    SDL_SetWindowFullscreen: ['pu', (window, flags) => {
      if (!win.hwnd) return -1;
      const p = place(flags, SDL_WINDOWPOS_CENTERED, SDL_WINDOWPOS_CENTERED, win.w, win.h);
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
    // SDL_RWops are PRISM's handles: freeing one is closing it.
    SDL_FreeRW: ['p', (rw) => { if (rw) M.rt.SDL_RWclose(rw); }],
    SDL_SaveBMP_RW: ['ppi', (s, rw, free) => { if (free && rw) M.rt.SDL_RWclose(rw); sdl.state.error = M.mod.intern([...enc.encode('SDL_SaveBMP: no files are written here'), 0]); return -1; }],
  };
  // SDL_mixer's functions a Windows build exports that PRISM's programs reach by macro or not at all.
  const MIXER = {
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
  const own = (table) => Object.fromEntries(Object.entries(table).map(([name, [sig, fn]]) => [name, [sig, (cx, ...a) => { x = cx; return fn(...a); }, { cdecl: true }]]));
  return [
    { dll: 'SDL2.dll', fns: { ...fromPrism(decls), ...own(WINDOW) } },
    { dll: 'SDL2_mixer.dll', fns: { ...fromPrism(mixer.mixerBuiltins(T)), ...own(MIXER) } },
  ];
}
