// sdl12.js — libSDL-1.2.so.0 for MIRAGE-LINUX: the i386 entry points the Linux intros of 2003-2010 call
// (an OpenGL window, its buffer swap, the clock, events, the audio callback and threads), their arguments decoded
// from the caller's stack by signature (i int, u unsigned, p pointer, f float, d double).
//
// PROVISIONAL behind the signatures: PRISM's src/env/sdl12.js is to answer these calls (ROADMAP O9 —
// one SDL for both projects, on MIRAGE's paged memory through src/hle/memory.js), once PRISM's
// environment modules read guest memory through an interface. Until then this file answers what the
// 1K intros need, and the swap paces them at sixty frames a second on the guest's clock.

const SDL_INIT_VIDEO = 0x20, SDL_OPENGL = 0x2, SDL_QUIT = 12, SDL_KEYDOWN = 2, SDL_KEYUP = 3;
const HLE_BASE = 0x48000000;
const SDL_MOUSEMOTION = 4, SDL_MOUSEBUTTONDOWN = 5, SDL_MOUSEBUTTONUP = 6;

/*
 * A PC scancode (set 1; e0: the extended prefix before it) as SDL 1.2's SDLKey (SDL_keysym.h): letters
 * and digits their lower-case ASCII, the cursor keys 273-276, F1-F15 282-296, the modifiers 300-313.
 */
const SCAN_ROWS = [[0x02, '1234567890-='], [0x10, 'qwertyuiop[]'], [0x1e, "asdfghjkl;'`"], [0x2b, '\\zxcvbnm,./']];
const SDLK = (() => {
  const t = {};
  for (const [at, keys] of SCAN_ROWS) [...keys].forEach((c, i) => { t[at + i] = c.charCodeAt(0); });
  Object.assign(t, { 0x01: 27, 0x0e: 8, 0x0f: 9, 0x1c: 13, 0x39: 32, 0x1d: 306, 0x2a: 304, 0x36: 303, 0x38: 308, 0x3a: 301,
    0x57: 292, 0x58: 293, 0x45: 300, 0x46: 302, 0x47: 263, 0x48: 264, 0x49: 265, 0x4a: 269, 0x4b: 260, 0x4c: 261, 0x4d: 262,
    0x4e: 270, 0x4f: 257, 0x50: 258, 0x51: 259, 0x52: 256, 0x53: 266, 0x37: 268 });
  for (let i = 0; i < 10; i++) t[0x3b + i] = 282 + i;
  return t;
})();
const SDLK_E0 = { 0x48: 273, 0x50: 274, 0x4d: 275, 0x4b: 276, 0x47: 278, 0x4f: 279, 0x49: 280, 0x51: 281, 0x52: 277, 0x53: 127,
  0x1c: 271, 0x1d: 305, 0x38: 307, 0x35: 267 };
export const sdlKey = (scancode, e0) => (e0 ? SDLK_E0[scancode] : SDLK[scancode]) || 0;
const b32 = (v) => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];

/*
 * SDL's own threads, as guest code made here: a loop for the audio, a call for SDL_CreateThread, each
 * run by src/linux.js's threads (the program's address space, its turn in the queue). The audio loop
 * gives the buffer to /dev/dsp (MIRAGE-LINUX's card, lx.dspPlay), whose full buffer makes it wait as
 * SDL's audio thread waits for the card, then calls the program's callback for the next one:
 *     loop: mov eax, HLE(SDL_mirage_audio) ; int 80h        -- play the buffer, waiting for room
 *           push len ; push buf ; push userdata ; mov eax, callback ; call eax ; add esp, 12 ; jmp loop
 * It starts at the play, so a paused device (SDL starts paused) waits there before the first callback.
 */
const audioLoop = (play, len, buf, userdata, callback) => [
  0xb8, ...b32(HLE_BASE + play), 0xcd, 0x80,
  0x68, ...b32(len), 0x68, ...b32(buf), 0x68, ...b32(userdata), 0xb8, ...b32(callback), 0xff, 0xd0, 0x83, 0xc4, 0x0c,
  0xeb, 0x100 - 34];
/** SDL_CreateThread's thread: fn(data), then the thread ends with what it returned (pushed twice: the
 *  trap reads its argument above a return address, as a stub's caller leaves one). */
const threadCall = (fn, data, exit) => [0x68, ...b32(data), 0xb8, ...b32(fn), 0xff, 0xd0, 0x50, 0x50, 0xb8, ...b32(HLE_BASE + exit), 0xcd, 0x80];

