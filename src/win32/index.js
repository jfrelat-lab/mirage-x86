// index.js — MIRAGE-WIN32 (ROADMAP K7/H14): a Win32 program run with no Windows, on MIRAGE-LINUX's
// process machinery (src/linux.js: the paged user space, the stubs' INT 80h trap into JavaScript, the
// guest clock). Every DLL it uses is made here (dll.js) and answered in JavaScript (src/win32/api):
// none of Microsoft's or Wine's code.
//
// The process is laid out as Windows XP SP2 lays one out, because the scene's packers read that
// layout rather than asking for it: Crinkler's header walks fs:[30h] (the PEB) -> Ldr -> the module
// lists to kernel32's export directory and resolves everything by hashing names. So:
//   - the image is mapped as XP's loader maps it: the headers from file offset 0 for SizeOfHeaders, each
//     section's raw data from PointerToRawData rounded down to 512 (Crinkler's is 1), its SizeOfImage
//     reserved and committed on first touch (Crinkler reserves 100-300 MB to unpack into);
//   - FS is selector 3Bh, the TEB's (XP's own selector); the PEB, its PEB_LDR_DATA and one
//     LDR_DATA_TABLE_ENTRY per module, in XP's orders: load and memory (exe, ntdll, kernel32, then the
//     imports), initialisation (ntdll, kernel32, the rest; not the exe);
//   - the DLLs at XP SP2's bases, the main thread's stack below 130000h, ESP at entry on a return
//     address into kernel32 (a program that returns from its entry point ends its process).
// Oracles: Windows XP's structures as Wine and ReactOS document them (winternl.h, ntdll/loader.c);
// the same .exe under Wine in Docker i386.
import { makeDll } from './dll.js';
import { hleDispatch, argBytes } from '../hle/index.js';

const PAGE = 0x1000;
const TEB = 0x7ffde000, PEB = 0x7ffdf000, FS_SEL = 0x3b;           // GDT entry 7, RPL 3: XP's FS
const STACK_TOP = 0x130000, STACK_RESERVE = 0x100000;
const HEAP = 0x00140000, HEAP_SIZE = 0x01000000;                   // the process heap: the loader's lists, HeapAlloc
export const BASES = { 'ntdll.dll': 0x7c900000, 'kernel32.dll': 0x7c800000, 'user32.dll': 0x7e410000, 'gdi32.dll': 0x77f10000,
  'opengl32.dll': 0x5ed00000, 'glu32.dll': 0x68b20000, 'winmm.dll': 0x76b40000, 'lz32.dll': 0x71b20000, 'msvcrt.dll': 0x77c10000,
  'advapi32.dll': 0x77dd0000, 'dsound.dll': 0x73f10000, 'shell32.dll': 0x7c9c0000, 'ole32.dll': 0x774e0000 };

/** The RAM a machine needs for `exe`: 64 MiB and its whole SizeOfImage, which a Crinkler intro touches
 *  much of (its decompressor's hash tables live there), as a power of two. */
export function win32Memory(exe) {
  const h = peHeader(exe), want = (64 << 20) + (h ? h.sizeImage : 0);
  let m = 64 << 20; while (m < want) m *= 2;
  return Math.min(m, 1024 << 20);
}

/** The headers of a PE image (what the loader reads), or null when `b` is not one. */
export function peHeader(b) {
  if (b.length < 0x40 || b[0] !== 0x4d || b[1] !== 0x5a) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength), lf = dv.getUint32(0x3c, true);
  if (lf + 24 > b.length || dv.getUint32(lf, true) !== 0x4550) return null;
  const nsec = dv.getUint16(lf + 6, true), optsz = dv.getUint16(lf + 20, true), o = lf + 24;
  if (dv.getUint16(lf + 4, true) !== 0x14c || dv.getUint16(o, true) !== 0x10b) return null;   // i386, PE32
  const rd = (off) => (off + 4 <= b.length ? dv.getUint32(off, true) : 0);
  const h = { entry: rd(o + 16), base: rd(o + 28), salign: rd(o + 32), falign: rd(o + 36), sizeImage: rd(o + 56), sizeHeaders: rd(o + 60),
    subsystem: dv.getUint16(o + 68, true), ndirs: rd(o + 92), dirs: [], sections: [] };
  for (let i = 0; i < Math.min(h.ndirs, 16); i++) h.dirs.push({ rva: rd(o + 96 + 8 * i), size: rd(o + 100 + 8 * i) });
  const s = o + optsz;
  for (let i = 0; i < nsec; i++) {
    const a = s + 40 * i;
    h.sections.push({ vsize: rd(a + 8), va: rd(a + 12), rsize: rd(a + 16), raw: rd(a + 20), flags: rd(a + 36) });
  }
  return h;
}

