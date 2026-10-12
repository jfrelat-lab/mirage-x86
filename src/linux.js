// linux.js — MIRAGE-LINUX: i386 Linux user-space programs on the recompiler, with the kernel in JS.
//
// The same idea as MIRAGE-DOS. There is no kernel image: a static ELF32 executable is mapped into a
// flat 32-bit address space of its own (paging on, ring 3, CS=73h DS=7Bh as Linux's __USER_CS and
// __USER_DS), and every `int 0x80` is answered here, in JS, with the i386 system call numbers and
// return conventions (EAX = result, or -errno). A CPU exception the program takes is what a kernel
// turns into a signal: SIGSEGV for a page or protection fault, SIGILL for #UD, SIGFPE for #DE — the
// process ends with status 128+signal, as a shell reports it.
//
// The oracle is a real kernel: the same binary under `docker run --platform linux/386 i386/debian`
// must print the same bytes and exit with the same status (tools/linux/).
//
// Memory: physical frames are handed out from FRAMES_BASE upward and never reused; the page
// directory and the GDT sit below them. The kernel reads and writes the program's memory through
// its own map of virtual pages (this.pages), so a bad pointer in a system call is -EFAULT, not a
// fault taken in the kernel.

const PAGE = 0x1000;
const PD_BASE = 0x10000, GDT_BASE = 0x11000, FRAMES_BASE = 0x100000;
const USER_CS = 0x73, USER_DS = 0x7b;                     // GDT entries 14 and 15, RPL 3
const TLS_MIN = 6, TLS_ENTRIES = 3;                       // set_thread_area's slots, as Linux has them
const GDT_ENTRIES = 32;
const STACK_TOP = 0xc0000000, STACK_SIZE = 0x40000;       // 256 KiB mapped up front...
const STACK_MAX = 8 << 20;                                // ...and grown on demand to 8 MiB, RLIMIT_STACK
const MMAP_BASE = 0x40000000;

const SIG = { SIGILL: 4, SIGFPE: 8, SIGSEGV: 11 };
const E = { EPERM: 1, ENOENT: 2, EBADF: 9, ENOMEM: 12, EACCES: 13, EFAULT: 14, EEXIST: 17, ENOTDIR: 20, EISDIR: 21,
  EINVAL: 22, ENOTTY: 25, ESPIPE: 29, ERANGE: 34, ENOSYS: 38, ENOTEMPTY: 39, ENOSPC: 28, ENODATA: 61 };