/*
 * SDL_AddTimer's thread, as guest code: wait for the timer (the trap answers when it is due, or nonzero when
 * the timer was removed or its callback returned 0), call callback(interval, param), keep what it returned
 * as the next interval (at `rec`), again:
 *     L: push rec ; push rec ; mov eax, HLE(SDL_mirage_timer) ; int 80h ; add esp, 8 ; test eax, eax ; jnz X
 *        push param ; push [rec] ; mov eax, callback ; call eax ; add esp, 8 ; mov [rec], eax ; jmp L
 *     X: push 0 ; push 0 ; mov eax, HLE(SDL_mirage_thread_exit) ; int 80h
 */
const timerLoop = (wait, exit, rec, callback, param) => [
  0x68, ...b32(rec), 0x68, ...b32(rec), 0xb8, ...b32(HLE_BASE + wait), 0xcd, 0x80, 0x83, 0xc4, 0x08, 0x85, 0xc0, 0x75, 0x1c,
  0x68, ...b32(param), 0xff, 0x35, ...b32(rec), 0xb8, ...b32(callback), 0xff, 0xd0, 0x83, 0xc4, 0x08, 0xa3, ...b32(rec), 0xeb, 0x100 - 52,
  0x6a, 0x00, 0x6a, 0x00, 0xb8, ...b32(HLE_BASE + exit), 0xcd, 0x80];
// SDL_GetKeyName's names (SDL_keyboard.c's keynames) for the keys a game shows in its key settings.
const KEYNAMES = { 8: 'backspace', 9: 'tab', 13: 'return', 27: 'escape', 32: 'space', 127: 'delete', 271: 'enter', 273: 'up', 274: 'down',
  275: 'right', 276: 'left', 277: 'insert', 278: 'home', 279: 'end', 280: 'page up', 281: 'page down', 301: 'caps lock', 303: 'right shift',
  304: 'left shift', 305: 'right ctrl', 306: 'left ctrl', 307: 'right alt', 308: 'left alt' };
const keyName = (sym) => KEYNAMES[sym] || (sym >= 282 && sym <= 296 ? `f${sym - 281}` : sym >= 256 && sym <= 265 ? `[${sym - 256}]` : sym > 32 && sym < 127 ? String.fromCharCode(sym) : 'unknown key');

/** A RIFF WAVE file's PCM: { rate, channels, bits, data } (its fmt and data chunks), or null. */
export function parseWav(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength), tag = (o) => String.fromCharCode(...b.subarray(o, o + 4));
  if (b.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
  let fmt = null;
  for (let o = 12; o + 8 <= b.length; ) {
    const id = tag(o), n = dv.getUint32(o + 4, true);
    if (id === 'fmt ') fmt = { format: dv.getUint16(o + 8, true), channels: dv.getUint16(o + 10, true), rate: dv.getUint32(o + 12, true), bits: dv.getUint16(o + 22, true) };
    else if (id === 'data' && fmt && fmt.format === 1) return { rate: fmt.rate, channels: fmt.channels, bits: fmt.bits, data: b.subarray(o + 8, Math.min(b.length, o + 8 + n)) };
    o += 8 + n + (n & 1);
  }
  return null;
}

