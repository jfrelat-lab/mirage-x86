// dll.js — a Windows DLL made for MIRAGE-WIN32 (ROADMAP K7/H14): a real PE image, as it lies in memory
// once mapped (headers at its base, one section), whose export directory names its functions and
// whose functions are stubs that trap into the JavaScript answering them:
//     mov eax, HLE_BASE + id ; int 80h ; ret <bytes of arguments>     (stdcall: the callee pops them)
//     mov eax, HLE_BASE + id ; int 80h ; ret                          (cdecl: wsprintfA, msvcrt)
// A program finds them as it would Windows' own: through its import directory, GetProcAddress, or —
// the 4K intros' packers (Crinkler) — by walking the PEB's module list to the export directory and
// hashing the names there. Names are sorted, as GetProcAddress's binary search wants them.
// A DATA export (msvcrt's _acmdln, a pointer a program reads where its import points) is a variable of
// 4 bytes in its stub's place, its value set by the loader (index.js); the section is writable for them.
import { HLE_BASE } from '../hle/elfso.js';

const STUB = 10;                                          // B8 imm32, CD 80, C2 imm16 (or C3, padded)

/**
 * The image of `name` at `base`: `fns` is [{ name, ordinal?, id, pop }] — pop the bytes a stdcall stub
 * pops (null for cdecl), `data` true for a variable, `keepEax` for a stub that pushes EAX before it
 * traps (its own return is the function's to make). Ordinals are the given ones, the others numbered after them from 1 up.
 * Returns { bytes (the mapped image, SizeOfImage long), exports: Map name -> address }.
 */
export function makeDll(name, fns, base) {
  const used = new Set(fns.filter((f) => f.ordinal).map((f) => f.ordinal));
  let next = 1;
  const withOrd = fns.map((f) => { if (f.ordinal) return f; while (used.has(next)) next++; used.add(next); return { ...f, ordinal: next }; });
  const ordBase = Math.min(...withOrd.map((f) => f.ordinal)), ordMax = Math.max(...withOrd.map((f) => f.ordinal));
  const nFuncs = ordMax - ordBase + 1;
  const named = withOrd.filter((f) => f.name).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const enc = new TextEncoder();
  // .text at 0x1000: the stubs, then the export directory, its arrays and names.
  const text = 0x1000, stubs = text, dir = stubs + withOrd.length * STUB;
  const funcs = dir + 40, names = funcs + nFuncs * 4, ords = names + named.length * 4;
  let strs = ords + named.length * 2;
  const strAt = new Map();
  const nameRva = strs; strs += name.length + 1;
  for (const f of named) { strAt.set(f.name, strs); strs += f.name.length + 1; }
  const size = Math.ceil(strs / 0x1000) * 0x1000;
  const b = new Uint8Array(size), dv = new DataView(b.buffer);
  const put = (at, s) => b.set(enc.encode(s + '\0'), at);
  // The headers: MZ, then PE at 40h.
  b[0] = 0x4d; b[1] = 0x5a; dv.setUint32(0x3c, 0x40, true);
  const pe = 0x40, opt = pe + 24;
  dv.setUint32(pe, 0x4550, true);
  dv.setUint16(pe + 4, 0x14c, true); dv.setUint16(pe + 6, 1, true); dv.setUint16(pe + 20, 0xe0, true);
  dv.setUint16(pe + 22, 0x2102, true);                     // executable, 32-bit, DLL
  dv.setUint16(opt, 0x10b, true);                          // PE32
  dv.setUint32(opt + 4, size - text, true);                // SizeOfCode
  dv.setUint32(opt + 20, text, true);                      // BaseOfCode
  dv.setUint32(opt + 28, base >>> 0, true);                // ImageBase
  dv.setUint32(opt + 32, 0x1000, true); dv.setUint32(opt + 36, 0x200, true);   // section and file alignment
  dv.setUint16(opt + 40, 4, true); dv.setUint16(opt + 48, 4, true);            // OS and subsystem 4.0
  dv.setUint32(opt + 56, size, true); dv.setUint32(opt + 60, 0x1000, true);    // SizeOfImage, SizeOfHeaders
  dv.setUint16(opt + 68, 2, true);                         // the Windows GUI subsystem
  dv.setUint32(opt + 92, 16, true);                        // NumberOfRvaAndSizes
  dv.setUint32(opt + 96, dir, true); dv.setUint32(opt + 100, strs - dir, true);  // the export directory
  const sec = opt + 0xe0;
  put(sec, '.text');
  dv.setUint32(sec + 8, size - text, true); dv.setUint32(sec + 12, text, true);
  dv.setUint32(sec + 16, size - text, true); dv.setUint32(sec + 20, 0x400, true);
  dv.setUint32(sec + 36, 0xe0000020, true);                // code, execute, read, write (data exports)
  // The stubs.
  const exports = new Map();
  withOrd.forEach((f, i) => {
    const o = stubs + i * STUB;
    dv.setUint32(funcs + (f.ordinal - ordBase) * 4, o, true);
    if (f.name) exports.set(f.name, (base + o) >>> 0);
    if (f.data) return;                                    // a variable: 0 until the loader sets it
    if (f.keepEax) {                                       // push eax first: what the caller had in EAX, for the function to read at [esp]
      b[o] = 0x50; b[o + 1] = 0xb8; dv.setUint32(o + 2, HLE_BASE + f.id, true); b[o + 6] = 0xcd; b[o + 7] = 0x80; b[o + 8] = 0xc3; b[o + 9] = 0x90;
      return;
    }
    b[o] = 0xb8; dv.setUint32(o + 1, HLE_BASE + f.id, true); b[o + 5] = 0xcd; b[o + 6] = 0x80;
    if (f.pop === null || f.pop === undefined) { b[o + 7] = 0xc3; b[o + 8] = 0x90; b[o + 9] = 0x90; }
    else { b[o + 7] = 0xc2; dv.setUint16(o + 8, f.pop, true); }
  });
  // The export directory (IMAGE_EXPORT_DIRECTORY).
  dv.setUint32(dir + 12, nameRva, true); dv.setUint32(dir + 16, ordBase, true);
  dv.setUint32(dir + 20, nFuncs, true); dv.setUint32(dir + 24, named.length, true);
  dv.setUint32(dir + 28, funcs, true); dv.setUint32(dir + 32, names, true); dv.setUint32(dir + 36, ords, true);
  put(nameRva, name);
  named.forEach((f, i) => {
    dv.setUint32(names + i * 4, strAt.get(f.name), true);
    dv.setUint16(ords + i * 2, f.ordinal - ordBase, true);
    put(strAt.get(f.name), f.name);
  });
  const byOrdinal = new Map(withOrd.map((f, i) => [f.ordinal, (base + stubs + i * STUB) >>> 0]));
  return { bytes: b, exports, byOrdinal };
}
