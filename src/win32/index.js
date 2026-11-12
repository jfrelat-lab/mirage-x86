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
const THREAD_STACKS = 0x02000000;                                  // the other threads' stacks, 1 MB each
const HEAP = 0x00140000, HEAP_SIZE = 0x01000000;                   // the process heap: the loader's lists, HeapAlloc
export const BASES = { 'ntdll.dll': 0x7c900000, 'kernel32.dll': 0x7c800000, 'user32.dll': 0x7e410000, 'gdi32.dll': 0x77f10000,
  'opengl32.dll': 0x5ed00000, 'glu32.dll': 0x68b20000, 'winmm.dll': 0x76b40000, 'lz32.dll': 0x71b20000, 'msvcrt.dll': 0x77c10000,
  'advapi32.dll': 0x77dd0000, 'd3d9.dll': 0x4fdd0000, 'dsound.dll': 0x73f10000, 'shell32.dll': 0x7c9c0000, 'ole32.dll': 0x774e0000 };

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
export function loadPE(lx, mem, cpu, exe, { path = 'C:\\intro.exe', args = '', apis = [], backend = {}, readFile = null } = {}) {
  const h = peHeader(exe);
  readFile = readFile || apis.readFile || null;                    // the program's own DLLs, from its disk
  if (!h) throw new Error('mirage-win32: not a PE32 i386 executable');
  lx.prepareSpace();
  const wr = (va, bytes) => lx.wrBytes(va, bytes);
  const enc = new TextEncoder();

  // ---- the image, as XP maps it --------------------------------------------------------------------
  const base = h.base >>> 0;
  lx.lazy.push([base, base + h.sizeImage]);
  const mapBytes = (va, bytes) => { lx.mapRange(va & ~0xfff, va + Math.max(bytes.length, 1), true); wr(va, bytes); };
  // An image at `at`: its headers, then each section at its RVA. A section alignment below the page's
  // (Crinkler's /TINYHEADER: no section at all, code in the headers) is one flat image: the whole file
  // at the base, file offset = RVA, the rest of SizeOfImage zero (ReactOS's ExeFmtpCreateImageSection,
  // the SectionAlignment < PAGE_SIZE case).
  const mapImage = (img, ih, at) => {
    if (ih.salign < PAGE) { mapBytes(at, img.subarray(0, Math.min(img.length, ih.sizeImage))); return; }
    mapBytes(at, img.subarray(0, Math.min(img.length, ih.sizeHeaders)));
    for (const sec of ih.sections) {
      const raw = sec.raw & ~0x1ff, len = Math.min(Math.ceil((sec.rsize + (sec.raw & 0x1ff)) / 0x200) * 0x200, Math.max(0, img.length - raw));
      if (len > 0 && sec.rsize) mapBytes(at + sec.va, img.subarray(raw, raw + len));
    }
  };
  mapImage(exe, h, base);

  // ---- the process heap, the stack, the TEB and the PEB -------------------------------------------
  // The heap: blocks of 8-byte multiples, each after an 8-byte header holding its size, a block freed
  // kept on a list by size and handed out again. Its first segment runs from 140000h to the image (as
  // XP's does, below the program); then segments of 256 MiB from 10000000h. A program that frees what
  // it allocates (.kkrieger's texture generator, megabytes at a time) stays in the memory it had; with
  // no reuse and no bound the heap grew into the image at 400000h and overwrote the program.
  const segments = [[HEAP, Math.min(HEAP + HEAP_SIZE, base > HEAP ? base : HEAP + HEAP_SIZE)]];
  for (let s = 0x10000000; s < 0x30000000; s += 0x10000000) segments.push([s, s + 0x10000000]);
  for (const [a, b] of segments) lx.lazy.push([a, b]);
  let seg = 0, heapNext = HEAP + 8;
  const freeBySize = new Map();
  const hw32 = (va, v) => lx.wrBytes(va, Uint8Array.of(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255));
  const hr32 = (va) => { const b = lx.rdBytes(va, 4); return (b[0] | b[1] << 8 | b[2] << 16 | b[3] << 24) >>> 0; };
  const heapAlloc = (n) => {
    const size = Math.ceil(Math.max(n, 1) / 8) * 8, free = freeBySize.get(size);
    if (free && free.length) return free.pop();
    while (heapNext + size > segments[seg][1]) {
      if (++seg >= segments.length) throw new Error(`mirage-win32: the heap is full (${n} bytes asked)`);
      heapNext = segments[seg][0] + 8;
    }
    const p = heapNext; heapNext += size + 8;
    hw32(p - 8, size);
    return p;
  };
  const heapSize = (p) => (p ? hr32(p - 8) : 0);
  const heapFree = (p) => {
    if (!p) return;
    const size = heapSize(p);
    if (!freeBySize.has(size)) freeBySize.set(size, []);
    freeBySize.get(size).push(p);
  };
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
  const dataInits = []; let x = null;
  const runDataInits = () => { for (const d of dataInits.splice(0)) w32(d.at, d.fn(x) >>> 0); };
  for (const api of apis) {
    const key = api.dll.toLowerCase();
    const fns = Object.entries(api.fns).map(([name, [sig, fn, opt = {}]]) => {
      table.push({ name: `${api.dll}!${name}`, sig, fn });
      return { name: opt.noName ? null : name, ordinal: opt.ordinal, id: table.length - 1, pop: opt.cdecl ? null : argBytes(sig), data: !!opt.data, keepEax: !!opt.keepEax };
    });
    images.set(key, { name: api.dll, fns });
  }
  const load = (name) => {
    let key = name.toLowerCase().replace(/^.*[\\/]/, '');
    if (!/\.[a-z0-9]+$/.test(key)) key += '.dll';
    if (modules.has(key)) return modules.get(key);
    const img = images.get(key);
    if (!img) return loadFile(key);
    const mb = BASES[key] || (0x60000000 + modules.size * 0x100000);
    const d = makeDll(img.name, img.fns, mb);
    mapBytes(mb, d.bytes);
    // Its data exports: each function, given the API's context, gives the variable's value (once that
    // context exists: the DLLs the program imports are mapped before it is made).
    for (const f of img.fns) if (f.data) dataInits.push({ at: (mb + 0x1000 + img.fns.indexOf(f) * 10) >>> 0, fn: table[f.id].fn });
    if (x) runDataInits();
    const mod = { name: img.name, base: mb, size: d.bytes.length, exports: d.exports, byOrdinal: d.byOrdinal };
    modules.set(key, mod);
    addEntry(mod, `C:\\WINDOWS\\system32\\${img.name}`, img.name);
    return mod;
  };
  const exeMod = { name: path.replace(/^.*\\/, ''), base, size: h.sizeImage, entry: base + h.entry, exports: new Map(), byOrdinal: new Map() };
  addEntry(exeMod, path, exeMod.name, { init: false });
  load('ntdll.dll'); load('kernel32.dll');

  // ---- the import directory: each DLL an image names, loaded, its address table filled ------------------
  const rd32 = (va) => { const b = lx.rdBytes(va, 4); return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0; };
  const bindImports = (ib, ih, who) => {
    const unresolved = [], imp = ih.dirs[1];
    if (!imp || !imp.rva) return;
    for (let d = ib + imp.rva; ; d += 20) {
      const olt = rd32(d), nameRva = rd32(d + 12), iat = rd32(d + 16);
      if (!nameRva) break;
      const dll = lx.rdStr(ib + nameRva), mod = load(dll);
      if (!mod) throw new Error(`mirage-win32: ${dll} is not made here (an import of ${who})`);
      for (let t = 0; ; t += 4) {
        const e = rd32(ib + (olt || iat) + t);
        if (!e) break;
        const fn = e & 0x80000000 ? mod.byOrdinal.get(e & 0xffff) : mod.exports.get(lx.rdStr(ib + e + 2));
        if (!fn) unresolved.push(`${dll}!${e & 0x80000000 ? '#' + (e & 0xffff) : lx.rdStr(ib + e + 2)}`);
        w32(ib + iat + t, fn || 0);
      }
    }
    if (unresolved.length) throw new Error(`mirage-win32: unresolved imports: ${unresolved.join(', ')}`);
  };
  /*
   * A DLL of the program's own, from its disk (`readFile`): Quake II's ref_gl.dll, ref_soft.dll and
   * gamex86.dll, which it loads with LoadLibrary and asks GetProcAddress for GetRefAPI and GetGameAPI.
   * Mapped from 50000000h up -- clear of the heap's segments, of lx.alloc's region from 40000000h (the
   * GL layer's strings, PRISM's own memory: a glGetString there overwrote ref_gl.dll's code when the
   * DLLs began at 40000000h) and of the DLLs made here (opengl32's at 5ED00000h) -- its base relocations
   * applied (IMAGE_REL_BASED_HIGHLOW) when that is not the base it was linked for, its imports bound,
   * its exports read. Its DllMain is LoadLibraryA's to call (src/win32/api.js): `init` is pending.
   */
  let dllNext = 0x50000000;
  const loaded = [];
  /*
   * Static TLS (__declspec(thread): Visual C++'s thread-safe statics, a C++ runtime's per-thread state):
   * a module's TLS directory names its template (StartAddressOfRawData to EndAddressOfRawData, then
   * SizeOfZeroFill zero bytes), where its index goes (AddressOfIndex) and its callbacks. Each thread
   * gets a copy of every template, and TEB+2Ch (ThreadLocalStoragePointer) points to the array of them,
   * by index -- the code reads fs:[2Ch], then [array + index * 4]. A module without one has none.
   */
  const tls = [];                                                     // { start, end, zero, callbacks, base }
  const addTls = (at, ih) => {
    const d = ih.dirs[9]; if (!d || !d.rva) return;
    const t = at + d.rva, rec = { start: rd32(t), end: rd32(t + 4), zero: rd32(t + 16), callbacks: [], base: at };
    w32(rd32(t + 8), tls.length);
    for (let c = rd32(t + 12); c && rd32(c); c += 4) rec.callbacks.push(rd32(c));
    tls.push(rec);
  };
  const tlsBlocks = (teb) => {
    if (!tls.length) return;
    const arr = heapAlloc(4 * tls.length);
    tls.forEach((r, i) => {
      const n = r.end - r.start, b = heapAlloc(Math.max(4, n + r.zero));
      wr(b, lx.rdBytes(r.start, n)); if (r.zero) wr(b + n, new Uint8Array(r.zero));
      w32(arr + 4 * i, b);
    });
    w32(teb + 0x2c, arr);
  };
  const loadFile = (key) => {
    const img = readFile && readFile(key), ih = img && peHeader(img);
    if (!ih) return null;
    const size = (ih.sizeImage + 0xffff) & ~0xffff, at = dllNext >>> 0; dllNext += size;
    lx.lazy.push([at, at + size]);
    mapImage(img, ih, at);
    const delta = (at - ih.base) | 0, rel = ih.dirs[5];
    if (delta && rel && rel.rva) {
      for (let blk = at + rel.rva, end = blk + rel.size; blk < end;) {
        const page = rd32(blk), bsize = rd32(blk + 4);
        if (!bsize) break;
        for (let k = 8; k < bsize; k += 2) {
          const b = lx.rdBytes(blk + k, 2), e = b[0] | b[1] << 8;
          if (e >> 12 === 3) { const a = at + page + (e & 0xfff); w32(a, (rd32(a) + delta) >>> 0); }
        }
        blk += bsize;
      }
    }
    const name = img.name || key, exports = new Map(), byOrdinal = new Map(), ex = ih.dirs[0];
    if (ex && ex.rva) {
      const d = at + ex.rva, ordBase = rd32(d + 16), nFuncs = rd32(d + 20), nNames = rd32(d + 24);
      const funcs = at + rd32(d + 28), names = at + rd32(d + 32), ords = at + rd32(d + 36);
      for (let i = 0; i < nFuncs; i++) { const r = rd32(funcs + 4 * i); if (r) byOrdinal.set(ordBase + i, at + r); }
      for (let i = 0; i < nNames; i++) {
        const b = lx.rdBytes(ords + 2 * i, 2), o = b[0] | b[1] << 8, r = rd32(funcs + 4 * o);
        if (r) exports.set(lx.rdStr(at + rd32(names + 4 * i)), at + r);
      }
    }
    const mod = { name: key, base: at, size, entry: ih.entry ? at + ih.entry : 0, exports, byOrdinal, file: true, init: !!ih.entry };
    modules.set(key, mod);
    addEntry(mod, `C:\\${key}`, key);
    // A DLL whose imports are not all here does not load, as on Windows (ERROR_MOD_NOT_FOUND): Half-Life's
    // launcher tries its 3dfx OpenGL driver, which needs glide2x.dll, and goes on without it.
    try { bindImports(at, ih, key); } catch (e) {
      modules.delete(key);
      if (lx.onOutput) lx.onOutput(2, new TextEncoder().encode(`mirage-win32: ${key} not loaded: ${e.message.replace(/^mirage-win32: /, '')}\n`));
      return null;
    }
    addTls(at, ih); mod.tls = tls[tls.length - 1]?.base === at ? tls[tls.length - 1] : null;
    loaded.push(mod);                                                 // its own imports first: the order DllMains run in
    return mod;
  };
  bindImports(base, h, exeMod.name);
  addTls(base, h);
  tlsBlocks(TEB);

  // ---- the API's context, and the stack at the entry point -----------------------------------------
  // ---- threads: each its TEB (below the first, as XP places them) and its stack, on lx.spawnThread --------
  let threads = 0;
  const createThread = (start, param) => {
    const n = ++threads, teb = TEB - n * PAGE, top = THREAD_STACKS + n * STACK_RESERVE;
    lx.mapRange(teb, teb + PAGE, true);
    lx.lazy.push([top - STACK_RESERVE, top]);
    w32(teb + 0x00, 0xffffffff); w32(teb + 0x04, top); w32(teb + 0x08, top - 0x3000);
    w32(teb + 0x18, teb); w32(teb + 0x20, 0x100); w32(teb + 0x30, PEB);
    // The thread's first frame: its parameter, and a return into ExitThread with what it returns.
    const exitT = modules.get('kernel32.dll').exports.get('ExitThread') || 0;
    let sp = top - 16;
    w32(sp, exitT); w32(sp + 4, param >>> 0); w32(sp + 8, 0);
    tlsBlocks(teb);
    const tid = lx.spawnThread({ eip: start, esp: sp, fsIndex: FS_SEL >> 3, fsBase: teb });
    w32(teb + 0x24, tid);
    return tid;
  };
  const win = {
    base, path, args, modules, load, heapAlloc, heapFree, heapSize, peb: PEB, teb: TEB, createThread,
    /** GetProcAddress: an export by name or ordinal, 0 when there is none. */
    proc: (mod, name) => (typeof name === 'number' ? mod.byOrdinal.get(name) : mod.exports.get(name)) || 0,
    moduleAt: (b) => [...modules.values(), exeMod].find((m) => m.base === b >>> 0) || null,
    /** A line for the log: what a program asked that is not here. */
    say: (t) => { if (lx.onOutput) lx.onOutput(2, enc.encode(`mirage-win32: ${t}\n`)); },
  };
  x = hleDispatch(lx, mem, cpu, table, backend);
  x.win = win;
  runDataInits();
  // A thread starts with its return address on a stub of kernel32 that ends the process (XP's
  // BaseProcessStart calls ExitThread with what the entry point returned).
  const k32 = modules.get('kernel32.dll'), exit = k32.exports.get('ExitThread') || 0;
  let sp = STACK_TOP - 0x3c;                                          // XP leaves a little above ESP
  for (const v of [exit, 0, 0]) { w32(sp, v); sp += 4; }
  sp -= 12;
  /*
   * The program's own DLLs it imports (Abuse's SDL2.dll and SDL2_mixer.dll) are initialized before its
   * entry point, as Windows' loader does it: each DllMain(DLL_PROCESS_ATTACH) in turn, a DLL's after
   * those of the DLLs it imports. A DLL's C runtime starts there -- its stack cookie set, its globals
   * built -- and a DllMain run later, inside one of its own functions, changed the cookie under a frame
   * that had saved the old one. A stub of code made here makes the calls, then jumps to the entry point.
   */
  let start = base + h.entry;
  // The TLS callbacks (a DLL's before its DllMain, the program's last) are called the same way.
  const pending = loaded.filter((m) => m.init && m.entry), exeTls = tls.find((r) => r.base === base);
  if (pending.length || (exeTls && exeTls.callbacks.length)) {
    const code = [], d32 = (v) => code.push(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255);
    const call = (b, fn) => { code.push(0x6a, 0x00, 0x6a, 0x01, 0x68); d32(b); code.push(0xb8); d32(fn); code.push(0xff, 0xd0); };   // fn(base, 1, 0)
    for (const m of pending) { m.init = false; for (const c of m.tls ? m.tls.callbacks : []) call(m.base, c); call(m.base, m.entry); }
    for (const c of exeTls ? exeTls.callbacks : []) call(base, c);
    code.push(0xbb); d32(PEB); code.push(0xb8); d32(start); code.push(0xff, 0xe0);                                                            // EBX, EAX; jmp to the entry
    start = heapAlloc(code.length); wr(start, Uint8Array.from(code));
  }
  lx.enterUser(start, sp, { fs: FS_SEL });
  cpu.reg[3] = PEB;                                                   // EBX: XP starts a process with the PEB there
  cpu.reg[0] = base + h.entry;                                        // EAX: the entry point
  cpu.fcw = 0x027f;                                                   // a Win32 process starts at 53 bits, not FNINIT's 0x037F
  lx.exe = path;
  return { modules, x, win };
}
