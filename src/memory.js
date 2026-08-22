/**
 * A page fault in flight. Thrown out of the memory accessors and caught by the recompiler's run
 * loop, which turns it into #PF — the only way to deliver a fault raised from INSIDE an access,
 * short of making every access site able to end its block.
 */
export class PageFault {
  constructor(lin, write) { this.lin = lin >>> 0; this.write = !!write; }
}

// memory.js — flat physical RAM with little-endian accessors and self-modifying-code
// (SMC) tracking. The engine is DOM-free so it runs identically in Node and the
// browser; everything visual is layered on top of this.

const PAGE_BITS = 12;            // 4 KiB pages — granularity for SMC invalidation
const PAGE_SIZE = 1 << PAGE_BITS;

export class Memory {
  /** @param {number} size power-of-two byte count (default 16 MiB) */
  constructor(size = 16 * 1024 * 1024) {
    if ((size & (size - 1)) !== 0) throw new Error('Memory size must be a power of two');
    this.size = size;
    this.paged = false;              // cached cpu.pagingOn — see syncPaging()
    this.pfRaise = false;            // Machine turns this on; see xlat()
    // Real-mode addressing wraps at 1 MiB (the 8086's 20-bit bus / the AT's A20 gate disabled at
    // reset). Default to that wrap regardless of how much RAM is installed, so segment:offset
    // arithmetic near FFFF:xxxx behaves like real hardware — DOS EXEPACK stubs and lots of startup
    // code rely on it (a 16 MiB buffer with no wrap makes them print "Packed file is corrupt").
    // A guest that wants the full range enables A20 (port 0x92) → setA20(true).
    this.a20 = false;
    this.mask = Math.min(size - 1, 0xfffff);
    this.buffer = new ArrayBuffer(size);
    this.u8 = new Uint8Array(this.buffer);
    this.dv = new DataView(this.buffer);

    // Pages that currently hold translated code. A write into one of these
    // pages tells the recompiler to throw the affected blocks away (SMC).
    this.codePage = new Uint8Array(size >> PAGE_BITS);
    this.onCodeWrite = null; // (page) => void, wired up by the recompiler
    this.planar = false;     // true in EGA/VGA 16-colour modes → A000 writes go through vga.js
    this.vga = null;         // the VGA planar device (set by installVGA); used on A000 writes
    this.shadowReads = false;   // MIRAGE_MEM_READ=shadow: the A000 window mirrors what a planar read
                                // returns, so emitted code can read it with no test at all

    // Page tables for the `paged` memory-dispatch strategy (src/mem-strategy.js). One entry per
    // 4 KiB page holding a BIASED offset — base - (page<<12) — so emitted code adds the whole
    // address and needs no offset mask (the shape v86's TLB and DOSBox's paging.h both use). A
    // negative entry means "not plain RAM: take the helper".
    //
    // Kept correct at all times rather than lazily, which is cheap because only three rare things
    // dirty them: entering/leaving a planar mode, the A20 line, and a page gaining translated code.
    // The WRITE table folds in what is currently a second probe — a page holding code is simply not
    // plain — so the SMC check leaves the fast path instead of sitting beside the device test.
    this.rdOfs = new Int32Array(size >> PAGE_BITS);
    this.wrOfs = new Int32Array(size >> PAGE_BITS);
    this.rebuildPageTables();
  }

  /**
   * Recompute both page tables. Without guest paging this is the identity mapping, so a plain page's
   * biased offset is 0. With CR0.PG set it becomes a genuine SOFTWARE TLB: each entry holds
   * physical - linear for that page, so emitted code adds the whole linear address and lands on the
   * right physical byte with no walk. That is the case the biased-offset design was built for and
   * measured as premature — it stops being premature the moment there is translation to do.
   *
   * Refilling the whole table costs one walk per 4 KiB page of installed RAM (4096 for 16 MiB),
   * which is cheap enough to do outright on a CR3 reload or a paging transition rather than
   * maintaining per-entry validity.
   */
  /** Kept in sync by rebuildPageTables, which every paging change already goes through. `pagingOn`
   *  is a getter over two CR0 bits, and calling it per access cost 6-12% on the intro bench once the
   *  multi-byte accessors needed it too — measured against HEAD, back to back, on an idle machine. */
  syncPaging() { this.paged = !!(this.cpu && this.cpu.pagingOn); }

  rebuildPageTables() {
    this.syncPaging();
    const n = this.rdOfs.length, pagesInRange = (this.mask + 1) >>> PAGE_BITS;
    const cpu = this.cpu, paging = cpu && cpu.pagingOn;
    for (let p = 0; p < n; p++) {
      const device = this.planar && p >= 0xa0 && p < 0xb0;
      if (device || p >= pagesInRange) { this.rdOfs[p] = -1; this.wrOfs[p] = -1; continue; }
      if (!paging) {
        this.rdOfs[p] = 0;
        this.wrOfs[p] = this.codePage[p] ? -1 : 0;
        continue;
      }
      const phys = this.walk(p << PAGE_BITS);
      if (phys < 0) { this.rdOfs[p] = -1; this.wrOfs[p] = -1; continue; }   // not present → the helper faults
      const bias = (phys - (p << PAGE_BITS)) | 0;
      this.rdOfs[p] = bias;
      // A code page must keep trapping writes, and so must a read-only one (the R/W bit lives in
      // the walk; `walk` reports it via walkRW).
      this.wrOfs[p] = (this.codePage[p] || !this.walkRW) ? -1 : bias;
    }
  }

