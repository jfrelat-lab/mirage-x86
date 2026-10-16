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
// The GDT's LINEAR address: in the kernel's part of the address space, as Linux keeps its tables. At
// its physical address (11000h) it sat inside an a.out ZMAGIC program, whose text runs from address 0:
// linuxsdoom's first page mapping replaced it, and loading CS took #GP(70h).
const GDT_LIN = 0xffc00000;
// A TSS for its I/O permission bitmap only: ioperm(2) opens ports in it, as the kernel does, and the
// CPU consults it for IN/OUT at CPL 3 whatever IOPL says (SVGAlib asks ioperm, then iopl(3), then
// iopl(0) again, and keeps programming the card through the ports ioperm gave it).
const TSS_BASE = 0x12000, TSS_LIN = 0xffc01000, IOMAP = 0x68, TSS_LIMIT = IOMAP + 8192;
const USER_CS = 0x73, USER_DS = 0x7b;                     // GDT entries 14 and 15, RPL 3
const TLS_MIN = 6, TLS_ENTRIES = 3;                       // set_thread_area's slots, as Linux has them
const GDT_ENTRIES = 32;
const STACK_TOP = 0xc0000000, STACK_SIZE = 0x40000;       // 256 KiB mapped up front...
const STACK_MAX = 8 << 20;                                // ...and grown on demand to 8 MiB, RLIMIT_STACK
const MMAP_BASE = 0x40000000;

