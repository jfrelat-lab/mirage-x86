// sdl12.js — libSDL-1.2.so.0 for MIRAGE-LINUX: the i386 entry points the Linux intros of 2003-2010 call
// (an OpenGL window, its buffer swap, the clock, events, the audio callback), their arguments decoded
// from the caller's stack by signature (i int, u unsigned, p pointer, f float, d double).
//
// PROVISIONAL behind the signatures: PRISM's src/env/sdl12.js is to answer these calls (ROADMAP O9 —
// one SDL for both projects, on MIRAGE's paged memory through src/hle/memory.js), once PRISM's
// environment modules read guest memory through an interface. Until then this file answers what the
// 1K intros need, and the swap paces them at sixty frames a second on the guest's clock.

const SDL_INIT_VIDEO = 0x20, SDL_OPENGL = 0x2, SDL_QUIT = 12, SDL_KEYDOWN = 2, SDL_KEYUP = 3;

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
      // Audio: the program's callback fills the buffer; M3 calls it. Opened, it plays nothing yet.
      SDL_OpenAudio: ['pp', (x, desired, obtained) => {
        st.audio = { freq: x.r32(desired), format: x.r16(desired + 4), channels: x.r8(desired + 6), samples: x.r16(desired + 8), callback: x.r32(desired + 16), userdata: x.r32(desired + 20) };
        if (obtained) for (let i = 0; i < 24; i++) x.w8(obtained + i, x.r8(desired + i));
        return 0;
      }],
      SDL_PauseAudio: ['i', () => 0],
      SDL_CloseAudio: ['', () => 0],
      SDL_CreateThread: ['pp', () => 0],
      SDL_KillThread: ['p', () => 0],
      SDL_WaitThread: ['pp', () => 0],
    },
  };
}