  /** Translate a linear page to a physical address, or -1 if not present. Sets walkRW as a side
   *  channel for the writability of the last successful walk. */
  walk(lin) {
    const cpu = this.cpu;
    const dir = (cpu.cr3 & 0xfffff000) >>> 0;
    const pde = this.r32phys(dir + ((lin >>> 22) * 4));
    if (!(pde & 1)) { this.walkRW = false; return -1; }
    const pt = (pde & 0xfffff000) >>> 0;
    const pte = this.r32phys(pt + (((lin >>> 12) & 0x3ff) * 4));
    if (!(pte & 1)) { this.walkRW = false; return -1; }
    this.walkRW = !!(pde & 2) && !!(pte & 2);          // both levels must allow writing
    return (pte & 0xfffff000) >>> 0;
  }

  /** A physical dword read that never itself translates — used by the walk. */
  r32phys(a) {
    a &= this.size - 1;
    return (this.u8[a] | (this.u8[a + 1] << 8) | (this.u8[a + 2] << 16) | (this.u8[a + 3] << 24)) >>> 0;
  }

  /** Open (A20 on) or close the 1 MiB address wrap. On: the full installed RAM is addressable
   *  (real-mode HMA at FFFF:0010+). Off: segment:offset wraps at 1 MiB like an 8086. */
  setA20(on) {
    this.a20 = !!on;
    this.mask = on ? (this.size - 1) : Math.min(this.size - 1, 0xfffff);
    this.rebuildPageTables();
  }

  /** Entering or leaving a planar EGA/VGA mode moves A000-AFFF between plain RAM and the device. */
  setPlanar(on) {
    if (this.planar === !!on) return;
    this.planar = !!on;
    for (let p = 0xa0; p < 0xb0; p++) { this.rdOfs[p] = this.planar ? -1 : 0; this.wrOfs[p] = this.planar || this.codePage[p] ? -1 : 0; }
    // Entering a planar mode makes the window's contents meaningful again — refill the shadow.
    if (this.shadowReads && this.planar && this.vga) this.vga.rebuildShadow();
  }

  /**
   * Linear -> physical for the helper path. The emitted fast path never comes here (its page-table
   * entry already carries the bias); this is for pages the table marks as not-plain: device windows,
   * and under paging the not-present ones.
   *
   * NOT YET a #PF: a non-present page is counted and reads as zero. Raising the fault from inside a
   * memory accessor needs the same block-ending treatment as #DE and #UD, which is its own step —
   * and a silent zero surfaces as a later POST failing rather than as a wrong answer nobody sees.
   */
  xlat(a, write) {
    if (!this.paged) return a & this.mask;
    const phys = this.walk(a);
    if (phys < 0) {
      this.pfCount = (this.pfCount || 0) + 1; this.lastPF = a >>> 0;
      if (this.pfRaise) { const f = new PageFault(a, write); if (this.pfTrace) f.stack = new Error().stack; throw f; }
      return -1;                                   // no run loop to catch it: the old silent zero
    }
    return (phys | (a & 0xfff)) & (this.size - 1);
  }

  // ---- reads ---------------------------------------------------------------
  // In a planar EGA/VGA mode, A000 reads go through the plane logic (and load the latches);
  // everything else is a direct typed-array read. `planar` is false for text/mode-13h/demos
  // so the check is a single predicted branch on the common path.
  r8(a)  {
    if (this.paged) { const t = this.xlat(a, false); return t < 0 ? 0 : this.u8[t]; }
    a &= this.mask; return (this.planar && a >= 0xa0000 && a < 0xb0000) ? this.vga.readByte(a) : this.u8[a];
  }
  // Under paging these go byte at a time, because only r8/w8 translate — and a multi-byte access can
  // straddle a page boundary, where the two halves land in unrelated frames. Composing was not just a
  // tidiness point: `a &= this.mask` treats a LINEAR address as physical, so every descriptor load
  // read half-translated (loadDescriptor mixes r16 and r8). Windows 3.0's WIN386 puts its GDT at
  // linear 0x8010011c, and we read the descriptor from physical 0x0010011c.
  r16(a) { if (this.paged) return this.r8(a) | (this.r8(a + 1) << 8);
    a &= this.mask; if (this.planar && a >= 0xa0000 && a < 0xb0000) return this.r8(a) | (this.r8((a + 1) & this.mask) << 8);
    return this.u8[a] | (this.u8[(a + 1) & this.mask] << 8); }
  r32(a) { if (this.paged) return (this.r8(a) | (this.r8(a + 1) << 8) | (this.r8(a + 2) << 16) | (this.r8(a + 3) << 24)) >>> 0;
    a &= this.mask; if (this.planar && a >= 0xa0000 && a < 0xb0000) return (this.r8(a) | (this.r8((a + 1) & this.mask) << 8) | (this.r8((a + 2) & this.mask) << 16) | (this.r8((a + 3) & this.mask) << 24)) >>> 0;
    return (this.u8[a] | (this.u8[(a + 1) & this.mask] << 8) | (this.u8[(a + 2) & this.mask] << 16) | (this.u8[(a + 3) & this.mask] << 24)) >>> 0; }

