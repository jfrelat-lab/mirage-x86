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
    this.mask = size - 1;
    this.buffer = new ArrayBuffer(size);
    this.u8 = new Uint8Array(this.buffer);
    this.dv = new DataView(this.buffer);

    // Pages that currently hold translated code. A write into one of these
    // pages tells the recompiler to throw the affected blocks away (SMC).
    this.codePage = new Uint8Array(size >> PAGE_BITS);
    this.onCodeWrite = null; // (page) => void, wired up by the recompiler
    this.planar = false;     // true in EGA/VGA 16-colour modes → A000 writes go through vga.js
    this.vga = null;         // the VGA planar device (set by installVGA); used on A000 writes
  }

  // ---- reads ---------------------------------------------------------------
  r8(a)  { return this.u8[a & this.mask]; }
  r16(a) { a &= this.mask; return this.u8[a] | (this.u8[(a + 1) & this.mask] << 8); }
  r32(a) {
    a &= this.mask;
    return (this.u8[a] | (this.u8[(a + 1) & this.mask] << 8) |
           (this.u8[(a + 2) & this.mask] << 16) | (this.u8[(a + 3) & this.mask] << 24)) >>> 0;
  }

  // ---- writes (with SMC tracking) -----------------------------------------
  w8(a, v) {
    a &= this.mask;
    this.u8[a] = v;
    if (this.codePage[a >> PAGE_BITS]) this._dirty(a, 1);
  }
  w16(a, v) {
    a &= this.mask;
    this.u8[a] = v; this.u8[(a + 1) & this.mask] = v >> 8;
    if (this.codePage[a >> PAGE_BITS] || this.codePage[(a + 1) >> PAGE_BITS]) this._dirty(a, 2);
  }
  w32(a, v) {
    a &= this.mask;
    this.u8[a] = v; this.u8[(a + 1) & this.mask] = v >> 8;
    this.u8[(a + 2) & this.mask] = v >> 16; this.u8[(a + 3) & this.mask] = v >> 24;
    if (this.codePage[a >> PAGE_BITS] || this.codePage[(a + 3) >> PAGE_BITS]) this._dirty(a, 4);
  }

  // SMC: report the written byte range so the recompiler can invalidate only the
  // blocks it actually overlaps (not the whole page).
  _dirty(addr, len) { if (this.onCodeWrite) this.onCodeWrite(addr, len); }

  markCodePage(page) { this.codePage[page] = 1; }

  // ---- bulk helpers --------------------------------------------------------
  /** Copy bytes in, marking SMC if they land on code pages. */
  blit(addr, bytes) {
    addr &= this.mask;
    this.u8.set(bytes, addr);
    const first = addr >> PAGE_BITS, last = (addr + bytes.length - 1) >> PAGE_BITS;
    for (let p = first; p <= last; p++) if (this.codePage[p]) { this._dirty(addr, bytes.length); break; }
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
