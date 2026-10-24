// elfso.js — an ELF32 shared object made in JavaScript, whose functions call JavaScript (ROADMAP O9:
// libraries the environment supplies). Each exported function is a stub of eight bytes,
//
//     mov eax, HLE_BASE + id ; int 80h ; ret
//
// so a call lands in MIRAGE-LINUX's system call dispatcher with the caller's arguments on the stack
// (cdecl: the return address at [esp], the first argument at [esp+4]), and the JavaScript behind `id`
// answers in EAX. Everything else is a real library, as the dynamic linker of the time reads one:
// one PT_LOAD (read, write, execute: ld.so relocates the .dynamic in place, glibc's elf_get_dynamic_info
// on i386), a PT_DYNAMIC, a SysV DT_HASH, DT_SYMTAB, DT_STRTAB and DT_SONAME. The Linux 1K intros of
// 2009 rely on exactly that: they walk the link_map, read DT_HASH, DT_STRTAB and DT_SYMTAB from each
// library's .dynamic and find their functions by a hash of the names, with no imports of their own.

export const HLE_BASE = 0x48000000;

/** The SysV ELF hash (the System V ABI, DT_HASH). */
const elfHash = (name) => {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = ((h << 4) + name.charCodeAt(i)) >>> 0;
    const g = h & 0xf0000000;
    if (g) h ^= g >>> 24;
    h &= ~g >>> 0;
  }
  return h >>> 0;
};

/** The bytes of a shared object named `soname` exporting `names`, the function `names[i]` calling
 *  HLE id `firstId + i`. */
export function makeSharedObject(soname, names, firstId) {
  const n = names.length, nsym = n + 1;
  const enc = new TextEncoder();
  // .dynstr: "\0" soname names
  const strs = [0], nameOff = [];
  const pushStr = (s) => { const off = strs.length; strs.push(...enc.encode(s), 0); return off; };
  const sonameOff = pushStr(soname);
  for (const s of names) nameOff.push(pushStr(s));
  const align = (x, a) => (x + a - 1) & ~(a - 1);
  // layout: header, 2 program headers, .hash, .dynsym, .dynstr, .text, .dynamic
  const EH = 52, PH = 32, nbucket = Math.max(1, n);
  const hashOff = EH + 2 * PH, hashSize = 4 * (2 + nbucket + nsym);
  const symOff = align(hashOff + hashSize, 4), symSize = 16 * nsym;
  const strOff = symOff + symSize, strSize = strs.length;
  const textOff = align(strOff + strSize, 16), STUB = 8, textSize = STUB * n;
  const dynOff = align(textOff + textSize, 8), DYN = [[4, hashOff], [5, strOff], [6, symOff], [10, strSize], [11, 16], [14, sonameOff], [0, 0]];
  const size = dynOff + DYN.length * 8;
  const b = new Uint8Array(size), dv = new DataView(b.buffer);
  const w16 = (o, v) => dv.setUint16(o, v, true), w32 = (o, v) => dv.setUint32(o, v >>> 0, true);
  // ELF header: ELFCLASS32, little-endian, ET_DYN, EM_386
  b.set([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1, 0]);
  w16(16, 3); w16(18, 3); w32(20, 1); w32(24, 0); w32(28, EH); w32(32, 0); w32(36, 0);
  w16(40, EH); w16(42, PH); w16(44, 2); w16(46, 40); w16(48, 0); w16(50, 0);
  // PT_LOAD: the whole file at 0, RWX; PT_DYNAMIC
  const ph = (o, type, off, sz, flags, al) => { w32(o, type); w32(o + 4, off); w32(o + 8, off); w32(o + 12, off); w32(o + 16, sz); w32(o + 20, sz); w32(o + 24, flags); w32(o + 28, al); };
  ph(EH, 1, 0, size, 7, 0x1000);
  ph(EH + PH, 2, dynOff, DYN.length * 8, 6, 4);
  // .hash: nbucket, nchain, buckets, chains
  w32(hashOff, nbucket); w32(hashOff + 4, nsym);
  const buckets = hashOff + 8, chains = buckets + 4 * nbucket;
  for (let i = 1; i < nsym; i++) {
    const h = elfHash(names[i - 1]) % nbucket;
    w32(chains + 4 * i, dv.getUint32(buckets + 4 * h, true));      // prepend to the bucket's chain
    w32(buckets + 4 * h, i);
  }
  // .dynsym: the null symbol, then one STB_GLOBAL STT_FUNC per name, defined (a section index of 1)
  for (let i = 1; i < nsym; i++) {
    const o = symOff + 16 * i;
    w32(o, nameOff[i - 1]); w32(o + 4, textOff + STUB * (i - 1)); w32(o + 8, STUB);
    b[o + 12] = 0x12; b[o + 13] = 0; w16(o + 14, 1);
  }
  b.set(strs, strOff);
  // .text: mov eax, imm32 (B8) ; int 80h (CD 80) ; ret (C3) ; nop
  for (let i = 0; i < n; i++) {
    const o = textOff + STUB * i;
    b[o] = 0xb8; w32(o + 1, HLE_BASE + firstId + i); b[o + 5] = 0xcd; b[o + 6] = 0x80; b[o + 7] = 0xc3;
  }
  DYN.forEach(([tag, val], i) => { w32(dynOff + 8 * i, tag); w32(dynOff + 8 * i + 4, val); });
  return b;
}
