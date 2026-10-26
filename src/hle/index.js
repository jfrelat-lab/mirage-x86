// index.js — the libraries MIRAGE-LINUX makes in JavaScript (ROADMAP O9), put into a program's file
// tree and answered when they are called. A library is { soname, links, fns: { name: [signature, fn] } }:
// makeSharedObject (elfso.js) turns it into a real ELF shared object whose functions trap into
// linux.js's dispatcher with an id, and here that id finds its function, its arguments decoded from the
// caller's stack by the signature — i (int32), u (uint32), p (pointer), f (float), d (double, 8 bytes)
// — as the i386 System V calling convention lays them out. A function gets the context `x`: the guest
// memory accessors (memory.js), the backend (what draws, plays and reads keys), lx, and the waits.
//
// Which JavaScript answers a call is the library's business: today a tracer, which records the calls
// for the tests (src/hle/sdl12.js, gl.js); then PRISM's environment modules (sdl12, gl, glu), the same
// code PRISM's programs call, on MIRAGE's memory.
import { makeSharedObject, HLE_BASE } from './elfso.js';
import { guestMemory } from './memory.js';

const SIZE = { i: 4, u: 4, p: 4, f: 4, d: 8 };

/** Install `libs` on `lx` with `backend`; returns the files to put in the tree ({ path, bytes, links }). */
export function installHLE(lx, mem, cpu, libs, backend, { dir = '/usr/lib' } = {}) {
  const table = [];                                        // id -> { name, sig, fn, lib }
  const files = [];
  for (const lib of libs) {
    const names = Object.keys(lib.fns), first = table.length;
    for (const name of names) { const [sig, fn] = lib.fns[name]; table.push({ name, sig, fn, lib }); }
    files.push({ path: `${dir}/${lib.soname}`, bytes: makeSharedObject(lib.soname, names, first), links: (lib.links || []).map((l) => `${dir}/${l}`) });
  }
  hleDispatch(lx, mem, cpu, table, backend);
  return files;
}

/**
 * Answer the stubs' traps on `lx` from `table` (id -> { name, sig, fn }): lx.hle(id) decodes the
 * arguments from the caller's stack by the signature and calls fn(x, ...args). Shared by the ELF
 * libraries above and Win32's DLLs (src/win32), whose stubs trap the same way. Returns the context x.
 */
export function hleDispatch(lx, mem, cpu, table, backend) {
  const m = guestMemory(lx, mem);
  const byName = new Map(table.map((f, id) => [f.name, id]));
  const BLOCK = lx.BLOCK;
  let ctx;
  const x = {
    ...m, lx, backend, cpu,
    // The x87's top, for the functions that return a double there (cdecl's rule: sin, cos, pow) or take
    // one there (msvcrt's _CIsin, _ftol).
    st0: () => cpu.fst[cpu.ftop],
    fpop: () => { const v = cpu.fst[cpu.ftop]; cpu.focc[cpu.ftop] = 0; cpu.ftop = (cpu.ftop + 1) & 7; return v; },
    // Wait as a system call waits: until the guest's clock reaches `t` (seconds, lx.mono).
    waitUntil: (t) => { if (lx.mono() >= t) return 0; if (lx.wake === null) lx.wake = t; return BLOCK; },
    sleep: (s) => { if (ctx.until === undefined) ctx.until = lx.mono() + s; const r = x.waitUntil(ctx.until); if (r !== BLOCK) ctx.until = undefined; return r; },
    // The entry point of a function by name, where the program can call it: glXGetProcAddress.
    entry: (name) => (byName.has(name) && x.entries ? x.entries(byName.get(name)) : 0),
    // A function's id, for code made here that traps into it (sdl12.js's audio and thread loops).
    idOf: (name) => byName.get(name),
  };
  ctx = {};
  lx.hle = (id) => {
    const f = table[id];
    if (!f) return -38;                                       // ENOSYS
    // At the INT 80h in the stub, [ESP] is the caller's return address, the arguments follow.
    let p = (cpu.reg[4] >>> 0) + 4;
    const args = [];
    for (const c of f.sig) {
      args.push(c === 'f' ? m.f32(p) : c === 'd' ? m.f64(p) : c === 'i' ? m.r32(p) | 0 : m.r32(p));
      p += SIZE[c];
    }
    if (backend.trace) backend.trace(f.name, args);
    const r = f.fn(x, ...args);
    if (r && typeof r === 'object' && 'st0' in r) {          // a double, returned on the x87 stack
      cpu.ftop = (cpu.ftop - 1) & 7; cpu.fst[cpu.ftop] = r.st0; cpu.focc[cpu.ftop] = 1;
      if ('edx' in r) cpu.reg[2] = r.edx >>> 0;
      return r.eax === undefined ? HLE_BASE + id : r.eax;
    }
    if (r && typeof r === 'object' && 'edx' in r) { cpu.reg[2] = r.edx >>> 0; return r.eax >>> 0; }   // a 64-bit result: EDX:EAX
    // A void function leaves EAX as the stub set it, nonzero as a real library's scratch value is: the
    // 1K intros read it back -- Metatunnel draws glRecti(-eax, -eax, eax, eax) after glColor4ubv.
    return r === undefined ? HLE_BASE + id : r;
  };
  lx.hleTable = table;
  return x;
}

/** The bytes a signature's arguments take on the stack: what a stdcall function pops. */
export const argBytes = (sig) => [...sig].reduce((n, c) => n + SIZE[c], 0);