/**
 * Run a PE `.exe` on `lx` (installLinux's): map it and the DLLs `apis` make, set up the process, and
 * leave the CPU at its entry point. `apis`: [{ dll, fns: { name: [sig, fn, { cdecl?, ordinal? }?] } }].
 * Returns { modules, x } — x the context the API functions get (guest memory, lx, backend, win).
 */
export function loadPE(lx, mem, cpu, exe, { path = 'C:\\intro.exe', apis = [], backend = {} } = {}) {
  const h = peHeader(exe);
  if (!h) throw new Error('mirage-win32: not a PE32 i386 executable');
  lx.prepareSpace();
  const wr = (va, bytes) => lx.wrBytes(va, bytes);
  const enc = new TextEncoder();

  // ---- the image, as XP maps it --------------------------------------------------------------------
  const base = h.base >>> 0;
  lx.lazy.push([base, base + h.sizeImage]);
  const mapBytes = (va, bytes) => { lx.mapRange(va & ~0xfff, va + Math.max(bytes.length, 1), true); wr(va, bytes); };
  mapBytes(base, exe.subarray(0, Math.min(exe.length, h.sizeHeaders)));
  for (const sec of h.sections) {
    const raw = sec.raw & ~0x1ff, len = Math.min(Math.ceil((sec.rsize + (sec.raw & 0x1ff)) / 0x200) * 0x200, Math.max(0, exe.length - raw));
    if (len > 0 && sec.rsize) mapBytes(base + sec.va, exe.subarray(raw, raw + len));
  }

  // ---- the process heap, the stack, the TEB and the PEB -------------------------------------------
  lx.lazy.push([HEAP, HEAP + HEAP_SIZE]);
  let heapNext = HEAP;
  const heapAlloc = (n) => { const p = heapNext; heapNext += Math.ceil(Math.max(n, 1) / 8) * 8 + 8; return p; };
  lx.lazy.push([STACK_TOP - STACK_RESERVE, STACK_TOP]);
  lx.mapRange(STACK_TOP - 0x3000, STACK_TOP, true);
  lx.mapRange(TEB, PEB + PAGE, true);
  const w32 = (va, v) => lx.wrBytes(va, Uint8Array.of(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255));
  const w16 = (va, v) => lx.wrBytes(va, Uint8Array.of(v & 255, (v >>> 8) & 255));
  w32(TEB + 0x00, 0xffffffff);                                        // ExceptionList: none
  w32(TEB + 0x04, STACK_TOP); w32(TEB + 0x08, STACK_TOP - 0x3000);    // StackBase, StackLimit
  w32(TEB + 0x18, TEB); w32(TEB + 0x20, 0x100); w32(TEB + 0x24, 0x104);   // Self, process and thread ids
  w32(TEB + 0x30, PEB);
  w32(PEB + 0x08, base);                                              // ImageBaseAddress
  w32(PEB + 0x18, HEAP);                                              // ProcessHeap
  w32(PEB + 0xa4, 5); w32(PEB + 0xa8, 1); w16(PEB + 0xac, 2600); w32(PEB + 0xb0, 2);   // Windows XP, build 2600, NT
  w32(PEB + 0x64, 1);                                                 // NumberOfProcessors
  lx.setDesc(FS_SEL >> 3, TEB, 0xfff, 0xf2, 0x40);                    // data, DPL 3, byte-granular, 32-bit

  // ---- the loader's lists ---------------------------------------------------------------------------
  const ldr = heapAlloc(0x28);
  w32(ldr, 0x28); w32(ldr + 4, 1);
  const heads = [ldr + 0x0c, ldr + 0x14, ldr + 0x1c];
  for (const hd of heads) { w32(hd, hd); w32(hd + 4, hd); }           // empty circular lists
  w32(PEB + 0x0c, ldr);
  const ustr = (s) => { const u = new Uint8Array(s.length * 2 + 2); for (let i = 0; i < s.length; i++) u[2 * i] = s.charCodeAt(i); const p = heapAlloc(u.length); wr(p, u); return { p, len: s.length * 2 }; };
  const link = (head, entry) => {                                      // insert at the tail: Flink of the last, Blink of the head
    const last = lx.rdBytes(head + 4, 4), lastA = new DataView(last.buffer).getUint32(0, true);
    w32(entry, head); w32(entry + 4, lastA); w32(lastA, entry); w32(head + 4, entry);
  };
  const modules = new Map();                                          // lower-case base name -> { base, size, exports, byOrdinal, entry }
  const addEntry = (mod, full, short, { init = true } = {}) => {
    const e = heapAlloc(0x50);
    w32(e + 0x18, mod.base); w32(e + 0x1c, mod.entry || 0); w32(e + 0x20, mod.size);
    const f = ustr(full), b = ustr(short);
    w16(e + 0x24, f.len); w16(e + 0x26, f.len + 2); w32(e + 0x28, f.p);
    w16(e + 0x2c, b.len); w16(e + 0x2e, b.len + 2); w32(e + 0x30, b.p);
    w32(e + 0x34, init ? 0x80004 : 0x4000); w16(e + 0x38, 0xffff);
    link(heads[0], e); link(heads[1], e + 8);
    if (init) link(heads[2], e + 0x10);
    mod.ldrEntry = e;
  };

  // ---- the DLLs: images made from the API tables, mapped when first loaded -------------------------
  const table = [];                                                   // id -> { name, sig, fn }
  const images = new Map();                                           // lower-case name -> { name, fns }
  for (const api of apis) {
    const key = api.dll.toLowerCase();
    const fns = Object.entries(api.fns).map(([name, [sig, fn, opt = {}]]) => {
      table.push({ name: `${api.dll}!${name}`, sig, fn });
      return { name: opt.noName ? null : name, ordinal: opt.ordinal, id: table.length - 1, pop: opt.cdecl ? null : argBytes(sig) };
    });
    images.set(key, { name: api.dll, fns });
  }
  const load = (name) => {
    let key = name.toLowerCase().replace(/^.*[\\/]/, '');
    if (!/\.[a-z0-9]+$/.test(key)) key += '.dll';
    if (modules.has(key)) return modules.get(key);
    const img = images.get(key);
    if (!img) return null;
    const mb = BASES[key] || (0x60000000 + modules.size * 0x100000);
    const d = makeDll(img.name, img.fns, mb);
    mapBytes(mb, d.bytes);
    const mod = { name: img.name, base: mb, size: d.bytes.length, exports: d.exports, byOrdinal: d.byOrdinal };
    modules.set(key, mod);
    addEntry(mod, `C:\\WINDOWS\\system32\\${img.name}`, img.name);
    return mod;
  };
  const exeMod = { name: path.replace(/^.*\\/, ''), base, size: h.sizeImage, entry: base + h.entry, exports: new Map(), byOrdinal: new Map() };
  addEntry(exeMod, path, exeMod.name, { init: false });
  load('ntdll.dll'); load('kernel32.dll');

  // ---- the import directory --------------------------------------------------------------------------
  const rd32 = (va) => { const b = lx.rdBytes(va, 4); return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0; };
  const unresolved = [];
  const imp = h.dirs[1];
  if (imp && imp.rva) {
    for (let d = base + imp.rva; ; d += 20) {
      const olt = rd32(d), nameRva = rd32(d + 12), iat = rd32(d + 16);
      if (!nameRva) break;
      const dll = lx.rdStr(base + nameRva), mod = load(dll);
      if (!mod) throw new Error(`mirage-win32: ${dll} is not made here (an import of ${exeMod.name})`);
      for (let t = 0; ; t += 4) {
        const e = rd32(base + (olt || iat) + t);
        if (!e) break;
        const fn = e & 0x80000000 ? mod.byOrdinal.get(e & 0xffff) : mod.exports.get(lx.rdStr(base + e + 2));
        if (!fn) unresolved.push(`${dll}!${e & 0x80000000 ? '#' + (e & 0xffff) : lx.rdStr(base + e + 2)}`);
        w32(base + iat + t, fn || 0);
      }
    }
  }
  if (unresolved.length) throw new Error(`mirage-win32: unresolved imports: ${unresolved.join(', ')}`);

  // ---- the API's context, and the stack at the entry point -----------------------------------------
  const win = {
    base, path, modules, load, heapAlloc, peb: PEB, teb: TEB,
    /** GetProcAddress: an export by name or ordinal, 0 when there is none. */
    proc: (mod, name) => (typeof name === 'number' ? mod.byOrdinal.get(name) : mod.exports.get(name)) || 0,
    moduleAt: (b) => [...modules.values(), exeMod].find((m) => m.base === b >>> 0) || null,
    /** A line for the log: what a program asked that is not here. */
    say: (t) => { if (lx.onOutput) lx.onOutput(2, enc.encode(`mirage-win32: ${t}\n`)); },
  };
  const x = hleDispatch(lx, mem, cpu, table, backend);
  x.win = win;
  // A thread starts with its return address on a stub of kernel32 that ends the process (XP's
  // BaseProcessStart calls ExitThread with what the entry point returned).
  const k32 = modules.get('kernel32.dll'), exit = k32.exports.get('ExitThread') || 0;
  let sp = STACK_TOP - 0x3c;                                          // XP leaves a little above ESP
  for (const v of [exit, 0, 0]) { w32(sp, v); sp += 4; }
  sp -= 12;
  lx.enterUser(base + h.entry, sp, { fs: FS_SEL });
  cpu.reg[3] = PEB;                                                   // EBX: XP starts a process with the PEB there
  cpu.reg[0] = base + h.entry;                                        // EAX: the entry point
  lx.exe = path;
  return { modules, x, win };
}