export function sdl12() {
  const st = { t0: null, w: 0, h: 0, surface: 0, lastSwap: 0, events: [], audio: null, mouse: { x: 0, y: 0, buttons: 0 },
    pushed: [], unicode: 0, files: new Map(), timers: new Map(), names: new Map() };
  return {
    soname: 'libSDL-1.2.so.0', links: ['libSDL.so', 'libSDL-1.2.so'],
    state: st,
    fns: {
      SDL_Init: ['u', (x) => { st.t0 = x.lx.mono(); return 0; }],
      SDL_InitSubSystem: ['u', () => 0],
      SDL_Quit: ['', (x) => { x.backend.quit && x.backend.quit(); return 0; }],
      SDL_WasInit: ['u', (x, f) => f],
      SDL_GetError: ['', (x) => (st.error ||= x.alloc(1))],          // "": a pointer to it, not the string
      // An SDL_Surface: flags, format, w, h, pitch (Uint16), pixels... — enough for a program that reads
      // its size back; the drawing is OpenGL's.
      SDL_SetVideoMode: ['iiiu', (x, w, h, bpp, flags) => {
        st.w = w || 640; st.h = h || 480;
        x.backend.setVideoMode(st.w, st.h, !!(flags & SDL_OPENGL));
        if (!st.surface) st.surface = x.alloc(64);
        x.w32(st.surface, flags); x.w32(st.surface + 8, st.w); x.w32(st.surface + 12, st.h); x.w16(st.surface + 16, st.w * 4);
        return st.surface;
      }],
      SDL_GL_SetAttribute: ['ii', () => 0],
      SDL_GL_GetAttribute: ['ip', (x, a, p) => { x.w32(p, 8); return 0; }],
      // The swap waits for the next sixtieth of a second, as a display's vertical blank does: an intro
      // that draws as fast as it can then runs at sixty frames a second on the guest's clock.
      SDL_GL_SwapBuffers: ['', (x) => {
        const now = x.lx.mono();
        if (now < st.lastSwap + 1 / 60) return x.waitUntil(st.lastSwap + 1 / 60);
        st.lastSwap = now;
        x.backend.swap();
        return 0;
      }],
      SDL_GetTicks: ['', (x) => Math.floor((x.lx.mono() - (st.t0 ?? 0)) * 1000) >>> 0],
      SDL_Delay: ['u', (x, ms) => x.sleep(ms / 1000)],
      SDL_ShowCursor: ['i', () => 0],
      SDL_WM_SetCaption: ['pp', () => 0],
      SDL_WM_GrabInput: ['i', () => 0],
      SDL_GetVideoInfo: ['', (x) => { const p = x.alloc(32); x.w32(p + 12, st.w); x.w32(p + 16, st.h); return p; }],
      // SDL_Event (SDL 1.2): Uint8 type at 0. A key event: state at 2, keysym's scancode at 4, sym (SDLKey,
      // 32 bits) at 8, mod at 12, unicode at 16 -- its sym from the scancode when the page gives only that.
      // A mouse motion: state at 2, x and y (Uint16) at 4 and 6, xrel and yrel at 8 and 10; a button:
      // button at 2, state at 3, x and y at 4 and 6. The mouse's last place and buttons are kept for
      // SDL_GetMouseState.
      SDL_PollEvent: ['p', (x, ev) => {
        if (st.pushed.length) { const b = st.pushed.shift(); if (ev) x.write(ev, b); return 1; }   // SDL_PushEvent's first
        const e = x.backend.nextEvent ? x.backend.nextEvent() : null;
        if (!e) return 0;
        const m = st.mouse;
        if (e.type === 'mousemove' || e.type === 'mousedown' || e.type === 'mouseup') {
          const dx = e.x - m.x, dy = e.y - m.y; m.x = e.x; m.y = e.y;
          if (e.type === 'mousedown') m.buttons |= 1 << (e.button - 1); else if (e.type === 'mouseup') m.buttons &= ~(1 << (e.button - 1));
          if (!ev) return 1;
          x.write(ev, new Uint8Array(20));
          if (e.type === 'mousemove') { x.w8(ev, SDL_MOUSEMOTION); x.w8(ev + 2, m.buttons); x.w16(ev + 8, dx & 0xffff); x.w16(ev + 10, dy & 0xffff); }
          else { x.w8(ev, e.type === 'mousedown' ? SDL_MOUSEBUTTONDOWN : SDL_MOUSEBUTTONUP); x.w8(ev + 2, e.button); x.w8(ev + 3, e.type === 'mousedown' ? 1 : 0); }
          x.w16(ev + 4, e.x & 0xffff); x.w16(ev + 6, e.y & 0xffff);
          return 1;
        }
        if (!ev) return 1;
        const sym = e.sym || sdlKey(e.scancode || 0, e.e0);
        x.w8(ev, e.type === 'quit' ? SDL_QUIT : e.type === 'keyup' ? SDL_KEYUP : SDL_KEYDOWN);
        x.w8(ev + 1, 0); x.w8(ev + 2, e.type === 'keyup' ? 0 : 1); x.w8(ev + 4, e.scancode || 0); x.w32(ev + 8, sym); x.w32(ev + 12, 0);
        x.w16(ev + 16, st.unicode && e.type !== 'keyup' && sym < 128 ? sym : 0);   // only while SDL_EnableUNICODE(1), as SDL fills it
        return 1;
      }],
      // SDL_GetMouseState(&x, &y): the buttons, the place.
      SDL_GetMouseState: ['pp', (x, px, py) => { if (px) x.w32(px, st.mouse.x); if (py) x.w32(py, st.mouse.y); return st.mouse.buttons; }],
      SDL_WarpMouse: ['uu', (x, X, Y) => { st.mouse.x = X & 0xffff; st.mouse.y = Y & 0xffff; return 0; }],
      SDL_EnableKeyRepeat: ['ii', () => 0],
      // No joystick is plugged in.
      SDL_NumJoysticks: ['', () => 0], SDL_JoystickOpen: ['i', () => 0], SDL_JoystickName: ['i', () => 0],
      SDL_JoystickNumAxes: ['p', () => 0], SDL_JoystickNumButtons: ['p', () => 0], SDL_JoystickUpdate: ['', () => 0],
      SDL_JoystickGetAxis: ['pi', () => 0], SDL_JoystickGetButton: ['pi', () => 0],
      // An event the program sends itself (SDL_Event: 20 bytes), taken before the page's.
      SDL_PushEvent: ['p', (x, ev) => { st.pushed.push(x.bytes(ev, 20).slice()); return 0; }],
      SDL_EnableUNICODE: ['i', (x, on) => { const was = st.unicode; if (on >= 0) st.unicode = on; return was; }],
      SDL_GetKeyName: ['u', (x, sym) => {
        if (!st.names.has(sym)) { const t = new TextEncoder().encode(keyName(sym) + '\0'), p = x.alloc(t.length); x.write(p, t); st.names.set(sym, p); }
        return st.names.get(sym);
      }],
      // Every mode is available ((SDL_Rect **)-1); the video surface is SDL_SetVideoMode's.
      SDL_ListModes: ['pu', () => 0xffffffff],
      SDL_GetVideoSurface: ['', () => st.surface],
      SDL_FreeSurface: ['p', () => 0],
      SDL_JoystickClose: ['p', () => 0], SDL_JoystickEventState: ['i', () => 0],
      // A file as SDL_RWops: a block whose bytes are kept here, read whole by SDL_LoadWAV_RW (what
      // SuperTuxKart opens one for). A path is the process's: from its working directory.
      SDL_RWFromFile: ['pp', (x, pPath) => {
        const name = x.str(pPath), path = name.startsWith('/') ? name : `${x.lx.cwd.replace(/\/$/, '')}/${name}`, b = x.lx.readFile(path);
        if (!b) return 0;
        const rw = x.alloc(32); x.write(rw, new Uint8Array(32)); st.files.set(rw, b); return rw;
      }],
      // SDL_LoadWAV_RW(src, freesrc, spec, &buffer, &length): PCM in 8 bits (AUDIO_U8) or 16 (AUDIO_S16LSB);
      // the SDL_AudioSpec filled -- freq, format, channels, silence, samples 4096, size.
      SDL_LoadWAV_RW: ['pippp', (x, rw, freesrc, spec, pBuf, pLen) => {
        const b = st.files.get(rw >>> 0), w = b && parseWav(b);
        if (freesrc) st.files.delete(rw >>> 0);
        if (!w || (w.bits !== 8 && w.bits !== 16)) return 0;
        const buf = x.alloc(Math.max(1, w.data.length)); x.write(buf, w.data);
        x.write(spec, new Uint8Array(24)); x.w32(spec, w.rate); x.w16(spec + 4, w.bits === 8 ? 0x0008 : 0x8010); x.w8(spec + 6, w.channels);
        x.w8(spec + 7, w.bits === 8 ? 0x80 : 0); x.w16(spec + 8, 4096); x.w32(spec + 12, w.data.length);
        x.w32(pBuf, buf); x.w32(pLen, w.data.length);
        return spec;
      }],
      SDL_FreeWAV: ['p', () => 0],
      // SDL_AddTimer(interval, callback, param): a thread of its own (timerLoop), the callback called every
      // `interval` ms of the guest's clock until it returns 0 or SDL_RemoveTimer; its id is its block.
      SDL_AddTimer: ['upp', (x, interval, callback, param) => {
        const rec = x.alloc(8), code = x.alloc(64), stack = x.alloc(0x10000);
        x.w32(rec, interval);
        st.timers.set(rec, { due: x.lx.mono() + interval / 1000, removed: false });
        x.write(code, Uint8Array.from(timerLoop(x.idOf('SDL_mirage_timer'), x.idOf('SDL_mirage_thread_exit'), rec, callback, param)));
        x.lx.spawnThread({ eip: code, esp: stack + 0x10000 - 16 });
        return rec;
      }],
      SDL_RemoveTimer: ['p', (x, rec) => { const t = st.timers.get(rec >>> 0); if (!t) return 0; t.removed = true; return 1; }],
      SDL_mirage_timer: ['p', (x, rec) => {
        const t = st.timers.get(rec >>> 0), ms = x.r32(rec);
        if (!t || t.removed || !ms) { st.timers.delete(rec >>> 0); return 1; }
        const now = x.lx.mono();
        if (now < t.due) return x.waitUntil(t.due);
        t.due = now + ms / 1000;
        return 0;
      }],
      // Mutexes and semaphores (SDL_mixer's, smpeg's): a mutex never waits, the guest's threads taking turns
      // only at system calls; a semaphore's count is kept, a wait on zero waits for a post.
      SDL_CreateMutex: ['', (x) => x.alloc(8)], SDL_DestroyMutex: ['p', () => 0], SDL_mutexP: ['p', () => 0], SDL_mutexV: ['p', () => 0],
      SDL_CreateSemaphore: ['u', (x, n) => { const p = x.alloc(8); x.w32(p, n); return p; }], SDL_DestroySemaphore: ['p', () => 0],
      SDL_SemPost: ['p', (x, p) => { x.w32(p, x.r32(p) + 1); return 0; }], SDL_SemValue: ['p', (x, p) => x.r32(p)],
      SDL_SemWait: ['p', (x, p) => { const n = x.r32(p); if (!n) return x.waitUntil(x.lx.mono() + 0.001); x.w32(p, n - 1); return 0; }],
      SDL_SetError: ['p', () => 0],
      // An OpenGL entry point by name, as glXGetProcAddressARB gives it.
      SDL_GL_GetProcAddress: ['p', (x, name) => x.entry(x.str(name))],
      SDL_PumpEvents: ['', () => 0],
      // Audio (SDL_AudioSpec: freq, format, channels, silence, samples, padding, size, callback,
      // userdata): unsigned 8 or signed 16 bits on /dev/dsp, the callback called by the audio loop.
      SDL_OpenAudio: ['pp', (x, desired, obtained) => {
        const a = { freq: x.r32(desired), format: x.r16(desired + 4), channels: x.r8(desired + 6) || 1, samples: x.r16(desired + 8) || 1024,
          callback: x.r32(desired + 16), userdata: x.r32(desired + 20), paused: true };
        if (a.format !== 0x0008 && a.format !== 0x8010) return -1;     // AUDIO_U8, AUDIO_S16LSB
        a.size = a.samples * a.channels * (a.format === 0x0008 ? 1 : 2);
        a.buf = x.alloc(a.size);
        x.lx.dspFormat(a.freq, a.format === 0x0008 ? 8 : 0x10, a.channels);
        const code = x.alloc(64), stack = x.alloc(0x10000);
        x.write(code, Uint8Array.from(audioLoop(x.idOf('SDL_mirage_audio'), a.size, a.buf, a.userdata, a.callback)));
        a.tid = x.lx.spawnThread({ eip: code, esp: stack + 0x10000 - 16 });
        st.audio = a;
        if (obtained) {
          for (let i = 0; i < 24; i++) x.w8(obtained + i, x.r8(desired + i));
          x.w8(obtained + 6, a.channels); x.w8(obtained + 7, a.format === 0x0008 ? 0x80 : 0); x.w16(obtained + 8, a.samples); x.w32(obtained + 12, a.size);
        }
        return 0;
      }],
      SDL_PauseAudio: ['i', (x, on) => { if (st.audio) st.audio.paused = !!on; return 0; }],
      SDL_CloseAudio: ['', (x) => { if (st.audio) { x.lx.killThread(st.audio.tid); st.audio = null; } return 0; }],
      SDL_LockAudio: ['', () => 0], SDL_UnlockAudio: ['', () => 0],
      // The audio loop's play: the buffer to the card, or a wait while it is full or the device paused.
      SDL_mirage_audio: ['', (x) => {
        const a = st.audio;
        if (!a || a.paused) return x.waitUntil(x.lx.mono() + 0.01);
        const r = x.lx.dspPlay(x.bytes(a.buf, a.size));
        return r === x.lx.BLOCK ? r : 0;
      }],
      // Threads: SDL_Thread* is a block holding the thread's id.
      SDL_CreateThread: ['pp', (x, fn, data) => {
        const code = x.alloc(32), stack = x.alloc(0x40000), t = x.alloc(8);
        x.write(code, Uint8Array.from(threadCall(fn, data, x.idOf('SDL_mirage_thread_exit'))));
        x.w32(t, x.lx.spawnThread({ eip: code, esp: stack + 0x40000 - 16 }));
        return t;
      }],
      SDL_mirage_thread_exit: ['i', (x, code) => { x.lx.exitThread(code); return 0; }],
      SDL_WaitThread: ['pp', (x, t, status) => {
        const tid = x.r32(t);
        if (!x.lx.threadExits.has(tid)) return x.waitUntil(x.lx.mono() + 0.001);
        if (status) x.w32(status, x.lx.threadExits.get(tid));
        return 0;
      }],
      SDL_KillThread: ['p', (x, t) => { x.lx.killThread(x.r32(t)); return 0; }],
      SDL_ThreadID: ['', (x) => x.lx.pid],
    },
  };
}
