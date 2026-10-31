// prism-gl.js — MIRAGE-LINUX's libGL and libGLU answered by PRISM's own gl.js and glu.js (the
// vendor/prism submodule: one OpenGL for both projects, ROADMAP O9), drawn by gl.js's WebGL2
// rasteriser, on MIRAGE's paged guest memory. PRISM's environment modules read a flat memory (M.u8[p],
// M.mod.dv); until they read it through an interface, this hands them an M whose u8 is a Proxy over
// the page map and whose dv is a DataView-like object over the same. libSDL and libasound are MIRAGE's
// (sdl12.js, asound.js): the window is gl.js's framebuffer, the sound the emulated card.
import { guestMemory } from './memory.js';
import { gl as glTable, glu as gluTable } from './gl.js';
import { asound } from './asound.js';
import { sdl12 } from './sdl12.js';

/** An M as PRISM's environment modules take it, over a Linux guest's memory. */
export function prismM(lx, mem) {
  const m = guestMemory(lx, mem);
  const u8 = new Proxy({}, {
    get(_, k) {
      if (typeof k === 'string' && /^\d+$/.test(k)) return m.r8(+k);
      if (k === 'slice' || k === 'subarray') return (a, b) => m.bytes(a, b - a);
      if (k === 'set') return (src, at = 0) => m.write(at, src instanceof Uint8Array ? src : Uint8Array.from(src));
      if (k === 'fill') return (v, a, b) => m.write(a, new Uint8Array(b - a).fill(v));
      if (k === 'copyWithin') return (to, a, b) => m.write(to, m.bytes(a, b - a));
      if (k === 'length' || k === 'byteLength') return 0x100000000;
      return undefined;
    },
    set(_, k, v) { m.w8(+k, v); return true; },
  });
  const tmp = new DataView(new ArrayBuffer(8));
  const dv = {
    getUint8: (p) => m.r8(p), getInt8: (p) => (m.r8(p) << 24) >> 24, setUint8: (p, v) => m.w8(p, v), setInt8: (p, v) => m.w8(p, v),
    getUint16: (p) => m.r16(p), getInt16: (p) => (m.r16(p) << 16) >> 16, setUint16: (p, v) => m.w16(p, v), setInt16: (p, v) => m.w16(p, v),
    getUint32: (p) => m.r32(p), getInt32: (p) => m.r32(p) | 0, setUint32: (p, v) => m.w32(p, v), setInt32: (p, v) => m.w32(p, v),
    getFloat32: (p) => m.f32(p), getFloat64: (p) => m.f64(p),
    setFloat32: (p, v) => { tmp.setFloat32(0, v, true); m.w32(p, tmp.getUint32(0, true)); },
    setFloat64: (p, v) => { tmp.setFloat64(0, v, true); m.w32(p, tmp.getUint32(0, true)); m.w32(p + 4, tmp.getUint32(4, true)); },
  };
  const cstr = (p) => m.str(p);
  const intern = (bytes) => { const p = lx.alloc(bytes.length); m.write(p, Uint8Array.from(bytes)); return p; };
  const rt = { calloc: (n, size) => lx.alloc(n * size), free: () => {}, malloc: (n) => lx.alloc(n) };
  return { u8, cstr, rt, mod: { dv, cstr, intern } };
}

/**
 * The libraries an image's `machine.hle` names (sdl12, gl, glu, asound) for linuxrun.js: libGL.so.1 and
 * libGLU.so.1 whose entry points hand their raw arguments (pointers as guest addresses) to PRISM's
 * gl.js and glu.js, libSDL-1.2.so.0 whose OpenGL window is gl.js's framebuffer, libasound.so.2.
 * `frame()` gives the last picture SDL_GL_SwapBuffers presented (an ImageBitmap), or null.
 */
export async function prismLibraries(lx, mem, names = ['sdl12', 'gl', 'glu', 'asound']) {
  const { installGL } = await import('../../vendor/prism/src/env/gl.js');
  const { installGlu } = await import('../../vendor/prism/src/env/glu.js');
  const M = prismM(lx, mem);
  const gl = installGL(M, { backend: 'webgl' });
  installGlu(M);
  let frame = null, size = null;
  const backend = {
    setVideoMode(w, h) { gl.resize(w, h); M.rt.glViewport(0, 0, w, h); size = { w, h }; },
    swap() { const b = gl.present(); if (b) { if (frame && frame.close) frame.close(); frame = b; } },
    nextEvent() { return null; },
    gl() { return 0; },
  };
  // The GL and GLU entry points: MIRAGE's tables for the signatures (how to read the stack), PRISM's
  // gl.js and glu.js for the work.
  const viaPrism = (table) => {
    const fns = {};
    for (const [name, [sig]] of Object.entries(table.fns)) {
      fns[name] = [sig, (x, ...a) => {
        const f = M.rt[name];
        if (!f) throw new Error(`gl: ${name} is not in PRISM's gl.js`);
        const r = f(...a);
        return typeof r === 'number' ? r : undefined;
      }];
    }
    return { soname: table.soname, links: table.links, fns };
  };
  const make = { sdl12, gl: () => viaPrism(glTable()), glu: () => viaPrism(gluTable()), asound };
  const unknown = names.find((n) => !make[n]);
  if (unknown) throw new Error(`machine.hle: no library '${unknown}' (sdl12, gl, glu, asound)`);
  return { libs: names.map((n) => make[n]()), backend, frame: () => frame, size: () => size, gl, M };
}
