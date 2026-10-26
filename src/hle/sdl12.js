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

export function sdl12() {
  const st = { t0: null, w: 0, h: 0, surface: 0, lastSwap: 0, events: [], audio: null };
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
      // SDL_Event (SDL 1.2): Uint8 type at 0; a key event's keysym.sym (SDLKey, 32 bits) at 8.
      SDL_PollEvent: ['p', (x, ev) => {
        const e = x.backend.nextEvent ? x.backend.nextEvent() : null;
        if (!e) return 0;
        if (!ev) return 1;
        x.w8(ev, e.type === 'quit' ? SDL_QUIT : e.type === 'keyup' ? SDL_KEYUP : SDL_KEYDOWN);
        x.w8(ev + 1, 0); x.w8(ev + 2, e.type === 'keyup' ? 0 : 1); x.w8(ev + 4, e.scancode || 0); x.w32(ev + 8, e.sym || 0); x.w32(ev + 12, 0);
        return 1;
      }],
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