const SIG = { SIGILL: 4, SIGFPE: 8, SIGSEGV: 11 };
const BLOCK = Symbol('block');                            // a system call that waits: int 80h runs again
const E = { EPERM: 1, ENOENT: 2, EBADF: 9, ENOMEM: 12, EACCES: 13, EFAULT: 14, EEXIST: 17, ENOTDIR: 20, EISDIR: 21,
  EINVAL: 22, ENOTTY: 25, ESPIPE: 29, ERANGE: 34, ENOSYS: 38, ENOTEMPTY: 39, ENOSPC: 28, ENODATA: 61, ENOEXEC: 8, EMFILE: 24, EAGAIN: 11, ECHILD: 10 };

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
  // Frames come back when a process exits or execs, so a shell that forks for every command does
  // not run out of memory.
  const freeFrames = [];
  const allocFrame = () => {
    let f = freeFrames.pop();
    if (f === undefined) {
      f = lx.nextFrame; lx.nextFrame += PAGE;
      if (lx.nextFrame > mem.size) throw new Error('mirage-linux: out of physical memory');
    }
    mem.u8.fill(0, f, f + PAGE);
    return f;
  };
  const dv = new DataView(mem.u8.buffer, mem.u8.byteOffset, mem.u8.byteLength);
  const mapPage = (vpn, write) => {
    const have = lx.pages.get(vpn);
    if (have) { if (have.none || (write && !have.write)) { have.none = false; if (write) have.write = true; setPte(vpn, have.frame, have.write); } return have.frame; }
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
  /** Map virtual pages straight onto physical frames — /dev/mem. The frames are the machine's own:
   *  A0000h-AFFFFh is the emulated VGA's window, so SVGAlib drawing through its mapping draws on it. */
  const mapPhys = (va, pa, len, write) => {
    for (let i = 0; i < Math.ceil(len / PAGE); i++) {
      const vpn = (va >>> 12) + i, frame = (pa & ~0xfff) + i * PAGE;
      lx.pages.set(vpn, { frame, write: !!write, phys: true });
      setPte(vpn, frame, write);
    }
    cpu.setCR3(cpu.cr3);
  };
  /** Drop every user mapping of a page set (its PTEs), and give its frames back. */
  const releasePages = (pages, free = true) => {
    for (const [vpn, pg] of pages) {
      const pde = dv.getUint32(PD_BASE + (vpn >>> 10) * 4, true);
      if (pde & 1) dv.setUint32((pde & 0xfffff000) + (vpn & 0x3ff) * 4, 0, true);
      if (free && !pg.phys) freeFrames.push(pg.frame);
    }
  };
  const clearPte = (vpn) => { const pde = dv.getUint32(PD_BASE + (vpn >>> 10) * 4, true); if (pde & 1) dv.setUint32((pde & 0xfffff000) + (vpn & 0x3ff) * 4, 0, true); };
  const installPages = (pages) => { for (const [vpn, pg] of pages) if (pg.none) clearPte(vpn); else setPte(vpn, pg.frame, pg.write); };
  const unmapRange = (start, end) => {
    for (let p = start >>> 12; p < Math.ceil(end / PAGE); p++) {
      const had = lx.pages.get(p);
      if (!had) continue;
      lx.pages.delete(p);
      if (!had.phys) freeFrames.push(had.frame);
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

  // ---- a.out, the format before ELF (Linux 0.x-1.2, libc 4) ---------------------------------------
  // struct exec: a_info (magic in the low 16 bits), a_text, a_data, a_bss, a_syms, a_entry, a_trsize,
  // a_drsize. As fs/binfmt_aout.c lays it out: ZMAGIC's text starts at file offset 1024 and runs at
  // address 0; QMAGIC's header is part of its text, which runs at 0x1000; OMAGIC/NMAGIC follow a
  // 32-byte header and run at 0. The data follows the text (page-aligned but OMAGIC), then the bss.
  const ZMAGIC = 0x10b, QMAGIC = 0xcc, OMAGIC = 0x107, NMAGIC = 0x108;
  const aoutHeader = (b) => {
    if (b.length < 32) return null;
    const d = new DataView(b.buffer, b.byteOffset, b.byteLength), magic = d.getUint32(0, true) & 0xffff;
    if (![ZMAGIC, QMAGIC, OMAGIC, NMAGIC].includes(magic)) return null;
    return { magic, text: d.getUint32(4, true), data: d.getUint32(8, true), bss: d.getUint32(12, true), entry: d.getUint32(20, true) };
  };
  const loadAout = (b, h, base) => {                                      // base: a library's own address, else per magic
    const txtOff = h.magic === ZMAGIC ? 1024 : h.magic === QMAGIC ? 0 : 32;
    const txtAddr = base !== undefined ? base : h.magic === QMAGIC ? PAGE : 0;
    const datAddr = h.magic === OMAGIC ? txtAddr + h.text : txtAddr + Math.ceil(h.text / PAGE) * PAGE;
    mapRange(txtAddr, txtAddr + h.text, true);                            // writable: libc 4 patches its jump table
    mapRange(datAddr, datAddr + h.data + h.bss, true);
    for (let k = 0; k < h.text; k++) mem.u8[phys(txtAddr + k)] = b[txtOff + k];
    for (let k = 0; k < h.data; k++) mem.u8[phys(datAddr + k)] = b[txtOff + h.text + k];
    return datAddr + h.data + h.bss;
  };
  /** uselib(2): an a.out library at the address its a_entry names, or an ELF with one PT_LOAD at its
   *  own address — how libc 4's crt0 brings in /lib/ld.so, and ld.so the DLL-jump libraries. */
  const uselib = (path) => {
    const b = lx.readFile(path);
    if (!b) return -E.ENOENT;
    const h = aoutHeader(b);
    if (h) { loadAout(b, h, h.entry & 0xfffff000); return 0; }
    try { loadImage(b, elfHeader(b), 0); return 0; } catch { return -E.ENOEXEC; }
  };

  /**
   * Map an ELF32 i386 program — static, or dynamic through its PT_INTERP — and point the CPU at the
   * entry, with the initial stack a kernel builds: argc, argv[], NULL, envp[], NULL, the auxiliary
   * vector, then the strings. A dynamic program's interpreter (/lib/ld-linux.so.2) is read from our
   * file system and started instead; it finds the program through AT_PHDR and AT_ENTRY.
   */
  lx.load = (elf, argv = ['a.out'], envp = []) => {
    mem.u8.fill(0, PD_BASE, PD_BASE + PAGE);
    // The GDT is read through paging like any other linear address: identity-mapped, supervisor only.
    setPte(GDT_LIN >>> 12, GDT_BASE, true, false);
    for (let i = 0; i < 3; i++) setPte((TSS_LIN >>> 12) + i, TSS_BASE + i * PAGE, true, false);
    mem.u8.fill(0, TSS_BASE, TSS_BASE + IOMAP); mem.u8.fill(0xff, TSS_BASE + IOMAP, TSS_BASE + TSS_LIMIT + 1);   // every port closed
    dv.setUint16(TSS_BASE + 0x66, IOMAP, true);
    lx.mmapNext = MMAP_BASE;
    const ah = aoutHeader(elf);
    const h = ah ? null : elfHeader(elf);
    const bias = h && h.type === 3 ? PIE_BASE : 0;
    const main = h ? loadImage(elf, h, bias) : { phdr: 0, top: loadAout(elf, ah) };
    lx.brkStart = lx.brk = Math.ceil(main.top / PAGE) * PAGE;
    const entry = ((h ? h.entry : ah.entry) + bias) >>> 0;
    let start = entry, interpBase = 0;
    const pin = h && h.ph.find((ph) => ph.type === 3);                    // PT_INTERP
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
    const auxv = [[3, main.phdr], [4, h ? h.phentsize : 32], [5, h ? h.phnum : 0], [6, PAGE], [7, interpBase], [8, 0], [9, entry],
      [11, 0], [12, 0], [13, 0], [14, 0], [16, 0], [17, 100], [23, 0], [25, random], [15, platform], [31, execfn], [0, 0]];
    let words = [argv.length, ...argAddrs, 0, ...envAddrs, 0, ...auxv.flat()];
    // a.out has no auxiliary vector, and its crt0 takes argv and envp as POINTERS to the arrays above
    // them (create_aout_tables): argc, &argv[0], &envp[0], argv[], NULL, envp[], NULL.
    if (ah) {
      const arrays = [...argAddrs, 0, ...envAddrs, 0];
      sp -= arrays.length * 4; sp &= ~15;
      for (let i = 0; i < arrays.length; i++) dv.setUint32(phys(sp + i * 4), arrays[i] >>> 0, true);
      words = [argv.length, sp, sp + (argAddrs.length + 1) * 4];
    }
    sp -= words.length * 4; sp &= ~15;
    for (let i = 0; i < words.length; i++) dv.setUint32(phys(sp + i * 4), words[i] >>> 0, true);

    // Flat segments, paging, ring 3.
    mem.u8.fill(0, GDT_BASE, GDT_BASE + GDT_ENTRIES * 8);
    setDesc(USER_CS >> 3, 0, 0xfffff, 0xfa, 0xc0);                       // code, DPL 3, 4 GiB, 32-bit
    setDesc(USER_DS >> 3, 0, 0xfffff, 0xf2, 0xc0);                       // data, DPL 3
    cpu.tr.sel = 0x80; cpu.tr.base = TSS_LIN; cpu.tr.limit = TSS_LIMIT;
    cpu.gdtr.base = GDT_LIN; cpu.gdtr.limit = GDT_ENTRIES * 8 - 1;
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
    if (lx.pid !== lx.rootPid && lx.procs.length) {                      // not the first process: another runs
      const pid = lx.pid, ppid = lx.ppid, code = signal ? signal & 0x7f : (status & 0xff) << 8;
      closeAll();
      releasePages(lx.pages);
      const parent = lx.procs.find((q) => q.pid === ppid);
      (parent ? parent.zombies : lx.orphans).set(pid, code);
      switchTo(lx.procs.shift());
      return;
    }
    for (const q of lx.procs) releasePages(q.pages);                     // the first process ends the run, as PID 1 does a container's
    lx.procs.length = 0;
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

  // ---- processes -----------------------------------------------------------------------------------
  // Processes run in turn. The one on the CPU is lx and the machine; the others wait in lx.procs,
  // each saved whole — registers, x87 and SSE state, pages, descriptors, directory, its children's
  // exit codes. A switch happens on a system-call boundary only, where the state is whole: when a
  // call blocks (the process tries it again on its next turn), when a call returns after the
  // quantum is spent, and at nanosleep. fork() puts the parent in the queue and runs the child first,
  // as before. A process that exits leaves its code with its parent; when every process is blocked
  // the machine waits for input, as one blocked process did. DOOM's sndserver reads a pipe that DOOM
  // writes, both running; until this one process ran at a time, a pipeline's left side to its end
  // before its right side started.
  lx.pid = 1; lx.ppid = 0; lx.nextPid = 100; lx.zombies = new Map();
  lx.rootPid = 1; lx.procs = []; lx.orphans = new Map(); lx.sliceStart = 0; lx.blockRun = 0;
  const QUANTUM = () => 0.02 * (machine.cyclesPerSecond || 1e8);         // 20 ms of guest time
  const TLS_A = GDT_BASE + TLS_MIN * 8, TLS_Z = GDT_BASE + (TLS_MIN + TLS_ENTRIES) * 8;
  const snapshot = () => ({
    pid: lx.pid, ppid: lx.ppid, pages: lx.pages, brkStart: lx.brkStart, brk: lx.brk, mmapNext: lx.mmapNext,
    fds: fds.slice(), cwd: lx.cwd, exe: lx.exe, sig: lx.sigHandlers.slice(), zombies: lx.zombies,
    reg: cpu.reg.slice(), eip: cpu.eip, flags: cpu.flags, seg: Array.from(cpu.seg),
    fst: cpu.fst ? cpu.fst.slice() : null, ftop: cpu.ftop, fsw: cpu.fsw, fcw: cpu.fcw, focc: cpu.focc ? cpu.focc.slice() : null,
    xmm: cpu.xmm ? new Uint8Array(cpu.xmm.u8).slice() : null,
    tls: mem.u8.slice(TLS_A, TLS_Z), io: mem.u8.slice(TSS_BASE + IOMAP, TSS_BASE + TSS_LIMIT + 1),
  });
  const restore = (s) => {
    Object.assign(lx, { pid: s.pid, ppid: s.ppid, pages: s.pages, brkStart: s.brkStart, brk: s.brk, mmapNext: s.mmapNext,
      cwd: s.cwd, exe: s.exe, sigHandlers: s.sig, zombies: s.zombies });
    fds.length = 0; s.fds.forEach((f, i) => { fds[i] = f; });
    installPages(s.pages);
    mem.u8.set(s.tls, TLS_A); mem.u8.set(s.io, TSS_BASE + IOMAP);
    cpu.setCR3(cpu.cr3);
    // No machine.rec.reset(): the CR3 load above starts a new epoch, and a translated block is checked
    // against the frames it was built from before it runs again (ROADMAP D8) — another process's code
    // at the same addresses is retranslated, the rest is kept. Dropping everything at each switch made
    // DOOM with its sndserver (switching every few ms) run several times slower.
    cpu.reg.set(s.reg); cpu.eip = s.eip; cpu.flags = s.flags;
    for (let i = 0; i < 6; i++) cpu.setSeg(i, s.seg[i]);
    if (s.fst) { cpu.fst.set(s.fst); cpu.ftop = s.ftop; cpu.fsw = s.fsw; cpu.fcw = s.fcw; cpu.focc.set(s.focc); }
    if (s.xmm) cpu.xmm.u8.set(s.xmm);
    cpu.halted = false; lx.done = false;
  };
  /** Put the running process aside (its pages unmapped, not freed) and run `next`. */
  const switchTo = (next) => {
    restore(next);
    lx.sliceStart = cpu.cycles;
  };
  const yieldTo = () => {
    if (!lx.procs.length) return;
    const me = snapshot();
    releasePages(lx.pages, false);
    lx.procs.push(me);
    switchTo(lx.procs.shift());
  };
  lx.alive = (pid) => pid === lx.pid || lx.procs.some((q) => q.pid === pid);
  const fork = (flags = 0x11, ctid = 0) => {
    if (flags & 0x100) return -E.ENOSYS;                                 // CLONE_VM: threads, not here
    const parent = snapshot(), pid = lx.nextPid++;
    parent.reg[0] = pid;                                                 // what fork returns to it
    const pages = new Map();
    for (const [vpn, pg] of lx.pages) {
      if (pg.phys) { pages.set(vpn, { ...pg }); continue; }
      const f = allocFrame();
      mem.u8.copyWithin(f, pg.frame, pg.frame + PAGE);
      pages.set(vpn, { frame: f, write: pg.write });
    }
    releasePages(lx.pages, false);
    lx.procs.push(parent);
    lx.pages = pages; installPages(pages); cpu.setCR3(cpu.cr3);
    lx.sliceStart = cpu.cycles;
    lx.ppid = lx.pid; lx.pid = pid; lx.zombies = new Map();
    if ((flags & 0x01000000) && ctid) wr32(ctid, pid);                   // CLONE_CHILD_SETTID
    return 0;
  };
  const closeAll = () => { fds.length = 0; };
  const wait = (pid, statusPtr, options) => {
    let key = null;
    for (const k of lx.zombies.keys()) if (pid <= 0 || pid === k) { key = k; break; }
    if (key === null) {
      const kids = lx.procs.some((q) => q.ppid === lx.pid && (pid <= 0 || q.pid === pid));
      if (!kids) return -E.ECHILD;
      return (options & 1) ? 0 : BLOCK;                                   // WNOHANG, or wait for it
    }
    const st = lx.zombies.get(key); lx.zombies.delete(key);
    if (statusPtr) wr32(statusPtr, st);
    return key;
  };
  const execve = (path, argv, envp) => {
    const p = resolve(path), n = p && getNode(p);
    if (!n) return -E.ENOENT;
    if (n.dir) return -E.EACCES;
    let bytes = dataOf(n);
    if (bytes[0] === 0x23 && bytes[1] === 0x21) {                         // #!interpreter [arg]
      let line = ''; for (let i = 2; i < bytes.length && bytes[i] !== 10 && i < 256; i++) line += String.fromCharCode(bytes[i]);
      const [interp, ...rest] = line.trim().split(/\s+/);
      argv = [interp, ...(rest.length ? [rest.join(' ')] : []), path, ...argv.slice(1)];
      const ib = lx.readFile(interp);
      if (!ib) return -E.ENOENT;
      bytes = ib;
    }
    if (!(bytes[0] === 0x7f && bytes[1] === 0x45) && !aoutHeader(bytes)) return -E.ENOEXEC;
    releasePages(lx.pages);
    lx.pages = new Map(); lx.sigHandlers = [];
    const io = mem.u8.slice(TSS_BASE + IOMAP, TSS_BASE + TSS_LIMIT + 1);   // ioperm survives execve
    lx.load(bytes, argv, envp);
    mem.u8.set(io, TSS_BASE + IOMAP);
    lx.exe = p;
    machine.rec.reset();
    return undefined;                                                    // it does not return
  };
  const strings = (ptr) => { const out = []; if (!ptr) return out; for (let a; (a = rd32(ptr)); ptr += 4) out.push(rdStr(a)); return out; };

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
  for (const d of ['null', 'zero', 'full', 'random', 'urandom', 'mem']) fs.set('/dev/' + d, { dev: d, mtime: 0 });
  // The console, as a program on the PC's own screen sees it (SVGAlib opens it to switch the virtual
  // terminal to graphics and the keyboard to raw). Its input is lx.ttyIn, bytes the host feeds in.
  // Device numbers as Linux has them: the virtual consoles are major 4 (tty0 the current one, tty1-63),
  // /dev/tty 5:0, /dev/console 5:1. SVGAlib insists its stdio is a VT, 4:1-63.
  const RDEV = { console: 0x501, tty: 0x500, tty0: 0x400, null: 0x103, zero: 0x105, full: 0x107, random: 0x108, urandom: 0x109, mem: 0x101 };
  for (const d of ['console', 'tty', 'tty0', 'tty1', 'tty2', 'tty3', 'tty4', 'tty5', 'tty6']) fs.set('/dev/' + d, { dev: 'tty', rdev: RDEV[d] || (0x400 | +d.slice(3)), mtime: 0 });
  for (const d of ['null', 'zero', 'full', 'random', 'urandom', 'mem']) fs.get('/dev/' + d).rdev = RDEV[d];
  // A mouse on the first serial port, as SVGAlib assumes one ("Microsoft mouse" on /dev/mouse): it
  // takes the line settings and has nothing to say until lx.mouseIn holds its 3-byte packets.
  fs.set('/dev/mouse', { dev: 'mouse', rdev: 0x440, mtime: 0 }); fs.set('/dev/ttyS0', fs.get('/dev/mouse'));
  lx.mouseIn = [];
  // /dev/input/mice (13:63), Linux's mousedev: every mouse as one PS/2 mouse — three bytes, bit 3 always
  // set, the buttons, the deltas' signs, then dX and dY with Y growing UPWARD. gpm and X servers read it;
  // a command written to it is acknowledged (FAh), and GET ID (F2h) answers 00h, a plain PS/2 mouse.
  fs.set('/dev/input', { dir: true, mtime: 0 });
  fs.set('/dev/input/mice', { dev: 'mice', rdev: 0xd3f, mtime: 0 }); fs.set('/dev/psaux', fs.get('/dev/input/mice'));
  lx.miceIn = [];
  /** A move and the buttons (1 left, 2 right), as a Microsoft serial mouse reports them: three bytes
   *  per packet — 01LRYYXX with the deltas' top bits, then X's and Y's low six bits; Y grows downward.
   *  Deltas beyond -128..127 go as several packets. SVGAlib's default ("Assuming Microsoft mouse"). */
  lx.mouseInput = (dx, dy, buttons) => {
    dx = Math.round(dx); dy = Math.round(dy);
    do {
      const x = Math.max(-128, Math.min(127, dx)), y = Math.max(-128, Math.min(127, dy));
      dx -= x; dy -= y;
      lx.mouseIn.push(0x40 | ((buttons & 1) << 5) | ((buttons & 2) << 3) | ((y >> 4) & 0x0c) | ((x >> 6) & 0x03), x & 0x3f, y & 0x3f);
      const py = -y;                                         // PS/2: Y up
      lx.miceIn.push(0x08 | (buttons & 1) | ((buttons & 2)) | (x < 0 ? 0x10 : 0) | (py < 0 ? 0x20 : 0), x & 0xff, py & 0xff);
    } while (dx || dy);
    if (lx.miceIn.length > 3000) lx.miceIn.splice(0, lx.miceIn.length - 3000);   // nobody reading
    if (lx.mouseIn.length > 3000) lx.mouseIn.splice(0, lx.mouseIn.length - 3000);
    machine.blocked = false;
  };
  // /dev/dsp, the OSS sound device (14:3): what a program writes is played at the rate, format and
  // channels it set, on the program's own clock — a full buffer blocks the writer, as the card's DMA
  // paces it. The samples go to src/audio.js (machine.dsp, beside the Sound Blaster). OSS's defaults:
  // 8 kHz, unsigned 8-bit, mono; 16 fragments of 4 KiB until SNDCTL_DSP_SETFRAGMENT says otherwise.
  // DOOM's sndserver mixes there; it stopped at "Could not open /dev/dsp".
  fs.set('/dev/dsp', { dev: 'dsp', rdev: 0xe03, mtime: 0 }); fs.set('/dev/audio', fs.get('/dev/dsp'));
  const dsp = lx.dsp = { rate: 8000, fmt: 8, ch: 1, fragShift: 12, frags: 16, queued: 0, t: 0, played: 0, pcm: [] };
  const dspBps = () => dsp.rate * dsp.ch * (dsp.fmt === 0x10 ? 2 : 1);
  const dspBuf = () => (1 << dsp.fragShift) * dsp.frags;
  const dspDrain = () => {                                   // what the card has played since the last look
    const now = lx.mono();
    if (dsp.map) {                                           // mmap'd: the card runs round its buffer
      if (!dsp.trig) { dsp.t = now; return; }
      const n = Math.floor((now - dsp.t) * dspBps()), step = (dsp.fmt === 0x10 ? 2 : 1) * dsp.ch, n2 = n - (n % step);
      if (n2 <= 0) return;
      const size = dsp.map.size, take = Math.min(n2, size);   // more than a lap behind: the last lap only
      const from = (dsp.played + n2 - take) % size, bytes = new Uint8Array(take);
      for (let i = 0; i < take; i++) bytes[i] = rd8(dsp.map.va + (from + i) % size);
      toPcm(bytes, take);
      dsp.played += n2; dsp.t += n2 / dspBps();
      return;
    }
    const n = Math.min(dsp.queued, Math.floor((now - dsp.t) * dspBps()));
    if (n > 0) { dsp.queued -= n; dsp.played += n; dsp.t += n / dspBps(); }
    if (!dsp.queued) dsp.t = now;
  };
  const toPcm = (bytes, take) => {                           // to signed 16-bit stereo for the mixer
    const wide = dsp.fmt === 0x10, step = (wide ? 2 : 1) * dsp.ch;
    for (let i = 0; i + step <= take; i += step) {
      const at = (k) => wide ? ((bytes[i + k * 2] | (bytes[i + k * 2 + 1] << 8)) << 16 >> 16) : (bytes[i + k] - 128) << 8;
      const l = at(0), r = dsp.ch > 1 ? at(1) : l;
      dsp.pcm.push(l, r);
    }
    if (dsp.pcm.length > dsp.rate * 4) dsp.pcm.splice(0, dsp.pcm.length - dsp.rate * 4);   // nobody is listening
  };
  const dspWrite = (f, bytes) => {
    dspDrain();
    const take = Math.min(bytes.length, dspBuf() - dsp.queued);
    if (take < Math.min(bytes.length, dspBuf())) return (f.flags & 0x800) ? -E.EAGAIN : BLOCK;   // wait for room
    toPcm(bytes, take);
    dsp.queued += take;
    return take;
  };
  machine.dsp = { drain: () => { const samples = dsp.pcm; dsp.pcm = []; return { rate: dsp.rate, samples }; } };
  /** Put stdin, stdout and stderr on the first virtual console, as for a program started there. */
  lx.consoleStdio = () => { const n = fs.get('/dev/tty1'); for (let i = 0; i < 3; i++) fds[i] = { node: n, path: '/dev/tty1', pos: 0, flags: 2 }; };
  lx.ttyIn = [];
  lx.tty = { kdMode: 0, kbMode: 1, termios: null };
  /** The PC keyboard's set-1 scancodes (make, or make|80h for a release; E0 before an extended key),
   *  delivered to the console as the kernel would in its current mode (KDSKBMODE): K_RAW passes the
   *  scancodes, K_MEDIUMRAW gives keycodes — the scancode for an ordinary key, the kernel's own number
   *  for an E0 key (Up 103, Left 105...), bit 7 for a release — and K_XLATE the characters. */
  const E0KEY = { 0x1c: 96, 0x1d: 97, 0x35: 98, 0x38: 100, 0x47: 102, 0x48: 103, 0x49: 104, 0x4b: 105,
    0x4d: 106, 0x4f: 107, 0x50: 108, 0x51: 109, 0x52: 110, 0x53: 111 };
  // US layout, set 1, unshifted and shifted (drivers/tty/vt/defkeymap.c_shipped, plain and shift maps).
  const KMAP = '\x00\x1b1234567890-=\x7f\tqwertyuiop[]\r\x00asdfghjkl;\'`\x00\\zxcvbnm,./\x00*\x00 ';
  const KSHIFT = '\x00\x1b!@#$%^&*()_+\x7f\tQWERTYUIOP{}\r\x00ASDFGHJKL:"~\x00|ZXCVBNM<>?\x00*\x00 ';
  // The sequences the console sends for the cursor and editing keys in K_XLATE.
  const E0SEQ = { 0x48: '\x1b[A', 0x50: '\x1b[B', 0x4d: '\x1b[C', 0x4b: '\x1b[D', 0x47: '\x1b[1~', 0x4f: '\x1b[4~',
    0x52: '\x1b[2~', 0x53: '\x1b[3~', 0x49: '\x1b[5~', 0x51: '\x1b[6~', 0x1c: '\r', 0x35: '/' };
  let e0 = false, shift = 0, ctrl = 0, caps = false;
  lx.keyScancodes = (codes) => {
    for (const c of codes) {
      if (c === 0xe0) { e0 = true; if (lx.tty.kbMode === 0) lx.ttyIn.push(c); continue; }
      const mode = lx.tty.kbMode, rel = c & 0x80, sc = c & 0x7f;
      if (sc === 0x2a || sc === 0x36) shift = rel ? 0 : 1;
      else if (sc === 0x1d) ctrl = rel ? 0 : 1;
      else if (sc === 0x3a && !rel) caps = !caps;
      if (mode === 0) lx.ttyIn.push(c);
      else if (mode === 2) { const k = e0 ? E0KEY[sc] : sc; if (k !== undefined) lx.ttyIn.push(k | rel); }
      else if (!rel) {
        let str = '';
        if (e0) str = E0SEQ[sc] || '';
        else if (sc < KMAP.length) {
          let ch = (shift ? KSHIFT : KMAP)[sc];
          if (caps && /[a-z]/i.test(ch)) ch = shift ? ch.toLowerCase() : ch.toUpperCase();
          if (ctrl && /[a-z@\[\\\]^_]/i.test(ch)) ch = String.fromCharCode(ch.toUpperCase().charCodeAt(0) & 0x1f);
          if (ch !== '\x00') str = ch;
        }
        if (str) ttyInput([...str].map((x) => x.charCodeAt(0)));
      }
      e0 = false;
    }
    if (lx.ttyIn.length) machine.blocked = false;
  };
  // The line discipline, as n_tty does it with the termios flags in force: ICRNL on input, ICANON's
  // line editing (erase, kill, ^D) with ECHO, or the bytes as they come; OPOST/ONLCR on output.
  const termios = () => {
    const t = lx.tty.termios;
    if (!t) return { iflag: 0x500, oflag: 0x5, lflag: 0x8a3b };
    const d = new DataView(t.buffer, t.byteOffset, t.byteLength);
    return { iflag: d.getUint32(0, true), oflag: d.getUint32(4, true), lflag: d.getUint32(12, true) };
  };
  lx.tty.line = [];
  const ttyInput = (bytes) => {
    const { iflag, lflag } = termios(), echo = (lflag & 8) !== 0;
    for (let b of bytes) {
      if (b === 13 && (iflag & 0x100)) b = 10;                           // ICRNL
      if (!(lflag & 2)) { lx.ttyIn.push(b); if (echo) ttyOutput([b]); continue; }   // raw
      const line = lx.tty.line;
      if (b === 0x7f || b === 8) { if (line.length) { line.pop(); if (echo) ttyOutput([8, 32, 8]); } continue; }
      if (b === 0x15) { while (line.length) { line.pop(); if (echo) ttyOutput([8, 32, 8]); } continue; }   // ^U
      if (b === 3 && (lflag & 1)) { line.length = 0; if (echo) ttyOutput([0x5e, 0x43, 10]); continue; }   // ^C (no signal yet)
      if (b === 4) { lx.ttyIn.push(...line); line.length = 0; lx.tty.eof = !lx.ttyIn.length; continue; }   // ^D
      line.push(b);
      if (echo) ttyOutput(b < 32 && b !== 10 && b !== 9 ? [0x5e, b + 64] : [b]);
      if (b === 10) { lx.ttyIn.push(...line); line.length = 0; }
    }
  };
  /** What a program writes to the console: through OPOST/ONLCR, then to the screen (lx.console,
   *  set by a page that shows the VGA text console) and to onOutput. */
  const ttyOutput = (bytes) => {
    const { oflag } = termios();
    const o = [];
    for (const b of bytes) { if (b === 10 && (oflag & 1) && (oflag & 4)) o.push(13); o.push(b); }
    if (lx.console && lx.tty.kdMode === 0) lx.console.write(o);
    out(1, Uint8Array.from(o));
  };
  lx.ttyInput = ttyInput;
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
    if (f.pp) { if (f.rd) return -E.EBADF; for (const b of bytes) f.pp.buf.push(b); return bytes.length; }
    if (f.pipe !== undefined) { if (f.pipe === 0) return -E.EBADF; out(f.pipe, bytes); return bytes.length; }
    if (f.node.dev === 'tty') { ttyOutput(bytes); return bytes.length; }
    if (f.node.dev === 'mouse') return bytes.length;
    if (f.node.dev === 'mice') { for (const c of bytes) { lx.miceIn.push(0xfa); if (c === 0xf2) lx.miceIn.push(0x00); } return bytes.length; }
    if (f.node.dev === 'dsp') return dspWrite(f, bytes);
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
    // A pipe: what its writer left. Its writer has run to its end already (one process at a time), so an
    // empty pipe is the end of it.
    if (f.pp) {
      if (!f.rd) return -E.EBADF;
      if (!f.pp.buf.length && n > 0 && writerOpen(f.pp)) return (f.flags & 0x800) ? -E.EAGAIN : BLOCK;   // a writer may still write
      const take = f.pp.buf.splice(0, n); wrBytes(buf, Uint8Array.from(take)); return take.length;
    }
    if (f.pipe !== undefined) {
      if (f.pipe !== 0) return -E.EBADF;
      src = lx.stdin.subarray(lx.stdinPos, lx.stdinPos + n); lx.stdinPos += src.length;
    } else if (f.node.dev === 'mouse') {
      if (!lx.mouseIn.length) return (f.flags & 0x800) ? -E.EAGAIN : 0;
      src = Uint8Array.from(lx.mouseIn.splice(0, n));
    } else if (f.node.dev === 'mice') {
      if (!lx.miceIn.length) return (f.flags & 0x800) ? -E.EAGAIN : BLOCK;   // a device that waits for a move
      src = Uint8Array.from(lx.miceIn.splice(0, n - (n % 3) || n));
    } else if (f.node.dev === 'tty') {
      if (!lx.ttyIn.length) {
        if (lx.tty.eof) { lx.tty.eof = false; return 0; }                // ^D on an empty line
        if (f.flags & 0x800) return -E.EAGAIN;                           // O_NONBLOCK
        // Non-canonical with VMIN 0 (c_cc[6], byte 23 of termios) returns at once: SVGAlib's keyboard
        // polls the console that way, every frame of DOOM.
        const t = lx.tty.termios;
        if (t && !(termios().lflag & 2) && t[23] === 0) return 0;
        return BLOCK;                                                    // wait for a key
      }
      // Canonical mode hands out at most one line per read.
      const { lflag } = termios();
      let take = n;
      if (lflag & 2) { const nl = lx.ttyIn.indexOf(10); if (nl >= 0) take = Math.min(n, nl + 1); }
      src = Uint8Array.from(lx.ttyIn.splice(0, take));
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
  const putStat = (buf, node, p) => { const b = new Uint8Array(96); putStatInto(b, node, p); wrBytes(buf, b); return 0; };
  const putStatInto = (b, node, p) => {
    const d = new DataView(b.buffer);
    const isPipe = node.pipe !== undefined || !!node.pp;
    d.setUint32(0, isPipe ? 0xc : 0x801, true);                             // st_dev
    d.setUint32(12, inoOf(p), true);
    const type = isPipe ? 0o010000 : node.dev ? 0o020000 : node.dir ? 0o040000 : node.link !== undefined ? 0o120000 : 0o100000;
    const perm = node.link !== undefined ? 0o777 : node.dev === 'tty' ? 0o620 : node.mode !== undefined ? node.mode & 0o7777 : isPipe ? 0o600 : node.dev ? 0o666 : node.dir ? 0o755 : node.link !== undefined ? 0o777 : 0o644;
    d.setUint32(16, type | perm, true);
    d.setUint32(20, node.nlink || (node.dir ? 2 : 1), true);
    d.setUint32(32, node.rdev || 0, true);                                  // st_rdev
    const size = isPipe || node.dir ? (node.dir ? 4096 : 0) : node.link !== undefined ? node.link.length : node.size;
    d.setUint32(44, size, true);
    d.setUint32(52, 4096, true);
    d.setUint32(56, Math.ceil(size / 512), true);
    const t = Math.floor(node.mtime || lx.epoch);
    d.setUint32(64, t, true); d.setUint32(72, t, true); d.setUint32(80, t, true);
    d.setUint32(88, inoOf(p), true);
  };
  // struct stat (i386, 64 bytes): the 32-bit form libc 4 and 5 ask for with stat/lstat/fstat 106-108.
  const putOldStat = (buf, node, p) => {
    const t = new Uint8Array(96); putStatInto(t, node, p);
    const s64 = new DataView(t.buffer), b = new Uint8Array(64), d = new DataView(b.buffer);
    d.setUint32(0, s64.getUint32(0, true), true);  d.setUint32(4, s64.getUint32(12, true), true);
    d.setUint16(8, s64.getUint32(16, true), true); d.setUint16(10, s64.getUint32(20, true), true);
    d.setUint32(16, s64.getUint32(32, true), true);
    d.setUint32(20, s64.getUint32(44, true), true); d.setUint32(24, 4096, true); d.setUint32(28, s64.getUint32(56, true), true);
    d.setUint32(32, s64.getUint32(64, true), true); d.setUint32(40, s64.getUint32(72, true), true); d.setUint32(48, s64.getUint32(80, true), true);
    wrBytes(buf, b); return 0;
  };
  const oldStat = (p, buf) => { const n = p && getNode(p); return n ? putOldStat(buf, n, p) : -E.ENOENT; };
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
      // The host's entries too, for any directory the host has — '/' and /dev included, which we
      // create ourselves: ls / showed only what had been looked up so far.
      const onHost = lx.host && (f.node.host || (lx.host.lstat(f.path) || {}).type === 'dir');
      if (onHost) for (const n of lx.host.list(f.path)) if (!gone.has(pre + n)) set.add(n);
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
  // ioctl on the console: what a kernel answers on virtual terminal 1 (linux/vt.h, linux/kd.h,
  // asm/termbits.h). Pipes and files are not terminals.
  const ioctl = (f, req, arg) => {
    if (f.node && f.node.dev === 'dsp') return dspIoctl(req >>> 0, arg);
    if (!f.node || (f.node.dev !== 'tty' && f.node.dev !== 'mouse')) return -E.ENOTTY;
    // The console's settings are the console's; a serial line (the mouse) has its own. Sharing them,
    // the mouse's 1200-baud setup (VMIN 1) became the console's, and DOOM's keyboard poll then waited.
    const t = f.node.dev === 'mouse' ? f.node : lx.tty;
    switch (req) {
      case 0x5401: {                                                        // TCGETS: struct termios, 36 bytes
        const b = t.termios || Uint8Array.from([0x00, 0x05, 0, 0, 0x05, 0x00, 0, 0, 0xbf, 0x04, 0, 0, 0x3b, 0x8a, 0, 0, 0,
          3, 0x1c, 0x7f, 0x15, 4, 0, 1, 0, 0x11, 0x13, 0x1a, 0, 0x12, 0x0f, 0x17, 0x16, 0, 0, 0]);
        wrBytes(arg, b); return 0;
      }
      case 0x5402: case 0x5403: case 0x5404: t.termios = rdBytes(arg, 36); return 0;   // TCSETS(W/F)
      case 0x5413: wr32(arg, (25 << 0) | (80 << 16)); wr32(arg + 4, 0); return 0;     // TIOCGWINSZ: 25 rows, 80 columns
      case 0x540f: wr32(arg, 1); return 0;                                  // TIOCGPGRP
      case 0x4b3b: wr32(arg, t.kdMode); return 0;                          // KDGETMODE
      case 0x4b3a: t.kdMode = arg; return 0;                               // KDSETMODE: KD_TEXT 0 / KD_GRAPHICS 1
      case 0x4b44: wr32(arg, t.kbMode); return 0;                          // KDGKBMODE
      case 0x4b45: t.kbMode = arg; return 0;                               // KDSKBMODE: K_RAW 0, K_XLATE 1, K_MEDIUMRAW 2
      case 0x4b33: wr8(arg, 4); return 0;                                  // KDGKBTYPE: KB_101
      case 0x5600: wr32(arg, 1); return 0;                                 // VT_OPENQRY
      case 0x5601: for (let i = 0; i < 8; i++) wr8(arg + i, 0); return 0;  // VT_GETMODE: VT_AUTO
      case 0x5603: wr8(arg, 1); wr8(arg + 1, 0); wr8(arg + 2, 0); wr8(arg + 3, 0); wr8(arg + 4, 2); wr8(arg + 5, 0); return 0;   // VT_GETSTATE: v_active 1
      default: return 0;                                                   // VT_SETMODE, VT_ACTIVATE, VT_WAITACTIVE, KDSETLED...
    }
  };
  // The OSS ioctls (linux/soundcard.h): 'P' requests, each in or out through an int (or a struct).
  const dspIoctl = (req, arg) => {
    const io = (v) => { wr32(arg, v); return 0; };
    switch (req) {
      case 0x5000: case 0x5001: case 0x5008: dspDrain(); if (req === 0x5000) { dsp.queued = 0; dsp.t = lx.mono(); } return 0;   // RESET, SYNC, POST
      case 0xc0045002: { const r = rd32(arg); if (r >= 4000 && r <= 48000) { dspDrain(); dsp.rate = r; } return io(dsp.rate); }   // SPEED
      case 0xc0045003: dsp.ch = rd32(arg) ? 2 : 1; return io(dsp.ch - 1);                     // STEREO
      case 0xc0045006: { const c = rd32(arg); dsp.ch = c >= 2 ? 2 : 1; return io(dsp.ch); }   // CHANNELS
      case 0xc0045005: { const v = rd32(arg); if (v === 8 || v === 0x10) dsp.fmt = v; return io(dsp.fmt); }   // SETFMT (AFMT_QUERY 0: the current one)
      case 0x8004500b: return io(0x18);                                                       // GETFMTS: U8 and S16_LE
      case 0xc0045004: return io(1 << dsp.fragShift);                                         // GETBLKSIZE
      case 0xc004500a: { const v = rd32(arg), sh = Math.max(4, Math.min(16, v & 0xffff)), n = Math.max(2, Math.min(256, v >>> 16)); dsp.fragShift = sh; dsp.frags = n; return 0; }   // SETFRAGMENT
      case 0xc0045009: return io(1);                                                          // SUBDIVIDE
      case 0x8010500c: { dspDrain(); const size = 1 << dsp.fragShift, free = dspBuf() - dsp.queued;   // GETOSPACE: audio_buf_info
        wr32(arg, Math.floor(free / size)); wr32(arg + 4, dsp.frags); wr32(arg + 8, size); wr32(arg + 12, free); return 0; }
      // GETCAPS: version 1, TRIGGER and MMAP. Quake's snd_linux.c mmaps the buffer and mixes into it,
      // asking GETOPTR where the card is ("sound driver too old" without MMAP — PRISM's dsp.js); the
      // buffer is a power of two, since Quake masks its positions with samples - 1.
      case 0x8004500f: return io(0x100 | 0x1000 | 0x2000);
      case 0x500e: return 0;                                                                   // NONBLOCK
      case 0x80045010: return io(2);                                                           // GETTRIGGER: output on
      case 0x40045010: { dspDrain(); dsp.trig = (rd32(arg) & 2) !== 0; dsp.t = lx.mono(); return 0; }   // SETTRIGGER: output on or off
      case 0x800c5012: { dspDrain(); wr32(arg, dsp.played); wr32(arg + 4, 0); wr32(arg + 8, dsp.played % dspBuf()); return 0; }   // GETOPTR
      default: return -E.EINVAL;
    }
  };
  const select = (n, inp, outp, exp, tv) => {
    let ready = 0, waitsOnTty = false;
    if (!tv && inp) for (let fd = 0; fd < n; fd++) if ((rd32(inp + (fd >>> 5) * 4) >>> (fd & 31)) & 1 && fds[fd] && fds[fd].node && (fds[fd].node.dev === 'tty' || fds[fd].node.dev === 'mice')) waitsOnTty = true;   // an input device: wait for it
    const has = (fd) => { const f = fds[fd]; if (!f) return false; if (f.pp) return !f.rd || f.pp.buf.length > 0 || !writerOpen(f.pp); if (f.pipe === 0) return lx.stdinPos < lx.stdin.length;
      if (f.node && f.node.dev === 'tty') return lx.ttyIn.length > 0; if (f.node && f.node.dev === 'mouse') return lx.mouseIn.length > 0;
      if (f.node && f.node.dev === 'mice') return lx.miceIn.length > 0; return true; };
    const writes = [];
    for (const [set, test] of [[inp, has], [outp, (fd) => !!fds[fd]], [exp, () => false]]) {
      if (!set) continue;
      for (let w = 0; w < Math.ceil(n / 32); w++) {
        let bits = rd32(set + w * 4), keep = 0;
        for (let b = 0; b < 32; b++) if ((bits >>> b) & 1 && test(w * 32 + b)) { keep |= 1 << b; ready++; }
        writes.push([set + w * 4, keep >>> 0]);
      }
    }
    // No timeout and nothing ready on a terminal: wait for a key — leaving the sets as they were, since
    // the call runs again from the start.
    if (!ready && waitsOnTty && !lx.ttyIn.length && !lx.miceIn.length) return BLOCK;
    if (!ready && !tv && lx.procs.length) return BLOCK;                  // no timeout: wait while another process runs
    for (const [a, v] of writes) wr32(a, v);
    return ready;
  };
  /** Is a pipe's write end open in any process? Then an empty pipe is not its end yet. */
  const writerOpen = (pp) => [fds, ...lx.procs.map((q) => q.fds)].some((t) => t.some((f) => f && f.pp === pp && !f.rd));
  const pipe = (ptr) => {
    const pp = { buf: [] };
    const r = newFd({ pp, rd: true }), w = newFd({ pp, rd: false });
    wr32(ptr, r); wr32(ptr + 4, w); return 0;
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
    if (f.pipe !== undefined || f.pp) return -E.ESPIPE;
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
        if (got === BLOCK) return total || BLOCK;
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
    41: (fd) => newFd(fdOf(fd)),                                           // dup: the same open file, offset shared
    63: (fd, to) => { const f = fdOf(fd); fds[to] = f; return to; },       // dup2
    330: (fd, to) => { const f = fdOf(fd); if (fd === to) return -E.EINVAL; fds[to] = f; return to; },   // dup3
    221: (fd, cmd, arg) => {                                               // fcntl64
      const f = fdOf(fd);
      if (cmd === 0 || cmd === 1030) return newFd(f, arg);                  // F_DUPFD, F_DUPFD_CLOEXEC
      if (cmd === 1 || cmd === 2) return 0;                                 // F_GETFD / F_SETFD
      if (cmd === 3) return f.flags !== undefined ? f.flags : (f.pipe === 0 ? 0 : 1);   // F_GETFL
      if (cmd === 4) { f.flags = ((f.flags || 0) & ~0x2c00) | (arg & 0x2c00); return 0; }   // F_SETFL: O_APPEND, O_NONBLOCK, O_ASYNC
      return 0;
    },
    194: (fd, lo, hi) => { const f = fdOf(fd); if (!f.node || f.node.dir) return -E.EINVAL; const n = lo + hi * 4294967296; grow(f.node, n); f.node.data.fill(0, Math.min(n, f.node.size), n); f.node.size = n; return 0; },   // ftruncate64
    118: () => 0, 148: () => 0,                                            // fsync, fdatasync
    54: (fd, req, arg) => ioctl(fdOf(fd), req, arg),                       // ioctl
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
      if (!(flags & 0x20) && fds[fd] && fds[fd].node && fds[fd].node.dev === 'dsp') {   // the card's buffer
        unmapRange(at, at + size); mapRange(at, at + size, true);
        dsp.map = { va: at, size: Math.min(size, dspBuf()) }; dsp.trig = false; dsp.played = 0; dsp.t = lx.mono();
        return at;
      }
      if (!(flags & 0x20) && fds[fd] && fds[fd].node && fds[fd].node.dev === 'mem') {
        unmapRange(at, at + size); mapPhys(at, pgoff * PAGE, size, (prot & 2) !== 0); return at;
      }
      if (!(flags & 0x20)) {                                                // a file: copied, not shared
        const f = fdOf(fd); if (!f.node || f.node.dir) return -E.EACCES;
        src = f.node.data.subarray(Math.min(pgoff * PAGE, f.node.size), Math.min(pgoff * PAGE + len, f.node.size));
      }
      unmapRange(at, at + size); mapRange(at, at + size, true);
      if (src) wrBytes(at, src);
      return at;
    },
    90: (args) => {                                                        // old_mmap: its six arguments in a struct (libc 4, ld.so)
      const off = rd32(args + 20);
      if (off & 0xfff) return -E.EINVAL;
      return SYS[192](rd32(args), rd32(args + 4), rd32(args + 8), rd32(args + 12), rd32(args + 16), off >>> 12);
    },
    86: (path) => uselib(rdStr(path)),                                     // uselib
    91: (addr, len) => { unmapRange(addr, addr + len); return 0; },        // munmap
    163: (old, oldLen, newLen, flags) => {                                 // mremap: move to fresh pages
      if (!(flags & 1)) return newLen <= oldLen ? old : -E.ENOMEM;          // MREMAP_MAYMOVE
      const at = lx.mmapNext, size = Math.ceil(newLen / PAGE) * PAGE; lx.mmapNext += size;
      mapRange(at, at + size, true);
      wrBytes(at, rdBytes(old, Math.min(oldLen, newLen)));
      unmapRange(old, old + oldLen); return at;
    },
    // mprotect: the pages' rights as Linux sets them — writable with PROT_WRITE, absent with PROT_NONE
    // (the kernel's own reads go through lx.pages, not the PTEs). Quake's Sys_MakeCodeWriteable asks
    // for its text to be writable and patches its own assembly; answered 0 and left read-only, its
    // first patch faulted (err 7) in the code.
    125: (addr, len, prot) => {
      if (addr & 0xfff) return -E.EINVAL;
      const first = addr >>> 12, end = Math.ceil((addr + len) / PAGE);
      for (let p = first; p < end; p++) if (!lx.pages.has(p)) return -E.ENOMEM;
      for (let p = first; p < end; p++) {
        const pg = lx.pages.get(p);
        pg.write = !!(prot & 2); pg.none = !(prot & 7);
        if (pg.none) clearPte(p); else setPte(p, pg.frame, pg.write);
      }
      cpu.setCR3(cpu.cr3);                                 // the software TLB forgets the old rights
      return 0;
    },
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
    258: () => lx.pid,                                                     // set_tid_address -> tid
    311: () => 0,                                                          // set_robust_list
    20: () => lx.pid, 64: () => lx.ppid, 224: () => lx.pid,                // getpid, getppid, gettid
    174: (sig, act) => {                                                   // rt_sigaction: remembered, not yet delivered
      if (act) lx.sigHandlers[sig] = rd32(act);
      return 0;
    },
    175: () => 0, 186: () => 0,                                            // rt_sigprocmask, sigaltstack
    37: (pid, sig) => {                                                    // kill: ourselves, or another process ends
      if ((pid | 0) <= 0 || pid === lx.pid) return raise(sig);
      const i = lx.procs.findIndex((q) => q.pid === pid);
      if (i < 0) return -3;                                                // ESRCH
      if (sig === 0) return 0;
      const [q] = lx.procs.splice(i, 1);
      releasePages(q.pages);
      const parent = q.ppid === lx.pid ? lx : lx.procs.find((x) => x.pid === q.ppid);
      ((parent && parent.zombies) || lx.orphans).set(pid, sig & 0x7f);
      return 0;
    },
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
    162: () => { yieldTo(); return 0; },                                   // nanosleep: no time to wait for; the others run
    43: (buf) => {                                                         // times: all of it user time, in 100 Hz ticks
      const ticks = Math.floor(lx.mono() * 100);
      if (buf) { wr32(buf, ticks); wr32(buf + 4, 0); wr32(buf + 8, 0); wr32(buf + 12, 0); }
      return ticks;
    },
    // Extended attributes (getxattr, lgetxattr, fgetxattr, listxattr...): none here, as on a file
    // system without ACLs — ENODATA to a get, an empty list. ls -l asks for each file it lists.
    229: () => -E.ENODATA, 230: () => -E.ENODATA, 231: () => -E.ENODATA,
    232: () => 0, 233: () => 0, 234: () => 0,
    // ---- libc 4 / a.out era ----
    24: () => 0, 49: () => 0, 47: () => 0, 50: () => 0,                    // get[e]uid, get[e]gid (16-bit): root, as SVGAlib requires
    23: () => 0, 46: () => 0, 213: () => 0, 214: () => 0,                  // setuid, setgid (16- and 32-bit): root may
    67: (sig, act, old) => { if (old) { wr32(old, 0); wr32(old + 4, 0); wr32(old + 8, 0); } return 0; },   // sigaction (old)
    101: (from, num, on) => {                                              // ioperm: the ports are the emulated card's
      if (from + num > 0x10000) return -E.EINVAL;
      for (let port = from; port < from + num; port++) {
        const a = TSS_BASE + IOMAP + (port >>> 3);
        mem.u8[a] = on ? mem.u8[a] & ~(1 << (port & 7)) : mem.u8[a] | (1 << (port & 7));
      }
      return 0;
    },
    110: (level) => { cpu.flags = (cpu.flags & ~0x3000) | ((level & 3) << 12); return 0; },   // iopl
    106: (path, buf) => oldStat(resolve(rdStr(path)), buf),                // stat (struct stat, not stat64)
    107: (path, buf) => oldStat(resolve(rdStr(path), lx.cwd, false), buf),  // lstat
    108: (fd, buf) => { const f = fdOf(fd); return f.path ? oldStat(f.path, buf) : putOldStat(buf, f, 'pipe:' + fd); },   // fstat
    42: (ptr) => pipe(ptr),                                                // pipe
    331: (ptr) => pipe(ptr),                                               // pipe2
    2: () => fork(),                                                       // fork
    190: () => fork(),                                                     // vfork: a fork here
    120: (flags, sp, ptid, tls, ctid) => fork(flags, ctid),                // clone, without CLONE_VM
    11: (path, argv, envp) => execve(rdStr(path), strings(argv), strings(envp)),   // execve
    114: (pid, st, opt) => wait(pid | 0, st, opt),                         // wait4
    7: (pid, st, opt) => wait(pid | 0, st, opt),                           // waitpid
    57: () => 0, 65: () => lx.pid, 132: () => lx.pid, 66: () => lx.pid, 147: () => lx.pid,   // setpgid, getpgrp, getpgid, setsid, getsid
    // select: a descriptor with input waiting is ready to read, every one is ready to write; with
    // nothing ready it returns at once (there is no other process to wait for).
    142: (n, inp, outp, exp, tv) => select(n, inp, outp, exp, tv),         // _newselect
    308: (n, inp, outp, exp, ts) => select(n, inp, outp, exp, ts),         // pselect6 (readline waits for keys with it)
    439: (dirfd, path) => { const r = resolve(rdStr(path), atBase(dirfd)); return r && getNode(r) ? 0 : -E.ENOENT; },   // faccessat2
    94: () => 0, 15: () => 0, 306: () => 0,                                // fchmod, chmod, fchmodat: modes are not kept
    82: (args) => select(rd32(args), rd32(args + 4), rd32(args + 8), rd32(args + 12), rd32(args + 16)),   // select (old: its arguments in a struct)
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
    if (ret === BLOCK) {                                                 // int 80h again: on its next turn, or when input comes
      cpu.eip = (cpu.eip - 2) >>> 0;
      if (lx.procs.length && ++lx.blockRun <= lx.procs.length) { yieldTo(); return; }
      lx.blockRun = 0; machine.blocked = true; return;                   // every process waits
    }
    lx.blockRun = 0;
    if (!lx.done && ret !== undefined) r[0] = ret | 0;
    if (lx.procs.length && !lx.done && cpu.cycles - lx.sliceStart > QUANTUM()) yieldTo();
  };

  return lx;
}
