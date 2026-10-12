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
const STACK_TOP = 0xc0000000, STACK_SIZE = 0x40000;       // 256 KiB, mapped up front
const MMAP_BASE = 0x40000000;

const SIG = { SIGILL: 4, SIGFPE: 8, SIGSEGV: 11 };
const E = { EPERM: 1, ENOENT: 2, EBADF: 9, ENOMEM: 12, EFAULT: 14, EINVAL: 22, ENOTTY: 25, ENOSYS: 38 };

export function installLinux(machine, { onOutput } = {}) {
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
  /**
   * Map a static ELF32 i386 executable and point the CPU at its entry, with the initial stack a
   * kernel builds: argc, argv[], NULL, envp[], NULL, the auxiliary vector, then the strings.
   */
  lx.load = (elf, argv = ['a.out'], envp = []) => {
    const d = new DataView(elf.buffer, elf.byteOffset, elf.byteLength);
    if (d.getUint32(0, false) !== 0x7f454c46) throw new Error('mirage-linux: not an ELF file');
    if (elf[4] !== 1 || elf[5] !== 1) throw new Error('mirage-linux: not ELF32 little-endian');
    if (d.getUint16(16, true) !== 2) throw new Error('mirage-linux: only static ET_EXEC programs for now');
    if (d.getUint16(18, true) !== 3) throw new Error('mirage-linux: not an i386 program');
    const entry = d.getUint32(24, true), phoff = d.getUint32(28, true);
    const phentsize = d.getUint16(42, true), phnum = d.getUint16(44, true);

    mem.u8.fill(0, PD_BASE, PD_BASE + PAGE);
    // The GDT is read through paging like any other linear address: identity-mapped, supervisor only.
    setPte(GDT_BASE >>> 12, GDT_BASE, true, false);
    let top = 0, phdrVa = 0;
    for (let i = 0; i < phnum; i++) {
      const o = phoff + i * phentsize, type = d.getUint32(o, true);
      const off = d.getUint32(o + 4, true), va = d.getUint32(o + 8, true);
      const filesz = d.getUint32(o + 16, true), memsz = d.getUint32(o + 20, true), flags = d.getUint32(o + 24, true);
      if (type === 6) phdrVa = va;                                        // PT_PHDR
      if (type === 3) throw new Error('mirage-linux: dynamically linked (PT_INTERP); build with -static');
      if (type !== 1) continue;                                           // PT_LOAD
      mapRange(va, va + memsz, (flags & 2) !== 0);
      for (let k = 0; k < filesz; k++) { const a = phys(va + k); mem.u8[a] = elf[off + k]; }
      if (off <= phoff && phoff < off + filesz && !phdrVa) phdrVa = va + (phoff - off);
      top = Math.max(top, va + memsz);
    }
    lx.brkStart = lx.brk = Math.ceil(top / PAGE) * PAGE;

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
    const auxv = [[3, phdrVa], [4, phentsize], [5, phnum], [6, PAGE], [7, 0], [8, 0], [9, entry],
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
    cpu.eip = entry >>> 0;
    cpu.flags = 0x0002;                     // IF clear: no device interrupts reach a program here
    lx.done = false; lx.status = 0; lx.signal = 0;
  };

  // ---- ending ------------------------------------------------------------------------------------
  const exit = (status, signal = 0) => {
    lx.done = true; lx.status = signal ? 128 + signal : status & 0xff; lx.signal = signal;
    cpu.halted = true;
    machine.rec.stop && machine.rec.stop();
  };
  lx.fault = (n, err) => {
    const sig = n === 0 ? SIG.SIGFPE : n === 6 ? SIG.SIGILL : n === 16 || n === 19 ? SIG.SIGFPE : SIG.SIGSEGV;
    lx.faultInfo = { n, err, eip: cpu.eip >>> 0, cr2: cpu.cr2 >>> 0 };
    exit(0, sig);
  };

  const out = (fd, bytes) => {
    (fd === 2 ? lx.stderr : lx.stdout).push(...bytes);
    if (lx.onOutput) lx.onOutput(fd, bytes);
  };

  // ---- system calls --------------------------------------------------------------------------------
  // i386 numbers (arch/x86/entry/syscalls/syscall_32.tbl). Arguments in EBX ECX EDX ESI EDI EBP.
  const SYS = {
    1: (status) => { exit(status); },                                      // exit
    252: (status) => { exit(status); },                                    // exit_group
    4: (fd, buf, n) => {                                                   // write
      if (fd !== 1 && fd !== 2) return -E.EBADF;
      out(fd, rdBytes(buf, n)); return n;
    },
    146: (fd, iov, cnt) => {                                               // writev
      if (fd !== 1 && fd !== 2) return -E.EBADF;
      let total = 0;
      for (let i = 0; i < cnt; i++) { const b = rd32(iov + i * 8), n = rd32(iov + i * 8 + 4); out(fd, rdBytes(b, n)); total += n; }
      return total;
    },
    3: (fd) => (fd === 0 ? 0 : -E.EBADF),                                  // read: stdin is empty
    6: (fd) => (fd <= 2 ? 0 : -E.EBADF),                                   // close
    45: (addr) => {                                                        // brk
      if (addr === 0 || addr < lx.brkStart) return lx.brk;
      if (addr > lx.brk) mapRange(lx.brk, addr, true);
      lx.brk = addr; return lx.brk;
    },
    192: (addr, len, prot, flags, fd) => {                                 // mmap2: anonymous only
      if (!(flags & 0x20)) return -E.ENOSYS;                               // MAP_ANONYMOUS
      const size = Math.ceil(len / PAGE) * PAGE;
      const at = (flags & 0x10) ? addr : lx.mmapNext;                      // MAP_FIXED
      if (!(flags & 0x10)) lx.mmapNext += size;
      unmapRange(at, at + size); mapRange(at, at + size, true);
      return at;
    },
    91: (addr, len) => { unmapRange(addr, addr + len); return 0; },        // munmap
    125: () => 0,                                                          // mprotect: pages stay as mapped
    54: (fd, req) => (fd <= 2 ? -E.ENOTTY : -E.EBADF),                     // ioctl: not a terminal
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
    20: () => 1,                                                           // getpid
    224: () => 1,                                                          // gettid
    174: () => 0, 175: () => 0,                                            // rt_sigaction, rt_sigprocmask
    199: () => 0, 200: () => 0, 201: () => 0, 202: () => 0,                // get[e]uid32, get[e]gid32
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