  // ---- writes (with SMC tracking) -----------------------------------------
  w8(a, v) {
    if (this.paged) { const t = this.xlat(a, true); if (t >= 0) { this.u8[t] = v; if (this.codePage[t >> PAGE_BITS]) this._dirty(t, 1); } return; }
    a &= this.mask;
    if (this.planar && a >= 0xa0000 && a < 0xb0000) { this.vga.writeByte(a, v & 0xff); return; }
    this.u8[a] = v;
    if (this.codePage[a >> PAGE_BITS]) this._dirty(a, 1);
  }
  w16(a, v) {
    if (this.paged) { this.w8(a, v & 0xff); this.w8(a + 1, (v >> 8) & 0xff); return; }
    a &= this.mask;
    if (this.planar && a >= 0xa0000 && a < 0xb0000) { this.w8(a, v & 0xff); this.w8((a + 1) & this.mask, (v >> 8) & 0xff); return; }
    this.u8[a] = v; this.u8[(a + 1) & this.mask] = v >> 8;
    if (this.codePage[a >> PAGE_BITS] || this.codePage[(a + 1) >> PAGE_BITS]) this._dirty(a, 2);
  }
  w32(a, v) {
    if (this.paged) {
      this.w8(a, v & 0xff); this.w8(a + 1, (v >> 8) & 0xff);
      this.w8(a + 2, (v >> 16) & 0xff); this.w8(a + 3, (v >>> 24) & 0xff); return;
    }
    a &= this.mask;
    if (this.planar && a >= 0xa0000 && a < 0xb0000) { this.w8(a, v & 0xff); this.w8((a + 1) & this.mask, (v >> 8) & 0xff); this.w8((a + 2) & this.mask, (v >> 16) & 0xff); this.w8((a + 3) & this.mask, (v >>> 24) & 0xff); return; }
    this.u8[a] = v; this.u8[(a + 1) & this.mask] = v >> 8;
    this.u8[(a + 2) & this.mask] = v >> 16; this.u8[(a + 3) & this.mask] = v >> 24;
    if (this.codePage[a >> PAGE_BITS] || this.codePage[(a + 3) >> PAGE_BITS]) this._dirty(a, 4);
  }

  // SMC: report the written byte range so the recompiler can invalidate only the
  // blocks it actually overlaps (not the whole page).
  _dirty(addr, len) { if (this.onCodeWrite) this.onCodeWrite(addr, len); }

  // A page gaining or losing translated code moves it in and out of the write fast path. wrOfs
  // mirrors rdOfs when the page is clean, so a device page stays a device page either way.
  markCodePage(page) { this.codePage[page] = 1; this.wrOfs[page] = -1; }
  clearCodePage(page) { this.codePage[page] = 0; this.wrOfs[page] = this.rdOfs[page]; }

  // ---- bulk helpers --------------------------------------------------------
  /** Copy bytes in, marking SMC if they land on code pages. */
  blit(addr, bytes) {
    addr &= this.mask;
    this.u8.set(bytes, addr);
    const first = addr >> PAGE_BITS, last = (addr + bytes.length - 1) >> PAGE_BITS;
    for (let p = first; p <= last; p++) if (this.codePage[p]) { this._dirty(addr, bytes.length); break; }
  }

  /** Copy `len` bytes within RAM (memmove semantics), marking SMC if the destination lands on code
   *  pages. XMS AH=0Bh is the one bulk path that routinely swaps *code* overlays into conventional
   *  memory, so writing straight into `u8` there left stale compiled blocks live — the destination
   *  has to go through the same dirty check `blit` uses. Addresses are absolute (no A20 mask): XMS
   *  endpoints are already resolved to physical linear addresses above 1 MiB. */
  move(dst, src, len) {
    if (len <= 0) return;
    this.u8.copyWithin(dst, src, src + len);
    const first = dst >> PAGE_BITS, last = (dst + len - 1) >> PAGE_BITS;
    for (let p = first; p <= last; p++) if (this.codePage[p]) { this._dirty(dst, len); break; }
  }

  /** Read a CP437/byte string until a terminator (default '$', DOS-style). */
  readStr(addr, term = 0x24, max = 65535) {
    const out = [];
    for (let i = 0; i < max; i++) {
      const b = this.u8[(addr + i) & this.mask];
      if (b === term) break;
      out.push(b);
    }
    return out;
  }

  /** Read a NUL-terminated ASCIIZ string. */
  readCStr(addr, max = 65535) { return this.readStr(addr, 0, max); }
}

export { PAGE_BITS, PAGE_SIZE };