export function installLinux(machine, { onOutput, realTime } = {}) {
  const cpu = machine.cpu, mem = machine.mem;
  const lx = {
    pages: new Map(),          // virtual page number -> { frame, write }
    nextFrame: FRAMES_BASE,
    brkStart: 0, brk: 0, mmapNext: MMAP_BASE,
    done: false, status: 0, signal: 0,
    stdout: [], stderr: [],
    unimplemented: new Map(),  // syscall number -> count
    onOutput,
  };
  machine.linux = lx;
  cpu.udToGuest = true;          // an invalid opcode is the program's SIGILL, not ours to report

  // ---- page tables -------------------------------------------------------------------------------
  const allocFrame = () => {
    const f = lx.nextFrame; lx.nextFrame += PAGE;
    if (lx.nextFrame > mem.size) throw new Error('mirage-linux: out of physical memory');
    mem.u8.fill(0, f, f + PAGE);
    return f;
  };
  const dv = new DataView(mem.u8.buffer, mem.u8.byteOffset, mem.u8.byteLength);
  const mapPage = (vpn, write) => {
    const have = lx.pages.get(vpn);
    if (have) { if (write && !have.write) { have.write = true; setPte(vpn, have.frame, true); } return have.frame; }
    const frame = allocFrame();
    lx.pages.set(vpn, { frame, write: !!write });
    setPte(vpn, frame, write);
    return frame;
  };
  const setPte = (vpn, frame, write, user = true) => {
    const pdeA = PD_BASE + (vpn >>> 10) * 4;
    let pde = dv.getUint32(pdeA, true);
    if (!(pde & 1)) { pde = (allocFrame() | 7) >>> 0; dv.setUint32(pdeA, pde, true); }   // P RW US: the PTE decides
    const pteA = (pde & 0xfffff000) + (vpn & 0x3ff) * 4;
    dv.setUint32(pteA, (frame | (user ? 5 : 1) | (write ? 2 : 0)) >>> 0, true);        // P US (+RW)
  };
  const mapRange = (start, end, write) => {
    for (let p = start >>> 12; p < Math.ceil(end / PAGE); p++) mapPage(p, write);
  };
  const unmapRange = (start, end) => {
    for (let p = start >>> 12; p < Math.ceil(end / PAGE); p++) {
      if (!lx.pages.delete(p)) continue;
      const pde = dv.getUint32(PD_BASE + (p >>> 10) * 4, true);
      if (pde & 1) dv.setUint32((pde & 0xfffff000) + (p & 0x3ff) * 4, 0, true);
    }
    cpu.setCR3(cpu.cr3);                                   // the software TLB forgets them
  };

  // ---- the program's memory, as the kernel sees it -------------------------------------------------
  // Physical addresses through our own map: no CPU translation, no fault in the kernel.
  const phys = (va) => { const p = lx.pages.get(va >>> 12); return p ? p.frame + (va & 0xfff) : -1; };
  const rd8 = (va) => { const a = phys(va >>> 0); if (a < 0) throw E.EFAULT; return mem.u8[a]; };
  const rd32 = (va) => (rd8(va) | (rd8(va + 1) << 8) | (rd8(va + 2) << 16) | (rd8(va + 3) << 24)) >>> 0;
  const wr8 = (va, v) => {
    const p = lx.pages.get((va >>> 0) >>> 12); if (!p) throw E.EFAULT;
    mem.u8[p.frame + (va & 0xfff)] = v;
    if (mem.codePage[(va >>> 0) >>> 12]) mem._dirty(va >>> 0, 1);    // code we already translated
  };
  const wr32 = (va, v) => { for (let i = 0; i < 4; i++) wr8(va + i, (v >>> (8 * i)) & 0xff); };
  const rdBytes = (va, n) => { const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = rd8(va + i); return b; };
  const wrBytes = (va, b) => { for (let i = 0; i < b.length; i++) wr8(va + i, b[i]); };
  const rdStr = (va) => { let s = ''; for (let c; (c = rd8(va++));) s += String.fromCharCode(c); return s; };
  lx.rdBytes = rdBytes; lx.rdStr = rdStr;

  // ---- descriptors -------------------------------------------------------------------------------
  const setDesc = (index, base, limit, access, flags) => {
    const a = GDT_BASE + index * 8;
    dv.setUint16(a, limit & 0xffff, true); dv.setUint16(a + 2, base & 0xffff, true);
    mem.u8[a + 4] = (base >>> 16) & 0xff; mem.u8[a + 5] = access;
    mem.u8[a + 6] = (flags & 0xf0) | ((limit >>> 16) & 0x0f); mem.u8[a + 7] = (base >>> 24) & 0xff;
  };

  // ---- the ELF loader ----------------------------------------------------------------------------
  // Where a kernel with address-space randomisation off puts things on i386: a PIE executable at
  // 5655_5000h (ELF_ET_DYN_BASE), and the dynamic linker in the mmap area, which grows up from
  // 4000_0000h here (the legacy layout).
  const PIE_BASE = 0x56555000;
  const elfHeader = (elf) => {
    const d = new DataView(elf.buffer, elf.byteOffset, elf.byteLength);
    if (elf.length < 52 || d.getUint32(0, false) !== 0x7f454c46) throw new Error('mirage-linux: not an ELF file');
    if (elf[4] !== 1 || elf[5] !== 1) throw new Error('mirage-linux: not ELF32 little-endian');
    if (d.getUint16(18, true) !== 3) throw new Error('mirage-linux: not an i386 program');
    const type = d.getUint16(16, true);
    if (type !== 2 && type !== 3) throw new Error('mirage-linux: neither an executable nor a shared object');
    const h = { d, type, entry: d.getUint32(24, true), phoff: d.getUint32(28, true),
      phentsize: d.getUint16(42, true), phnum: d.getUint16(44, true), ph: [] };
    for (let i = 0; i < h.phnum; i++) {
      const o = h.phoff + i * h.phentsize;
      h.ph.push({ type: d.getUint32(o, true), off: d.getUint32(o + 4, true), va: d.getUint32(o + 8, true),
        filesz: d.getUint32(o + 16, true), memsz: d.getUint32(o + 20, true), flags: d.getUint32(o + 24, true) });
    }
    return h;
  };
  /** Map an image's PT_LOAD segments at `bias` (0 for ET_EXEC). Returns its PHDR address and top. */
  const loadImage = (elf, h, bias) => {
    let top = 0, phdr = 0;
    for (const ph of h.ph) {
      if (ph.type === 6) phdr = ph.va + bias;                             // PT_PHDR
      if (ph.type !== 1) continue;                                        // PT_LOAD
      const va = (ph.va + bias) >>> 0;
      mapRange(va, va + ph.memsz, (ph.flags & 2) !== 0);
      for (let k = 0; k < ph.filesz; k++) mem.u8[phys(va + k)] = elf[ph.off + k];
      if (!phdr && ph.off <= h.phoff && h.phoff < ph.off + ph.filesz) phdr = va + (h.phoff - ph.off);
      top = Math.max(top, va + ph.memsz);
    }
    return { phdr: phdr >>> 0, top };
  };
  const span = (h) => {                                                   // the address range an ET_DYN needs
    let lo = Infinity, hi = 0;
    for (const ph of h.ph) if (ph.type === 1) { lo = Math.min(lo, ph.va & ~0xfff); hi = Math.max(hi, ph.va + ph.memsz); }
    return Math.ceil((hi - lo) / PAGE) * PAGE;
  };

  /**
   * Map an ELF32 i386 program — static, or dynamic through its PT_INTERP — and point the CPU at the
   * entry, with the initial stack a kernel builds: argc, argv[], NULL, envp[], NULL, the auxiliary
   * vector, then the strings. A dynamic program's interpreter (/lib/ld-linux.so.2) is read from our
   * file system and started instead; it finds the program through AT_PHDR and AT_ENTRY.
   */
  lx.load = (elf, argv = ['a.out'], envp = []) => {
    const h = elfHeader(elf);
    mem.u8.fill(0, PD_BASE, PD_BASE + PAGE);
    // The GDT is read through paging like any other linear address: identity-mapped, supervisor only.
    setPte(GDT_BASE >>> 12, GDT_BASE, true, false);
    lx.mmapNext = MMAP_BASE;
    const bias = h.type === 3 ? PIE_BASE : 0;
    const main = loadImage(elf, h, bias);
    lx.brkStart = lx.brk = Math.ceil(main.top / PAGE) * PAGE;
    const entry = (h.entry + bias) >>> 0;
    let start = entry, interpBase = 0;
    const pin = h.ph.find((ph) => ph.type === 3);                         // PT_INTERP
    if (pin) {
      let name = ''; for (let k = pin.off; elf[k]; k++) name += String.fromCharCode(elf[k]);
      const ib = lx.readFile(name);
      if (!ib) throw new Error(`mirage-linux: the program's interpreter ${name} is not in the file system`);
      const ih = elfHeader(ib);
      interpBase = lx.mmapNext; lx.mmapNext += span(ih);
      loadImage(ib, ih, interpBase);
      start = (ih.entry + interpBase) >>> 0;
    }

    // The stack, and what a kernel leaves on it.
    mapRange(STACK_TOP - STACK_SIZE, STACK_TOP, true);
    let sp = STACK_TOP;
    const pushStr = (s) => { const b = new TextEncoder().encode(s + '\0'); sp -= b.length; for (let i = 0; i < b.length; i++) mem.u8[phys(sp + i)] = b[i]; return sp; };
    const execfn = pushStr(argv[0] || '');
    const envAddrs = envp.map(pushStr);
    const argAddrs = argv.map(pushStr);
    const platform = pushStr('i686');
    sp -= 16; const random = sp;
    for (let i = 0; i < 16; i++) mem.u8[phys(random + i)] = (i * 73 + 41) & 0xff;   // AT_RANDOM: fixed, so runs repeat
    sp &= ~15;
    const auxv = [[3, main.phdr], [4, h.phentsize], [5, h.phnum], [6, PAGE], [7, interpBase], [8, 0], [9, entry],
      [11, 0], [12, 0], [13, 0], [14, 0], [16, 0], [17, 100], [23, 0], [25, random], [15, platform], [31, execfn], [0, 0]];
    const words = [argv.length, ...argAddrs, 0, ...envAddrs, 0, ...auxv.flat()];
    sp -= words.length * 4; sp &= ~15;
    for (let i = 0; i < words.length; i++) dv.setUint32(phys(sp + i * 4), words[i] >>> 0, true);

    // Flat segments, paging, ring 3.
    mem.u8.fill(0, GDT_BASE, GDT_BASE + GDT_ENTRIES * 8);
    setDesc(USER_CS >> 3, 0, 0xfffff, 0xfa, 0xc0);                       // code, DPL 3, 4 GiB, 32-bit
    setDesc(USER_DS >> 3, 0, 0xfffff, 0xf2, 0xc0);                       // data, DPL 3
    cpu.gdtr.base = GDT_BASE; cpu.gdtr.limit = GDT_ENTRIES * 8 - 1;
    cpu.idtr.base = 0; cpu.idtr.limit = 0;                               // INT 80h and faults never reach it
    mem.setA20(true); machine.rec.setMask(mem.mask);
    cpu.setCR3(PD_BASE);
    cpu.setCR0((cpu.cr0 | 0x80000001) >>> 0);                            // PE + PG
    machine.rec.reset();
    cpu._cpl = 3;
    for (const s of [0, 2, 3, 4, 5]) cpu.setSeg(s, USER_DS);              // ES SS DS FS GS
    cpu.setSeg(1, USER_CS);
    cpu.reg.fill(0); cpu.reg[4] = sp >>> 0;
    cpu.eip = start >>> 0;
    cpu.flags = 0x0002;                     // IF clear: no device interrupts reach a program here
    lx.done = false; lx.status = 0; lx.signal = 0;
    lx.exe = norm(argv[0] || '/a.out');
  };

  // ---- ending ------------------------------------------------------------------------------------
  const exit = (status, signal = 0) => {
    lx.done = true; lx.status = signal ? 128 + signal : status & 0xff; lx.signal = signal;
    cpu.halted = true;
    machine.rec.stop && machine.rec.stop();
  };
  lx.fault = (n, err) => {
    // The stack grows on demand, as a kernel grows it: a page fault anywhere in its 8 MiB maps the
    // page and the instruction runs again. gcc's memcpy-1 keeps two 1 MiB arrays there.
    const cr2 = cpu.cr2 >>> 0;
    if (n === 14 && !(err & 1) && cr2 < STACK_TOP && cr2 >= STACK_TOP - STACK_MAX) { mapPage(cr2 >>> 12, true); return; }
    const sig = n === 0 ? SIG.SIGFPE : n === 6 ? SIG.SIGILL : n === 16 || n === 19 ? SIG.SIGFPE : SIG.SIGSEGV;
    lx.faultInfo = { n, err, eip: cpu.eip >>> 0, cr2: cpu.cr2 >>> 0 };
    exit(0, sig);
  };

  // ---- files -------------------------------------------------------------------------------------
  // One in-memory tree: absolute path -> node. A directory is { dir: true }, a file { data, size }.
  // Paths are case-sensitive and '/'-separated, as a Linux program writes them. The host fills it
  // before the run (addFile) and reads it after (readFile): tools/linux/run.mjs mounts the program's
  // own directory at /w and starts there, which is what `docker run -v dir:/w -w /w` does.
  const fs = new Map([['/', { dir: true, mtime: 0 }]]);
  const norm = (path, base = lx.cwd) => {
    const parts = [];
    for (const p of ((path.startsWith('/') ? '' : base + '/') + path).split('/')) {
      if (!p || p === '.') continue;
      if (p === '..') parts.pop(); else parts.push(p);
    }
    return '/' + parts.join('/');
  };
  const parent = (p) => p.slice(0, p.lastIndexOf('/')) || '/';
  const join = (d, n) => (d === '/' ? '/' + n : d + '/' + n);
  // A ROOT ON THE HOST, read lazily (lx.host, from run.mjs: a Debian i386 tree): { lstat(p) ->
  // {type:'dir'|'file'|'link', size, target} | null, read(p) -> bytes, list(p) -> names }. A node
  // is made the first time a path is looked up, a file's bytes the first time it is opened, and a
  // path the program removed is remembered so the host's copy does not come back.
  lx.host = null;
  const gone = new Set();
  const getNode = (p) => {
    let n = fs.get(p);
    if (n || !lx.host || gone.has(p)) return n;
    const st = lx.host.lstat(p);
    if (!st) return undefined;
    const meta = { mtime: st.mtime ?? lx.epoch, mode: st.mode, nlink: st.nlink };
    n = st.type === 'dir' ? { dir: true, host: true, ...meta }
      : st.type === 'link' ? { link: st.target, ...meta }
        : { data: null, size: st.size, host: p, ...meta };
    fs.set(p, n); return n;
  };
  const dataOf = (n) => { if (n.data === null) { n.data = lx.host.read(n.host); n.size = n.data.length; } return n.data; };
  const removeNode = (p) => { fs.delete(p); gone.add(p); };
  /** A path to the canonical one of what it names, every symbolic link on the way followed — the
   *  last one too unless `follow` is false (lstat, unlink, readlink). The last component need not
   *  exist (open with O_CREAT); one in the middle must. Null when it cannot be resolved. */
  const resolve = (path, base = lx.cwd, follow = true, hops = 0) => {
    if (hops > 40) return null;                                              // ELOOP
    const parts = path.split('/');
    let cur = path.startsWith('/') ? '/' : base;
    for (let i = 0; i < parts.length; i++) {
      const c = parts[i];
      if (!c || c === '.') continue;
      if (c === '..') { cur = parent(cur); continue; }
      const next = join(cur, c), n = getNode(next);
      const last = !parts.slice(i + 1).some((x) => x && x !== '.');
      if (n && n.link !== undefined && (!last || follow)) {
        const r = resolve(n.link, cur, true, hops + 1);
        if (r === null) return null;
        cur = r; continue;
      }
      if (!n && !last) return null;
      if (n && !last && !n.dir) return null;
      cur = next;
    }
    return cur;
  };
  const mkdirs = (p) => { if (getNode(p)) return; mkdirs(parent(p)); fs.set(p, { dir: true, mtime: lx.now() }); };
  lx.fs = fs; lx.cwd = '/';
  fs.set('/tmp', { dir: true, mtime: 0 });                                 // tmpnam() and friends write there
  // The character devices every program assumes. A tree unpacked on the host has none (macOS's tar
  // cannot make device nodes), and Perl stops at once: "Can't open /dev/null".
  fs.set('/dev', { dir: true, mtime: 0 });
  for (const d of ['null', 'zero', 'full', 'random', 'urandom']) fs.set('/dev/' + d, { dev: d, mtime: 0 });
  lx.addFile = (path, bytes) => { const p = norm(path, '/'); mkdirs(parent(p)); fs.set(p, { data: Uint8Array.from(bytes), size: bytes.length, mtime: lx.now() }); };
  lx.readFile = (path) => { const r = resolve(path, '/'), n = r && getNode(r); return n && !n.dir && n.link === undefined ? dataOf(n).subarray(0, n.size) : null; };
  lx.mkdir = (path) => mkdirs(norm(path, '/'));
  lx.chdir = (path) => { lx.cwd = norm(path, '/'); };
  lx.stdin = new Uint8Array(0); lx.stdinPos = 0;
  lx.exe = '/a.out';
  // Time runs with the guest's cycles from a fixed start, so a run repeats. A benchmark wants the
  // host's clock instead — how fast MIRAGE really is — and `realTime` (run.mjs: MIRAGE_LXWALLCLOCK=1)
  // gives every clock the wall clock.
  lx.epoch = 1767225600;                                       // 2026-01-01T00:00:00Z
  lx.realTime = !!realTime;
  lx.now = () => lx.realTime ? Date.now() / 1000 : lx.epoch + cpu.cycles / (machine.cyclesPerSecond || 1e8);
  lx.mono = () => lx.realTime ? performance.now() / 1000 : cpu.cycles / (machine.cyclesPerSecond || 1e8);

  // File descriptors: 0-2 are the pipes the oracle has (Docker without -t), never a terminal.
  const fds = [{ pipe: 0 }, { pipe: 1 }, { pipe: 2 }];
  lx.fds = fds;
  const fdOf = (fd) => { const f = fds[fd]; if (!f) throw E.EBADF; return f; };
  const newFd = (f, min = 0) => { let i = min; while (fds[i]) i++; fds[i] = f; return i; };
  const grow = (node, size) => {
    if (size <= node.data.length) return;
    const d = new Uint8Array(Math.max(size, node.data.length * 2, 256)); d.set(node.data); node.data = d;
  };
  // A signal sent to ourselves takes its default action: most end the process with 128+sig, a few
  // are ignored. One with a handler installed is not delivered yet — it ends the process too, which
  // is what a program that relies on its handler would not expect; lx.sigHandlers says which.
  lx.sigHandlers = [];
  const IGNORED = new Set([17, 23, 28]);                                   // SIGCHLD, SIGURG, SIGWINCH
  const raise = (sig) => {
    if (sig === 0) return 0;
    if (sig < 1 || sig > 64) return -E.EINVAL;
    if (lx.sigHandlers[sig] === 1 || (IGNORED.has(sig) && !lx.sigHandlers[sig])) return 0;   // SIG_IGN
    exit(0, sig); return 0;
  };
  const out = (fd, bytes) => {
    (fd === 2 ? lx.stderr : lx.stdout).push(...bytes);
    if (lx.onOutput) lx.onOutput(fd, bytes);
  };
  const doWrite = (fd, bytes) => {
    const f = fdOf(fd);
    if (f.pipe !== undefined) { if (f.pipe === 0) return -E.EBADF; out(f.pipe, bytes); return bytes.length; }
    if (f.node.dev) return f.node.dev === 'full' ? -E.ENOSPC : bytes.length;
    if (f.node.dir) return -E.EISDIR;
    if ((f.flags & 3) === 0) return -E.EBADF;                               // O_RDONLY
    if (f.flags & 0x400) f.pos = f.node.size;                               // O_APPEND
    grow(f.node, f.pos + bytes.length);
    f.node.data.set(bytes, f.pos); f.pos += bytes.length;
    f.node.size = Math.max(f.node.size, f.pos); f.node.mtime = lx.now();
    return bytes.length;
  };
  const doRead = (fd, buf, n, at) => {
    const f = fdOf(fd);
    let src;
    if (f.pipe !== undefined) {
      if (f.pipe !== 0) return -E.EBADF;
      src = lx.stdin.subarray(lx.stdinPos, lx.stdinPos + n); lx.stdinPos += src.length;
    } else if (f.node.dev) {
      const d = f.node.dev;
      src = d === 'null' ? new Uint8Array(0) : new Uint8Array(Math.min(n, 1 << 20));
      if (d === 'random' || d === 'urandom') for (let i = 0; i < src.length; i++) src[i] = (lx.rng = (Math.imul(lx.rng || 12345, 1103515245) + 12345) >>> 0) >>> 24;
    } else {
      if (f.node.dir) return -E.EISDIR;
      if ((f.flags & 3) === 1) return -E.EBADF;                             // O_WRONLY
      const pos = at === undefined ? f.pos : at;
      src = f.node.data.subarray(Math.min(pos, f.node.size), Math.min(pos + n, f.node.size));
      if (at === undefined) f.pos += src.length;
    }
    wrBytes(buf, src); return src.length;
  };
  const doOpen = (path, flags, base = lx.cwd) => {
    const p = resolve(path, base);
    if (p === null) return -E.ENOENT;
    let node = getNode(p);
    if (node && (flags & 0xc0) === 0xc0) return -E.EEXIST;                  // O_CREAT|O_EXCL
    if (!node) {
      if (!(flags & 0x40)) return -E.ENOENT;                                // O_CREAT
      const dir = getNode(parent(p));
      if (!dir) return -E.ENOENT;
      if (!dir.dir) return -E.ENOTDIR;
      node = { data: new Uint8Array(0), size: 0, mtime: lx.now() }; fs.set(p, node);
    }
    if (node.dir && (flags & 3)) return -E.EISDIR;
    if (!node.dir && !node.dev) dataOf(node);
    if ((flags & 0x10000) && !node.dir) return -E.ENOTDIR;                  // O_DIRECTORY
    if ((flags & 0x200) && !node.dir && (flags & 3)) { node.size = 0; node.mtime = lx.now(); }   // O_TRUNC
    return newFd({ node, path: p, pos: 0, flags });
  };
  const atBase = (dirfd) => {                                               // the *at() calls' starting directory
    if ((dirfd | 0) === -100) return lx.cwd;                                // AT_FDCWD
    const f = fdOf(dirfd); if (!f.node || !f.node.dir) throw E.ENOTDIR; return f.path;
  };
  // struct stat64, 96 bytes (arch/x86/include/uapi/asm/stat.h).
  const inoOf = (p) => { let h = 2166136261; for (let i = 0; i < p.length; i++) h = Math.imul(h ^ p.charCodeAt(i), 16777619); return (h >>> 0) || 1; };
  const putStat = (buf, node, p) => {
    const b = new Uint8Array(96), d = new DataView(b.buffer);
    const isPipe = node.pipe !== undefined;
    d.setUint32(0, isPipe ? 0xc : 0x801, true);                             // st_dev
    d.setUint32(12, inoOf(p), true);
    const type = isPipe ? 0o010000 : node.dev ? 0o020000 : node.dir ? 0o040000 : node.link !== undefined ? 0o120000 : 0o100000;
    const perm = node.link !== undefined ? 0o777 : node.mode !== undefined ? node.mode & 0o7777 : isPipe ? 0o600 : node.dev ? 0o666 : node.dir ? 0o755 : node.link !== undefined ? 0o777 : 0o644;
    d.setUint32(16, type | perm, true);
    d.setUint32(20, node.nlink || (node.dir ? 2 : 1), true);
    const size = isPipe || node.dir ? (node.dir ? 4096 : 0) : node.link !== undefined ? node.link.length : node.size;
    d.setUint32(44, size, true);
    d.setUint32(52, 4096, true);
    d.setUint32(56, Math.ceil(size / 512), true);
    const t = Math.floor(node.mtime || lx.epoch);
    d.setUint32(64, t, true); d.setUint32(72, t, true); d.setUint32(80, t, true);
    d.setUint32(88, inoOf(p), true);
    wrBytes(buf, b); return 0;
  };
  const statPath = (base, path, buf, follow = true) => {
    const p = resolve(rdStr(path), base, follow), node = p && getNode(p);
    return node ? putStat(buf, node, p) : -E.ENOENT;
  };
  const putTime = (buf, s, frac, scale, wide) => {                          // timespec / timeval, 32- or 64-bit seconds
    if (wide) { wr32(buf, s >>> 0); wr32(buf + 4, Math.floor(s / 4294967296)); wr32(buf + 8, Math.floor(frac * scale)); wr32(buf + 12, 0); }
    else { wr32(buf, s >>> 0); wr32(buf + 4, Math.floor(frac * scale)); }
  };
  const clock = (id, buf, wide) => {
    const t = id === 0 || id === 5 || id === 8 ? lx.now() : lx.mono();   // REALTIME*, else monotonic and CPU time
    putTime(buf, Math.floor(t), t - Math.floor(t), 1e9, wide); return 0;
  };
  const getdents = (fd, buf, cnt) => {
    const f = fdOf(fd);
    if (!f.node || !f.node.dir) return -E.ENOTDIR;
    const pre = f.path === '/' ? '/' : f.path + '/';
    if (!f.names) {
      const set = new Set([...fs.keys()].filter((k) => k !== '/' && k.startsWith(pre) && !k.slice(pre.length).includes('/')).map((k) => k.slice(pre.length)));
      if (lx.host && f.node.host) for (const n of lx.host.list(f.path)) if (!gone.has(pre + n)) set.add(n);
      f.names = ['.', '..', ...[...set].sort()];
    }
    const names = f.names;
    let o = 0;
    while (f.pos < names.length) {
      const name = new TextEncoder().encode(names[f.pos]);
      const len = (19 + name.length + 1 + 7) & ~7;
      if (o + len > cnt) { if (o === 0) return -E.EINVAL; break; }
      const full = names[f.pos] === '.' ? f.path : names[f.pos] === '..' ? parent(f.path) : pre + names[f.pos];
      const node = getNode(full);
      const b = new Uint8Array(len), d = new DataView(b.buffer);
      d.setUint32(0, inoOf(full), true); d.setUint32(8, f.pos + 1, true);
      d.setUint16(16, len, true); b[18] = node && node.dir ? 4 : node && node.link !== undefined ? 10 : 8;   // DT_DIR / DT_LNK / DT_REG
      b.set(name, 19);
      wrBytes(buf + o, b); o += len; f.pos++;
    }
    return o;
  };
  const readlink = (path, base, buf, size) => {
    let t;
    if (path === '/proc/self/exe') t = lx.exe;
    else { const p = resolve(path, base, false), n = p && getNode(p); if (!n) return -E.ENOENT; if (n.link === undefined) return -E.EINVAL; t = n.link; }
    const b = new TextEncoder().encode(t).subarray(0, size);
    wrBytes(buf, b); return b.length;
  };
  const seek = (fd, off, whence) => {
    const f = fdOf(fd);
    if (f.pipe !== undefined) return -E.ESPIPE;
    if (f.node.dev) return 0;
    const base = whence === 0 ? 0 : whence === 1 ? f.pos : whence === 2 ? f.node.size : NaN;
    if (Number.isNaN(base) || base + off < 0) return -E.EINVAL;
    f.pos = base + off; return f.pos;
  };

  // ---- system calls --------------------------------------------------------------------------------
  // i386 numbers (arch/x86/entry/syscalls/syscall_32.tbl). Arguments in EBX ECX EDX ESI EDI EBP.
  const SYS = {
    1: (status) => { exit(status); },                                      // exit
    252: (status) => { exit(status); },                                    // exit_group
    3: (fd, buf, n) => doRead(fd, buf, n),                                 // read
    4: (fd, buf, n) => doWrite(fd, rdBytes(buf, n)),                       // write
    145: (fd, iov, cnt) => {                                               // readv
      let total = 0;
      for (let i = 0; i < cnt; i++) {
        const b = rd32(iov + i * 8), n = rd32(iov + i * 8 + 4), got = doRead(fd, b, n);
        if (got < 0) return total || got;
        total += got; if (got < n) break;
      }
      return total;
    },
    146: (fd, iov, cnt) => {                                               // writev
      let total = 0;
      for (let i = 0; i < cnt; i++) { const r = doWrite(fd, rdBytes(rd32(iov + i * 8), rd32(iov + i * 8 + 4))); if (r < 0) return total || r; total += r; }
      return total;
    },
    180: (fd, buf, n, lo, hi) => doRead(fd, buf, n, lo + hi * 4294967296),  // pread64
    5: (path, flags) => doOpen(rdStr(path), flags),                        // open
    295: (dirfd, path, flags) => doOpen(rdStr(path), flags, atBase(dirfd)),// openat
    6: (fd) => { fdOf(fd); delete fds[fd]; return 0; },                    // close
    19: (fd, off, whence) => seek(fd, off | 0, whence),                    // lseek
    140: (fd, hi, lo, res, whence) => {                                    // _llseek
      const r = seek(fd, (hi | 0) * 4294967296 + lo, whence);
      if (r < 0) return r;
      wr32(res, r >>> 0); wr32(res + 4, Math.floor(r / 4294967296)); return 0;
    },
    195: (path, buf) => statPath(lx.cwd, path, buf),                       // stat64
    196: (path, buf) => statPath(lx.cwd, path, buf, false),                // lstat64
    197: (fd, buf) => { const f = fdOf(fd); return putStat(buf, f.node || f, f.path || 'pipe:' + fd); },   // fstat64
    300: (dirfd, path, buf, flags) => {                                    // fstatat64
      if ((flags & 0x1000) && rd8(path) === 0) return SYS[197](dirfd, buf);  // AT_EMPTY_PATH
      return statPath(atBase(dirfd), path, buf, !(flags & 0x100));          // AT_SYMLINK_NOFOLLOW
    },
    33: (path) => { const r = resolve(rdStr(path)); return r && getNode(r) ? 0 : -E.ENOENT; },   // access
    307: (dirfd, path) => { const r = resolve(rdStr(path), atBase(dirfd)); return r && getNode(r) ? 0 : -E.ENOENT; },   // faccessat
    183: (buf, size) => {                                                  // getcwd
      const b = new TextEncoder().encode(lx.cwd + '\0');
      if (b.length > size) return -E.ERANGE;
      wrBytes(buf, b); return b.length;
    },
    12: (path) => {                                                        // chdir
      const p = resolve(rdStr(path)), n = p && getNode(p);
      if (!n) return -E.ENOENT; if (!n.dir) return -E.ENOTDIR;
      lx.cwd = p; return 0;
    },
    39: (path) => {                                                        // mkdir
      const p = resolve(rdStr(path), lx.cwd, false);
      if (p === null) return -E.ENOENT;
      if (getNode(p)) return -E.EEXIST;
      if (!getNode(parent(p))) return -E.ENOENT;
      fs.set(p, { dir: true, mtime: lx.now() }); gone.delete(p); return 0;
    },
    296: (dirfd, path) => SYS[39](path),                                   // mkdirat (relative to cwd only)
    40: (path) => {                                                        // rmdir
      const p = resolve(rdStr(path), lx.cwd, false), n = p && getNode(p);
      if (!n) return -E.ENOENT; if (!n.dir) return -E.ENOTDIR;
      if ([...fs.keys()].some((k) => k.startsWith(p + '/')) || (n.host && lx.host.list(p).some((c) => !gone.has(join(p, c))))) return -E.ENOTEMPTY;
      removeNode(p); return 0;
    },
    10: (path) => {                                                        // unlink: the link itself, not what it names
      const p = resolve(rdStr(path), lx.cwd, false), n = p && getNode(p);
      if (!n) return -E.ENOENT; if (n.dir) return -E.EISDIR;
      removeNode(p); return 0;
    },
    301: (dirfd, path, flags) => (flags & 0x200 ? SYS[40](path) : SYS[10](path)),   // unlinkat (AT_REMOVEDIR)
    38: (from, to) => {                                                    // rename (a file, or a directory of our own)
      const a = resolve(rdStr(from), lx.cwd, false), b = resolve(rdStr(to), lx.cwd, false), n = a && getNode(a);
      if (!n || b === null) return -E.ENOENT;
      if (!getNode(parent(b))) return -E.ENOENT;
      if (!n.dir && n.link === undefined) dataOf(n);
      for (const [k, v] of [...fs]) if (k === a || k.startsWith(a + '/')) { removeNode(k); fs.set(b + k.slice(a.length), v); gone.delete(b + k.slice(a.length)); }
      return 0;
    },
    83: (target, path) => {                                                // symlink
      const p = resolve(rdStr(path), lx.cwd, false);
      if (p === null) return -E.ENOENT; if (getNode(p)) return -E.EEXIST;
      fs.set(p, { link: rdStr(target), mtime: lx.now() }); gone.delete(p); return 0;
    },
    220: (fd, buf, cnt) => getdents(fd, buf, cnt),                         // getdents64
    41: (fd) => newFd({ ...fdOf(fd) }),                                    // dup (the offset is not shared: enough here)
    63: (fd, to) => { const f = fdOf(fd); if (fd !== to) fds[to] = { ...f }; return to; },   // dup2
    221: (fd, cmd, arg) => {                                               // fcntl64
      const f = fdOf(fd);
      if (cmd === 0 || cmd === 1030) return newFd({ ...f }, arg);           // F_DUPFD, F_DUPFD_CLOEXEC
      if (cmd === 1 || cmd === 2) return 0;                                 // F_GETFD / F_SETFD
      if (cmd === 3) return f.flags !== undefined ? f.flags : (f.pipe === 0 ? 0 : 1);   // F_GETFL
      return 0;
    },
    194: (fd, lo, hi) => { const f = fdOf(fd); if (!f.node || f.node.dir) return -E.EINVAL; const n = lo + hi * 4294967296; grow(f.node, n); f.node.data.fill(0, Math.min(n, f.node.size), n); f.node.size = n; return 0; },   // ftruncate64
    118: () => 0, 148: () => 0,                                            // fsync, fdatasync
    54: (fd) => { fdOf(fd); return -E.ENOTTY; },                           // ioctl: nothing is a terminal
    85: (path, buf, size) => readlink(rdStr(path), lx.cwd, buf, size),     // readlink
    305: (dirfd, path, buf, size) => readlink(rdStr(path), atBase(dirfd), buf, size),   // readlinkat
    45: (addr) => {                                                        // brk
      if (addr === 0 || addr < lx.brkStart) return lx.brk;
      if (addr > lx.brk) mapRange(lx.brk, addr, true);
      lx.brk = addr; return lx.brk;
    },
    192: (addr, len, prot, flags, fd, pgoff) => {                          // mmap2
      const size = Math.ceil(len / PAGE) * PAGE;
      const at = (flags & 0x10) ? addr : lx.mmapNext;                      // MAP_FIXED
      if (!(flags & 0x10)) lx.mmapNext += size;
      let src = null;
      if (!(flags & 0x20)) {                                                // a file: copied, not shared
        const f = fdOf(fd); if (!f.node || f.node.dir) return -E.EACCES;
        src = f.node.data.subarray(Math.min(pgoff * PAGE, f.node.size), Math.min(pgoff * PAGE + len, f.node.size));
      }
      unmapRange(at, at + size); mapRange(at, at + size, true);
      if (src) wrBytes(at, src);
      return at;
    },
    90: () => -E.ENOSYS,                                                   // old_mmap: libcs use mmap2
    91: (addr, len) => { unmapRange(addr, addr + len); return 0; },        // munmap
    163: (old, oldLen, newLen, flags) => {                                 // mremap: move to fresh pages
      if (!(flags & 1)) return newLen <= oldLen ? old : -E.ENOMEM;          // MREMAP_MAYMOVE
      const at = lx.mmapNext, size = Math.ceil(newLen / PAGE) * PAGE; lx.mmapNext += size;
      mapRange(at, at + size, true);
      wrBytes(at, rdBytes(old, Math.min(oldLen, newLen)));
      unmapRange(old, old + oldLen); return at;
    },
    125: () => 0,                                                          // mprotect: pages stay as mapped
    219: () => 0,                                                          // madvise
    243: (uinfo) => {                                                      // set_thread_area
      let idx = rd32(uinfo) | 0;
      if (idx === -1) idx = TLS_MIN;
      if (idx < TLS_MIN || idx >= TLS_MIN + TLS_ENTRIES) return -E.EINVAL;
      const base = rd32(uinfo + 4), limit = rd32(uinfo + 8), fl = rd32(uinfo + 12);
      setDesc(idx, base, limit, 0xf2, (fl & 1 ? 0x40 : 0) | (fl & 0x10 ? 0x80 : 0));   // seg_32bit, limit_in_pages
      wr32(uinfo, idx);
      return 0;
    },
    258: () => 1,                                                          // set_tid_address -> tid
    311: () => 0,                                                          // set_robust_list
    20: () => 1, 64: () => 0, 224: () => 1,                                // getpid, getppid, gettid
    174: (sig, act) => {                                                   // rt_sigaction: remembered, not yet delivered
      if (act) lx.sigHandlers[sig] = rd32(act);
      return 0;
    },
    175: () => 0, 186: () => 0,                                            // rt_sigprocmask, sigaltstack
    37: (pid, sig) => raise(sig),                                          // kill: there is one process
    238: (tid, sig) => raise(sig),                                         // tkill
    270: (tgid, tid, sig) => raise(sig),                                   // tgkill
    199: () => 0, 200: () => 0, 201: () => 0, 202: () => 0,                // get[e]uid32, get[e]gid32
    60: () => 0o022,                                                       // umask
    191: (res, rl) => { wr32(rl, 0xffffffff); wr32(rl + 4, 0xffffffff); if (res === 3) { wr32(rl, 8 << 20); } return 0; },   // ugetrlimit: stack 8 MiB, the rest unlimited
    340: (pid, res, nw, old) => { if (old) { wr32(old, 0xffffffff); wr32(old + 4, 0xffffffff); wr32(old + 8, 0xffffffff); wr32(old + 12, 0xffffffff); if (res === 3) { wr32(old, 8 << 20); wr32(old + 4, 0); } } return 0; },   // prlimit64
    355: (buf, n) => { for (let i = 0; i < n; i++) wr8(buf + i, (lx.rng = (Math.imul(lx.rng || 12345, 1103515245) + 12345) >>> 0) >>> 24); return n; },   // getrandom: seeded, so runs repeat
    13: (tloc) => { const t = Math.floor(lx.now()); if (tloc) wr32(tloc, t); return t; },   // time
    78: (tv) => { const t = lx.now(); if (tv) putTime(tv, Math.floor(t), t - Math.floor(t), 1e6, false); return 0; },   // gettimeofday
    265: (id, ts) => clock(id, ts, false),                                 // clock_gettime
    403: (id, ts) => clock(id, ts, true),                                  // clock_gettime64
    266: (id, ts) => { if (ts) putTime(ts, 0, 1e-9, 1e9, false); return 0; },   // clock_getres
    162: () => 0,                                                          // nanosleep: no time to wait for
    43: (buf) => {                                                         // times: all of it user time, in 100 Hz ticks
      const ticks = Math.floor(lx.mono() * 100);
      if (buf) { wr32(buf, ticks); wr32(buf + 4, 0); wr32(buf + 8, 0); wr32(buf + 12, 0); }
      return ticks;
    },
    // Extended attributes (getxattr, lgetxattr, fgetxattr, listxattr...): none here, as on a file
    // system without ACLs — ENODATA to a get, an empty list. ls -l asks for each file it lists.
    229: () => -E.ENODATA, 230: () => -E.ENODATA, 231: () => -E.ENODATA,
    232: () => 0, 233: () => 0, 234: () => 0,
    122: (buf) => {                                                        // uname: as the oracle's i386 kernel says
      const f = ['Linux', 'mirage', '2.6.32', '#1', 'i686', '(none)'];
      for (let i = 0; i < 6; i++) { const b = new TextEncoder().encode(f[i]); wrBytes(buf + i * 65, b); wr8(buf + i * 65 + b.length, 0); }
      return 0;
    },
  };

  lx.syscall = () => {
    const r = cpu.reg, n = r[0] >>> 0;
    const fn = SYS[n];
    let ret;
    if (!fn) { lx.unimplemented.set(n, (lx.unimplemented.get(n) || 0) + 1); ret = -E.ENOSYS; }
    else {
      try { ret = fn(r[3] >>> 0, r[1] >>> 0, r[2] >>> 0, r[6] >>> 0, r[7] >>> 0, r[5] >>> 0); }
      catch (e) { if (typeof e === 'number') ret = -e; else throw e; }
    }
    if (!lx.done && ret !== undefined) r[0] = ret | 0;
  };

  return lx;
}
